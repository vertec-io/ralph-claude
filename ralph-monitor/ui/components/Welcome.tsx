// Welcome — empty-state page shown when no project is selected.

export interface WelcomeProps {
  onNewProject: () => void
}

export function Welcome({ onNewProject }: WelcomeProps) {
  return (
    <div className="flex items-center justify-center h-full bg-zinc-950">
      <div className="max-w-sm w-full mx-auto text-center space-y-6 p-8">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-zinc-100">Welcome to ralph-monitor</h1>
          <p className="text-sm text-zinc-400">
            Open a directory to get started. ralph-monitor auto-discovers Claude conversations
            and PRDs (under <code className="font-mono">./tasks/*/prd.json</code>) for it.
          </p>
        </div>

        <button
          type="button"
          onClick={onNewProject}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-600 transition"
        >
          Open a folder
        </button>
      </div>
    </div>
  )
}
