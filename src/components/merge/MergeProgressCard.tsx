import { createPortal } from 'react-dom'
import './MergeProgressCard.css'

interface Props {
  label: string
  stage: string
  context: string
  detail?: string
  progress?: number
  error?: string | null
  onDetails?: () => void
  onDismiss?: () => void
  needsAttention?: boolean
  autoDismiss?: boolean
}

export function MergeProgressCard({ label, stage, context, detail, progress, error, onDetails, onDismiss, needsAttention, autoDismiss }: Props) {
  const shouldFade = autoDismiss && !!onDismiss && !error && !needsAttention
  return createPortal(
    <section
      className={shouldFade ? 'merge-progress-notice merge-progress-notice--expiring' : 'merge-progress-notice'}
      aria-label={label}
      onAnimationEnd={shouldFade ? event => {
        if (event.target === event.currentTarget && event.animationName === 'merge-progress-fade-out') onDismiss?.()
      } : undefined}
    >
      <div role="status"><strong>{stage}</strong><span>{context}</span></div>
      {detail && <p className="merge-progress-detail">{detail}</p>}
      {progress !== undefined && <progress aria-label="Transfer progress" value={progress} max={100} />}
      {error && <p role="alert">{error}</p>}
      <div className="merge-progress-actions">
        {onDetails && <button onClick={onDetails}>{needsAttention ? 'Review issue' : 'View details'}</button>}
        {onDismiss && <button onClick={onDismiss}>Dismiss</button>}
      </div>
    </section>,
    document.getElementById('repository-progress') ?? document.body,
  )
}
