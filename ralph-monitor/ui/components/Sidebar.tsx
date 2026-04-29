// Sidebar — lifecycle-bucketed project tree (US-014a).
//
// Three collapsible sections:
//   Active   — pinned projects + projects with a live session + newly-created
//              (created_at < 30d) projects that have never been opened
//   Recent   — all other non-archived projects (last_opened_at within 30d, or
//              old last_opened_at, or never-opened but created >30d ago)
//   Archived — soft-deleted projects, collapsed by default
//
// Bucketing rule interpretation:
//   The AC says "Recent (last_opened_at within 30d AND no live session)".
//   We treat this as the *primary* path into Recent, not as a hard filter.
//   Any non-archived, non-pinned, non-live project that doesn't qualify for
//   Active lands in Recent regardless of the age of last_opened_at.
//   The 30-day threshold only matters for the never-opened boundary: a project
//   that was never opened AND is freshly created (<30d) is promoted to Active.
//   Otherwise it falls into Recent (shown with '—' time).
//
// US-014b additions:
//   Each project node expands to show its efforts (excluding archived ones unless
//   the per-project 'show archived' toggle is on). Each effort expands to show
//   sessions with status icon + title + last-activity timestamp.
//
// US-014c additions:
//   - Right-click context menus on project / effort / session rows.
//   - Selection encoded in URL hash via useSelection() (hoisted to App.tsx).
//   - Auto-expand: when selection changes (e.g. on page load with a deep link),
//     expand the relevant project + effort so the selected node is visible.

import { useEffect, useState } from 'react'
import { Circle, CircleAlert, CircleSlash, CircleOff, ChevronRight, ChevronDown } from 'lucide-react'
import type { Project } from '../../server/db/projects'
import type { Effort } from '../../server/db/efforts'
import type { Session } from '../../server/db/sessions'
import { authFetch } from '../auth'
import { ContextMenu, useContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'

export type SessionStatus = 'dormant' | 'live-attached' | 'live-orphaned' | 'exited'

export interface SidebarProps {
  projects: Project[]
  efforts: Effort[]
  sessions: Session[]
  liveSessionIds: Set<string>
  effortsLiveByProject?: Map<string, boolean>
  selectedProjectId: string | null
  onSelectProject: (id: string) => void
  selectedEffortId: string | null
  onSelectEffort: (id: string) => void
  selectedSessionId: string | null
  onSelectSession: (id: string) => void
  unmanagedPrds?: React.ReactNode
  // Called after a mutation so the parent can re-fetch projects/efforts/sessions.
  onRefresh?: () => void
}

export interface BucketedProjects {
  active: Project[]
  recent: Project[]
  archived: Project[]
}

// Pure bucketing function — exported for unit tests.
//
// Priority order:
//   1. archived → archived bucket regardless of anything else
//   2. pinned || hasLiveSession → active
//   3. never-opened + newly-created (<30d) → active
//   4. everything else → recent
export function bucketProjects(
  projects: Project[],
  liveSessionIds: Set<string>,
  effortsLiveByProject?: Map<string, boolean>,
  now: number = Date.now(),
): BucketedProjects {
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
  const active: Project[] = []
  const recent: Project[] = []
  const archived: Project[] = []

  for (const p of projects) {
    if (p.archived) {
      archived.push(p)
      continue
    }

    const hasLiveSession = effortsLiveByProject?.get(p.id) === true

    if (p.pinned || hasLiveSession) {
      active.push(p)
      continue
    }

    if (!p.last_opened_at) {
      // Never opened — promote to Active only if freshly created
      if (p.created_at && now - p.created_at < THIRTY_DAYS_MS) {
        active.push(p)
      } else {
        recent.push(p)
      }
      continue
    }

    // Has a last_opened_at — all non-archived non-pinned non-live projects
    // land in Recent regardless of how old last_opened_at is.
    recent.push(p)
  }

  return { active, recent, archived }
}

// Group efforts by project_id — exported for unit tests.
export function groupEffortsByProject(efforts: Effort[]): Map<string, Effort[]> {
  const map = new Map<string, Effort[]>()
  for (const e of efforts) {
    const list = map.get(e.project_id) ?? []
    list.push(e)
    map.set(e.project_id, list)
  }
  return map
}

// Group sessions by effort_id — exported for unit tests.
export function groupSessionsByEffort(sessions: Session[]): Map<string, Session[]> {
  const map = new Map<string, Session[]>()
  for (const s of sessions) {
    const list = map.get(s.effort_id) ?? []
    list.push(s)
    map.set(s.effort_id, list)
  }
  return map
}

// Client-side status approximation.
//
// The server's computeSessionStatus uses the PTY registry (in-memory handle with
// `handle.exited` flag) which is not available in the client. The client only has
// liveSessionIds — a set of session IDs that currently have a live, attached PTY
// handle, broadcast via SSE. This means:
//
//   - 'exited' cannot be distinguished from 'dormant' on the client. The exited
//     state is a transient grace window during which the PTY handle is still in
//     the registry but handle.exited === true. From the client's perspective,
//     once a session is no longer in liveSessionIds, we treat it as 'dormant'.
//     The session detail view can show a more nuanced state via a direct API call.
//
//   - 'live-attached' vs 'live-orphaned': if a session ID is in liveSessionIds we
//     know the server has an active PTY handle → 'live-attached'. If it's NOT in
//     liveSessionIds but has a non-null process_pid, the process is orphaned.
export function computeStatusClient(
  session: Session,
  liveSessionIds: Set<string>,
): SessionStatus {
  if (liveSessionIds.has(session.id) && session.process_pid != null) {
    return 'live-attached'
  }
  if (!liveSessionIds.has(session.id) && session.process_pid != null) {
    return 'live-orphaned'
  }
  // process_pid == null (or in liveSessionIds but pid is null, which shouldn't
  // happen in practice) — treat as dormant.
  return 'dormant'
}

// Status icon — maps a SessionStatus to a lucide-react icon.
function StatusIcon({ status }: { status: SessionStatus }) {
  switch (status) {
    case 'live-attached':
      return <Circle fill="currentColor" className="text-green-500 w-3 h-3 shrink-0" />
    case 'live-orphaned':
      return <CircleAlert className="text-yellow-500 w-3 h-3 shrink-0" />
    case 'dormant':
      return <CircleSlash className="text-zinc-400 w-3 h-3 shrink-0" />
    case 'exited':
      return <CircleOff className="text-zinc-300/50 w-3 h-3 shrink-0" />
  }
}

// Small helper — same shape as timeAgo in App.tsx but lives here so Sidebar
// has no cross-file dependency on App internals.
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

// ---------------------------------------------------------------------------
// API mutation helpers
// ---------------------------------------------------------------------------

async function patchProject(id: string, patch: Record<string, unknown>): Promise<void> {
  await authFetch(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

async function deleteProject(id: string, confirmName: string): Promise<void> {
  await authFetch(`/api/projects/${id}?confirm_name=${encodeURIComponent(confirmName)}`, {
    method: 'DELETE',
  })
}

async function patchEffort(id: string, patch: Record<string, unknown>): Promise<void> {
  await authFetch(`/api/efforts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

async function deleteEffort(id: string): Promise<void> {
  await authFetch(`/api/efforts/${id}`, { method: 'DELETE' })
}

async function deleteSession(id: string, purgeJsonl: boolean): Promise<void> {
  await authFetch(`/api/sessions/${id}?purge_jsonl=${purgeJsonl}`, { method: 'DELETE' })
}

// Kill: US-016c will add the actual endpoint. For now we POST to
// /api/sessions/:id/kill and swallow 404/501 silently; a real error will be
// surfaced as a console.error + alert so the user knows something went wrong.
async function killSession(id: string): Promise<void> {
  const r = await authFetch(`/api/sessions/${id}/kill`, { method: 'POST' })
  if (!r.ok && r.status !== 404 && r.status !== 501) {
    const body = await r.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`)
  }
}

// ---------------------------------------------------------------------------
// SessionRow
// ---------------------------------------------------------------------------

interface SessionRowProps {
  session: Session
  selected: boolean
  liveSessionIds: Set<string>
  onSelect: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

function SessionRow({ session, selected, liveSessionIds, onSelect, onContextMenu }: SessionRowProps) {
  const status = computeStatusClient(session, liveSessionIds)
  const lastActivity = session.last_activity_at ? timeAgo(session.last_activity_at) : '—'
  const title = session.title ?? session.id.slice(0, 8)

  return (
    <li>
      <button
        onClick={onSelect}
        onContextMenu={onContextMenu}
        data-testid={`session-row-${session.id}`}
        className={`w-full text-left pl-10 pr-3 py-1.5 rounded transition ${
          selected
            ? 'bg-zinc-700/60 text-zinc-100'
            : 'hover:bg-zinc-800/60 text-zinc-400'
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <StatusIcon status={status} />
          <span className="text-xs truncate flex-1">{title}</span>
          <span className="text-[11px] text-zinc-600 tabular-nums shrink-0">{lastActivity}</span>
        </div>
      </button>
    </li>
  )
}

// ---------------------------------------------------------------------------
// EffortRow
// ---------------------------------------------------------------------------

interface EffortRowProps {
  effort: Effort
  sessions: Session[]
  expanded: boolean
  selected: boolean
  selectedSessionId: string | null
  liveSessionIds: Set<string>
  onToggle: () => void
  onSelect: () => void
  onSelectSession: (id: string) => void
  onContextMenu: (e: React.MouseEvent) => void
  onSessionContextMenu: (session: Session, e: React.MouseEvent) => void
}

function EffortRow({
  effort,
  sessions,
  expanded,
  selected,
  selectedSessionId,
  liveSessionIds,
  onToggle,
  onSelect,
  onSelectSession,
  onContextMenu,
  onSessionContextMenu,
}: EffortRowProps) {
  const hasLive = sessions.some(
    (s) => computeStatusClient(s, liveSessionIds) === 'live-attached' ||
           computeStatusClient(s, liveSessionIds) === 'live-orphaned',
  )

  return (
    <>
      <li>
        <div
          onContextMenu={onContextMenu}
          className={`flex items-center pl-5 pr-3 py-1.5 rounded transition ${
            selected
              ? 'bg-zinc-700/40 text-zinc-200'
              : 'hover:bg-zinc-800/40 text-zinc-400'
          }`}
        >
          <button
            onClick={onToggle}
            className="shrink-0 mr-1 text-zinc-500 hover:text-zinc-300 transition"
            aria-label={expanded ? 'collapse effort' : 'expand effort'}
          >
            {expanded
              ? <ChevronDown className="w-3 h-3" />
              : <ChevronRight className="w-3 h-3" />}
          </button>
          <button
            onClick={onSelect}
            data-testid={`effort-row-${effort.id}`}
            className="flex items-center gap-2 min-w-0 flex-1 text-left"
          >
            <span className={`size-1.5 rounded-full shrink-0 ${
              hasLive ? 'bg-emerald-500' : 'bg-zinc-600'
            }`} />
            <span className="text-xs truncate">{effort.name}</span>
            {effort.status === 'done' && (
              <span className="text-[10px] text-zinc-600 shrink-0">done</span>
            )}
          </button>
        </div>
      </li>
      {expanded && (
        <ul className="space-y-0.5">
          {sessions.length === 0 && (
            <li className="pl-10 pr-3 py-1 text-[11px] text-zinc-600 italic">no sessions</li>
          )}
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              selected={s.id === selectedSessionId}
              liveSessionIds={liveSessionIds}
              onSelect={() => onSelectSession(s.id)}
              onContextMenu={(e) => onSessionContextMenu(s, e)}
            />
          ))}
        </ul>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// ProjectRow
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  project: Project
  efforts: Effort[]
  sessionsByEffort: Map<string, Session[]>
  expanded: boolean
  selected: boolean
  hasLiveSession: boolean
  selectedEffortId: string | null
  selectedSessionId: string | null
  liveSessionIds: Set<string>
  expandedEfforts: Set<string>
  showArchivedEfforts: boolean
  onToggle: () => void
  onSelect: () => void
  onSelectEffort: (id: string) => void
  onSelectSession: (id: string) => void
  onToggleEffort: (id: string) => void
  onToggleShowArchived: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onEffortContextMenu: (effort: Effort, e: React.MouseEvent) => void
  onSessionContextMenu: (session: Session, e: React.MouseEvent) => void
}

function ProjectRow({
  project,
  efforts,
  sessionsByEffort,
  expanded,
  selected,
  hasLiveSession,
  selectedEffortId,
  selectedSessionId,
  liveSessionIds,
  expandedEfforts,
  showArchivedEfforts,
  onToggle,
  onSelect,
  onSelectEffort,
  onSelectSession,
  onToggleEffort,
  onToggleShowArchived,
  onContextMenu,
  onEffortContextMenu,
  onSessionContextMenu,
}: ProjectRowProps) {
  const dotColor = hasLiveSession
    ? 'bg-emerald-500'
    : project.pinned
      ? 'bg-sky-400'
      : 'bg-zinc-600'

  const lastActivity = project.last_opened_at
    ? timeAgo(project.last_opened_at)
    : '—'

  // Filter archived efforts based on the per-project toggle
  const visibleEfforts = showArchivedEfforts
    ? efforts
    : efforts.filter((e) => e.status !== 'archived')

  const archivedCount = efforts.filter((e) => e.status === 'archived').length

  return (
    <>
      <li>
        <div
          onContextMenu={onContextMenu}
          className={`flex items-start rounded transition ${
            selected
              ? 'bg-zinc-700/60 text-zinc-100'
              : 'hover:bg-zinc-800/60 text-zinc-300'
          }`}
        >
          <button
            onClick={onToggle}
            className="shrink-0 mt-2.5 ml-1 mr-0.5 text-zinc-500 hover:text-zinc-300 transition"
            aria-label={expanded ? 'collapse project' : 'expand project'}
          >
            {expanded
              ? <ChevronDown className="w-3 h-3" />
              : <ChevronRight className="w-3 h-3" />}
          </button>
          <button
            onClick={onSelect}
            data-testid={`project-row-${project.id}`}
            className="flex-1 text-left px-2 py-2 min-w-0"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`size-2 rounded-full shrink-0 ${dotColor}`}
                title={hasLiveSession ? 'live' : project.pinned ? 'pinned' : 'dormant'}
              />
              <span className="text-sm truncate flex-1">{project.name}</span>
            </div>
            <div className="mt-0.5 ml-4 text-[11px] text-zinc-500 tabular-nums">
              {lastActivity}
            </div>
          </button>
        </div>
      </li>

      {expanded && (
        <ul className="space-y-0.5">
          {visibleEfforts.length === 0 && archivedCount === 0 && (
            <li className="pl-7 pr-3 py-1 text-[11px] text-zinc-600 italic">no efforts</li>
          )}
          {visibleEfforts.map((e) => (
            <EffortRow
              key={e.id}
              effort={e}
              sessions={sessionsByEffort.get(e.id) ?? []}
              expanded={expandedEfforts.has(e.id)}
              selected={e.id === selectedEffortId}
              selectedSessionId={selectedSessionId}
              liveSessionIds={liveSessionIds}
              onToggle={() => onToggleEffort(e.id)}
              onSelect={() => onSelectEffort(e.id)}
              onSelectSession={onSelectSession}
              onContextMenu={(ev) => onEffortContextMenu(e, ev)}
              onSessionContextMenu={onSessionContextMenu}
            />
          ))}
          {archivedCount > 0 && (
            <li>
              <button
                onClick={onToggleShowArchived}
                className="pl-7 pr-3 py-1 text-[11px] text-zinc-600 hover:text-zinc-400 transition italic"
              >
                {showArchivedEfforts
                  ? `hide ${archivedCount} archived`
                  : `show ${archivedCount} archived`}
              </button>
            </li>
          )}
        </ul>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

interface SectionProps {
  title: string
  projects: Project[]
  open: boolean
  onToggle: () => void
  selectedProjectId: string | null
  onSelectProject: (id: string) => void
  liveSessionIds: Set<string>
  effortsLiveByProject?: Map<string, boolean>
  effortsByProject: Map<string, Effort[]>
  sessionsByEffort: Map<string, Session[]>
  selectedEffortId: string | null
  onSelectEffort: (id: string) => void
  selectedSessionId: string | null
  onSelectSession: (id: string) => void
  // Per-project expansion state — hoisted up to the Section so all projects
  // within a section share the same maps (avoid losing state on re-render).
  expandedProjects: Set<string>
  onToggleProject: (id: string) => void
  expandedEfforts: Set<string>
  onToggleEffort: (id: string) => void
  showArchivedByProject: Set<string>
  onToggleShowArchived: (id: string) => void
  onProjectContextMenu: (project: Project, e: React.MouseEvent) => void
  onEffortContextMenu: (effort: Effort, e: React.MouseEvent) => void
  onSessionContextMenu: (session: Session, e: React.MouseEvent) => void
}

function Section({
  title,
  projects,
  open,
  onToggle,
  selectedProjectId,
  onSelectProject,
  effortsLiveByProject,
  effortsByProject,
  sessionsByEffort,
  selectedEffortId,
  onSelectEffort,
  selectedSessionId,
  onSelectSession,
  liveSessionIds,
  expandedProjects,
  onToggleProject,
  expandedEfforts,
  onToggleEffort,
  showArchivedByProject,
  onToggleShowArchived,
  onProjectContextMenu,
  onEffortContextMenu,
  onSessionContextMenu,
}: SectionProps) {
  return (
    <div>
      <button
        onClick={onToggle}
        data-testid={`sidebar-section-${title.toLowerCase()}`}
        className="w-full flex items-center justify-between px-1 py-1.5 text-[11px] uppercase tracking-widest text-zinc-500 font-semibold hover:text-zinc-300 transition"
      >
        <span>
          {title} ({projects.length})
        </span>
        <span className="text-zinc-600">{open ? '▾' : '▸'}</span>
      </button>
      {open && projects.length > 0 && (
        <ul className="space-y-0.5">
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              efforts={effortsByProject.get(p.id) ?? []}
              sessionsByEffort={sessionsByEffort}
              expanded={expandedProjects.has(p.id)}
              selected={p.id === selectedProjectId}
              hasLiveSession={effortsLiveByProject?.get(p.id) === true}
              selectedEffortId={selectedEffortId}
              selectedSessionId={selectedSessionId}
              liveSessionIds={liveSessionIds}
              expandedEfforts={expandedEfforts}
              showArchivedEfforts={showArchivedByProject.has(p.id)}
              onToggle={() => onToggleProject(p.id)}
              onSelect={() => onSelectProject(p.id)}
              onSelectEffort={onSelectEffort}
              onSelectSession={onSelectSession}
              onToggleEffort={onToggleEffort}
              onToggleShowArchived={() => onToggleShowArchived(p.id)}
              onContextMenu={(e) => onProjectContextMenu(p, e)}
              onEffortContextMenu={onEffortContextMenu}
              onSessionContextMenu={onSessionContextMenu}
            />
          ))}
        </ul>
      )}
      {open && projects.length === 0 && (
        <div className="px-3 py-1.5 text-[11px] text-zinc-600 italic">
          none
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// DeleteSessionDialog
// ---------------------------------------------------------------------------

interface DeleteSessionDialogProps {
  session: Session
  onConfirm: (purgeJsonl: boolean) => void
  onCancel: () => void
}

function DeleteSessionDialog({ session, onConfirm, onCancel }: DeleteSessionDialogProps) {
  const [purge, setPurge] = useState(false)
  const title = session.title ?? session.id.slice(0, 8)

  // ESC cancels
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-[10000] bg-black/60 flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-6 max-w-sm w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100 mb-2">Delete session?</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Session <span className="font-mono text-zinc-200">{title}</span> will be permanently deleted.
        </p>
        <label className="flex items-center gap-2 mb-5 cursor-pointer">
          <input
            type="checkbox"
            checked={purge}
            onChange={(e) => setPurge(e.target.checked)}
            className="accent-rose-500"
          />
          <span className="text-sm text-zinc-300">Also delete JSONL transcript from disk</span>
        </label>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 rounded text-sm text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 transition"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(purge)}
            className="px-4 py-1.5 rounded text-sm bg-rose-700 text-white hover:bg-rose-600 transition"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar({
  projects,
  efforts,
  sessions,
  liveSessionIds,
  effortsLiveByProject,
  selectedProjectId,
  onSelectProject,
  selectedEffortId,
  onSelectEffort,
  selectedSessionId,
  onSelectSession,
  unmanagedPrds,
  onRefresh,
}: SidebarProps) {
  const [activeOpen, setActiveOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(true)
  const [archivedOpen, setArchivedOpen] = useState(false)

  // Per-project expansion state (shared across sections via a single set)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const toggleProject = (id: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Per-effort expansion state
  const [expandedEfforts, setExpandedEfforts] = useState<Set<string>>(new Set())
  const toggleEffort = (id: string) => {
    setExpandedEfforts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Per-project "show archived efforts" toggle
  const [showArchivedByProject, setShowArchivedByProject] = useState<Set<string>>(new Set())
  const toggleShowArchived = (id: string) => {
    setShowArchivedByProject((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ---------------------------------------------------------------------------
  // Auto-expand on selection changes (US-014c)
  //
  // When the URL carries a deep link (e.g. #/p/abc/e/def/s/ghi) we need to
  // expand the relevant project and effort so the selected node is visible.
  //
  // Edge case: if the selected project/effort isn't in the loaded data yet
  // (data hasn't arrived from the server), the expansion is a no-op — neither
  // set will contain the id, and the node won't be visible. Once the data
  // arrives and the component re-renders, this effect re-runs and expands the
  // correct nodes.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (selectedProjectId) {
      setExpandedProjects((prev) => {
        if (prev.has(selectedProjectId)) return prev
        const next = new Set(prev)
        next.add(selectedProjectId)
        return next
      })
    }
    if (selectedEffortId) {
      setExpandedEfforts((prev) => {
        if (prev.has(selectedEffortId)) return prev
        const next = new Set(prev)
        next.add(selectedEffortId)
        return next
      })
    }
  }, [selectedProjectId, selectedEffortId])

  const buckets = bucketProjects(projects, liveSessionIds, effortsLiveByProject)
  const effortsByProject = groupEffortsByProject(efforts)
  const sessionsByEffort = groupSessionsByEffort(sessions)

  // ---------------------------------------------------------------------------
  // Context menu wiring
  // ---------------------------------------------------------------------------

  const menu = useContextMenu()

  // Delete-session dialog state
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<Session | null>(null)

  const handleProjectContextMenu = (project: Project, e: React.MouseEvent) => {
    e.preventDefault()
    const items: MenuItem[] = [
      {
        label: project.pinned ? 'Unpin' : 'Pin',
        onClick: async () => {
          await patchProject(project.id, { pinned: !project.pinned })
          onRefresh?.()
        },
      },
      {
        label: project.archived ? 'Unarchive' : 'Archive',
        onClick: async () => {
          await patchProject(project.id, { archived: !project.archived })
          onRefresh?.()
        },
      },
      {
        label: 'Rename',
        onClick: async () => {
          const name = window.prompt('New project name:', project.name)
          if (!name || name.trim() === '' || name === project.name) return
          await patchProject(project.id, { name: name.trim() })
          onRefresh?.()
        },
      },
      {
        label: 'Delete',
        destructive: true,
        separator: true,
        onClick: async () => {
          const ok = window.confirm(
            `Delete project "${project.name}"?\n\nThis will also delete all efforts and sessions. Type the project name to confirm.`,
          )
          if (!ok) return
          // Typed-name confirmation (full dialog deferred to US-017b; for now
          // we use a second prompt to get the typed name).
          const typed = window.prompt(`Type "${project.name}" to confirm deletion:`)
          if (typed !== project.name) {
            if (typed !== null) window.alert('Name did not match — deletion cancelled.')
            return
          }
          try {
            await deleteProject(project.id, project.name)
            onRefresh?.()
          } catch (err) {
            window.alert(`Delete failed: ${(err as Error)?.message ?? err}`)
          }
        },
      },
    ]
    menu.open(e.clientX, e.clientY, items)
  }

  const handleEffortContextMenu = (effort: Effort, e: React.MouseEvent) => {
    e.preventDefault()
    const items: MenuItem[] = [
      {
        label: effort.status === 'archived' ? 'Unarchive' : 'Archive',
        onClick: async () => {
          await patchEffort(effort.id, {
            status: effort.status === 'archived' ? 'active' : 'archived',
          })
          onRefresh?.()
        },
      },
      {
        label: 'Rename',
        onClick: async () => {
          const name = window.prompt('New effort name:', effort.name)
          if (!name || name.trim() === '' || name === effort.name) return
          await patchEffort(effort.id, { name: name.trim() })
          onRefresh?.()
        },
      },
      {
        label: 'Delete',
        destructive: true,
        separator: true,
        onClick: async () => {
          const ok = window.confirm(`Delete effort "${effort.name}"?\n\nThis will also delete all sessions.`)
          if (!ok) return
          try {
            await deleteEffort(effort.id)
            onRefresh?.()
          } catch (err) {
            window.alert(`Delete failed: ${(err as Error)?.message ?? err}`)
          }
        },
      },
    ]
    menu.open(e.clientX, e.clientY, items)
  }

  const handleSessionContextMenu = (session: Session, e: React.MouseEvent) => {
    e.preventDefault()
    const status = computeStatusClient(session, liveSessionIds)
    const isLive = status === 'live-attached' || status === 'live-orphaned'

    const items: MenuItem[] = []

    if (isLive) {
      items.push({
        label: 'Kill',
        destructive: true,
        onClick: async () => {
          try {
            await killSession(session.id)
            onRefresh?.()
          } catch (err) {
            // US-016c hasn't landed yet — 404 is expected. Log but don't alert.
            console.error('[sidebar] kill session failed:', err)
            window.alert(`Kill failed: ${(err as Error)?.message ?? err}`)
          }
        },
      })
    }

    items.push({
      label: 'Delete',
      destructive: true,
      separator: items.length > 0,
      onClick: () => {
        setDeleteSessionTarget(session)
      },
    })

    menu.open(e.clientX, e.clientY, items)
  }

  const sharedSectionProps = {
    liveSessionIds,
    effortsLiveByProject,
    effortsByProject,
    sessionsByEffort,
    selectedEffortId,
    onSelectEffort,
    selectedSessionId,
    onSelectSession,
    expandedProjects,
    onToggleProject: toggleProject,
    expandedEfforts,
    onToggleEffort: toggleEffort,
    showArchivedByProject,
    onToggleShowArchived: toggleShowArchived,
    onProjectContextMenu: handleProjectContextMenu,
    onEffortContextMenu: handleEffortContextMenu,
    onSessionContextMenu: handleSessionContextMenu,
  }

  return (
    <aside
      data-testid="sidebar"
      className="w-64 border-r border-zinc-700/40 overflow-y-auto p-3 space-y-2"
    >
      {unmanagedPrds}

      <Section
        title="Active"
        projects={buckets.active}
        open={activeOpen}
        onToggle={() => setActiveOpen((o) => !o)}
        selectedProjectId={selectedProjectId}
        onSelectProject={onSelectProject}
        {...sharedSectionProps}
      />

      <Section
        title="Recent"
        projects={buckets.recent}
        open={recentOpen}
        onToggle={() => setRecentOpen((o) => !o)}
        selectedProjectId={selectedProjectId}
        onSelectProject={onSelectProject}
        {...sharedSectionProps}
      />

      <Section
        title="Archived"
        projects={buckets.archived}
        open={archivedOpen}
        onToggle={() => setArchivedOpen((o) => !o)}
        selectedProjectId={selectedProjectId}
        onSelectProject={onSelectProject}
        {...sharedSectionProps}
      />

      {/* Context menu portal — renders at fixed position over everything */}
      <ContextMenu {...menu.state} onClose={menu.close} />

      {/* Delete-session confirmation dialog */}
      {deleteSessionTarget && (
        <DeleteSessionDialog
          session={deleteSessionTarget}
          onConfirm={async (purge) => {
            const target = deleteSessionTarget
            setDeleteSessionTarget(null)
            try {
              await deleteSession(target.id, purge)
              onRefresh?.()
            } catch (err) {
              window.alert(`Delete failed: ${(err as Error)?.message ?? err}`)
            }
          }}
          onCancel={() => setDeleteSessionTarget(null)}
        />
      )}
    </aside>
  )
}
