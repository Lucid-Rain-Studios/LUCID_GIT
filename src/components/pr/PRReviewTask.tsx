import { useBackgroundRepoTaskStore } from '@/stores/backgroundRepoTaskStore'
import { useMergeWindowStore } from '@/stores/mergeWindowStore'
import { MergeProgressCard } from '@/components/merge/MergeProgressCard'
import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ipc, prTaskIpc, PullRequest, ConflictPreviewFile, BranchDiffSummary } from '@/ipc'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'
import { useOperationStore } from '@/stores/operationStore'
import { useRepoStore } from '@/stores/repoStore'
import { useStatusToastStore } from '@/stores/statusToastStore'
import { prReviewKey, usePRReviewStore } from '@/stores/prReviewStore'
import { markFetchPerformed } from '@/lib/fetchState'
import { PRReviewWorkspace } from './PRReviewWorkspace'
import './PRReviewDialog.css'

export function ResolveDialog({
  pr, ghSlug, repoPath, onClose, onDone, minimized = false, onMinimize,
}: {
  pr: PullRequest
  ghSlug: string
  repoPath: string
  minimized?: boolean
  onMinimize?: (value: boolean) => void
  onClose: () => void
  onDone: (result: { prNumber: number; action: 'accept' | 'decline' }) => void
}) {
  const taskBusy = useBackgroundRepoTaskStore(s => s.repoPath === repoPath)
  const localMergeBusy = useMergeWindowStore(s => !!s.task && s.task.phase !== 'complete')
  const opRun         = useOperationStore(s => s.run)
  const operationRunning = useOperationStore(s => s.isRunning)
  const bumpHistoryTick = useRepoStore(s => s.bumpHistoryTick)
  const bumpPrTick      = useRepoStore(s => s.bumpPrTick)
  const bumpSyncTick    = useRepoStore(s => s.bumpSyncTick)
  const refreshStatus   = useRepoStore(s => s.refreshStatus)
  const [choice, setChoice] = useState<'accept' | 'decline'>('accept')
  const [expanded, setExpanded] = useState(false)
  const showStatusToast = useStatusToastStore(s => s.show)
  const [conflicts, setConflicts] = useState<ConflictPreviewFile[]>([])
  const [conflictChoices, setConflictChoices] = useState<Record<string, 'head' | 'base'>>({})
  const [conflictLoading, setConflictLoading] = useState(true)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [outcome, setOutcome] = useState<'success' | 'error' | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [merged, setMerged] = useState(false)
  const [locallyMinimized, setLocallyMinimized] = useState(false)
  const hidden = onMinimize ? minimized : locallyMinimized
  const minimize = (value: boolean) => onMinimize ? onMinimize(value) : setLocallyMinimized(value)
  const dismissReview = () => busy || outcome ? minimize(true) : onClose()
  const runStep = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    setStage(label)
    return opRun(label, fn)
  }
  const [branchDiff, setBranchDiff] = useState<BranchDiffSummary | null>(null)
  const [branchDiffLoading, setBranchDiffLoading] = useState(true)
  const [branchDiffError, setBranchDiffError] = useState<string | null>(null)
  // Previews stay gated until a fresh fetch lands so they reflect the PR's
  // current remote state rather than a stale local snapshot.
  const [refsFetched, setRefsFetched] = useState(false)

  // Fetch the latest remote refs once so the conflict / commit previews below
  // reflect the PR's current state rather than a stale local snapshot.
  useEffect(() => {
    let cancelled = false
    setRefsFetched(false)
    ipc.fetch(repoPath)
      .then(() => markFetchPerformed(repoPath))
      .then(() => { if (!cancelled) setRefsFetched(true) })
      .catch(error => { if (!cancelled) { setConflictError(String(error)); setConflictLoading(false); setBranchDiffError(String(error)); setBranchDiffLoading(false) } })
    return () => { cancelled = true }
  }, [repoPath, pr.headSha, pr.baseSha])

  useEffect(() => {
    if (choice !== 'accept' || !refsFetched) return
    let cancelled = false
    setConflictLoading(true)
    setConflictError(null)
    // Preview conflicts between the PR's own base and head branches — never
    // the branch the user happens to be checked out on.
    ipc.mergePreview(repoPath, pr.headSha, pr.baseSha)
      .then(files => {
        if (cancelled) return
        setConflicts(files)
        setConflictChoices(prev => {
          const active = new Set(files.map(file => file.path))
          const next: Record<string, 'head' | 'base'> = {}
          Object.entries(prev).forEach(([path, selected]) => {
            if (active.has(path)) next[path] = selected
          })
          return next
        })
      })
      .catch((e) => {
        if (cancelled) return
        setConflicts([])
        setConflictError(String(e))
      })
      .finally(() => { if (!cancelled) setConflictLoading(false) })
    return () => { cancelled = true }
  }, [choice, repoPath, pr.headBranch, pr.baseBranch, pr.headSha, pr.baseSha, refsFetched])

  useEffect(() => {
    if (choice !== 'accept' || !refsFetched) return
    let cancelled = false
    setBranchDiffLoading(true)
    setBranchDiffError(null)
    ipc.branchDiff(repoPath, pr.baseSha, pr.headSha)
      .then(value => { if (!cancelled) setBranchDiff(value) })
      .catch((e) => {
        if (cancelled) return
        setBranchDiff(null)
        setBranchDiffError(String(e))
      })
      .finally(() => { if (!cancelled) setBranchDiffLoading(false) })
    return () => { cancelled = true }
  }, [choice, repoPath, pr.baseBranch, pr.headBranch, pr.baseSha, pr.headSha, refsFetched])

  const allConflictChoicesMade = conflicts.length > 0 && conflicts.every(file => conflictChoices[file.path])
  const modal = useDialogOverlayDismiss(dismissReview, true, 'Review pull request', !hidden)

  const resolveConflictedPRLocally = async (owner: string, repo: string) => {
    const originalBranch = await prTaskIpc.currentBranch(repoPath)

    let mergeSha = pr.headSha
    let switched = false
    let cleanupError: unknown
    try {
    await runStep('Fetching latest PR refs...', () => prTaskIpc.fetch(repoPath))
    markFetchPerformed(repoPath)
    await runStep(`Switching to ${pr.headBranch}...`, () => prTaskIpc.checkout(repoPath, pr.headBranch))
    switched = true
    const [reviewedTip] = await prTaskIpc.log(repoPath, { limit: 1 })
    if (!reviewedTip || reviewedTip.hash !== pr.headSha) throw new Error('PR head changed since review. Reopen the preview before resolving.')

    try {
      await runStep(`Updating ${pr.headBranch} from ${pr.baseBranch}...`, () => prTaskIpc.merge(repoPath, pr.baseSha))
    } catch (mergeError) {
      const message = mergeError instanceof Error ? mergeError.message : String(mergeError)
      const isConflict = /conflict|automatic merge failed|fix conflicts|cannot merge binary/i.test(message)
      if (!isConflict) throw mergeError

      for (const file of conflicts) {
        const selected = conflictChoices[file.path]
        if (!selected) continue
        await runStep(
          `Resolving ${file.path}...`,
          () => prTaskIpc.mergeResolveText(repoPath, file.path, selected === 'head' ? 'ours' : 'theirs'),
        )
      }
      await runStep(`Committing ${pr.baseBranch} update...`, () => prTaskIpc.mergeContinue(repoPath, pr.baseBranch))
    }

    await runStep(`Pushing ${pr.headBranch}...`, () => prTaskIpc.push(repoPath))
    const [tip] = await prTaskIpc.log(repoPath, { limit: 1 })
    if (!tip) throw new Error('Unable to verify the PR revision after local resolution')
    mergeSha = tip.hash
    } finally {
      try {
      if (switched && originalBranch && originalBranch !== pr.headBranch) {
        const inProgress = await prTaskIpc.mergeInProgress(repoPath)
        if (!inProgress) await runStep('Restoring ' + originalBranch, () => prTaskIpc.checkout(repoPath, originalBranch))
        else showStatusToast('Conflict resolution is still active on ' + pr.headBranch + '. Complete or abort it before switching branches.')
      }
      } catch (restoreError) {
        showStatusToast('Could not restore ' + originalBranch + '. Check the current branch before continuing.')
        cleanupError = restoreError
      } finally { try { if (useRepoStore.getState().repoPath === repoPath) await refreshStatus() } finally { bumpSyncTick() } }
    }
    if (cleanupError) throw cleanupError
    await runStep('Merging PR #' + pr.number, () => prTaskIpc.githubMergePR({ owner, repo, prNumber: pr.number, repoPath, expectedSha: mergeSha }))
  }

  const handleConfirm = async () => {
    if (busy || useBackgroundRepoTaskStore.getState().repoPath === repoPath || localMergeBusy || usePRReviewStore.getState().busy || useOperationStore.getState().isRunning || outcome === 'success' || (choice === 'accept' && (!refsFetched || conflictLoading || branchDiffLoading ||
      conflictError || branchDiffError || !pr.headSha || !pr.baseSha || conflicts.some(file => !conflictChoices[file.path])))) return
    const [owner, repo] = ghSlug.split('/')
    setBusy(true)
    usePRReviewStore.setState({ busy: true })
    setOutcome(null)
    setOperationError(null)
    setStage(`${choice === 'accept' ? 'Merging' : 'Closing'} PR #${pr.number}...`)
    minimize(true)
    try {
      if (choice === 'accept') {
        if (conflicts.length > 0) {
          await resolveConflictedPRLocally(owner, repo)
        } else {
          await runStep(`Merging PR #${pr.number}…`, () => prTaskIpc.githubMergePR({ owner, repo, prNumber: pr.number, repoPath, expectedSha: pr.headSha }))
        }
        setMerged(true)
        setStage('Merged - Updating repository...')
        onDone({ prNumber: pr.number, action: choice })
        bumpPrTick()
        let fetchedMergedPrUpdates = false
        try {
          await runStep('Merged - Updating repository...', () => prTaskIpc.fetch(repoPath))
          markFetchPerformed(repoPath)
          fetchedMergedPrUpdates = true
        } catch (fetchError) {
          setOperationError('PR merged, but fetch failed. Fetch manually to update pull status.')
          console.error('Post-PR-merge fetch failed', fetchError)
        }
        if (fetchedMergedPrUpdates) bumpSyncTick()
        else bumpHistoryTick()
      } else {
        await runStep(`Closing PR #${pr.number}…`, () => prTaskIpc.githubClosePR({ owner, repo, prNumber: pr.number }))
        bumpPrTick()
        onDone({ prNumber: pr.number, action: choice })
      }
      setOutcome('success')
      setStage(choice === 'accept' ? `PR #${pr.number} merged` : `PR #${pr.number} closed`)
      minimize(true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setOperationError(msg)
      setOutcome('error')
      setStage(`PR #${pr.number} needs attention`)
      console.error('PR merge/close failed', e)
    } finally { setBusy(false); usePRReviewStore.setState({ busy: false }) }
  }

  const waitingForConflictChoices = choice === 'accept' && conflicts.length > 0 && !allConflictChoicesMade
  const disabled = busy || taskBusy || localMergeBusy || operationRunning || outcome === 'success' || waitingForConflictChoices || (choice === 'accept' && (!refsFetched || conflictLoading || branchDiffLoading || !!conflictError || !!branchDiffError || !pr.headSha || !pr.baseSha))
  const pending = conflicts.filter(file => !conflictChoices[file.path]).length
  const reviewStatus = conflictError || branchDiffError ? 'Review unavailable'
    : !refsFetched || conflictLoading || branchDiffLoading ? 'Loading review…'
    : conflicts.length ? pending ? `${pending} of ${conflicts.length} files need a choice` : `${conflicts.length} file choices ready`
    : 'No merge conflicts detected'

  return <>
    {hidden && !localMergeBusy && (busy || outcome) && <MergeProgressCard
      label={`PR #${pr.number} progress`} stage={stage} context={`PR #${pr.number} · ${pr.title}`}
      error={operationError} needsAttention={outcome === 'error'}
      autoDismiss={merged && outcome === 'success' && !busy}
      onDetails={() => minimize(false)} onDismiss={!busy ? onClose : undefined}
    />}
    {createPortal(<div {...modal} style={{ position: 'fixed', inset: 0, zIndex: 600, display: hidden ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)' }}>
    <div className={'pr-review-dialog' + (expanded ? ' pr-review-expanded' : '')}>
      <header className="pr-review-title">
        <span className="pr-review-number">#{pr.number}</span><h2>{pr.title}</h2><span className="pr-review-pill">{merged ? 'Merged' : busy ? 'Merging...' : 'Open'}</span>
        <span className="pr-review-spacer" />
        <button aria-label={expanded ? 'Restore PR review size' : 'Expand PR review'} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Restore' : 'Expand'}</button>
        <details className="pr-review-pr-menu"><summary aria-label="Pull request actions">⋮</summary>
          <button disabled={busy || outcome === 'success'} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); setChoice(choice === 'accept' ? 'decline' : 'accept') }}>{choice === 'accept' ? 'Close PR' : 'Review merge'}</button>
        </details>
        <button aria-label={busy || outcome ? "Hide progress" : "Close PR review"} onClick={dismissReview}>×</button>
      </header>
      {operationError && <div className="pr-operation-error" role="alert">{operationError}</div>}
      <div className="pr-review-branches"><strong>{pr.headBranch}</strong><span>→</span><span>{pr.baseBranch}</span><span>· by {pr.author}</span><small>{pr.headSha.slice(0, 7)}</small></div>
      {choice === 'accept' ? <PRReviewWorkspace pr={pr} repoPath={repoPath} ghSlug={ghSlug} summary={branchDiff}
        loading={!refsFetched || conflictLoading || branchDiffLoading} error={conflictError || branchDiffError}
        conflicts={conflicts} choices={conflictChoices} busy={busy}
        onChoose={(path, side) => setConflictChoices(previous => ({ ...previous, [path]: side }))} />
        : <div className="pr-review-decline-warning">This will close PR #{pr.number} without merging. The branch will remain intact.<div style={{ marginTop: 14 }}><button disabled={busy} onClick={() => setChoice('accept')}>Back to review</button></div></div>}
      <footer className="pr-review-footer">
        <span role="status">{busy ? stage : merged ? 'Merged' : choice === 'accept' ? reviewStatus : 'Close without merging'}</span><span className="pr-review-spacer" />
        {!expanded && <small className="pr-review-resize-note">Drag bottom-right corner to resize</small>}
        <button onClick={dismissReview}>{busy || outcome ? 'Hide progress' : 'Cancel'}</button>
        <button className={choice === 'accept' ? 'pr-review-confirm' : 'pr-review-decline'} onClick={handleConfirm} disabled={disabled}
          title={waitingForConflictChoices ? 'Choose a revision for every conflicting file.' : undefined}>
          {busy ? 'Merging...' : merged ? 'Merged' : choice === 'accept' ? conflicts.length > 0 ? 'Resolve & Merge' : 'Merge PR' : 'Close PR'}
        </button>
      </footer>
    </div>
  </div>, document.body)}
  </>
}


export function PRReviewHost() {
  const request = usePRReviewStore(s => s.request)
  const minimized = usePRReviewStore(s => s.minimized)
  if (!request) return null
  return <ResolveDialog key={prReviewKey(request)} {...request}
    minimized={minimized} onMinimize={value => usePRReviewStore.setState({ minimized: value })}
    onClose={() => usePRReviewStore.getState().close()}
    onDone={({ prNumber, action }) => usePRReviewStore.getState().complete(request.repoPath, prNumber, action)} />
}
