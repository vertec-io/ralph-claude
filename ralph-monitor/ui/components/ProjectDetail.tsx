// ProjectDetail — shown when a project is selected but no effort is selected.
//
// Layout:
//   - Header: project name + root_dir
//   - Toolbar: "+ New effort" button
//   - List of efforts with name, status badge, session count, click to navigate
//   - Empty state if no efforts

import type { Project } from '../../server/db/projects'
import type { Effort } from '../../server/db/efforts'
import type { Session } from '../../server/db/sessions'
import { DiskConversations } from './DiskConversations'

export interface ProjectDetailProps {
  project: Project
  efforts: Effort[]
  sessions: Session[]
  onSelectEffort: (id: string) => void
  onNewEffort: () => void
  onRefresh?: () => void
}

function StatusBadge({ status }: { status: Effort['status'] }) {
  const map: Record<string, string> = {
    active: 'bg-emerald-900/60 text-emerald-300',
    done: 'bg-sky-900/60 text-sky-300',
    archived: 'bg-zinc-800 text-zinc-500',
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${map[status] ?? 'bg-zinc-800 text-zinc-500'}`}>
      {status}
    </span>
  )
}

export function ProjectDetail({ project, efforts, sessions, onSelectEffort, onNewEffort, onRefresh }: ProjectDetailProps) {
  const visibleEfforts = efforts.filter((e) => e.status !== 'archived')

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Header */}
      <header className="px-6 py-4 border-b border-zinc-800 shrink-0">
        <h2 className="text-base font-semibold text-zinc-100 truncate">{project.name}</h2>
        <div className="mt-0.5 text-[11px] text-zinc-500 font-mono truncate">{project.root_dir}</div>
      </header>

      {/* Toolbar */}
      <div className="px-6 py-3 border-b border-zinc-800 shrink-0 flex items-center gap-3">
        <button
          type="button"
          onClick={onNewEffort}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-700 text-white text-xs font-medium hover:bg-emerald-600 transition"
        >
          + New effort
        </button>
      </div>

      {/* Effort list + disk conversations */}
      <div className="flex-1 overflow-y-auto">
        {visibleEfforts.length === 0 ? (
          <div className="px-6 py-10 text-sm text-zinc-500 text-center">
            No efforts yet. Click <span className="text-zinc-300 font-medium">+ New effort</span> to create one,
            or right-click a project in the sidebar to adopt an existing PRD.
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {visibleEfforts.map((effort) => {
              const sessionCount = sessions.filter((s) => s.effort_id === effort.id).length
              return (
                <li key={effort.id}>
                  <button
                    type="button"
                    onClick={() => onSelectEffort(effort.id)}
                    className="w-full text-left px-6 py-3.5 hover:bg-zinc-900/60 transition group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-zinc-200 truncate flex-1 group-hover:text-zinc-100">
                        {effort.name}
                      </span>
                      <StatusBadge status={effort.status} />
                    </div>
                    <div className="mt-1 flex items-center gap-3">
                      {effort.working_dir && (
                        <span className="text-[11px] text-zinc-500 font-mono truncate flex-1">
                          {effort.working_dir}
                        </span>
                      )}
                      <span className="text-[11px] text-zinc-600 shrink-0">
                        {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
                      </span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {/* Disk conversation discovery */}
        <DiskConversations
          projectId={project.id}
          efforts={efforts}
          onAdopted={() => onRefresh?.()}
        />
      </div>
    </div>
  )
}
