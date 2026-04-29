import React, { useState } from 'react'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { ipc } from '@/ipc'
import { cn } from '@/lib/utils'
import { useErrorStore } from '@/stores/errorStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useLockStore } from '@/stores/lockStore'
import { useAuthStore } from '@/stores/authStore'

type HookState = 'idle' | 'running' | 'passed' | 'failed'

export function CommitBox() {
  const { repoPath, fileStatus, refreshStatus } = useRepoStore()
  const opRun = useOperationStore(s => s.run)
  const dialog = useDialogStore()
  const { locks, unlockFile } = useLockStore()
  const { accounts, currentAccountId } = useAuthStore()
  const currentLogin = accounts.find(a => a.userId === currentAccountId)?.login ?? null

  const [message, setMessage]         = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [error, setError]             = useState<string | null>(null)

  const pushError = useErrorStore(s => s.pushRaw)
  const [hookState, setHookState]     = useState<HookState>('idle')
  const [hookOutput, setHookOutput]   = useState('')
  const [hookDuration, setHookDuration] = useState(0)

  const stagedCount = fileStatus.filter(f => f.staged).length
  const canCommit   = Boolean(repoPath && message.trim() && stagedCount > 0 && !isCommitting)

  const runCommit = async (noVerify = false) => {
    if (!repoPath) return
    setIsCommitting(true)
    setError(null)

    // Capture staged files locked by the current user before the commit clears them
    const stagedLockedByMe = currentLogin
      ? fileStatus.filter(f => f.staged && locks.some(
          l => l.path.replace(/\\/g, '/') === f.path.replace(/\\/g, '/') &&
               l.owner.login === currentLogin
        ))
      : []

    try {
      await opRun('Committing…', () => ipc.commit(repoPath, message.trim(), noVerify))
      setMessage('')
      setHookState('idle')
      setHookOutput('')
      refreshStatus()

      // Unlock any files that were staged and locked by us — mirrors Unreal Engine behaviour
      for (const file of stagedLockedByMe) {
        unlockFile(repoPath, file.path).catch(() => {})
      }
    } catch (e) {
      const s = String(e)
      setError(s)
      pushError(s)
    } finally {
      setIsCommitting(false)
    }
  }

  const handleCommit = async () => {
    if (!canCommit || !repoPath) return

    // Run pre-commit hook inline first
    setHookState('running')
    setHookOutput('')
    setError(null)

    try {
      const result = await ipc.hookRunPreCommit(repoPath)

      if (!result.exists || result.exitCode === 0) {
        setHookState(result.exists ? 'passed' : 'idle')
        setHookDuration(result.durationMs)
        // Hook passed (or no hook) — proceed with --no-verify to avoid double-run
        await runCommit(result.exists)
        if (result.exists) setHookState('idle')
      } else {
        setHookState('failed')
        setHookOutput(result.output)
        setHookDuration(result.durationMs)
      }
    } catch (e) {
      setHookState('idle')
      setError(String(e))
    }
  }

  const handleBypass = async () => {
    const confirmed = await dialog.confirm({
      title: 'Bypass pre-commit hook',
      message: 'The hook reported a failure. Bypassing means it will not run.',
      detail: 'Only proceed if you know the hook failure is not blocking.',
      confirmLabel: 'Bypass & Commit',
      danger: true,
    })
    if (!confirmed) return
    setHookState('idle')
    setHookOutput('')
    await runCommit(true)
  }

  return (
    <div className="border-t border-lg-border p-2.5 space-y-2 shrink-0 bg-lg-bg-secondary">
      <textarea
        value={message}
        onChange={e => setMessage(e.target.value)}
        onKeyDown={e => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canCommit) handleCommit()
        }}
        placeholder={
          stagedCount > 0
            ? 'Summary (Ctrl+Enter to commit)'
            : 'Stage changes to commit'
        }
        disabled={stagedCount === 0 || isCommitting}
        rows={3}
        className="w-full bg-lg-bg-primary border border-lg-border rounded px-2 py-1.5 text-xs font-mono text-lg-text-primary placeholder:text-lg-text-secondary resize-none focus:outline-none focus:border-lg-accent disabled:opacity-40 transition-colors"
      />

      {/* ── Hook output ─────────────────────────────────────────────── */}
      {hookState === 'running' && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-lg-text-secondary animate-pulse">
          <span className="w-1.5 h-1.5 rounded-full bg-lg-accent-secondary animate-pulse" />
          Running pre-commit hook…
        </div>
      )}

      {hookState === 'passed' && (
        <div className="text-[10px] font-mono text-lg-success">
          ✓ Hook passed ({hookDuration}ms)
        </div>
      )}

      {hookState === 'failed' && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-lg-error">
            <span>✗ Pre-commit hook failed ({hookDuration}ms)</span>
          </div>
          {hookOutput && (
            <pre className={cn(
              'p-2 bg-lg-bg-primary border border-lg-error/40 rounded',
              'text-[9px] font-mono text-lg-error/90 max-h-32 overflow-y-auto whitespace-pre-wrap'
            )}>
              {hookOutput}
            </pre>
          )}
          <button
            onClick={handleBypass}
            disabled={isCommitting}
            className="w-full h-6 rounded text-[10px] font-mono border border-lg-warning/60 text-lg-warning hover:bg-lg-warning/10 disabled:opacity-40 transition-colors"
          >
            Bypass hook (confirm required)
          </button>
        </div>
      )}

      {/* ── Commit error ─────────────────────────────────────────────── */}
      {error && (
        <div
          className="text-[10px] font-mono text-lg-error truncate"
          title={error}
        >
          {error}
        </div>
      )}

      {/* ── Commit button (hidden when hook failed — bypass is shown) ── */}
      {hookState !== 'failed' && (
        <button
          onClick={handleCommit}
          disabled={!canCommit || hookState === 'running'}
          className="w-full h-7 bg-lg-accent rounded text-[11px] font-mono text-white hover:bg-lg-accent/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isCommitting
            ? 'Committing…'
            : hookState === 'running'
              ? 'Running hook…'
              : stagedCount > 0
                ? `Commit ${stagedCount} file${stagedCount !== 1 ? 's' : ''}`
                : 'Commit'}
        </button>
      )}
    </div>
  )
}
