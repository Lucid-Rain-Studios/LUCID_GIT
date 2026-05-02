import React, { useEffect, useState } from 'react'
import { ipc, BranchDiffSummary, ConflictPreviewFile, MergeConflictText } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { cn } from '@/lib/utils'

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

export function MergePreviewDialog({ targetBranch, onClose, onMerged }: MergePreviewDialogProps) {
  const { repoPath, currentBranch, refreshStatus } = useRepoStore()

  const [loading, setLoading]   = useState(true)
  const [conflicts, setConflicts] = useState<ConflictPreviewFile[]>([])
  const [diffSummary, setDiffSummary] = useState<BranchDiffSummary | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [merging, setMerging]   = useState(false)
  const [inConflictResolution, setInConflictResolution] = useState(false)
  const [textByFile, setTextByFile] = useState<Record<string, MergeConflictText>>({})
  const [resolvedFiles, setResolvedFiles] = useState<Record<string, 'ours' | 'theirs'>>({})
  const [preselectedChoices, setPreselectedChoices] = useState<Record<string, 'ours' | 'theirs'>>({})
  const opRun = useOperationStore(s => s.run)

  useEffect(() => {
    if (!repoPath) return
    setLoading(true)
    setError(null)
    Promise.all([
      opRun(`Analyzing merge with ${targetBranch}…`, () => ipc.mergePreview(repoPath, targetBranch)),
      ipc.branchDiff(repoPath, currentBranch, targetBranch),
      ipc.branchDiff(repoPath, targetBranch, currentBranch),
    ])
      .then(([preview, forwardDiff, reverseDiff]) => {
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
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
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
      onMerged()
      onClose()
    } catch (e) {
      const msg = String(e)
      if (msg.toLowerCase().includes('conflict')) {
        setInConflictResolution(true)
        const loaded: Record<string, MergeConflictText> = {}
        await Promise.all(conflicts.filter(c => c.conflictType === 'content').map(async c => {
          try {
            loaded[c.path] = await ipc.mergeGetConflictText(repoPath, c.path)
          } catch {
            loaded[c.path] = { ours: '(Unable to load ours)', theirs: '(Unable to load theirs)' }
          }
        }))
        setTextByFile(loaded)
        setError(null)

        const selectedEntries = Object.entries(preselectedChoices)
        if (selectedEntries.length > 0) {
          for (const [filePath, choice] of selectedEntries) {
            await opRun(`Resolving ${filePath}…`, () => ipc.mergeResolveText(repoPath, filePath, choice))
          }
          setResolvedFiles(prev => ({ ...prev, ...preselectedChoices }))
        }
      } else {
        setError(msg)
      }
      setMerging(false)
    }
  }

  const resolveFile = async (filePath: string, choice: 'ours' | 'theirs') => {
    if (!repoPath) return
    try {
      await opRun(`Resolving ${filePath}…`, () => ipc.mergeResolveText(repoPath, filePath, choice))
      setResolvedFiles(prev => ({ ...prev, [filePath]: choice }))
    } catch (e) {
      setError(String(e))
    }
  }

  const finalizeMerge = async () => {
    if (!repoPath) return
    await opRun('Finalizing merge…', () => ipc.mergeContinue(repoPath, targetBranch))
    await refreshStatus()
    onMerged()
    onClose()
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-lg-bg-elevated border border-lg-border rounded-lg shadow-2xl w-[640px] max-h-[80vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-lg-border shrink-0">
          <div>
            <div className="text-xs font-mono font-semibold text-lg-text-primary">
              Merge preview
            </div>
            <div className="text-[10px] font-mono text-lg-text-secondary mt-0.5">
              <span className="text-lg-accent">{targetBranch}</span>
              {' → '}
              <span className="text-lg-success">{currentBranch}</span>
            </div>
          </div>
          <button
            onClick={onClose}
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
              <div className="text-xs font-mono text-lg-text-primary font-semibold">No conflicts</div>
              <div className="text-[10px] font-mono text-lg-text-secondary">
                This merge can be applied cleanly.
              </div>
            </div>
          )}

          {!loading && !error && diffSummary && (
            <div className="border-y border-lg-border bg-lg-bg-primary/40">
              <div className="px-4 py-2 border-b border-lg-border/60 flex items-center justify-between gap-3">
                <div className="text-[10px] font-mono text-lg-text-secondary">Incoming changes from <span className="text-lg-accent">{targetBranch}</span></div>
                <div className="text-[10px] font-mono text-lg-text-primary">
                  {mergeCommitCount} commit{mergeCommitCount !== 1 ? 's' : ''} · {mergeFileCount} file{mergeFileCount !== 1 ? 's' : ''}
                </div>
              </div>

              {mergeCommitCount === 0 && mergeFileCount === 0 ? (
                <div className="px-4 py-3 text-[10px] font-mono text-lg-text-secondary">
                  No changes to merge. Current branch already contains all commits from {targetBranch}.
                </div>
              ) : (
                <div className="max-h-44 overflow-y-auto">
                  {diffSummary.files.map(file => (
                    <div key={file.path} className="px-4 py-1.5 border-b border-lg-border/40 flex items-center gap-3 text-[10px] font-mono">
                      <span className="w-4 shrink-0 text-lg-text-secondary">{file.status}</span>
                      <span className="flex-1 text-lg-text-primary truncate" title={file.path}>{file.path}</span>
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
                </span>
              </div>
              {conflicts.map(file => (
                <div key={file.path} className="px-4 py-3 border-b border-lg-border/50">
                  {/* File name row */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm">{TYPE_ICON[file.type]}</span>
                    <span className="flex-1 text-xs font-mono text-lg-text-primary truncate" title={file.path}>
                      {file.path}
                    </span>
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

                  {/* Contributor comparison */}
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { label: 'Ours', info: file.ours },
                      { label: 'Theirs', info: file.theirs },
                    ] as const).map(({ label, info }) => (
                      <div key={label} className="bg-lg-bg-secondary rounded px-2 py-1.5 space-y-0.5">
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
                      </div>
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
                      Keep {targetBranch}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {inConflictResolution && (
          <div className="border-t border-lg-border bg-lg-bg-secondary/50 px-4 py-3 space-y-3">
            <div className="text-[11px] font-mono text-lg-warning">Resolve merge conflicts</div>
            {conflicts.map(c => {
              const done = resolvedFiles[c.path]
              const text = textByFile[c.path]
              return (
                <div key={c.path} className="border border-lg-border rounded p-2 space-y-2">
                  <div className="text-[10px] font-mono text-lg-text-primary">{c.path}</div>
                  {c.conflictType === 'content' && (
                    <div className="grid grid-cols-2 gap-2">
                      <pre className="text-[9px] font-mono bg-lg-bg-primary rounded p-2 max-h-28 overflow-auto whitespace-pre-wrap">{text?.ours || ''}</pre>
                      <pre className="text-[9px] font-mono bg-lg-bg-primary rounded p-2 max-h-28 overflow-auto whitespace-pre-wrap">{text?.theirs || ''}</pre>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => resolveFile(c.path, 'ours')} className="px-2 h-6 text-[10px] font-mono border rounded border-lg-border">Accept ours</button>
                    <button onClick={() => resolveFile(c.path, 'theirs')} className="px-2 h-6 text-[10px] font-mono border rounded border-lg-border">Accept theirs</button>
                    {done && <span className="text-[10px] font-mono text-lg-success">Resolved with {done}</span>}
                  </div>
                </div>
              )
            })}
            <button onClick={finalizeMerge} disabled={Object.keys(resolvedFiles).length < conflicts.length} className="px-3 h-7 rounded text-[11px] font-mono bg-lg-success/20 border border-lg-success/60 text-lg-success disabled:opacity-40">Finalize merge</button>
          </div>
        )}

        {/* Footer */}

        {!loading && !error && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-lg-border shrink-0 gap-3">
            {conflicts.length > 0 && (
              <div className="text-[10px] font-mono text-lg-text-secondary">
                Conflicting files will need manual resolution after merging.
              </div>
            )}
            {conflicts.length === 0 && <div />}
            <div className="flex gap-2 shrink-0">
              <button
                onClick={onClose}
                className="px-3 h-7 rounded text-[11px] font-mono border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={doMerge}
                disabled={merging || inConflictResolution}
                className={cn(
                  'px-3 h-7 rounded text-[11px] font-mono transition-colors disabled:opacity-40',
                  conflicts.length > 0
                    ? 'bg-lg-warning/20 border border-lg-warning/60 text-lg-warning hover:bg-lg-warning/30'
                    : 'bg-lg-success/20 border border-lg-success/60 text-lg-success hover:bg-lg-success/30'
                )}
              >
                {merging ? 'Merging…' : conflicts.length > 0 ? 'Merge anyway' : 'Merge'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
