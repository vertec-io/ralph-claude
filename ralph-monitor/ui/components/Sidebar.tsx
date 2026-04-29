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

import { useState } from 'react'
import type { Project } from '../../server/db/projects'

export interface SidebarProps {
  projects: Project[]
  liveSessionIds: Set<string>
  effortsLiveByProject?: Map<string, boolean>
  selectedProjectId: string | null
  onSelectProject: (id: string) => void
  unmanagedPrds?: React.ReactNode
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
// ProjectRow
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  project: Project
  selected: boolean
  hasLiveSession: boolean
  onSelect: () => void
}

function ProjectRow({ project, selected, hasLiveSession, onSelect }: ProjectRowProps) {
  const dotColor = hasLiveSession
    ? 'bg-emerald-500'
    : project.pinned
      ? 'bg-sky-400'
      : 'bg-zinc-600'

  const lastActivity = project.last_opened_at
    ? timeAgo(project.last_opened_at)
    : '—'

  return (
    <li>
      <button
        onClick={onSelect}
        data-testid={`project-row-${project.id}`}
        className={`w-full text-left px-3 py-2 rounded transition ${
          selected
            ? 'bg-zinc-700/60 text-zinc-100'
            : 'hover:bg-zinc-800/60 text-zinc-300'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`size-2 rounded-full shrink-0 ${dotColor}`} title={hasLiveSession ? 'live' : project.pinned ? 'pinned' : 'dormant'} />
          <span className="text-sm truncate flex-1">{project.name}</span>
        </div>
        <div className="mt-0.5 ml-4 text-[11px] text-zinc-500 tabular-nums">
          {lastActivity}
        </div>
      </button>
    </li>
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
  selectedId: string | null
  onSelectProject: (id: string) => void
  liveSessionIds: Set<string>
  effortsLiveByProject?: Map<string, boolean>
}

function Section({
  title,
  projects,
  open,
  onToggle,
  selectedId,
  onSelectProject,
  effortsLiveByProject,
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
              selected={p.id === selectedId}
              hasLiveSession={effortsLiveByProject?.get(p.id) === true}
              onSelect={() => onSelectProject(p.id)}
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
  liveSessionIds,
  effortsLiveByProject,
  selectedProjectId,
  onSelectProject,
  unmanagedPrds,
}: SidebarProps) {
  const [activeOpen, setActiveOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(true)
  const [archivedOpen, setArchivedOpen] = useState(false)

  const buckets = bucketProjects(projects, liveSessionIds, effortsLiveByProject)

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
        selectedId={selectedProjectId}
        onSelectProject={onSelectProject}
        liveSessionIds={liveSessionIds}
        effortsLiveByProject={effortsLiveByProject}
      />

      <Section
        title="Recent"
        projects={buckets.recent}
        open={recentOpen}
        onToggle={() => setRecentOpen((o) => !o)}
        selectedId={selectedProjectId}
        onSelectProject={onSelectProject}
        liveSessionIds={liveSessionIds}
        effortsLiveByProject={effortsLiveByProject}
      />

      <Section
        title="Archived"
        projects={buckets.archived}
        open={archivedOpen}
        onToggle={() => setArchivedOpen((o) => !o)}
        selectedId={selectedProjectId}
        onSelectProject={onSelectProject}
        liveSessionIds={liveSessionIds}
        effortsLiveByProject={effortsLiveByProject}
      />
    </aside>
  )
}
