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

import { useEffect, useRef, useState } from 'react'
import { Circle, CircleAlert, CircleSlash, CircleOff, ChevronRight, ChevronDown, Plus, Pin } from 'lucide-react'
import type { Project } from '../../server/db/projects'
import type { Effort } from '../../server/db/efforts'
import type { Session } from '../../server/db/sessions'
import { authFetch } from '../auth'
import { ContextMenu, useContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import { NewProjectDialog } from './NewProjectDialog'
import { NewEffortDialog } from './NewEffortDialog'
import { NewSessionDialog } from './NewSessionDialog'
import { ConfirmDeleteProjectDialog } from './ConfirmDeleteProjectDialog'
import { ConfirmDeleteEffortDialog } from './ConfirmDeleteEffortDialog'
import { ConfirmDeleteSessionDialog } from './ConfirmDeleteSessionDialog'

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
  // Called after a new session is created so the parent can navigate to it.
  onSessionCreated?: (projectId: string, effortId: string, sessionId: string) => void
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

async function patchProject(id: string, patch: Record<string, unknown>): Promise<Response> {
  return authFetch(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

async function patchEffort(id: string, patch: Record<string, unknown>): Promise<Response> {
  return authFetch(`/api/efforts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
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
  renamingId: string | null
  onRenameCommit: (id: string, name: string) => void
  onRenameCancel: () => void
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
  renamingId,
  onRenameCommit,
  onRenameCancel,
}: EffortRowProps) {
  const hasLive = sessions.some(
    (s) => computeStatusClient(s, liveSessionIds) === 'live-attached' ||
           computeStatusClient(s, liveSessionIds) === 'live-orphaned',
  )

  const isRenaming = renamingId === effort.id
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

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
          {isRenaming ? (
            <input
              ref={renameInputRef}
              defaultValue={effort.name}
              className="flex-1 text-xs bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-zinc-100 outline-none min-w-0"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const v = (e.target as HTMLInputElement).value.trim()
                  if (v) onRenameCommit(effort.id, v)
                  else onRenameCancel()
                } else if (e.key === 'Escape') {
                  onRenameCancel()
                }
              }}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== effort.name) onRenameCommit(effort.id, v)
                else onRenameCancel()
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
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
          )}
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
  renamingId: string | null
  onRenameCommit: (id: string, name: string) => void
  onRenameCancel: () => void
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
  renamingId,
  onRenameCommit,
  onRenameCancel,
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

  const isRenaming = renamingId === project.id
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

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
          <div className="flex-1 px-2 py-2 min-w-0">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                defaultValue={project.name}
                className="w-full text-sm bg-zinc-800 border border-zinc-600 rounded px-1 py-0.5 text-zinc-100 outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = (e.target as HTMLInputElement).value.trim()
                    if (v) onRenameCommit(project.id, v)
                    else onRenameCancel()
                  } else if (e.key === 'Escape') {
                    onRenameCancel()
                  }
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== project.name) onRenameCommit(project.id, v)
                  else onRenameCancel()
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <button
                onClick={onSelect}
                data-testid={`project-row-${project.id}`}
                className="w-full text-left min-w-0"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`size-2 rounded-full shrink-0 ${dotColor}`}
                    title={hasLiveSession ? 'live' : project.pinned ? 'pinned' : 'dormant'}
                  />
                  <span className="text-sm truncate flex-1">{project.name}</span>
                  {project.pinned && (
                    <Pin className="w-3 h-3 text-sky-400 shrink-0" aria-label="pinned" />
                  )}
                </div>
                <div className="mt-0.5 ml-4 text-[11px] text-zinc-500 tabular-nums">
                  {lastActivity}
                </div>
              </button>
            )}
          </div>
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
              renamingId={renamingId}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
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
  renamingId: string | null
  onRenameCommit: (id: string, name: string) => void
  onRenameCancel: () => void
  /** When true, renders projects with reduced opacity (for Archived section). */
  dimmed?: boolean
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
  renamingId,
  onRenameCommit,
  onRenameCancel,
  dimmed,
}: SectionProps) {
  return (
    <div className={dimmed ? 'opacity-60' : undefined}>
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
              renamingId={renamingId}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
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
  onSessionCreated,
}: SidebarProps) {
  const [activeOpen, setActiveOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(true)
  const [archivedOpen, setArchivedOpen] = useState(false)

  // "+" menu — opens a small popover with "New Project" (future: "New Effort").
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const plusMenuRef = useRef<HTMLDivElement>(null)

  // Close the "+" popover when clicking outside it.
  useEffect(() => {
    if (!plusMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) {
        setPlusMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [plusMenuOpen])

  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)

  // New Effort dialog state — stores { projectId, rootDir } when open, null when closed.
  const [newEffortTarget, setNewEffortTarget] = useState<{
    projectId: string
    rootDir: string
    initialPickedPath?: string
  } | null>(null)

  // New Session dialog state — stores effort info when open, null when closed.
  const [newSessionTarget, setNewSessionTarget] = useState<{
    projectId: string
    effortId: string
    effortName: string
    effortWorkingDir: string | null
  } | null>(null)

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

  // Delete dialog state for project / effort / session
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null)
  const [deleteEffortTarget, setDeleteEffortTarget] = useState<Effort | null>(null)
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<Session | null>(null)

  // Inline rename state — stores the id of the project or effort being renamed
  // (both share the same field since only one item can be renamed at a time).
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const handleRenameCommitProject = async (id: string, name: string) => {
    setRenamingId(null)
    const res = await patchProject(id, { name })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      window.alert(`Rename failed: ${(body as { error?: string }).error ?? `HTTP ${res.status}`}`)
      return
    }
    onRefresh?.()
  }

  const handleRenameCommitEffort = async (id: string, name: string) => {
    setRenamingId(null)
    const res = await patchEffort(id, { name })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      window.alert(`Rename failed: ${(body as { error?: string }).error ?? `HTTP ${res.status}`}`)
      return
    }
    onRefresh?.()
  }

  // Unified rename commit — detects whether the id is a project or effort.
  const handleRenameCommit = async (id: string, name: string) => {
    const isProject = projects.some((p) => p.id === id)
    if (isProject) {
      await handleRenameCommitProject(id, name)
    } else {
      await handleRenameCommitEffort(id, name)
    }
  }

  const handleRenameCancel = () => setRenamingId(null)

  const handleProjectContextMenu = (project: Project, e: React.MouseEvent) => {
    e.preventDefault()
    const items: MenuItem[] = [
      {
        label: 'New Effort',
        onClick: () => {
          setNewEffortTarget({ projectId: project.id, rootDir: project.root_dir })
        },
      },
      {
        label: project.pinned ? 'Unpin' : 'Pin',
        onClick: async () => {
          const res = await patchProject(project.id, { pinned: !project.pinned })
          if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            window.alert(`Pin failed: ${(body as { error?: string }).error ?? `HTTP ${res.status}`}`)
            return
          }
          onRefresh?.()
        },
      },
      {
        label: project.archived ? 'Unarchive' : 'Archive',
        onClick: async () => {
          const res = await patchProject(project.id, { archived: !project.archived })
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string }
            if (body.error === 'project_has_live_sessions') {
              window.alert('Stop the live session first.')
            } else {
              window.alert(`Archive failed: ${body.error ?? `HTTP ${res.status}`}`)
            }
            return
          }
          onRefresh?.()
        },
      },
      {
        label: 'Rename',
        onClick: () => {
          setRenamingId(project.id)
        },
      },
      {
        label: 'Delete',
        destructive: true,
        separator: true,
        onClick: () => {
          setDeleteProjectTarget(project)
        },
      },
    ]
    menu.open(e.clientX, e.clientY, items)
  }

  const handleEffortContextMenu = (effort: Effort, e: React.MouseEvent) => {
    e.preventDefault()
    const items: MenuItem[] = [
      {
        label: 'New Session',
        onClick: () => {
          setNewSessionTarget({
            projectId: effort.project_id,
            effortId: effort.id,
            effortName: effort.name,
            effortWorkingDir: effort.working_dir,
          })
        },
      },
      {
        separator: true,
        label: effort.status === 'archived' ? 'Unarchive' : 'Archive',
        onClick: async () => {
          const res = await patchEffort(effort.id, {
            status: effort.status === 'archived' ? 'active' : 'archived',
          })
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string }
            if (body.error === 'effort_has_live_sessions') {
              window.alert('Stop the live session first.')
            } else {
              window.alert(`Archive failed: ${body.error ?? `HTTP ${res.status}`}`)
            }
            return
          }
          onRefresh?.()
        },
      },
      {
        label: 'Rename',
        onClick: () => {
          setRenamingId(effort.id)
        },
      },
      {
        label: 'Delete',
        destructive: true,
        separator: true,
        onClick: () => {
          setDeleteEffortTarget(effort)
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
      label: 'Delete…',
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
    renamingId,
    onRenameCommit: handleRenameCommit,
    onRenameCancel: handleRenameCancel,
  }

  return (
    <aside
      data-testid="sidebar"
      className="w-64 border-r border-zinc-700/40 overflow-y-auto p-3 space-y-2"
    >
      {/* Sidebar header with "+" menu */}
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[11px] uppercase tracking-widest text-zinc-500 font-semibold">
          Projects
        </span>
        <div className="relative" ref={plusMenuRef}>
          <button
            type="button"
            data-testid="sidebar-plus-button"
            onClick={() => setPlusMenuOpen((o) => !o)}
            className="flex items-center justify-center w-5 h-5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition"
            aria-label="New project"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          {plusMenuOpen && (
            <div className="absolute right-0 top-full mt-1 z-[200] min-w-[140px] bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1">
              <button
                type="button"
                onClick={() => {
                  setPlusMenuOpen(false)
                  setShowNewProjectDialog(true)
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition"
              >
                New Project
              </button>
              {selectedProjectId && (() => {
                const proj = projects.find((p) => p.id === selectedProjectId)
                return proj ? (
                  <button
                    type="button"
                    onClick={() => {
                      setPlusMenuOpen(false)
                      setNewEffortTarget({ projectId: proj.id, rootDir: proj.root_dir })
                    }}
                    className="w-full text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition"
                  >
                    New Effort
                  </button>
                ) : null
              })()}
            </div>
          )}
        </div>
      </div>

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
        dimmed
        {...sharedSectionProps}
      />

      {/* Context menu portal — renders at fixed position over everything */}
      <ContextMenu {...menu.state} onClose={menu.close} />

      {/* Delete-project confirmation dialog */}
      {deleteProjectTarget && (
        <ConfirmDeleteProjectDialog
          project={deleteProjectTarget}
          onClose={() => setDeleteProjectTarget(null)}
          onDeleted={() => {
            setDeleteProjectTarget(null)
            onRefresh?.()
          }}
        />
      )}

      {/* Delete-effort confirmation dialog */}
      {deleteEffortTarget && (
        <ConfirmDeleteEffortDialog
          effort={deleteEffortTarget}
          onClose={() => setDeleteEffortTarget(null)}
          onDeleted={() => {
            setDeleteEffortTarget(null)
            onRefresh?.()
          }}
        />
      )}

      {/* Delete-session confirmation dialog */}
      {deleteSessionTarget && (
        <ConfirmDeleteSessionDialog
          session={deleteSessionTarget}
          onClose={() => setDeleteSessionTarget(null)}
          onDeleted={() => {
            setDeleteSessionTarget(null)
            onRefresh?.()
          }}
        />
      )}

      {/* New Project dialog */}
      <NewProjectDialog
        open={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
        onCreated={() => {
          setShowNewProjectDialog(false)
          onRefresh?.()
        }}
        onAddAsEffort={(projectId, pickedPath) => {
          // Open the New Effort dialog for the matched project, pre-filling prd_path.
          setShowNewProjectDialog(false)
          const proj = projects.find((p) => p.id === projectId)
          if (proj) {
            setNewEffortTarget({
              projectId: proj.id,
              rootDir: proj.root_dir,
              initialPickedPath: pickedPath,
            })
          } else {
            onRefresh?.()
          }
        }}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      />

      {/* New Effort dialog */}
      {newEffortTarget && (
        <NewEffortDialog
          open={true}
          projectId={newEffortTarget.projectId}
          projectRootDir={newEffortTarget.rootDir}
          initialPickedPath={newEffortTarget.initialPickedPath}
          onClose={() => setNewEffortTarget(null)}
          onCreated={() => {
            setNewEffortTarget(null)
            onRefresh?.()
          }}
        />
      )}

      {/* New Session dialog */}
      {newSessionTarget && (
        <NewSessionDialog
          open={true}
          effortId={newSessionTarget.effortId}
          effortName={newSessionTarget.effortName}
          effortWorkingDir={newSessionTarget.effortWorkingDir}
          onClose={() => setNewSessionTarget(null)}
          onCreated={(session) => {
            const { projectId, effortId } = newSessionTarget
            setNewSessionTarget(null)
            onRefresh?.()
            onSessionCreated?.(projectId, effortId, session.id)
          }}
        />
      )}
    </aside>
  )
}
