// Welcome — empty-state page shown when no project is selected.
//
// Props:
//   unmanagedCount  — number of unmanaged PRDs (shown as a hint if > 0)
//   onNewProject    — callback to open the NewProjectDialog

export interface WelcomeProps {
  unmanagedCount: number
  onNewProject: () => void
}

export function Welcome({ unmanagedCount, onNewProject }: WelcomeProps) {
  return (
    <div className="flex items-center justify-center h-full bg-zinc-950">
      <div className="max-w-sm w-full mx-auto text-center space-y-6 p-8">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-zinc-100">Welcome to ralph-monitor</h1>
          <p className="text-sm text-zinc-400">
            Create a new project to get started, or adopt an existing PRD.
          </p>
        </div>

        <button
          type="button"
          onClick={onNewProject}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-600 transition"
        >
          New project
        </button>

        {unmanagedCount > 0 && (
          <p className="text-xs text-zinc-500">
            {unmanagedCount} unmanaged{' '}
            {unmanagedCount === 1 ? 'PRD' : 'PRDs'} detected — see sidebar to adopt.
          </p>
        )}
      </div>
    </div>
  )
}
