import { isGitHubLockOwner } from '../../../electron/util/github-login'
import { useBackgroundRepoTask } from '@/lib/useBackgroundRepoTask'
import { MergeProgressCard } from '@/components/merge/MergeProgressCard'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ipc, backgroundTaskIpc, Lock } from '@/ipc'
import type { PushLockCheck } from '../../../electron/pushTypes'
import { useRepoStore } from '@/stores/repoStore'
import { useAuthStore } from '@/stores/authStore'
import { useOperationStore } from '@/stores/operationStore'
import { FilePathText } from '@/components/ui/FilePathText'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'

interface PushBlockedByLocksDialogProps {
  repoPath?: string
  errorMessage: string
  onClose: () => void
  onPushed: () => void
}

export function PushBlockedByLocksDialog({ repoPath: taskRepo, errorMessage, onClose, onPushed }: PushBlockedByLocksDialogProps) {
  const repo = useRepoStore()
  const [repoPath] = useState(taskRepo ?? repo.repoPath)
  const task = useBackgroundRepoTask(repoPath)
  const pushing = task.running
  const { accounts, currentAccountId } = useAuthStore()
  const currentLogin = accounts.find(a => a.userId === currentAccountId)?.login
  const opRun = useOperationStore(s => s.run)
  const operationLabel = useOperationStore(s => s.label)
  const latestStep = useOperationStore(s => s.latestStep)
  const [loading, setLoading] = useState(true)
  const [check, setCheck] = useState<PushLockCheck | null>(null)
  const [locks, setLocks] = useState<Lock[]>([])
  const [checkError, setCheckError] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const generation = useRef(0)

  const retryChecks = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setCheck(null)
    setLocks([])
    setCheckError(null)
    setConfirming(false)
    try {
      if (!repoPath) throw new Error('Select a repository and retry checks.')
      if (!currentLogin) throw new Error('Sign in before checking lock ownership.')
      // Read authoritative LFS locks directly; PR ghost overlays are not push blockers.
      const [result, realLocks] = await Promise.all([ipc.pushLockCheck(repoPath), ipc.listLocks(repoPath)])
      if (request !== generation.current) return
      setCheck(result)
      setLocks(realLocks.filter(lock => !lock.prOverlay && !lock.id.startsWith('ghost-pr-')))
    } catch (error) {
      if (request === generation.current) setCheckError(String(error))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [repoPath, currentLogin])

  useEffect(() => {
    void retryChecks()
    const requests = generation
    return () => { requests.current++ }
  }, [retryChecks])

  const ahead = new Set(check?.files.map(p => p.replace(/\\/g, '/')))
  const overlapping = locks.filter(lock => ahead.has(lock.path.replace(/\\/g, '/')))
  const blocking = overlapping.filter(lock => !isGitHubLockOwner(lock, currentLogin))
  const ownLocks = overlapping.filter(lock => isGitHubLockOwner(lock, currentLogin))
  const ready = !loading && !checkError && check !== null
  const canOverride = ready && !check.overrideReason

  const push = async (override: boolean) => {
    const stage = override ? 'Publishing branch with locks retained…' : 'Pushing…'
    if (!repoPath || !check || !ready || (override && !canOverride) || !task.begin(stage)) return
    setRetryError(null)
    try {
      // If the user browsed away after an earlier failure, the reviewed
      // branch must still be the one Git would push.
      if (await ipc.currentBranch(repoPath) !== check.branch) {
        throw new Error('The checked-out branch changed. Review the updated lock checks before pushing.')
      }
      await opRun(stage, () =>
        override ? backgroundTaskIpc.push(repoPath, false, {
          branch: check.branch, head: check.head, remoteUrl: check.remoteUrl, targetBranch: check.targetBranch,
        }) : backgroundTaskIpc.push(repoPath))
    } catch (error) {
      const message = String(error)
      setRetryError(message)
      task.finish(message)
      void retryChecks()
      return
    }
    task.finish()
    onPushed()
    onClose()
  }

  const dismiss = () => pushing ? task.setHidden(true) : onClose()
  const overlayDismiss = useDialogOverlayDismiss(dismiss, true, 'Push stopped by LFS lock verification', !task.hidden)
  const transfer = pushing && operationLabel === task.stage ? latestStep : null

  return <>
    {task.hidden && (pushing || task.failure) && <MergeProgressCard
      label="Push progress" stage={pushing ? task.stage : 'Push needs attention'}
      context={check?.branch ?? repoPath ?? ''} error={task.failure}
      detail={transfer?.label} progress={transfer?.overallProgress ?? transfer?.progress}
      needsAttention={!!task.failure} onDetails={() => task.setHidden(false)}
      onDismiss={!pushing ? onClose : undefined}
    />}
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
      style={{ display: task.hidden ? 'none' : undefined }} {...overlayDismiss}>
      <div className="bg-lg-bg-elevated border border-lg-border rounded-lg shadow-2xl w-full max-w-[660px] max-h-[85vh] flex flex-col">
        <div className="px-4 py-3 border-b border-lg-border">
          <h2 className="text-sm font-mono font-semibold text-lg-text-primary">Push stopped by LFS lock verification</h2>
          <p className="text-xs text-lg-text-secondary mt-1">Git LFS stopped the push locally because it detected locked files in the outgoing changes.</p>
        </div>
        <div className="overflow-y-auto min-h-0">
          <details className="px-4 py-3 border-b border-lg-border">
            <summary className="text-xs text-lg-text-secondary cursor-pointer">Original Git output</summary>
            <pre className="mt-2 text-xs text-lg-error whitespace-pre-wrap break-words">{errorMessage.trim()}</pre>
          </details>
          <div className="px-4 py-4 space-y-3 text-xs">
            {loading && <p role="status">Checking outgoing files and LFS locks…</p>}
            {checkError && <div role="alert" className="text-lg-error"><p>Couldn’t determine blocking locks.</p><p className="break-words mt-1">{checkError}</p></div>}
            {ready && <>
              <p className="text-lg-text-secondary break-words">Publishing {check.branch} → origin/{check.targetBranch}</p>
              {blocking.length > 0 ? <>
                <p className="text-lg-warning">{blocking.length} outgoing file{blocking.length === 1 ? '' : 's'} locked by other users</p>
                <ul className="space-y-3">{blocking.map(lock => <li key={lock.id}>
                  <FilePathText path={lock.path} displayText={lock.path} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }} className="block font-mono" />
                  <span className="text-lg-text-secondary">Locked by {lock.owner.name || lock.owner.login}</span>
                </li>)}</ul>
              </> : <>
                <p className="text-lg-text-primary">No overlapping locks found.</p>
                <p className="text-lg-text-secondary">The current checks found no outgoing files locked by another user. Retry the push with normal verification; any new rejection will appear here.</p>
              </>}
              {ownLocks.length > 0 && <p className="text-lg-text-secondary">Your locks on {ownLocks.length} outgoing file{ownLocks.length === 1 ? '' : 's'} do not block your push.</p>}
              {check.overrideReason && <p className="text-lg-text-secondary">{check.overrideReason}</p>}
            </>}
            {confirming && ready && <div className="border border-lg-warning/60 rounded p-3 space-y-2" role="group" aria-label="Confirm push with locks retained">
              <p className="font-semibold text-lg-warning">Publish this branch while preserving existing locks?</p>
              <p>Coordinate with the owners before merging these files. This can create conflicting asset versions. This publishes your branch without merging it into the default branch.</p>
              <p className="text-lg-text-secondary">Lock verification is skipped for this push only. All locks stay in place. Remote branch protection still applies.</p>
              <div className="flex flex-wrap gap-2">
                <ActionBtn disabled={pushing} onClick={() => setConfirming(false)}>Cancel override</ActionBtn>
                <ActionBtn disabled={task.blocked || !canOverride} onClick={() => push(true)}>Publish branch with locks retained</ActionBtn>
              </div>
            </div>}
            {retryError && <p role="alert" className="text-lg-error whitespace-pre-wrap break-words">{retryError}</p>}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-4 py-3 border-t border-lg-border">
          <ActionBtn onClick={dismiss}>{pushing ? 'Hide progress' : 'Cancel'}</ActionBtn>
          <ActionBtn disabled={pushing || loading} onClick={retryChecks}>Retry checks</ActionBtn>
          <ActionBtn disabled={task.blocked || !ready} onClick={() => push(false)}>{pushing ? 'Pushing…' : 'Retry push'}</ActionBtn>
          {!confirming && canOverride && <ActionBtn disabled={task.blocked} onClick={() => setConfirming(true)}>Push anyway…</ActionBtn>}
        </div>
      </div>
    </div>
  </>
}
