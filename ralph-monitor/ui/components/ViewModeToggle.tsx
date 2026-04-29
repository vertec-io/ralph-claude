// View-mode toggle (US-011).
//
// Standalone toggle so US-016a (the session detail shell) can drop it next
// to the Chat / Stream views without coupling either of them to layout.
//
// The disabled-stream affordance follows the AC: greyed button with a tooltip
// explaining why Stream is unavailable. Chat remains selectable in every
// status, so this component never disables both buttons at once.

export type ViewMode = 'chat' | 'stream'

export interface ViewModeToggleProps {
  mode: ViewMode
  onChange: (mode: ViewMode) => void
  streamDisabled?: boolean
  streamDisabledTooltip?: string
}

export function ViewModeToggle({
  mode,
  onChange,
  streamDisabled,
  streamDisabledTooltip,
}: ViewModeToggleProps) {
  return (
    <div className="inline-flex rounded border border-gray-300 dark:border-gray-700">
      <button
        onClick={() => onChange('chat')}
        className={`px-3 py-1 text-sm ${mode === 'chat' ? 'bg-blue-100 dark:bg-blue-900/40' : ''}`}
        data-testid="view-mode-chat"
      >
        Chat
      </button>
      <button
        onClick={() => (streamDisabled ? null : onChange('stream'))}
        disabled={streamDisabled}
        title={streamDisabled ? (streamDisabledTooltip ?? 'Stream unavailable') : ''}
        className={`px-3 py-1 text-sm border-l border-gray-300 dark:border-gray-700 ${mode === 'stream' ? 'bg-blue-100 dark:bg-blue-900/40' : ''} ${streamDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        data-testid="view-mode-stream"
      >
        Stream
      </button>
    </div>
  )
}
