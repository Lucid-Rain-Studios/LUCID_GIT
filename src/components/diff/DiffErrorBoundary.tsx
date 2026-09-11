import React from 'react'
import { logUiError } from '@/ipc'

interface Props {
  children: React.ReactNode
  /** Changes when a different diff is shown, which clears a previous failure. */
  resetKey: string
}

interface State {
  error: Error | null
}

/**
 * Keeps a failure inside the diff viewer inside the diff viewer.
 *
 * Monaco throws from its own async teardown — "TextModel got disposed before
 * DiffEditorWidget model got reset" is the one seen in the wild — and an
 * uncaught throw during render takes the entire React tree down with it. The
 * window then paints a stale frame and stops responding to anything, which is
 * indistinguishable from the app having hung; the Update-from-main that
 * finished underneath it was never drawn.
 *
 * Deliberately not `PanelErrorBoundary`: this sits inside a panel that is
 * working fine, so it must fail small and offer a retry, not a full-panel
 * takeover with a Return to Dashboard button.
 */
export class DiffErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    logUiError('renderer.diffCrash', `Diff viewer crashed: ${error.message}`, {
      error,
      componentStack: info.componentStack,
    })
  }

  componentDidUpdate(prevProps: Props) {
    // A different file is being shown, so the previous failure is stale.
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex flex-col items-center justify-center gap-2 h-full px-6 text-center">
        <div className="text-[11px] font-mono text-lg-text-secondary">
          The diff viewer failed to render this file.
        </div>
        <div className="text-[10px] font-mono text-lg-error break-all max-w-md">
          {this.state.error.message}
        </div>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-1 px-2 h-6 rounded text-[10px] font-mono border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent transition-colors"
        >
          Try again
        </button>
      </div>
    )
  }
}
