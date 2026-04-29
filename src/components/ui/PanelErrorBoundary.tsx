import React from 'react'

interface Props {
  children: React.ReactNode
  tabId: string
  onGoHome: () => void
}

interface State {
  hasError: boolean
  error: Error | null
}

export class PanelErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Panel crash]', error.message, info.componentStack?.slice(0, 300))
  }

  componentDidUpdate(prevProps: Props) {
    // Clear the error when the user navigates to a different tab
    if (prevProps.tabId !== this.props.tabId && this.state.hasError) {
      this.setState({ hasError: false, error: null })
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const msg = this.state.error?.message ?? 'Unknown error'

    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 18,
        background: '#0b0d13', padding: 40,
      }}>
        {/* Icon */}
        <div style={{
          width: 52, height: 52, borderRadius: 14,
          background: 'rgba(232,69,69,0.08)', border: '1px solid rgba(232,69,69,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
            <path d="M11 2L2 19h18L11 2Z" stroke="#e84545" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M11 9v5" stroke="#e84545" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="11" cy="16.5" r="0.8" fill="#e84545" />
          </svg>
        </div>

        {/* Heading */}
        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 14, fontWeight: 600,
            color: '#c4cad8', marginBottom: 6,
          }}>This panel encountered an error</div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
            color: '#e84545', background: 'rgba(232,69,69,0.08)',
            border: '1px solid rgba(232,69,69,0.2)', borderRadius: 5,
            padding: '4px 10px', maxWidth: 480, wordBreak: 'break-all',
          }}>{msg}</div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              height: 32, padding: '0 16px', borderRadius: 6,
              background: 'transparent', border: '1px solid #2f3a54',
              color: '#8b94b0', fontFamily: "'IBM Plex Sans', system-ui",
              fontSize: 12.5, cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#3f4a60'; e.currentTarget.style.color = '#c4cad8' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#2f3a54'; e.currentTarget.style.color = '#8b94b0' }}
          >Try again</button>
          <button
            onClick={this.props.onGoHome}
            style={{
              height: 32, padding: '0 16px', borderRadius: 6,
              background: '#e8622f', border: '1px solid #e8622f',
              color: '#fff', fontFamily: "'IBM Plex Sans', system-ui",
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f0714d' }}
            onMouseLeave={e => { e.currentTarget.style.background = '#e8622f' }}
          >Return to Dashboard</button>
        </div>
      </div>
    )
  }
}
