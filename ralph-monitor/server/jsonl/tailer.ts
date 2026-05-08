// Per-session JSONL live-tailer for US-010.
//
// `attachTailer(jsonlPath, sessionId, onEvent)` returns a disposer and emits
//
//   { type: 'snapshot', turns }    on attach (and again on truncation)
//   { type: 'turn', turn, byteOffset } per new record after attach
//   { type: 'gone' }                when the JSONL is unlinked
//
// One chokidar watcher per session id is shared across subscribers — the AC's
// "shared watcher per session id" optimisation. Each subscriber tracks its own
// `byteOffset` so two clients on the same session see the same `change` event
// but each resumes from the byte boundary it observed at attach.
//
// === The snapshot-during-change race ===
//
// When subscriber B attaches while a `'change'` event for the same file is in
// flight, naive code can miss a turn: chokidar delivers the change → we read
// new bytes from `state.lastByteOffset` and emit a `turn`; meanwhile B reads
// `parseTranscript` and starts at offset 0. If B's read happens BEFORE the
// change's writes hit the disk view, B's snapshot lacks the turn AND B's
// per-subscriber offset is set to the file size as B saw it — strictly less
// than `state.lastByteOffset` after the change-handler emits. B never gets the
// turn.
//
// Fix used here:
//   1. The shared change handler holds an in-flight promise the whole time it
//      reads + emits new turns (`state.changeInFlight`). New attach() calls
//      await it before reading their snapshot, so B's parseTranscript observes
//      the file AFTER the change-handler has finished advancing
//      lastByteOffset.
//   2. B's per-subscriber `byteOffset` is set to the file size B observed when
//      it parsed its snapshot — NOT to `state.lastByteOffset`. This is so any
//      `'change'` event that fires between B's snapshot read and B being added
//      to the subscribers Set still skips the turns B already saw on disk.
//
// === Truncation vs append ===
//
// chokidar's `awaitWriteFinish` debounces a sequence of writes into a single
// `'change'`. Our handler always re-stat()s before reading; if size shrunk we
// treat the file as recreated and emit a fresh `snapshot` to all subscribers,
// resetting `lastByteOffset` to the post-truncate size.
//
// === `'add'` after delete-recreate ===
//
// chokidar emits `'unlink'` then `'add'` when a file is recreated. The
// `'unlink'` path emits `{type:'gone'}` and tears down the tailer state, so
// any subsequent `'add'` for the same path lands on a NEW tailer (a new
// attachTailer call from a reconnecting client). We deliberately do NOT keep
// the watcher alive across delete: subscribers that survived the delete have
// no path forward without re-attaching anyway, and chokidar's add-after-delete
// behaviour is squirrelly enough that we'd rather start fresh.
//
// === Why we watch the parent directory ===
//
// `chokidar.watch(<single-file-path>)` on Linux uses an inotify watch on the
// inode itself. When the file is unlinked the inode goes away and chokidar
// does NOT emit `unlink` (verified empirically on chokidar 4.0.3 / Linux
// 6.19). To get reliable `unlink` we watch the parent directory at depth 0
// and filter events to the JSONL filename only. Append/truncate/recreate all
// also surface through the same parent watch.

import chokidar, { type FSWatcher } from 'chokidar'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parseStream, parseTranscript, type Turn } from './parser'

export type TailEvent =
  | { type: 'snapshot'; turns: Turn[] }
  | { type: 'turn'; turn: Turn; byteOffset: number }
  | { type: 'gone' }

export type TailEventHandler = (event: TailEvent) => void | Promise<void>

interface TailerSubscriber {
  onEvent: TailEventHandler
  byteOffset: number
}

interface TailerState {
  watcher: FSWatcher
  subscribers: Set<TailerSubscriber>
  lastByteOffset: number
  jsonlPath: string
  // Promise that resolves once the in-flight `'change'` handler has finished
  // reading new bytes and emitting them to subscribers. New attaches await
  // this before computing their initial snapshot to close the race window.
  changeInFlight: Promise<void> | null
  closed: boolean
}

const tailers = new Map<string, TailerState>()

// Test-only — exposes the live-tailer registry size so tests can assert that
// the last subscriber's disposer tore down the watcher. Not part of the
// public API.
export const __test__ = {
  tailerCount(): number {
    return tailers.size
  },
  hasTailer(sessionId: string): boolean {
    return tailers.has(sessionId)
  },
}

export async function attachTailer(
  jsonlPath: string,
  sessionId: string,
  onEvent: TailEventHandler,
): Promise<() => void> {
  let state = tailers.get(sessionId)
  if (!state) {
    state = await createTailerState(jsonlPath, sessionId)
    tailers.set(sessionId, state)
  }

  // Wait for any in-flight change handler so our snapshot reflects the
  // post-change file. See the race-window note at the top of this file.
  if (state.changeInFlight) {
    try {
      await state.changeInFlight
    } catch {
      // The change handler logs its own errors. We carry on and parse the
      // current disk state regardless.
    }
  }

  // Take an authoritative snapshot from disk + the file size we read. The
  // subscriber's byteOffset starts at THAT size — not at `state.lastByteOffset`
  // — so a `'change'` that lands between snapshot computation and subscription
  // still skips records the snapshot already showed.
  let snapshotTurns: Turn[] = []
  let snapshotSize = 0
  try {
    snapshotTurns = await parseTranscript(jsonlPath)
    snapshotSize = (await stat(jsonlPath)).size
  } catch (err) {
    // ENOENT is fine — empty snapshot, offset stays at 0. The watcher is still
    // running on the path; chokidar will fire an `add`/`change` if the file
    // appears later.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const subscriber: TailerSubscriber = {
    onEvent,
    byteOffset: snapshotSize,
  }
  state.subscribers.add(subscriber)

  // Fire the snapshot AFTER adding to the subscriber set so the subscriber's
  // own change-handler emits (which only happen after `subscribers.add`) are
  // correctly ordered relative to its initial snapshot.
  await safeEmit(subscriber, { type: 'snapshot', turns: snapshotTurns })

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const s = tailers.get(sessionId)
    if (!s) return
    s.subscribers.delete(subscriber)
    if (s.subscribers.size === 0) {
      teardownTailer(sessionId, s)
    }
  }
}

async function createTailerState(
  jsonlPath: string,
  sessionId: string,
): Promise<TailerState> {
  // Initialise lastByteOffset to the current file size so subsequent `change`
  // events read only NEW bytes. Not failing on ENOENT — chokidar can watch a
  // path that doesn't yet exist.
  let initialSize = 0
  try {
    initialSize = (await stat(jsonlPath)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  // Watch the parent directory (depth 0) and filter to our JSONL filename so
  // we get reliable unlink + add-after-recreate events on Linux. See the
  // "Why we watch the parent directory" comment at the top of this module.
  const watchDir = dirname(jsonlPath)
  const target = resolve(jsonlPath)

  const watcher = chokidar.watch(watchDir, {
    persistent: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  })

  const state: TailerState = {
    watcher,
    subscribers: new Set(),
    lastByteOffset: initialSize,
    jsonlPath,
    changeInFlight: null,
    closed: false,
  }

  const onChangeOrAdd = (path: string): void => {
    if (resolve(path) !== target) return
    // Serialise change handling: if a previous read is still in flight, chain
    // onto it so reads happen in order and lastByteOffset advances
    // monotonically.
    const prev = state.changeInFlight ?? Promise.resolve()
    let chain: Promise<void>
    chain = prev
      .catch(() => {})
      .then(() => handleChange(state))
      .finally(() => {
        // Only clear if WE were the most recent in-flight promise. Otherwise a
        // subsequent change has chained on us and we'd be clearing the wrong
        // marker.
        if (state.changeInFlight === chain) {
          state.changeInFlight = null
        }
      })
    state.changeInFlight = chain
  }

  watcher.on('change', onChangeOrAdd)
  // chokidar fires `add` on initial discovery and after delete-recreate. We
  // want both paths to drain new bytes the same way.
  watcher.on('add', onChangeOrAdd)
  watcher.on('unlink', (path) => {
    if (resolve(path) !== target) return
    handleUnlink(sessionId, state)
  })
  watcher.on('error', (err) => {
    console.warn(`[tailer] watcher error for session ${sessionId}:`, err)
  })

  // Wait for chokidar to finish its initial readdir + inotify-watch install
  // before returning. Otherwise a fast unlink immediately after attach can
  // race the watcher setup and never fire `unlink`.
  await new Promise<void>((resolveReady) => {
    if (state.closed) return resolveReady()
    watcher.once('ready', () => resolveReady())
  })

  return state
}

async function handleChange(state: TailerState): Promise<void> {
  if (state.closed) return
  let size: number
  try {
    size = (await stat(state.jsonlPath)).size
  } catch (err) {
    // The file vanished between change and stat. The unlink handler will
    // (or did) take care of teardown — bail.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  if (size < state.lastByteOffset) {
    // Truncation (or recreate-with-shorter-content). Treat as a fresh file:
    // re-parse the whole thing, emit snapshot, reset offsets.
    const turns = await parseTranscript(state.jsonlPath)
    state.lastByteOffset = size
    for (const sub of state.subscribers) {
      sub.byteOffset = size
      await safeEmit(sub, { type: 'snapshot', turns })
    }
    return
  }

  if (size === state.lastByteOffset) return

  // Read new turns and emit each one. parseStream advances the offset
  // record-by-record; we update lastByteOffset incrementally so a partial
  // failure mid-loop still leaves us at the last successfully emitted record.
  for await (const yld of parseStream(state.jsonlPath, state.lastByteOffset)) {
    if (state.closed) return
    state.lastByteOffset = yld.byteOffset
    for (const sub of state.subscribers) {
      // Per-subscriber offset gating: only deliver turns past what THIS
      // subscriber already saw via its initial snapshot.
      if (yld.byteOffset <= sub.byteOffset) continue
      sub.byteOffset = yld.byteOffset
      await safeEmit(sub, {
        type: 'turn',
        turn: yld.turn,
        byteOffset: yld.byteOffset,
      })
    }
  }
}

function handleUnlink(sessionId: string, state: TailerState): void {
  if (state.closed) return
  // Snapshot subscribers before teardown so iteration is stable.
  const subs = [...state.subscribers]
  teardownTailer(sessionId, state)
  for (const sub of subs) {
    void safeEmit(sub, { type: 'gone' })
  }
}

function teardownTailer(sessionId: string, state: TailerState): void {
  if (state.closed) return
  state.closed = true
  state.subscribers.clear()
  // chokidar's close() returns a promise; we don't await it because callers
  // (the disposer) are sync. Errors during close are non-actionable.
  state.watcher.close().catch((err) => {
    console.warn(`[tailer] watcher close failed for ${sessionId}:`, err)
  })
  if (tailers.get(sessionId) === state) {
    tailers.delete(sessionId)
  }
}

async function safeEmit(
  sub: TailerSubscriber,
  event: TailEvent,
): Promise<void> {
  try {
    await sub.onEvent(event)
  } catch (err) {
    console.warn('[tailer] subscriber callback threw:', err)
  }
}
