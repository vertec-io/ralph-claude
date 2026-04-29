import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import { useServerStream } from './sse'
import { authFetch } from './auth'
import type { PRDRecord, UserStory, AppEvent, CommitRow } from '../server/types'
import { PrdSnapshotPanels } from './components/PrdSnapshotPanels'

marked.setOptions({ gfm: true, breaks: false })

export function App() {
  const { snapshot, connected } = useServerStream()
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null)
  const [showAllEvents, setShowAllEvents] = useState(false)

  if (!snapshot) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-500">
        connecting to ralph-monitor server…
      </div>
    )
  }

  const selected = snapshot.prds.find(p => p.unitName === selectedUnit) ?? snapshot.prds[0]
  const filteredEvents = showAllEvents
    ? snapshot.events
    : snapshot.events.filter(e => 'unitName' in e && e.unitName === selected?.unitName)

  return (
    <div className="grid grid-cols-[300px_1fr_360px] h-screen">
      <PRDList
        prds={snapshot.prds}
        selectedUnit={selected?.unitName ?? null}
        onSelect={setSelectedUnit}
        connected={connected}
      />
      {selected ? <PRDDetail prd={selected} /> : <EmptyDetail />}
      <EventFeed
        events={filteredEvents}
        showAll={showAllEvents}
        onToggleShowAll={() => setShowAllEvents(s => !s)}
        scopeName={selected?.unitName ?? null}
      />
    </div>
  )
}

function PRDList({ prds, selectedUnit, onSelect, connected }: {
  prds: PRDRecord[]
  selectedUnit: string | null
  onSelect: (u: string) => void
  connected: boolean
}) {
  return (
    <aside className="border-r border-zinc-800 overflow-y-auto bg-zinc-950">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-tight">ralph-monitor</h1>
        <span className={`size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
      </div>
      {prds.length === 0 && (
        <div className="px-4 py-6 text-sm text-zinc-500">
          no PRDs registered. install a watchdog via{' '}
          <code className="text-zinc-300">install-watchdog.sh</code> to see it here.
        </div>
      )}
      <ul>
        {prds.map(prd => (
          <PRDListItem
            key={prd.unitName}
            prd={prd}
            selected={prd.unitName === selectedUnit}
            onSelect={() => onSelect(prd.unitName)}
          />
        ))}
      </ul>
    </aside>
  )
}

function PRDListItem({ prd, selected, onSelect }: { prd: PRDRecord; selected: boolean; onSelect: () => void }) {
  const stories = prd.prd?.userStories ?? []
  const passing = stories.filter(s => s.passes).length
  const total = stories.length
  const pct = total === 0 ? 0 : Math.round((passing / total) * 100)
  const title = prd.prd?.title ?? prd.unitName.replace(/^ralph-pilot-native-/, '')

  return (
    <li>
      <button
        onClick={onSelect}
        className={`w-full text-left px-4 py-3 border-b border-zinc-900 transition ${
          selected ? 'bg-zinc-900' : 'hover:bg-zinc-900/50'
        }`}
      >
        <div className="flex items-center gap-2">
          <StatusPip status={prd.status} />
          <span className="text-sm font-medium truncate">{title}</span>
        </div>
        <div className="mt-1 text-xs text-zinc-500 truncate">
          {prd.prd?.branchName ?? prd.unitName}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-zinc-800 rounded overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[11px] tabular-nums text-zinc-400">{passing}/{total}</span>
        </div>
        {prd.heartbeatMtime && (
          <div className="mt-1 text-[11px] text-zinc-500">
            ♥ {timeAgo(prd.heartbeatMtime)}
          </div>
        )}
      </button>
    </li>
  )
}

function PRDDetail({ prd }: { prd: PRDRecord }) {
  const stories = prd.prd?.userStories ?? []
  const [openStoryId, setOpenStoryId] = useState<string | null>(null)
  const [openFilePath, setOpenFilePath] = useState<string | null>(null)
  const openStory = openStoryId ? stories.find(s => s.id === openStoryId) ?? null : null

  return (
    <main className="overflow-y-auto bg-zinc-950">
      <header className="px-6 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
        <div className="flex items-center gap-3">
          <StatusPip status={prd.status} />
          <h2 className="text-base font-semibold">{prd.prd?.title ?? prd.unitName}</h2>
        </div>
        <div className="mt-1 text-xs text-zinc-500 font-mono">
          {prd.worktreeDir} · {prd.prd?.branchName ?? '—'} · session {prd.sessionId.slice(0, 8)}
        </div>
      </header>

      <PrdSnapshotPanels
        snapshot={prd}
        onStoryClick={setOpenStoryId}
        onFileClick={setOpenFilePath}
      />

      {openStory && (
        <StoryModal
          story={openStory}
          allStories={stories}
          recentCommits={prd.recentCommits}
          onClose={() => setOpenStoryId(null)}
        />
      )}

      {openFilePath && (
        <FileModal
          path={openFilePath}
          onClose={() => setOpenFilePath(null)}
        />
      )}
    </main>
  )
}

function StoryModal({ story, allStories, recentCommits, onClose }: {
  story: UserStory
  allStories: UserStory[]
  recentCommits: CommitRow[]
  onClose: () => void
}) {
  // Close on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const crit = (story.acceptanceCriteria ?? []).map(c =>
    typeof c === 'string' ? { description: c, passes: story.passes } : c
  )
  const passing = crit.filter(c => c.passes).length

  // Stories that are blocked by this one
  const blockingOthers = allStories.filter(s => (s.blockedBy ?? []).includes(story.id))

  // Commits whose subject mentions this story ID
  const relatedCommits = recentCommits.filter(c =>
    new RegExp(`\\b${escapeRegex(story.id)}\\b`).test(c.subject)
  )

  const passingMap = new Map(allStories.map(s => [s.id, s.passes]))

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl max-w-3xl w-full max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
          <div className="flex items-start gap-3">
            <span className={`mt-1.5 size-2.5 rounded-full shrink-0 ${
              story.passes ? 'bg-emerald-500' : 'bg-zinc-700'
            }`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-mono text-sm text-zinc-400">{story.id}</span>
                {story.modelHint && (
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                    {story.modelHint}
                  </span>
                )}
                {story.type && (
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                    {story.type}
                  </span>
                )}
                {story.phase !== undefined && (
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                    phase {String(story.phase)}
                  </span>
                )}
                {story.priority !== undefined && (
                  <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">
                    p{story.priority}
                  </span>
                )}
                <span className="ml-auto text-[11px] tabular-nums text-zinc-400">
                  {passing}/{crit.length || '—'} criteria
                </span>
              </div>
              <h2 className={`mt-1 text-lg font-semibold ${story.passes ? 'text-zinc-400 line-through' : 'text-zinc-100'}`}>
                {story.title}
              </h2>
              {story.lastActivityAt && (
                <div className="mt-1 text-[11px] text-zinc-500">
                  last activity {timeAgo(story.lastActivityAt)}
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-zinc-500 hover:text-zinc-200 text-2xl leading-none px-2"
              aria-label="close"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-5">
          {story.description && (
            <Section title="description">
              <p className="text-sm text-zinc-300 whitespace-pre-wrap">{story.description}</p>
            </Section>
          )}

          <Section title={`acceptance criteria (${passing}/${crit.length || 0})`}>
            {crit.length === 0 ? (
              <p className="text-sm text-zinc-500 italic">no criteria</p>
            ) : (
              <ul className="space-y-1.5">
                {crit.map((c, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className={`mt-1.5 size-2 rounded-full shrink-0 ${c.passes ? 'bg-emerald-500' : 'bg-zinc-700'}`} />
                    <span className={c.passes ? 'text-zinc-500 line-through' : 'text-zinc-300'}>
                      {c.description}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {(story.blockedBy?.length ?? 0) > 0 && (
            <Section title="blocked by">
              <ul className="text-sm space-y-0.5">
                {story.blockedBy!.map(id => (
                  <li key={id} className="flex items-center gap-2 font-mono">
                    <span className={passingMap.get(id) ? 'text-emerald-500' : 'text-violet-400'}>
                      {passingMap.get(id) ? '✓' : '○'}
                    </span>
                    <span className={passingMap.get(id) ? 'text-zinc-500 line-through' : 'text-zinc-300'}>
                      {id}
                    </span>
                    {!passingMap.has(id) && <span className="text-xs text-zinc-600">(unknown)</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {blockingOthers.length > 0 && (
            <Section title={`blocking ${blockingOthers.length} other ${blockingOthers.length === 1 ? 'story' : 'stories'}`}>
              <ul className="text-sm space-y-0.5">
                {blockingOthers.map(s => (
                  <li key={s.id} className="flex items-baseline gap-2 font-mono">
                    <span className="text-violet-400">⛓</span>
                    <span className="text-zinc-300">{s.id}</span>
                    <span className="font-sans text-zinc-500 truncate">{s.title}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {relatedCommits.length > 0 && (
            <Section title="related commits">
              <ul className="text-sm font-mono space-y-0.5">
                {relatedCommits.map(c => (
                  <li key={c.sha} className="flex gap-3 text-zinc-300">
                    <span className="text-emerald-500">{c.short}</span>
                    <span className="text-zinc-500 shrink-0">{timeAgo(c.ts * 1000)}</span>
                    <span className="truncate">{c.subject}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {story.notes && story.notes.trim().length > 0 && (
            <Section title="notes">
              <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-sans leading-relaxed">
                {story.notes}
              </pre>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] uppercase tracking-wide text-zinc-500 mb-2">{title}</h3>
      {children}
    </div>
  )
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type FileMode = 'rendered' | 'raw' | 'edit'

function FileModal({ path, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null)
  const [originalContent, setOriginalContent] = useState<string>('')
  const [mtime, setMtime] = useState<number | null>(null)
  const [externalMtime, setExternalMtime] = useState<number | null>(null)
  const [mode, setMode] = useState<FileMode>('rendered')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const isMarkdown = /\.md$/i.test(path)
  const dirty = content !== null && content !== originalContent

  // Load file
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    authFetch(`/api/file?path=${encodeURIComponent(path)}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json()).error ?? 'load failed')
        return r.json() as Promise<{ content: string; mtime: number }>
      })
      .then(data => {
        if (cancelled) return
        setContent(data.content)
        setOriginalContent(data.content)
        setMtime(data.mtime)
        setExternalMtime(data.mtime)
        // Default to rendered for markdown, raw for non-markdown
        setMode(/\.md$/i.test(path) ? 'rendered' : 'raw')
      })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [path])

  // Periodically check the file mtime for external changes (every 5s while open)
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await authFetch(`/api/file?path=${encodeURIComponent(path)}`)
        if (!r.ok) return
        const data = await r.json() as { mtime: number; content: string }
        setExternalMtime(data.mtime)
        // If we're not dirty AND we don't have the latest, auto-refresh
        if (!dirty && mtime !== null && data.mtime > mtime) {
          setContent(data.content)
          setOriginalContent(data.content)
          setMtime(data.mtime)
        }
      } catch {}
    }, 5000)
    return () => clearInterval(id)
  }, [path, dirty, mtime])

  const save = async () => {
    if (!dirty || content === null) return
    setSaving(true)
    setSaveError(null)
    try {
      const r = await authFetch('/api/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content, expectedMtime: mtime ?? undefined }),
      })
      const data = await r.json()
      if (!r.ok) {
        setSaveError(data?.error ?? `save failed (${r.status})`)
      } else {
        setOriginalContent(content)
        setMtime(data.mtime)
        setExternalMtime(data.mtime)
      }
    } catch (e: any) {
      setSaveError(String(e?.message ?? e))
    } finally {
      setSaving(false)
    }
  }

  const reload = async () => {
    setLoading(true)
    try {
      const r = await authFetch(`/api/file?path=${encodeURIComponent(path)}`)
      const data = await r.json() as { content: string; mtime: number }
      setContent(data.content)
      setOriginalContent(data.content)
      setMtime(data.mtime)
      setExternalMtime(data.mtime)
    } finally { setLoading(false) }
  }

  // Keyboard: ESC closes (with dirty confirm), Cmd/Ctrl+S saves
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (dirty && !confirm('Discard unsaved changes?')) return
        onClose()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && mode === 'edit') {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, mode, content, onClose])

  const externallyChanged = externalMtime !== null && mtime !== null && externalMtime > mtime
  const filename = path.split('/').slice(-1)[0]
  const renderedHtml = useMemo(() => {
    if (content === null) return ''
    return marked.parse(content, { async: false }) as string
  }, [content])

  return (
    <div
      onClick={() => {
        if (dirty && !confirm('Discard unsaved changes?')) return
        onClose()
      }}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl w-[min(1200px,95vw)] h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-zinc-800 flex items-center gap-3">
          <span className="font-mono text-sm text-zinc-200 truncate flex-1">{filename}</span>
          {dirty && <span className="text-[11px] uppercase px-2 py-0.5 rounded bg-amber-900/50 text-amber-300">unsaved</span>}
          {saving && <span className="text-[11px] text-zinc-400">saving…</span>}
          <SegmentedControl
            value={mode}
            onChange={setMode}
            options={isMarkdown
              ? [{ value: 'rendered', label: 'rendered' }, { value: 'raw', label: 'raw' }, { value: 'edit', label: 'edit' }]
              : [{ value: 'raw', label: 'raw' }, { value: 'edit', label: 'edit' }]
            }
          />
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="text-xs px-3 py-1 rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:bg-zinc-800 disabled:text-zinc-600 disabled:cursor-not-allowed"
            title="Cmd/Ctrl+S"
          >
            save
          </button>
          <button
            onClick={() => {
              if (dirty && !confirm('Discard unsaved changes?')) return
              onClose()
            }}
            className="text-zinc-500 hover:text-zinc-200 text-2xl leading-none px-2"
            aria-label="close"
          >
            ×
          </button>
        </div>

        {/* Sub-header: path + warnings */}
        <div className="px-5 py-1.5 border-b border-zinc-800/50 text-[11px] text-zinc-500 font-mono truncate">
          {path}
        </div>

        {externallyChanged && (
          <div className="px-5 py-2 bg-amber-950/40 border-b border-amber-900/40 text-xs text-amber-200 flex items-center justify-between gap-3">
            <span>file was modified externally since you opened it</span>
            <button
              onClick={reload}
              className="text-amber-100 underline hover:no-underline"
            >
              {dirty ? 'discard local changes & reload' : 'reload'}
            </button>
          </div>
        )}

        {saveError && (
          <div className="px-5 py-2 bg-rose-950/40 border-b border-rose-900/40 text-xs text-rose-200">
            save failed: {saveError}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          {loading && <div className="p-6 text-zinc-500 text-sm">loading…</div>}
          {error && !loading && <div className="p-6 text-rose-400 text-sm">{error}</div>}
          {!loading && !error && content !== null && (
            <>
              {mode === 'rendered' && (
                <div
                  className="prose-zinc-tight overflow-y-auto h-full px-6 py-5"
                  dangerouslySetInnerHTML={{ __html: renderedHtml }}
                />
              )}
              {mode === 'raw' && (
                <pre className="overflow-auto h-full px-6 py-5 text-xs font-mono text-zinc-200 whitespace-pre-wrap break-words">
                  {content}
                </pre>
              )}
              {mode === 'edit' && (
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  spellCheck={false}
                  className="w-full h-full px-6 py-5 text-xs font-mono text-zinc-100 bg-zinc-950 outline-none resize-none border-0"
                  autoFocus
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SegmentedControl<T extends string>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden text-xs">
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-3 py-1 ${
            value === opt.value
              ? 'bg-zinc-700 text-zinc-100'
              : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function EventFeed({ events, showAll, onToggleShowAll, scopeName }: {
  events: AppEvent[]
  showAll: boolean
  onToggleShowAll: () => void
  scopeName: string | null
}) {
  const scopeLabel = scopeName?.replace(/^ralph-pilot-native-/, '') ?? '(no PRD selected)'
  return (
    <aside className="border-l border-zinc-800 overflow-y-auto bg-zinc-950">
      <div className="px-4 py-3 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
        <div className="flex items-center justify-between mb-1.5">
          <h2 className="text-sm font-semibold tracking-tight">events</h2>
          <button
            onClick={onToggleShowAll}
            className={`text-[10px] uppercase px-2 py-0.5 rounded border ${
              showAll
                ? 'border-zinc-600 text-zinc-200 bg-zinc-800'
                : 'border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
            }`}
            title={showAll ? 'showing events from all PRDs' : 'showing events for current PRD only'}
          >
            {showAll ? 'all PRDs' : 'this PRD'}
          </button>
        </div>
        <div className="text-[11px] text-zinc-600 truncate">
          {showAll ? 'all registered PRDs' : `scope: ${scopeLabel}`}
        </div>
      </div>
      <ul>
        {events.length === 0 && (
          <li className="px-4 py-6 text-sm text-zinc-500">
            {showAll ? 'no events yet' : 'no events for this PRD yet'}
          </li>
        )}
        {events.map((e, i) => (
          <li key={i} className="px-4 py-2 border-b border-zinc-900 text-xs">
            <div className="flex items-baseline gap-2">
              <span className={`font-mono ${eventColor(e.type)}`}>{e.type}</span>
              <span className="text-zinc-600 ml-auto tabular-nums">{timeAgo(e.ts)}</span>
            </div>
            {showAll && 'unitName' in e && e.unitName && (
              <div className="text-zinc-500 truncate">
                {e.unitName.replace(/^ralph-pilot-native-/, '')}
              </div>
            )}
            {'detail' in e && e.detail && <div className="text-zinc-400 truncate font-mono">{e.detail}</div>}
          </li>
        ))}
      </ul>
    </aside>
  )
}

function EmptyDetail() {
  return (
    <main className="flex items-center justify-center text-zinc-500">
      select a PRD on the left
    </main>
  )
}

function StatusPip({ status }: { status: PRDRecord['status'] }) {
  const colors: Record<PRDRecord['status'], string> = {
    active: 'bg-emerald-500',
    idle: 'bg-amber-500',
    crashed: 'bg-rose-500',
    complete: 'bg-sky-500',
    blocked: 'bg-violet-500',
    pending: 'bg-zinc-500',
  }
  return <span className={`size-2 rounded-full ${colors[status]}`} title={status} />
}

function eventColor(type: AppEvent['type']): string {
  if (type.startsWith('story') || type.startsWith('criterion')) return 'text-emerald-400'
  if (type === 'commit.landed') return 'text-sky-400'
  if (type.startsWith('watchdog.resurrect')) return 'text-rose-400'
  if (type.startsWith('watchdog')) return 'text-zinc-400'
  if (type.startsWith('decision')) return 'text-violet-400'
  if (type.startsWith('hook')) return 'text-zinc-500'
  return 'text-zinc-300'
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'in future'
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

