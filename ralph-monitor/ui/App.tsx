import { useCallback, useEffect, useRef, useState } from 'react'
import { authFetch, authEventSource, getToken } from './auth'
import type { UnmanagedPRDItem } from '../server/routes/unmanaged'
import type { Project } from '../server/db'
import type { Effort } from '../server/db/efforts'
import type { Session } from '../server/db/sessions'
import { AdoptPrdDialog } from './components/AdoptPrdDialog'
import { Sidebar } from './components/Sidebar'
import { SessionDetail } from './components/SessionDetail'
import { NewProjectDialog } from './components/NewProjectDialog'
import { NewEffortDialog } from './components/NewEffortDialog'
import { NewSessionDialog } from './components/NewSessionDialog'
import { Welcome } from './components/Welcome'
import { ProjectDetail } from './components/ProjectDetail'
import { EffortDetail } from './components/EffortDetail'
import { useSelection } from './router'

// ---------------------------------------------------------------------------
// Hook: fetch /api/unmanaged-prds + /api/projects on demand.
// ---------------------------------------------------------------------------
function useUnmanagedPrds(triggerVersion: number): {
  unmanaged: UnmanagedPRDItem[]
  projects: Project[]
  refresh: () => void
} {
  const [unmanaged, setUnmanaged] = useState<UnmanagedPRDItem[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const versionRef = useRef(triggerVersion)
  versionRef.current = triggerVersion

  const fetch_ = useCallback(() => {
    authFetch('/api/unmanaged-prds')
      .then((r) => r.json())
      .then((body: any) => { if (Array.isArray(body?.unmanaged)) setUnmanaged(body.unmanaged) })
      .catch(() => {})
    authFetch('/api/projects')
      .then((r) => r.json())
      .then((body: any) => { if (Array.isArray(body?.projects)) setProjects(body.projects) })
      .catch(() => {})
  }, [])

  // Re-fetch whenever the trigger version increments (SSE event) or on mount.
  useEffect(() => { fetch_() }, [fetch_, triggerVersion])

  return { unmanaged, projects, refresh: fetch_ }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const [unmanagedVersion, setUnmanagedVersion] = useState(0)
  const bumpUnmanaged = useCallback(() => setUnmanagedVersion((v) => v + 1), [])

  const { unmanaged, projects, refresh: refreshUnmanaged } = useUnmanagedPrds(unmanagedVersion)

  const [efforts, setEfforts] = useState<Effort[]>([])
  const [sessions, setSessions] = useState<Session[]>([])

  const [selection, setSelection] = useSelection()
  const { projectId, effortId, sessionId } = selection

  const [adoptItem, setAdoptItem] = useState<UnmanagedPRDItem | null>(null)

  // ---------------------------------------------------------------------------
  // Dialog state — hoisted here so both Sidebar and main-content buttons
  // can open the same modals.
  // ---------------------------------------------------------------------------
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [newEffortTarget, setNewEffortTarget] = useState<{
    projectId: string
    rootDir: string
    initialPickedPath?: string
  } | null>(null)
  const [newSessionTarget, setNewSessionTarget] = useState<{
    projectId: string
    effortId: string
    effortName: string
    effortWorkingDir: string | null
  } | null>(null)

  // ---------------------------------------------------------------------------
  // Fan out from projects to load all efforts + sessions.
  // ---------------------------------------------------------------------------
  const refreshEffortsAndSessions = useCallback(async () => {
    if (projects.length === 0) {
      setEfforts([])
      setSessions([])
      return
    }
    const effortBatches = await Promise.all(
      projects.map((p) =>
        authFetch(`/api/projects/${p.id}/efforts`)
          .then((r) => (r.ok ? r.json() : { efforts: [] }))
          .catch(() => ({ efforts: [] })),
      ),
    )
    const allEfforts: Effort[] = effortBatches.flatMap((b: any) =>
      Array.isArray(b?.efforts) ? (b.efforts as Effort[]) : [],
    )
    setEfforts(allEfforts)

    const sessionBatches = await Promise.all(
      allEfforts.map((e) =>
        authFetch(`/api/efforts/${e.id}/sessions`)
          .then((r) => (r.ok ? r.json() : { sessions: [] }))
          .catch(() => ({ sessions: [] })),
      ),
    )
    const allSessions: Session[] = sessionBatches.flatMap((b: any) =>
      Array.isArray(b?.sessions) ? (b.sessions as Session[]) : [],
    )
    setSessions(allSessions)
  }, [projects])

  useEffect(() => { void refreshEffortsAndSessions() }, [refreshEffortsAndSessions])

  // ---------------------------------------------------------------------------
  // Thin SSE subscription — replaces the old useServerStream for App's needs.
  // SessionDetail has its own SSE subscription; leave it alone.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Wait for the token to be loaded before opening the EventSource.
    let es: EventSource | null = null
    let cancelled = false

    getToken()
      .then(() => {
        if (cancelled) return
        es = authEventSource('/events')
        const handler = (e: MessageEvent) => {
          try {
            const evt = JSON.parse(e.data)
            const t = evt.type
            if (
              t?.startsWith('effort.') ||
              t?.startsWith('session.') ||
              t?.startsWith('project.')
            ) {
              void refreshEffortsAndSessions()
              if (t === 'effort.created' || t === 'effort.deleted') bumpUnmanaged()
            }
          } catch {}
        }
        es.addEventListener('update', handler as EventListener)
      })
      .catch(() => {})

    return () => {
      cancelled = true
      if (es) {
        es.close()
      }
    }
  }, [refreshEffortsAndSessions, bumpUnmanaged])

  // ---------------------------------------------------------------------------
  // Derived selection state
  // ---------------------------------------------------------------------------
  const selectedProject = projects.find((p) => p.id === projectId) ?? null
  const selectedEffort = efforts.find((e) => e.id === effortId) ?? null

  const projectEfforts = selectedProject
    ? efforts.filter((e) => e.project_id === selectedProject.id)
    : []
  const effortSessions = selectedEffort
    ? sessions.filter((s) => s.effort_id === selectedEffort.id)
    : []

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="grid grid-cols-[280px_1fr] h-screen">
      <Sidebar
        projects={projects}
        efforts={efforts}
        sessions={sessions}
        liveSessionIds={new Set<string>()}
        selectedProjectId={projectId}
        onSelectProject={(id) => setSelection({ projectId: id, effortId: null, sessionId: null })}
        selectedEffortId={effortId}
        onSelectEffort={(id) => {
          const e = efforts.find((x) => x.id === id)
          setSelection({ projectId: e?.project_id ?? projectId, effortId: id, sessionId: null })
        }}
        selectedSessionId={sessionId}
        onSelectSession={(id) => {
          const s = sessions.find((x) => x.id === id)
          const e = s ? efforts.find((x) => x.id === s.effort_id) : null
          setSelection({
            projectId: e?.project_id ?? projectId,
            effortId: e?.id ?? effortId,
            sessionId: id,
          })
        }}
        unmanaged={unmanaged}
        onAdopt={setAdoptItem}
        onRefresh={() => { refreshUnmanaged(); void refreshEffortsAndSessions() }}
        onSessionCreated={(pId, eId, sId) =>
          setSelection({ projectId: pId, effortId: eId, sessionId: sId })
        }
        onOpenNewProject={() => setNewProjectOpen(true)}
        onOpenNewEffort={(target) => setNewEffortTarget(target)}
        onOpenNewSession={(target) => setNewSessionTarget(target)}
      />

      <main className="overflow-y-auto bg-zinc-950">
        {sessionId ? (
          <SessionDetail
            sessionId={sessionId}
            project={selectedProject}
            effort={selectedEffort}
          />
        ) : effortId && selectedEffort ? (
          <EffortDetail
            project={selectedProject}
            effort={selectedEffort}
            sessions={effortSessions}
            onSelectSession={(id) =>
              setSelection({ projectId, effortId, sessionId: id })
            }
            onNewSession={() => {
              if (selectedEffort) {
                setNewSessionTarget({
                  projectId: selectedEffort.project_id,
                  effortId: selectedEffort.id,
                  effortName: selectedEffort.name,
                  effortWorkingDir: selectedEffort.working_dir,
                })
              }
            }}
          />
        ) : projectId && selectedProject ? (
          <ProjectDetail
            project={selectedProject}
            efforts={projectEfforts}
            sessions={sessions}
            onSelectEffort={(id) =>
              setSelection({ projectId: selectedProject.id, effortId: id, sessionId: null })
            }
            onNewEffort={() => {
              if (selectedProject) {
                setNewEffortTarget({
                  projectId: selectedProject.id,
                  rootDir: selectedProject.root_dir,
                })
              }
            }}
          />
        ) : (
          <Welcome
            unmanagedCount={unmanaged.length}
            onNewProject={() => setNewProjectOpen(true)}
          />
        )}
      </main>

      {/* Adopt PRD dialog */}
      {adoptItem && (
        <AdoptPrdDialog
          item={adoptItem}
          projects={projects}
          onClose={() => setAdoptItem(null)}
          onAdopted={() => {
            setAdoptItem(null)
            refreshUnmanaged()
          }}
        />
      )}

      {/* New Project dialog */}
      <NewProjectDialog
        open={newProjectOpen}
        onClose={() => setNewProjectOpen(false)}
        onCreated={() => {
          setNewProjectOpen(false)
          refreshUnmanaged()
        }}
        onAddAsEffort={(pId, pickedPath) => {
          setNewProjectOpen(false)
          const proj = projects.find((p) => p.id === pId)
          if (proj) {
            setNewEffortTarget({
              projectId: proj.id,
              rootDir: proj.root_dir,
              initialPickedPath: pickedPath,
            })
          } else {
            refreshUnmanaged()
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
            void refreshEffortsAndSessions()
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
            const { projectId: pId, effortId: eId } = newSessionTarget
            setNewSessionTarget(null)
            void refreshEffortsAndSessions()
            setSelection({ projectId: pId, effortId: eId, sessionId: session.id })
          }}
        />
      )}
    </div>
  )
}
