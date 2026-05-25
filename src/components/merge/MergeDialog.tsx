import React, { useEffect, useState } from 'react'
import { ipc, BranchDiffSummary, ConflictPreviewFile, FileStatus } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { cn } from '@/lib/utils'
import { FilePathText } from '@/components/ui/FilePathText'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'

interface MergePreviewDialogProps {
  targetBranch: string
  onClose: () => void
  onMerged: () => void
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

const UE_EXTS = new Set(['.uasset', '.umap', '.udk', '.ubulk', '.uexp', '.ucas'])
const BINARY_EXTS = new Set([
  '.uasset', '.umap', '.udk', '.ubulk', '.uexp', '.ucas', '.pak',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.psd', '.tiff',
  '.wav', '.mp3', '.ogg', '.flac', '.aiff', '.wem',
  '.zip', '.7z', '.rar', '.pdf', '.fbx', '.obj',
])

function extname(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function conflictFileType(filePath: string): ConflictPreviewFile['type'] {
  const ext = extname(filePath)
  if (UE_EXTS.has(ext)) return 'ue-asset'
  return BINARY_EXTS.has(ext) ? 'binary' : 'text'
}

function conflictTypeFromStatus(status: FileStatus, filePath: string): ConflictPreviewFile['conflictType'] {
  if (status.indexStatus === 'D' || status.workingStatus === 'D') return 'delete-modify'
  return BINARY_EXTS.has(extname(filePath)) ? 'binary' : 'content'
}

function isUnmerged(status: FileStatus): boolean {
  const xy = `${status.indexStatus}${status.workingStatus}`
  return ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy)
}

function fallbackConflict(path: string, status: FileStatus, currentBranch: string, targetBranch: string): ConflictPreviewFile {
  const emptyInfo = (branch: string) => ({
    branch,
    lastContributor: { name: '', email: '' },
    lastEditedAt: '',
    lastCommitMessage: '',
    sizeBytes: 0,
  })
  return {
    path,
    type: conflictFileType(path),
    conflictType: conflictTypeFromStatus(status, path),
    ours: emptyInfo(currentBranch),
    theirs: emptyInfo(targetBranch),
  }
}

export function MergePreviewDialog({ targetBranch, onClose, onMerged }: MergePreviewDialogProps) {
  const { repoPath, currentBranch, refreshStatus, bumpSyncTick } = useRepoStore()

  const [loading, setLoading]   = useState(true)
  const [conflicts, setConflicts] = useState<ConflictPreviewFile[]>([])
  const [diffSummary, setDiffSummary] = useState<BranchDiffSummary | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [merging, setMerging]   = useState(false)
  const [inConflictResolution, setInConflictResolution] = useState(false)
  const [preselectedChoices, setPreselectedChoices] = useState<Record<string, 'ours' | 'theirs'>>({})
  const [recoveredMergeBranch, setRecoveredMergeBranch] = useState<string | null>(null)
  const opRun = useOperationStore(s => s.run)
  const displayMergeBranch = recoveredMergeBranch ?? targetBranch
  // Auto-resolved files don't need a choice — git already wrote one to the
  // index and the user can opt-in to override. Only truly unmerged files
  // (with stages 1/2/3) gate "Complete merge".
  const unresolvedFiles = conflicts.filter(c => !c.autoResolved)
  const allChoicesMade = unresolvedFiles.length > 0 && unresolvedFiles.every(c => preselectedChoices[c.path])
  // A merge can already be in progress with zero unresolved files — e.g. git
  // auto-resolved everything but stopped before committing. In that case the
  // user just needs to finalize; there are no per-file choices required.
  const canFinalizeWithoutChoices = inConflictResolution && unresolvedFiles.length === 0

  useEffect(() => {
    if (!repoPath) return
    setLoading(true)
    setError(null)

    // If a merge is already in progress (e.g. "Update from main" hit binary
    // conflicts and bailed), jump straight to conflict-resolution mode against
    // the existing MERGE_HEAD. Re-running the merge would just fail with
    // "MERGE_HEAD exists" and never let the user resolve anything.
    ipc.mergeInProgress(repoPath)
      .then(async (inProgress) => {
        if (inProgress) {
          setRecoveredMergeBranch(inProgress.mergedBranch)
          setConflicts(inProgress.conflicts)
          setInConflictResolution(true)
          setLoading(false)
          return
        }

        const [preview, forwardDiff, reverseDiff] = await Promise.all([
          opRun(`Analyzing merge with ${targetBranch}…`, () => ipc.mergePreview(repoPath, targetBranch)),
          ipc.branchDiff(repoPath, currentBranch, targetBranch),
          ipc.branchDiff(repoPath, targetBranch, currentBranch),
        ])
        setConflicts(preview)
        const forwardIncoming = forwardDiff.aheadCommits.length
        const reverseIncoming = reverseDiff.behindCommits.length
        const chosen = reverseIncoming > forwardIncoming
          ? {
              ...reverseDiff,
              aheadCommits: reverseDiff.behindCommits,
              behindCommits: reverseDiff.aheadCommits,
            }
          : forwardDiff
        setDiffSummary(chosen)
        setLoading(false)
      })
      .catch(e => {
        setError(String(e))
        setLoading(false)
      })
  }, [repoPath, targetBranch, currentBranch, opRun])

  const mergeCommitCount = diffSummary?.aheadCommits.length ?? 0
  const mergeFileCount = diffSummary?.files.length ?? 0

  const doMerge = async () => {
    if (!repoPath) return
    setMerging(true)
    setError(null)
    try {
      await opRun(`Merging ${targetBranch}…`, () => ipc.merge(repoPath, targetBranch))
      await refreshStatus()
      bumpSyncTick()
      onMerged()
      onClose()
    } catch (e) {
      const msg = String(e)
      if (msg.toLowerCase().includes('conflict')) {
        const status = await ipc.status(repoPath).catch(() => [])
        const conflictMap = new Map(conflicts.map(c => [c.path, c]))
        for (const file of status.filter(isUnmerged)) {
          if (!conflictMap.has(file.path)) {
            conflictMap.set(file.path, fallbackConflict(file.path, file, currentBranch, targetBranch))
          }
        }
        setConflicts([...conflictMap.values()])
        setInConflictResolution(true)
        setError(null)
      } else {
        setError(msg)
      }
      setMerging(false)
    }
  }

  // Apply the user's per-file ours/theirs choices, then commit the merge.
  // Resolves are idempotent — calling mergeResolveText for the same choice
  // twice just re-stages the same content — so we always resolve all files
  // here to honor whatever the user has selected most recently in the UI.
  const finalizeMerge = async () => {
    if (!repoPath) return
    setMerging(true)
    setError(null)
    try {
      for (const c of conflicts) {
        const choice = preselectedChoices[c.path]
        if (!choice) continue
        await opRun(`Resolving ${c.path}…`, () => ipc.mergeResolveText(repoPath, c.path, choice))
      }
      await opRun('Finalizing merge...', () => ipc.mergeContinue(repoPath, displayMergeBranch))
      await refreshStatus()
      bumpSyncTick()
      onMerged()
      onClose()
    } catch (e) {
      setError(String(e))
      setMerging(false)
    }
  }

  const abortMerge = async () => {
    if (!repoPath) return
    try {
      setError(null)
      await opRun('Aborting merge...', () => ipc.mergeAbort(repoPath))
      await refreshStatus()
      bumpSyncTick()
      onClose()
    } catch (e) {
      setError(String(e))
    }
  }

  const overlayDismiss = useDialogOverlayDismiss(onClose, !inConflictResolution)

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      {...overlayDismiss}
    >
      <div className="bg-lg-bg-elevated border border-lg-border rounded-lg shadow-2xl w-[640px] max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-lg-border shrink-0">
          <div>
            <div className="text-xs font-mono font-semibold text-lg-text-primary">
              Merge preview
            </div>
            <div className="text-[10px] font-mono text-lg-text-secondary mt-0.5">
              <span className="text-lg-accent">{displayMergeBranch}</span>
              {' → '}
              <span className="text-lg-success">{currentBranch}</span>
            </div>
          </div>
          <button
            onClick={inConflictResolution ? abortMerge : onClose}
            className="text-lg-text-secondary hover:text-lg-text-primary text-lg font-mono leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <span className="text-xs font-mono text-lg-text-secondary animate-pulse">
                Analyzing conflicts…
              </span>
            </div>
          )}

          {!loading && error && (
            <div className="px-4 py-4 text-xs font-mono text-lg-error whitespace-pre-wrap">
              {error}
            </div>
          )}

          {!loading && !error && conflicts.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <div className="text-lg-success text-2xl">✓</div>
              <div className="text-xs font-mono text-lg-text-primary font-semibold">
                {inConflictResolution ? 'Merge ready to finalize' : 'No conflicts'}
              </div>
              <div className="text-[10px] font-mono text-lg-text-secondary text-center max-w-sm">
                {inConflictResolution
                  ? 'A merge from this branch is already in progress and has no unresolved files. Complete it to commit, or abort to discard.'
                  : 'This merge can be applied cleanly.'}
              </div>
            </div>
          )}

          {!loading && !error && diffSummary && (
            <div className="border-y border-lg-border bg-lg-bg-primary/40">
              <div className="px-4 py-2 border-b border-lg-border/60 flex items-center justify-between gap-3">
                <div className="text-[10px] font-mono text-lg-text-secondary">Incoming changes from <span className="text-lg-accent">{displayMergeBranch}</span></div>
                <div className="text-[10px] font-mono text-lg-text-primary">
                  {mergeCommitCount} commit{mergeCommitCount !== 1 ? 's' : ''} · {mergeFileCount} file{mergeFileCount !== 1 ? 's' : ''}
                </div>
              </div>

              {mergeCommitCount === 0 && mergeFileCount === 0 ? (
                <div className="px-4 py-3 text-[10px] font-mono text-lg-text-secondary">
                  No changes to merge. Current branch already contains all commits from {displayMergeBranch}.
                </div>
              ) : (
                <div className="max-h-44 overflow-y-auto">
                  {diffSummary.files.map(file => (
                    <div key={file.path} className="px-4 py-1.5 border-b border-lg-border/40 flex items-center gap-3 text-[10px] font-mono">
                      <span className="w-4 shrink-0 text-lg-text-secondary">{file.status}</span>
                      <FilePathText path={file.path} className="flex-1 text-lg-text-primary truncate" />
                      <span className="shrink-0 text-lg-success">+{file.additions}</span>
                      <span className="shrink-0 text-lg-error">-{file.deletions}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!loading && !error && conflicts.length > 0 && (
            <div>
              <div className="px-4 py-2 border-b border-lg-border bg-lg-bg-secondary">
                <span className="text-[10px] font-mono text-lg-warning">
                  ⚠ {conflicts.length} file{conflicts.length !== 1 ? 's' : ''} will conflict
                  {conflicts.some(c => c.autoResolved) && (
                    <span className="ml-2 text-lg-text-secondary">
                      · {conflicts.filter(c => c.autoResolved).length} auto-resolved (review below)
                    </span>
                  )}
                </span>
              </div>
              {conflicts.map(file => (
                <div key={file.path} className="px-4 py-3 border-b border-lg-border/50">
                    {/* File name row */}
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm">{TYPE_ICON[file.type]}</span>
                      <FilePathText path={file.path} className="flex-1 text-xs font-mono text-lg-text-primary truncate" />
                      {file.autoResolved && (
                        <span
                          className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-mono bg-lg-accent/20 text-lg-accent"
                          title="Git auto-picked one side. Confirm or flip it before completing the merge."
                        >
                          Auto-resolved
                        </span>
                      )}
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
                        onClick={() => setPreselectedChoices(prev => ({ ...prev, [file.path]: choice }))}
                        className={cn(
                          'bg-lg-bg-secondary rounded px-2 py-1.5 space-y-0.5 text-left border transition-colors',
                          preselectedChoices[file.path] === choice
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
                        onClick={() => setPreselectedChoices(prev => ({ ...prev, [file.path]: 'ours' }))}
                        className={cn(
                          'px-2 h-6 text-[10px] font-mono border rounded',
                          preselectedChoices[file.path] === 'ours'
                            ? 'border-lg-success text-lg-success bg-lg-success/10'
                            : 'border-lg-border text-lg-text-secondary'
                        )}
                      >
                        Keep {currentBranch}
                      </button>
                      <button
                        onClick={() => setPreselectedChoices(prev => ({ ...prev, [file.path]: 'theirs' }))}
                        className={cn(
                          'px-2 h-6 text-[10px] font-mono border rounded',
                          preselectedChoices[file.path] === 'theirs'
                            ? 'border-lg-accent text-lg-accent bg-lg-accent/10'
                            : 'border-lg-border text-lg-text-secondary'
                        )}
                      >
                        Keep {displayMergeBranch}
                      </button>
                    </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}

        {!loading && !error && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-lg-border shrink-0 gap-3">
            {conflicts.length > 0 && (
              <div className="text-[10px] font-mono text-lg-text-secondary">
                {inConflictResolution
                  ? unresolvedFiles.length === 0
                    ? 'Git auto-resolved every conflict. Review the picks above (optional) and complete the merge.'
                    : allChoicesMade
                      ? 'All conflicts have a choice — complete the merge to commit.'
                      : `Pick a side for each conflicted file (${unresolvedFiles.filter(c => preselectedChoices[c.path]).length}/${unresolvedFiles.length} chosen).`
                  : 'Pick a preferred side for each file before merging.'}
              </div>
            )}
            {conflicts.length === 0 && <div />}
            <div className="flex gap-2 shrink-0">
              <ActionBtn
                onClick={inConflictResolution ? abortMerge : onClose}
                disabled={merging}
                color={inConflictResolution ? '#e84545' : undefined}
                size="sm"
                style={{ height: 28, paddingLeft: 12, paddingRight: 12, fontSize: 11, fontFamily: 'var(--lg-font-mono)' }}
              >
                {inConflictResolution ? 'Abort merge' : 'Cancel'}
              </ActionBtn>
              {inConflictResolution ? (
                <button
                  onClick={finalizeMerge}
                  disabled={merging || (!allChoicesMade && !canFinalizeWithoutChoices)}
                  className="px-3 h-7 rounded text-[11px] font-mono bg-lg-success/20 border border-lg-success/60 text-lg-success hover:bg-lg-success/30 transition-colors disabled:opacity-40"
                  title={!allChoicesMade && !canFinalizeWithoutChoices ? 'Pick a side for every conflicted file first' : undefined}
                >
                  {merging ? 'Completing merge…' : 'Complete merge'}
                </button>
              ) : (
                <button
                  onClick={doMerge}
                  disabled={merging}
                  className={cn(
                    'px-3 h-7 rounded text-[11px] font-mono transition-colors disabled:opacity-40',
                    conflicts.length > 0
                      ? 'bg-lg-warning/20 border border-lg-warning/60 text-lg-warning hover:bg-lg-warning/30'
                      : 'bg-lg-success/20 border border-lg-success/60 text-lg-success hover:bg-lg-success/30'
                  )}
                >
                  {merging ? 'Merging…' : 'Merge'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
