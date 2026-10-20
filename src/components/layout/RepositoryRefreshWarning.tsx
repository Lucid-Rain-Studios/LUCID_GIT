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
        className="relative flex items-center justify-center rounded hover:bg-lg-bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-lg-warning disabled:cursor-wait"
        style={{ width: 30, height: 30, flexShrink: 0, color: 'var(--lg-warning)' }}
      >
        <RefreshCw size={18} aria-hidden="true" className={isLoading ? 'animate-spin motion-reduce:animate-none' : undefined} />
        <span aria-hidden="true" style={{
          position: 'absolute', right: 0, top: 0, width: 12, height: 12,
          borderRadius: '50%', background: 'var(--lg-warning)', color: 'var(--lg-bg-primary)',
          fontSize: 10, fontWeight: 800, lineHeight: '12px', textAlign: 'center',
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
