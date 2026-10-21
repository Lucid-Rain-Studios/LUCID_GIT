import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw } from 'lucide-react'
import { useRepoStore } from '@/stores/repoStore'

/** Retry the same repository reads as the former stale-data banner. */
export function RepositoryRefreshWarning() {
  const repoPath = useRepoStore(s => s.repoPath)
  const error = useRepoStore(s => s.error)
  const isLoading = useRepoStore(s => s.isLoading)
  const refreshStatus = useRepoStore(s => s.refreshStatus)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const showMessage = () => setAnchor(buttonRef.current?.getBoundingClientRect() ?? null)
  useEffect(() => { setAnchor(null) }, [repoPath, error])

  if (!repoPath || !error) return null

  const message = `Repository data may be incomplete or stale: ${error}`
  return (
    <span style={{ display: 'flex' }} onMouseEnter={showMessage} onMouseLeave={() => setAnchor(null)}>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Refresh repository data"
        aria-description={message}
        aria-busy={isLoading}
        disabled={isLoading}
        onFocus={showMessage}
        onBlur={() => setAnchor(null)}
        onKeyDown={event => { if (event.key === 'Escape') setAnchor(null) }}
        onClick={() => { void refreshStatus() }}
        className="lg-toolbar-control lg-icon-control relative flex items-center justify-center hover:bg-lg-bg-hover transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-lg-warning"
        style={{ width: 32, height: 28, padding: 0, border: 0, borderRadius: 5, flexShrink: 0, cursor: isLoading ? 'wait' : 'pointer', color: 'var(--lg-warning)' }}
      >
        <RefreshCw size={14} aria-hidden="true" className={isLoading ? 'animate-spin motion-reduce:animate-none' : undefined} />
        <span aria-hidden="true" style={{
          position: 'absolute', right: 2, top: 1, width: 10, height: 10,
          borderRadius: '50%', background: 'var(--lg-warning)', color: 'var(--lg-bg-primary)',
          fontSize: 8, fontWeight: 800, lineHeight: '10px', textAlign: 'center',
        }}>!</span>
        <span role="status" className="sr-only">{message}</span>
      </button>
      {anchor && createPortal(
        <div role="tooltip" style={{
          position: 'fixed', zIndex: 9999, top: anchor.bottom + 8,
          left: Math.max(12, Math.min(anchor.left, window.innerWidth - 392)),
          width: 'min(380px, calc(100vw - 24px))', boxSizing: 'border-box',
          padding: '10px 12px', borderRadius: 6, border: '1px solid var(--lg-border-strong)',
          background: 'var(--lg-bg-elevated)', color: 'var(--lg-text-primary)',
          fontSize: 12, lineHeight: 1.5, overflowWrap: 'anywhere', pointerEvents: 'none',
          boxShadow: 'var(--lg-shadow-md)',
        }}>
          <div>{message}</div>
          <div style={{ marginTop: 6, color: 'var(--lg-warning)' }}>
            {isLoading ? 'Refreshing repository data…' : 'Click to refresh repository data.'}
          </div>
        </div>, document.body,
      )}
    </span>
  )
}
