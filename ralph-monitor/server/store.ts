// Central in-memory state + SSE broadcast hub.

import type { PRDRecord, ServerSnapshot, AppEvent } from './types'

type Subscriber = (chunk: string) => Promise<void> | void

// Stories are "active" if any signal fired within this window.
// 30 min matches typical story durations (10–30 min for a single Sonnet task);
// a 5-min window dropped stories from the bucket between tool calls.
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

class Store {
  private prds = new Map<string, PRDRecord>()
  private events: AppEvent[] = []
  private subscribers = new Set<{ id: number; send: Subscriber }>()
  private nextId = 1
  private readonly EVENT_CAP = 500
  // unitName -> storyId -> last-activity-ms. Persists across snapshot refreshes
  // (which rebuild PRDRecord from disk and would otherwise lose this).
  private activityByStory = new Map<string, Map<string, number>>()

  setPRD(record: PRDRecord) {
    const prior = this.prds.get(record.unitName)
    this.prds.set(record.unitName, record)
    if (!prior) {
      this.recordEvent({ ts: Date.now(), unitName: record.unitName, type: 'prd.discovered' })
    } else {
      this.recordEvent({ ts: Date.now(), unitName: record.unitName, type: 'prd.updated' })
    }
    this.diffAndEmit(prior, record)
  }

  removePRD(unitName: string) {
    if (this.prds.delete(unitName)) {
      this.activityByStory.delete(unitName)
      this.recordEvent({ ts: Date.now(), unitName, type: 'prd.removed' })
    }
  }

  getPRD(unitName: string): PRDRecord | undefined {
    return this.prds.get(unitName)
  }

  // Mark a story as having had activity NOW. Called from criterion/story diff
  // events and from Task hook payloads that mention story IDs.
  markStoryActivity(unitName: string, storyId: string) {
    let m = this.activityByStory.get(unitName)
    if (!m) { m = new Map(); this.activityByStory.set(unitName, m) }
    m.set(storyId, Date.now())
  }

  snapshot(): ServerSnapshot {
    const decorated = [...this.prds.values()].map(p => this.decorate(p))
    return {
      prds: decorated.sort((a, b) => a.unitName.localeCompare(b.unitName)),
      events: this.events.slice(0, 100),
    }
  }

  private decorate(prd: PRDRecord): PRDRecord {
    const activity = this.activityByStory.get(prd.unitName)
    if (!prd.prd || !activity) return prd
    const now = Date.now()
    const activeStoryIds: string[] = []
    const stories = prd.prd.userStories.map(s => {
      const ts = activity.get(s.id)
      if (!ts) return s
      if (!s.passes && now - ts < ACTIVE_WINDOW_MS) activeStoryIds.push(s.id)
      return { ...s, lastActivityAt: ts }
    })
    return {
      ...prd,
      prd: { ...prd.prd, userStories: stories },
      activeStoryIds,
    }
  }

  recordEvent(evt: AppEvent) {
    this.events.unshift(evt)
    if (this.events.length > this.EVENT_CAP) this.events.length = this.EVENT_CAP
    this.fanout('update', JSON.stringify(evt))
  }

  // Compare prior vs. next PRD record and emit fine-grained events
  // (story.passed, criterion.passed, commit.landed, etc.).
  private diffAndEmit(prior: PRDRecord | undefined, next: PRDRecord) {
    // First observation: skip diffing entirely. Otherwise every pre-existing
    // commit, the first heartbeat read, and every historical watchdog log
    // line would fire as a "new" event timestamped now.
    if (!prior) return
    if (!next.prd) return

    // Story passes
    if (prior?.prd) {
      const priorById = new Map(prior.prd.userStories.map(s => [s.id, s]))
      for (const s of next.prd.userStories) {
        const before = priorById.get(s.id)
        if (before && !before.passes && s.passes) {
          this.markStoryActivity(next.unitName, s.id)
          this.recordEvent({
            ts: Date.now(),
            unitName: next.unitName,
            type: 'story.passed',
            detail: `${s.id}: ${s.title}`,
          })
        }
        // Criterion passes
        const beforeCrit = before?.acceptanceCriteria
        const afterCrit = s.acceptanceCriteria
        if (Array.isArray(beforeCrit) && Array.isArray(afterCrit)) {
          for (let i = 0; i < afterCrit.length; i++) {
            const a = afterCrit[i]
            const b = beforeCrit[i]
            if (typeof a === 'object' && typeof b === 'object' && !b.passes && a.passes) {
              this.markStoryActivity(next.unitName, s.id)
              this.recordEvent({
                ts: Date.now(),
                unitName: next.unitName,
                type: 'criterion.passed',
                detail: `${s.id}: ${a.description}`,
              })
            }
          }
        }
      }
    }

    // New commits
    const priorShas = new Set((prior?.recentCommits ?? []).map(c => c.sha))
    for (const c of next.recentCommits) {
      if (!priorShas.has(c.sha)) {
        this.recordEvent({
          ts: Date.now(),
          unitName: next.unitName,
          type: 'commit.landed',
          detail: `${c.short} ${c.subject}`,
        })
      }
    }

    // Heartbeat newly touched
    if (prior?.heartbeatMtime !== next.heartbeatMtime && next.heartbeatMtime) {
      this.recordEvent({
        ts: Date.now(),
        unitName: next.unitName,
        type: 'heartbeat.touched',
      })
    }

    // Watchdog log new lines containing 'resurrecting'
    const priorLog = new Set(prior?.watchdogLogTail ?? [])
    for (const line of next.watchdogLogTail) {
      if (priorLog.has(line)) continue
      if (line.includes('resurrecting')) {
        this.recordEvent({
          ts: Date.now(),
          unitName: next.unitName,
          type: 'watchdog.resurrect',
          detail: line,
        })
      } else if (line.includes('alive:')) {
        this.recordEvent({
          ts: Date.now(),
          unitName: next.unitName,
          type: 'watchdog.tick',
          detail: line,
        })
      }
    }
  }

  // SSE management
  subscribe(send: Subscriber): number {
    const id = this.nextId++
    this.subscribers.add({ id, send })
    return id
  }

  unsubscribe(id: number) {
    for (const sub of this.subscribers) {
      if (sub.id === id) this.subscribers.delete(sub)
    }
  }

  private fanout(eventName: string, data: string) {
    const payload = `event: ${eventName}\ndata: ${data}\n\n`
    for (const sub of this.subscribers) {
      Promise.resolve(sub.send(payload)).catch(() => this.unsubscribe(sub.id))
    }
  }
}

export const store = new Store()
