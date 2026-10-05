import React, { useEffect, useState } from 'react'
import { ipc, ConflictPreviewFile } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { cn } from '@/lib/utils'
import { FilePathText } from '@/components/ui/FilePathText'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'

const INDEX_LOCK_RE = /Unable to create '.*index\.lock'.*File exists/i

function formatAge(seconds: number): string {
  if (seconds < 60)    return `${seconds}s ago`
  if (seconds < 3600)  return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

interface CherryPickConflictDialogProps {
  onClose: () => void
  onResolved: () => void
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function formatBytes(b: number): string {
  if (b < 1024)       return `${b} B`
  if (b < 1048576)    return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

const CONFLICT_LABEL: Record<ConflictPreviewFile['conflictType'], string> = {
  content:       'Text conflict',
  binary:        'Binary conflict',
  'delete-modify': 'Delete / modify',
}

const TYPE_ICON: Record<ConflictPreviewFile['type'], string> = {
  text:      '📄',
  binary:    '📦',
  'ue-asset': '🎮',
}

export function CherryPickConflictDialog({ onClose, onResolved }: CherryPickConflictDialogProps) {
  const { repoPath, currentBranch, refreshStatus, bumpSyncTick } = useRepoStore()
  const opRun = useOperationStore(s => s.run)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lockInfo, setLockInfo] = useState<{ path: string; ageSeconds: number } | null>(null)
  const [lockFailureCount, setLockFailureCount] = useState(0)
  const [conflicts, setConflicts] = useState<ConflictPreviewFile[]>([])
  const [sourceLabel, setSourceLabel] = useState<string>('')
  const [working, setWorking] = useState(false)
  const [choices, setChoices] = useState<Record<string, 'ours' | 'theirs'>>({})

  useEffect(() => {
    if (!repoPath) return
    setLoading(true)
    setError(null)
    ipc.cherryPickInProgress(repoPath)
      .then(state => {
        if (!state) {
          // No cherry-pick in progress — nothing to resolve, close.
          onClose()
          return
        }
        setConflicts(state.conflicts)
        setSourceLabel(
          state.sourceMessage
            ? `${state.cherryPickHead.slice(0, 7)} — ${state.sourceMessage}`
            : state.cherryPickHead.slice(0, 7),
        )
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [repoPath, onClose])

  const allChoicesMade = conflicts.length > 0 && conflicts.every(c => choices[c.path])

  const runFinalize = async () => {
    if (!repoPath) return
    for (const c of conflicts) {
      const choice = choices[c.path]
      if (!choice) continue
      // mergeResolveText is purely file-level (git checkout --ours/theirs + git add)
      // and works identically for cherry-pick conflicts.
      await opRun(`Resolving ${c.path}…`, () => ipc.mergeResolveText(repoPath, c.path, choice))
    }
    await opRun('Finalizing cherry-pick…', () => ipc.cherryPickContinue(repoPath))
    await refreshStatus()
    bumpSyncTick()
    onResolved()
    onClose()
  }

  const handleFinalizeError = async (e: unknown) => {
    if (!repoPath) return
    const msg = String(e)
    setError(msg)
    // If the failure was an index.lock contention, fetch its metadata so we
    // can offer recovery. Track consecutive lock failures so we can escalate
    // from "click to clear" to "another process is genuinely writing" guidance.
    if (INDEX_LOCK_RE.test(msg)) {
      const info = await ipc.getIndexLockInfo(repoPath).catch(() => null)
      if (info) setLockInfo(info)
      setLockFailureCount(n => n + 1)
    } else {
      setLockInfo(null)
      setLockFailureCount(0)
    }
    setWorking(false)
  }

  const finalize = async () => {
    if (!repoPath) return
    setWorking(true)
    setError(null)
    setLockInfo(null)
    setLockFailureCount(0)
    try {
      await runFinalize()
    } catch (e) {
      await handleFinalizeError(e)
    }
  }

  const clearLockAndRetry = async () => {
    if (!repoPath || !lockInfo) return
    setWorking(true)
    setError(null)
    try {
      const remaining = await ipc.getIndexLockInfo(repoPath)
      if (remaining) throw new Error('The index lock still exists. Its age cannot prove that its owner stopped. Close other Git clients and verify no Git writer is running before manually removing ' + remaining.path)
      setLockInfo(null)
      await runFinalize()
    } catch (e) {
      await handleFinalizeError(e)
    }
  }

  const abort = async () => {
    if (!repoPath) return
    try {
      setError(null)
      await opRun('Aborting cherry-pick…', () => ipc.cherryPickAbort(repoPath))
      await refreshStatus()
      bumpSyncTick()
      onClose()
    } catch (e) {
      setError(String(e))
    }
  }

  // Disable backdrop-click dismiss while a cherry-pick is in progress —
  // the user must explicitly resolve or abort.
  const overlayDismiss = useDialogOverlayDismiss(onClose, false)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      {...overlayDismiss}
    >
      <div className="bg-lg-bg-elevated border border-lg-border rounded-lg shadow-2xl w-[640px] max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-lg-border shrink-0">
          <div>
            <div className="text-xs font-mono font-semibold text-lg-text-primary">
              Cherry-pick conflict
            </div>
            <div className="text-[10px] font-mono text-lg-text-secondary mt-0.5 truncate max-w-[520px]" title={sourceLabel}>
              <span className="text-lg-accent">{sourceLabel || 'cherry-pick'}</span>
              {' → '}
              <span className="text-lg-success">{currentBranch}</span>
            </div>
          </div>
          <button
            onClick={abort}
            className="text-lg-text-secondary hover:text-lg-text-primary text-lg font-mono leading-none"
            title="Abort cherry-pick"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <span className="text-xs font-mono text-lg-text-secondary animate-pulse">
                Loading conflicts…
              </span>
            </div>
          )}

          {!loading && error && (
            <div className="px-4 py-3 space-y-2">
              <div className="text-xs font-mono text-lg-error whitespace-pre-wrap">
                {error}
              </div>
              {lockInfo && (() => {
                const persistent = lockFailureCount >= 2
                return (
                  <div className="rounded border border-lg-warning/40 bg-lg-warning/10 px-3 py-2 space-y-1">
                    <div className="text-[11px] font-mono font-semibold text-lg-warning">
                      {persistent ? 'Repeated index lock contention' : 'Git index lock detected'}
                    </div>
                    <div className="text-[10px] font-mono text-lg-text-secondary">
                      <code className="text-lg-text-primary">.git/index.lock</code> was last touched <span className="text-lg-text-primary">{formatAge(lockInfo.ageSeconds)}</span>.
                      {' Its owner is unknown. Age does not prove it is abandoned. Close other Git clients and verify no Git writer is running before manual recovery. Lucid Git will leave the lock in place.'}
                    </div>
                    <div className="pt-1 flex gap-2">
                      <button
                        onClick={clearLockAndRetry}
                        disabled={working}
                        className="px-2 h-6 rounded text-[10px] font-mono bg-lg-warning/20 border border-lg-warning/60 text-lg-warning hover:bg-lg-warning/30 transition-colors disabled:opacity-40"
                      >
                        {working ? 'Checking…' : 'Check lock & retry'}
                      </button>
                      <button
                        onClick={finalize}
                        disabled={working}
                        className="px-2 h-6 rounded text-[10px] font-mono border border-lg-border text-lg-text-secondary hover:bg-lg-bg-secondary transition-colors disabled:opacity-40"
                        title="Try again without removing the lock — useful after closing the other process"
                      >
                        Retry only
                      </button>
                    </div>
                  </div>
                )
              })()}
            </div>
          )}

          {!loading && conflicts.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <div className="text-lg-success text-2xl">✓</div>
              <div className="text-xs font-mono text-lg-text-primary font-semibold">No remaining conflicts</div>
              <div className="text-[10px] font-mono text-lg-text-secondary">
                Click "Complete cherry-pick" to finalize.
              </div>
            </div>
          )}

          {!loading && conflicts.length > 0 && (
            <div>
              <div className="px-4 py-2 border-b border-lg-border bg-lg-bg-secondary">
                <span className="text-[10px] font-mono text-lg-warning">
                  ⚠ {conflicts.length} file{conflicts.length !== 1 ? 's' : ''} need resolution
                </span>
              </div>
              {conflicts.map(file => (
                <div key={file.path} className="px-4 py-3 border-b border-lg-border/50">
                  {/* File name row */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm">{TYPE_ICON[file.type]}</span>
                    <FilePathText path={file.path} className="flex-1 text-xs font-mono text-lg-text-primary truncate" />
                    <span className={cn(
                      'shrink-0 px-1.5 py-0.5 rounded text-[9px] font-mono',
                      file.conflictType === 'content'
                        ? 'bg-lg-warning/20 text-lg-warning'
                        : file.conflictType === 'delete-modify'
                          ? 'bg-lg-error/20 text-lg-error'
                          : 'bg-[#4a9eff]/20 text-[#4a9eff]'
                    )}>
                      {CONFLICT_LABEL[file.conflictType]}
                    </span>
                  </div>

                  {/* Contributor comparison (click a side to preselect resolution) */}
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { label: 'Ours', info: file.ours, choice: 'ours' as const },
                      { label: 'Theirs', info: file.theirs, choice: 'theirs' as const },
                    ] as const).map(({ label, info, choice }) => (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setChoices(prev => ({ ...prev, [file.path]: choice }))}
                        className={cn(
                          'bg-lg-bg-secondary rounded px-2 py-1.5 space-y-0.5 text-left border transition-colors',
                          choices[file.path] === choice
                            ? choice === 'ours'
                              ? 'border-lg-success bg-lg-success/10'
                              : 'border-lg-accent bg-lg-accent/10'
                            : 'border-lg-border hover:border-lg-accent/60'
                        )}
                        title={`Use ${label.toLowerCase()} version for ${file.path}`}
                      >
                        <div className="text-[9px] font-mono uppercase tracking-widest text-lg-text-secondary">
                          {label} · <span className="text-lg-accent">{info.branch}</span>
                        </div>
                        <div className="text-[10px] font-mono text-lg-text-primary truncate">
                          {info.lastContributor.name || info.lastContributor.email || '—'}
                        </div>
                        <div className="text-[9px] font-mono text-lg-text-secondary truncate" title={info.lastCommitMessage}>
                          {info.lastCommitMessage || '—'}
                        </div>
                        <div className="text-[9px] font-mono text-lg-text-secondary flex items-center justify-between">
                          <span>{info.lastEditedAt ? timeAgo(info.lastEditedAt) : '—'}</span>
                          {info.sizeBytes > 0 && <span>{formatBytes(info.sizeBytes)}</span>}
                        </div>
                      </button>
                    ))}
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[10px] font-mono text-lg-text-secondary">Preferred resolution:</span>
                    <button
                      onClick={() => setChoices(prev => ({ ...prev, [file.path]: 'ours' }))}
                      className={cn(
                        'px-2 h-6 text-[10px] font-mono border rounded',
                        choices[file.path] === 'ours'
                          ? 'border-lg-success text-lg-success bg-lg-success/10'
                          : 'border-lg-border text-lg-text-secondary'
                      )}
                    >
                      Keep {currentBranch}
                    </button>
                    <button
                      onClick={() => setChoices(prev => ({ ...prev, [file.path]: 'theirs' }))}
                      className={cn(
                        'px-2 h-6 text-[10px] font-mono border rounded',
                        choices[file.path] === 'theirs'
                          ? 'border-lg-accent text-lg-accent bg-lg-accent/10'
                          : 'border-lg-border text-lg-text-secondary'
                      )}
                    >
                      Keep cherry-picked
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        {!loading && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-lg-border shrink-0 gap-3">
            {conflicts.length > 0 ? (
              <div className="text-[10px] font-mono text-lg-text-secondary">
                {allChoicesMade
                  ? 'All conflicts have a choice — complete the cherry-pick to commit.'
                  : `Pick a side for each file (${Object.keys(choices).filter(p => conflicts.some(c => c.path === p)).length}/${conflicts.length} chosen).`}
              </div>
            ) : <div />}
            <div className="flex gap-2 shrink-0">
              <ActionBtn
                onClick={abort}
                disabled={working}
                color="#e84545"
                size="sm"
                style={{ height: 28, paddingLeft: 12, paddingRight: 12, fontSize: 11, fontFamily: 'var(--lg-font-mono)' }}
              >
                Abort
              </ActionBtn>
              <button
                onClick={finalize}
                disabled={working || (conflicts.length > 0 && !allChoicesMade)}
                className="px-3 h-7 rounded text-[11px] font-mono bg-lg-success/20 border border-lg-success/60 text-lg-success hover:bg-lg-success/30 transition-colors disabled:opacity-40"
                title={conflicts.length > 0 && !allChoicesMade ? 'Pick a side for every conflicted file first' : undefined}
              >
                {working ? 'Completing…' : 'Complete cherry-pick'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
