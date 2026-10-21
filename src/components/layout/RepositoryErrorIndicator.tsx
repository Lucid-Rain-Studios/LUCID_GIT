import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert } from 'lucide-react'
import { useRepoStore } from '@/stores/repoStore'
import { useErrorStore } from '@/stores/errorStore'
import { repositoryIssueSource, useRepositoryIssueStore } from '@/stores/repositoryIssueStore'
import { parseGitErrorOrGeneric } from '@/lib/gitErrors'

export function RepositoryErrorIndicator() {
  const repoPath = useRepoStore(s => s.repoPath)
  const readError = useRepoStore(s => s.error)
  const current = useErrorStore(s => s.current)
  const issues = useRepositoryIssueStore(s => repoPath ? s.repositories[repoPath] : undefined)
  const parsedRead = readError ? { ...parseGitErrorOrGeneric(readError), repoPath } : null
  const source = current && repositoryIssueSource(current)
  const visibleCurrent = current?.repoPath === repoPath && current?.severity !== 'warning' && !(source && issues?.[source] === null) ? current : null
  const error = issues?.index || issues?.['lock-cache'] ||
    (parsedRead && (parsedRead.severity === 'fatal' || repositoryIssueSource(parsedRead)) ? parsedRead : null) || visibleCurrent
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const showMessage = () => setAnchor(buttonRef.current?.getBoundingClientRect() ?? null)
  useEffect(() => { setAnchor(null) }, [repoPath, error?.gitMessage])
  if (!repoPath || !error) return null
  const message = `${error.title}: ${error.gitMessage}`
  return (
    <span style={{ display: 'flex' }} onMouseEnter={showMessage} onMouseLeave={() => setAnchor(null)}>
      <button ref={buttonRef} type="button" aria-label="View repository error" aria-description={message}
        onFocus={showMessage} onBlur={() => setAnchor(null)}
        onKeyDown={event => { if (event.key === 'Escape') setAnchor(null) }}
        onClick={() => { setAnchor(null); useErrorStore.setState({ current: error }) }}
        className="lg-toolbar-control lg-icon-control flex items-center justify-center hover:bg-lg-bg-hover transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-lg-error"
        style={{ width: 32, height: 28, padding: 0, border: 0, borderRadius: 5, flexShrink: 0, cursor: 'pointer', color: 'var(--lg-error)' }}>
        <CircleAlert size={14} aria-hidden="true" />
      </button>
      {anchor && createPortal(
        <div role="tooltip" style={{ position: 'fixed', zIndex: 9999, top: anchor.bottom + 8,
          left: Math.max(12, Math.min(anchor.left, window.innerWidth - 392)), width: 'min(380px, calc(100vw - 24px))',
          boxSizing: 'border-box', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--lg-border-strong)',
          background: 'var(--lg-bg-elevated)', color: 'var(--lg-text-primary)', fontSize: 12, lineHeight: 1.5,
          overflowWrap: 'anywhere', pointerEvents: 'none', boxShadow: 'var(--lg-shadow-md)' }}>
          <div>{message}</div>
          <div style={{ marginTop: 6, color: 'var(--lg-error)' }}>Click to view error details and recovery options.</div>
        </div>, document.body,
      )}
    </span>
  )
}
