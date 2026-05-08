// Sidebar — projects + per-project conversation list (Recents / Pinned / More).
//
// Layout:
//
//   [+ New project]                                  ← top action
//
//   ── PROJECTS ──
//   ▾ project-name                                  ← expandable
//       ▸ Recents (5)                               ← default-expanded
//           ● live-pulse  conversation-title
//             …
//       ▸ Pinned (n)                                ← when n > 0
//       [ See more (k) ]                            ← when total > 5
//   ▸ another-project
//
// Selection drives `#/p/:pid/c/:cid`. Clicking a project header selects the
// project (no conversation). Clicking a conversation row sets both.

import { useEffect, useState } from 'react'
import { ChevronRight, ChevronDown, Plus, Pin, PinOff, Pencil, MoreHorizontal, Archive } from 'lucide-react'
import type { Project } from '../../server/db/projects'
import type { Session } from '../../server/db/sessions'
import { authFetch } from '../auth'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu'

export interface SidebarProps {
  projects: Project[]
  sessionsByProject: Map<string, Session[]>
  /** Session IDs in the registry's live-attached set. */
  liveSessionIds: Set<string>
  /** Session IDs with recent live transcript activity. Pulses for ~3s. */
  recentActivityIds: Set<string>
  selectedProjectId: string | null
  selectedConversationId: string | null
  onSelectProject: (projectId: string) => void
  onSelectConversation: (projectId: string, conversationId: string) => void
  onOpenNewProject: () => void
  onOpenNewSession: (projectId: string) => void
  onRefresh: () => void
}

const RECENT_COUNT = 5

export function Sidebar({
  projects,
  sessionsByProject,
  liveSessionIds,
  recentActivityIds,
  selectedProjectId,
  selectedConversationId,
  onSelectProject,
  onSelectConversation,
  onOpenNewProject,
  onOpenNewSession,
  onRefresh,
}: SidebarProps) {
  // Per-project expansion state. Auto-expand the selected project.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const s = new Set<string>()
    if (selectedProjectId) s.add(selectedProjectId)
    return s
  })
  const [showAll, setShowAll] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (selectedProjectId) {
      setExpanded((prev) => {
        if (prev.has(selectedProjectId)) return prev
        const next = new Set(prev)
        next.add(selectedProjectId)
        return next
      })
    }
  }, [selectedProjectId])

  const toggleProject = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleShowAll = (id: string) => {
    setShowAll((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <aside className="border-r border-zinc-800 bg-zinc-950 overflow-y-auto flex flex-col">
      <div className="p-3 border-b border-zinc-800">
        <button
          type="button"
          onClick={onOpenNewProject}
          className="w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded bg-emerald-700 text-white hover:bg-emerald-600 transition"
        >
          <Plus className="w-3.5 h-3.5" />
          New project
        </button>
      </div>

      <div className="px-2 py-2 text-[11px] uppercase tracking-wide text-zinc-500">
        Projects
      </div>

      <nav className="flex-1">
        {projects.length === 0 && (
          <div className="px-3 py-4 text-xs text-zinc-600 italic">
            No projects yet — open a folder to start.
          </div>
        )}
        {projects.map((p) => (
          <ProjectRow
            key={p.id}
            project={p}
            sessions={sessionsByProject.get(p.id) ?? []}
            liveSessionIds={liveSessionIds}
            recentActivityIds={recentActivityIds}
            isExpanded={expanded.has(p.id)}
            isSelected={p.id === selectedProjectId}
            selectedConversationId={selectedConversationId}
            showAll={showAll.has(p.id)}
            onToggleExpand={() => toggleProject(p.id)}
            onToggleShowAll={() => toggleShowAll(p.id)}
            onSelectProject={() => onSelectProject(p.id)}
            onSelectConversation={(cid) => onSelectConversation(p.id, cid)}
            onOpenNewSession={() => onOpenNewSession(p.id)}
            onRefresh={onRefresh}
          />
        ))}
      </nav>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Project row
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  project: Project
  sessions: Session[]
  liveSessionIds: Set<string>
  recentActivityIds: Set<string>
  isExpanded: boolean
  isSelected: boolean
  selectedConversationId: string | null
  showAll: boolean
  onToggleExpand: () => void
  onToggleShowAll: () => void
  onSelectProject: () => void
  onSelectConversation: (cid: string) => void
  onOpenNewSession: () => void
  onRefresh: () => void
}

function ProjectRow({
  project,
  sessions,
  liveSessionIds,
  recentActivityIds,
  isExpanded,
  isSelected,
  selectedConversationId,
  showAll,
  onToggleExpand,
  onToggleShowAll,
  onSelectProject,
  onSelectConversation,
  onOpenNewSession,
  onRefresh,
}: ProjectRowProps) {
  const ctx = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(project.name)

  const pinned = sessions.filter((s) => s.pinned)
  const unpinned = sessions.filter((s) => !s.pinned)
  const sortByRecency = (a: Session, b: Session) =>
    (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0) ||
    b.created_at - a.created_at
  pinned.sort(sortByRecency)
  unpinned.sort(sortByRecency)

  const recents = unpinned.slice(0, showAll ? unpinned.length : RECENT_COUNT)
  const moreCount = unpinned.length - recents.length

  const projectMenuItems: MenuItem[] = [
    {
      label: 'Rename project',
      onClick: () => {
        setDraftName(project.name)
        setRenaming(true)
      },
    },
    { label: 'New session', onClick: onOpenNewSession },
    {
      label: project.pinned ? 'Unpin project' : 'Pin project',
      onClick: () => void togglePinProject(project, onRefresh),
    },
    {
      label: 'Rescan disk + tasks',
      onClick: () => void rescanProject(project.id, onRefresh),
    },
    {
      label: project.archived ? 'Unarchive' : 'Archive',
      onClick: () => void archiveProject(project, onRefresh),
      separator: true,
    },
  ]

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    ctx.open(e.clientX, e.clientY, projectMenuItems)
  }

  return (
    <div className="group">
      <div
        className={`flex items-center gap-1 px-2 py-1.5 text-sm cursor-pointer hover:bg-zinc-900 ${
          isSelected ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-300'
        }`}
        onClick={() => {
          onToggleExpand()
          onSelectProject()
        }}
        onContextMenu={onContextMenu}
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
          className="text-zinc-500 hover:text-zinc-300 transition shrink-0"
        >
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        {project.pinned && <Pin className="w-3 h-3 text-amber-500 shrink-0" />}
        {renaming ? (
          <input
            autoFocus
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void renameProject(project.id, draftName.trim(), onRefresh)
                setRenaming(false)
              } else if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={() => {
              if (draftName.trim() && draftName.trim() !== project.name) {
                void renameProject(project.id, draftName.trim(), onRefresh)
              }
              setRenaming(false)
            }}
            className="flex-1 min-w-0 bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-sm text-zinc-100 outline-none"
          />
        ) : (
          <span className="flex-1 min-w-0 truncate font-medium">{project.name}</span>
        )}
        <button
          type="button"
          title="New session"
          onClick={(e) => { e.stopPropagation(); onOpenNewSession() }}
          className="opacity-0 group-hover:opacity-100 transition text-zinc-500 hover:text-zinc-200 shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {isExpanded && (
        <div className="ml-5 border-l border-zinc-800/60">
          {pinned.length > 0 && (
            <>
              <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-zinc-600">
                Pinned
              </div>
              {pinned.map((s) => (
                <ConversationRow
                  key={s.id}
                  session={s}
                  isLive={liveSessionIds.has(s.id)}
                  isActive={recentActivityIds.has(s.id)}
                  isSelected={s.id === selectedConversationId}
                  onSelect={() => onSelectConversation(s.id)}
                  onRefresh={onRefresh}
                />
              ))}
            </>
          )}

          {recents.length > 0 && (
            <>
              {pinned.length > 0 && (
                <div className="px-2 pt-2 pb-1 text-[10px] uppercase tracking-wide text-zinc-600">
                  Recents
                </div>
              )}
              {recents.map((s) => (
                <ConversationRow
                  key={s.id}
                  session={s}
                  isLive={liveSessionIds.has(s.id)}
                  isActive={recentActivityIds.has(s.id)}
                  isSelected={s.id === selectedConversationId}
                  onSelect={() => onSelectConversation(s.id)}
                  onRefresh={onRefresh}
                />
              ))}
            </>
          )}

          {moreCount > 0 && !showAll && (
            <button
              type="button"
              onClick={onToggleShowAll}
              className="w-full text-left px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition flex items-center gap-1"
            >
              <MoreHorizontal className="w-3 h-3" />
              See {moreCount} more
            </button>
          )}
          {showAll && unpinned.length > RECENT_COUNT && (
            <button
              type="button"
              onClick={onToggleShowAll}
              className="w-full text-left px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition"
            >
              Collapse
            </button>
          )}

          {pinned.length === 0 && recents.length === 0 && (
            <div className="px-2 py-2 text-[11px] text-zinc-600 italic">
              No conversations yet.
            </div>
          )}
        </div>
      )}

      <ContextMenu {...ctx.state} onClose={ctx.close} items={projectMenuItems} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Conversation row
// ---------------------------------------------------------------------------

interface ConversationRowProps {
  session: Session
  isLive: boolean
  isActive: boolean
  isSelected: boolean
  onSelect: () => void
  onRefresh: () => void
}

function ConversationRow({
  session,
  isLive,
  isActive,
  isSelected,
  onSelect,
  onRefresh,
}: ConversationRowProps) {
  const ctx = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(session.title ?? '')

  const display = session.title ?? session.id.slice(0, 8)

  const items: MenuItem[] = [
    { label: 'Rename', onClick: () => { setDraft(session.title ?? ''); setRenaming(true) } },
    {
      label: session.pinned ? 'Unpin' : 'Pin',
      onClick: () => void toggleSessionPin(session, onRefresh),
    },
    {
      label: session.archived ? 'Unarchive' : 'Archive',
      onClick: () => void toggleSessionArchive(session, onRefresh),
    },
  ]

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    ctx.open(e.clientX, e.clientY, items)
  }

  return (
    <div
      className={`flex items-center gap-2 pl-2 pr-2 py-1 text-[13px] cursor-pointer hover:bg-zinc-900 group ${
        isSelected ? 'bg-zinc-800/70 text-zinc-100' : 'text-zinc-400'
      }`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <span className="shrink-0 w-2 h-2 flex items-center justify-center">
        {isActive ? (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        ) : isLive ? (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
        ) : (
          <span className="w-1 h-1 rounded-full bg-zinc-700" />
        )}
      </span>
      {session.pinned && <Pin className="w-2.5 h-2.5 text-amber-500/70 shrink-0" />}
      {renaming ? (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void renameSession(session.id, draft.trim(), onRefresh)
              setRenaming(false)
            } else if (e.key === 'Escape') setRenaming(false)
          }}
          onBlur={() => {
            if (draft.trim() && draft.trim() !== session.title) {
              void renameSession(session.id, draft.trim(), onRefresh)
            }
            setRenaming(false)
          }}
          className="flex-1 min-w-0 bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-[12px] text-zinc-100 outline-none"
        />
      ) : (
        <span className="flex-1 min-w-0 truncate" title={display}>{display}</span>
      )}
      <ContextMenu {...ctx.state} onClose={ctx.close} items={items} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mutators (local helpers)
// ---------------------------------------------------------------------------

async function renameProject(id: string, name: string, onRefresh: () => void) {
  if (!name) return
  await authFetch(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  onRefresh()
}

async function togglePinProject(p: Project, onRefresh: () => void) {
  await authFetch(`/api/projects/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: !p.pinned }),
  })
  onRefresh()
}

async function archiveProject(p: Project, onRefresh: () => void) {
  await authFetch(`/api/projects/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: !p.archived }),
  })
  onRefresh()
}

async function rescanProject(id: string, onRefresh: () => void) {
  await authFetch(`/api/projects/${id}/scan`, { method: 'POST' })
  onRefresh()
}

async function renameSession(id: string, title: string, onRefresh: () => void) {
  await authFetch(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  onRefresh()
}

async function toggleSessionPin(s: Session, onRefresh: () => void) {
  await authFetch(`/api/sessions/${s.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: !s.pinned }),
  })
  onRefresh()
}

async function toggleSessionArchive(s: Session, onRefresh: () => void) {
  await authFetch(`/api/sessions/${s.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archived: !s.archived }),
  })
  onRefresh()
}
