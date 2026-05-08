import { useCallback, useEffect, useRef, useState } from 'react'
import { authFetch, authEventSource, getToken } from './auth'
import type { Project } from '../server/db'
import type { Session } from '../server/db/sessions'
import type { LifecycleAppEvent } from '../server/types'
import { Sidebar } from './components/Sidebar'
import { ConversationDetail } from './components/ConversationDetail'
import { NewProjectDialog } from './components/NewProjectDialog'
import { NewSessionDialog } from './components/NewSessionDialog'
import { Welcome } from './components/Welcome'
import { ProjectDetail } from './components/ProjectDetail'
import { PrdDetail } from './components/PrdDetail'
import { GitStatusBar } from './components/GitStatusBar'
import { useSelection } from './router'

export function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [sessionsByProject, setSessionsByProject] = useState<Map<string, Session[]>>(new Map())
  const [liveSessionIds, setLiveSessionIds] = useState<Set<string>>(new Set())

  const [recentActivityIds, setRecentActivityIds] = useState<Set<string>>(new Set())
  const activityTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const [selection, setSelection] = useSelection()
  const { projectId, conversationId, prdSpecId } = selection

  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [newSessionTarget, setNewSessionTarget] = useState<Project | null>(null)

  const refreshProjects = useCallback(async () => {
    try {
      const res = await authFetch('/api/projects')
      if (!res.ok) return
      const body = (await res.json()) as { projects: Project[] }
      setProjects(body.projects)
    } catch {}
  }, [])

  const refreshSessions = useCallback(async (projectList: Project[]) => {
    const map = new Map<string, Session[]>()
    await Promise.all(
      projectList.map(async (p) => {
        try {
          const res = await authFetch(
            `/api/projects/${p.id}/sessions?include_archived=false`,
          )
          if (res.ok) {
            const body = (await res.json()) as { sessions: Session[] }
            map.set(p.id, body.sessions)
          } else {
            map.set(p.id, [])
          }
        } catch {
          map.set(p.id, [])
        }
      }),
    )
    setSessionsByProject(map)
  }, [])

  // Initial load.
  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  // Whenever projects change, refresh per-project sessions.
  useEffect(() => {
    void refreshSessions(projects)
  }, [projects, refreshSessions])

  const refreshAll = useCallback(async () => {
    await refreshProjects()
  }, [refreshProjects])

  // Lifecycle SSE — refresh on project / session events; track live + activity.
  useEffect(() => {
    let es: EventSource | null = null
    let cancelled = false

    getToken()
      .then(() => {
        if (cancelled) return
        es = authEventSource('/events')

        es.addEventListener('lifecycle.snapshot', (ev) => {
          try {
            const data = JSON.parse((ev as MessageEvent).data) as {
              projects: Project[]
              live_session_ids: string[]
            }
            setProjects(data.projects)
            setLiveSessionIds(new Set(data.live_session_ids))
          } catch {}
        })

        const handler = (e: MessageEvent) => {
          let evt: LifecycleAppEvent
          try { evt = JSON.parse(e.data) } catch { return }

          if (evt.type === 'session.activity') {
            const id = evt.id
            setRecentActivityIds((prev) => {
              const next = new Set(prev)
              next.add(id)
              return next
            })
            const existing = activityTimers.current.get(id)
            if (existing !== undefined) clearTimeout(existing)
            const timer = setTimeout(() => {
              setRecentActivityIds((prev) => {
                const next = new Set(prev)
                next.delete(id)
                return next
              })
              activityTimers.current.delete(id)
            }, 3000)
            activityTimers.current.set(id, timer)
            return
          }

          if (evt.type === 'session.created' || evt.type === 'session.updated') {
            // Mark/unmark live session id based on process_pid presence.
            const s = evt.session
            setLiveSessionIds((prev) => {
              const next = new Set(prev)
              if (s.process_pid != null) next.add(s.id)
              else next.delete(s.id)
              return next
            })
          }
          if (evt.type === 'session.exited' || evt.type === 'session.deleted') {
            setLiveSessionIds((prev) => {
              const next = new Set(prev)
              next.delete(evt.id)
              return next
            })
          }

          if (
            evt.type.startsWith('session.') ||
            evt.type.startsWith('project.') ||
            evt.type.startsWith('prd_spec.')
          ) {
            void refreshAll()
          }
        }
        es.addEventListener('update', handler as EventListener)
      })
      .catch(() => {})

    return () => {
      cancelled = true
      if (es) es.close()
    }
  }, [refreshAll])

  const selectedProject = projects.find((p) => p.id === projectId) ?? null
  const projectSessions = projectId ? sessionsByProject.get(projectId) ?? [] : []

  return (
    <div className="grid grid-cols-[280px_1fr] h-screen">
      <Sidebar
        projects={projects}
        sessionsByProject={sessionsByProject}
        liveSessionIds={liveSessionIds}
        recentActivityIds={recentActivityIds}
        selectedProjectId={projectId}
        selectedConversationId={conversationId}
        onSelectProject={(id) =>
          setSelection({ projectId: id, conversationId: null, prdSpecId: null })
        }
        onSelectConversation={(pid, cid) =>
          setSelection({ projectId: pid, conversationId: cid, prdSpecId: null })
        }
        onOpenNewProject={() => setNewProjectOpen(true)}
        onOpenNewSession={(pid) => {
          const p = projects.find((x) => x.id === pid)
          if (p) setNewSessionTarget(p)
        }}
        onRefresh={() => void refreshAll()}
      />

      <main className="grid grid-rows-[1fr_auto] overflow-hidden bg-zinc-950">
        <div className="overflow-y-auto min-h-0">
          {conversationId ? (
            <ConversationDetail
              conversationId={conversationId}
              project={selectedProject}
            />
          ) : prdSpecId && selectedProject ? (
            <PrdDetail
              project={selectedProject}
              prdSpecId={prdSpecId}
              onSelectConversation={(cid) =>
                setSelection({ projectId: selectedProject.id, conversationId: cid, prdSpecId: null })
              }
            />
          ) : selectedProject ? (
            <ProjectDetail
              project={selectedProject}
              sessions={projectSessions}
              onSelectConversation={(cid) =>
                setSelection({ projectId: selectedProject.id, conversationId: cid, prdSpecId: null })
              }
              onSelectPrd={(pid) =>
                setSelection({ projectId: selectedProject.id, conversationId: null, prdSpecId: pid })
              }
              onOpenNewSession={() => setNewSessionTarget(selectedProject)}
              onRefresh={() => void refreshAll()}
            />
          ) : (
            <Welcome onNewProject={() => setNewProjectOpen(true)} />
          )}
        </div>
        {selectedProject && <GitStatusBar projectId={selectedProject.id} />}
      </main>

      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={(project) => {
          setNewProjectOpen(false)
          void refreshAll()
          setSelection({ projectId: project.id, conversationId: null, prdSpecId: null })
        }}
      />

      {newSessionTarget && (
        <NewSessionDialog
          open={true}
          project={newSessionTarget}
          onClose={() => setNewSessionTarget(null)}
          onCreated={(session) => {
            const p = newSessionTarget
            setNewSessionTarget(null)
            void refreshAll()
            setSelection({ projectId: p.id, conversationId: session.id, prdSpecId: null })
          }}
        />
      )}
    </div>
  )
}
