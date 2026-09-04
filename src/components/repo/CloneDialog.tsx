import React, { useState } from 'react'
import { ipc, OperationStep, GitHubRepo } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { useAuthStore } from '@/stores/authStore'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'

interface CloneDialogProps {
  onClose: () => void
}

export function CloneDialog({ onClose }: CloneDialogProps) {
  const [url, setUrl]     = useState('')
  const [dir, setDir]     = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isCloning, setIsCloning] = useState(false)

  const [showPicker, setShowPicker]   = useState(false)
  const [repoFilter, setRepoFilter]   = useState('')
  const [repos, setRepos]             = useState<GitHubRepo[] | null>(null)
  const [reposLoading, setReposLoading] = useState(false)
  const [reposError, setReposError]   = useState<string | null>(null)

  const { start, updateStep, finish, latestStep } = useOperationStore()
  const { openRepo } = useRepoStore()
  const { currentAccountId } = useAuthStore()

  const browseDir = async () => {
    const selected = await ipc.openDirectory()
    if (selected) setDir(selected)
  }

  const togglePicker = async () => {
    if (showPicker) {
      setShowPicker(false)
      return
    }
    setShowPicker(true)
    if (repos !== null || reposLoading) return
    setReposLoading(true)
    setReposError(null)
    try {
      const list = await ipc.githubListRepos()
      setRepos(list)
    } catch (err) {
      setReposError(err instanceof Error ? err.message : 'Failed to load repositories')
    } finally {
      setReposLoading(false)
    }
  }

  const pickRepo = (repo: GitHubRepo) => {
    setUrl(repo.cloneUrl)
    setShowPicker(false)
    setRepoFilter('')
  }

  const filteredRepos = (repos ?? []).filter(r =>
    r.fullName.toLowerCase().includes(repoFilter.trim().toLowerCase())
  )

  const repoName = url.trim()
    ? (url.split('/').pop()?.replace(/\.git$/, '') || 'repo')
    : ''

  const targetDir = dir && repoName
    ? `${dir.replace(/\\/g, '/')}/${repoName}`
    : ''

  const handleClone = async () => {
    if (!url.trim() || !dir.trim()) {
      setError('Both URL and destination are required')
      return
    }

    setError(null)
    setIsCloning(true)
    start('Cloning repository')

    // Subscribe to progress for this operation
    const unsub = ipc.onOperationProgress((step: OperationStep) => updateStep(step))

    try {
      await ipc.clone({ url: url.trim(), dir: targetDir })
      finish()
      unsub()
      await openRepo(targetDir)
      onClose()
    } catch (err) {
      finish()
      unsub()
      setError(err instanceof Error ? err.message : 'Clone failed')
      setIsCloning(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isCloning && !showPicker) handleClone()
    if (e.key === 'Escape' && !isCloning) {
      if (showPicker) setShowPicker(false)
      else onClose()
    }
  }

  const overlayDismiss = useDialogOverlayDismiss(onClose, !isCloning)

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      {...overlayDismiss}
    >
      <div
        className="bg-lg-bg-elevated border border-lg-border rounded-lg w-[540px] shadow-2xl"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-lg-border">
          <span className="font-mono text-sm font-bold text-lg-text-primary">
            Clone Repository
          </span>
          <button
            onClick={onClose}
            disabled={isCloning}
            className="text-lg-text-secondary hover:text-lg-text-primary transition-colors text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* URL */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-mono text-lg-text-secondary uppercase tracking-wider">
                Repository URL
              </label>
              {currentAccountId && (
                <button
                  type="button"
                  onClick={togglePicker}
                  disabled={isCloning}
                  className="text-[11px] font-mono text-lg-accent hover:underline disabled:opacity-50"
                >
                  {showPicker ? 'Enter URL instead' : 'Browse your GitHub repos…'}
                </button>
              )}
            </div>

            {showPicker ? (
              <div className="border border-lg-border rounded bg-lg-bg-secondary">
                <input
                  type="text"
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  placeholder="Filter repositories…"
                  autoFocus
                  className="w-full bg-transparent border-b border-lg-border px-3 py-2 text-sm font-mono text-lg-text-primary placeholder:text-lg-text-secondary/40 focus:outline-none"
                />
                <div className="max-h-56 overflow-y-auto">
                  {reposLoading && (
                    <div className="px-3 py-3 text-xs font-mono text-lg-text-secondary">Loading repositories…</div>
                  )}
                  {reposError && (
                    <div className="px-3 py-3 text-xs font-mono text-lg-error">{reposError}</div>
                  )}
                  {!reposLoading && !reposError && filteredRepos.length === 0 && (
                    <div className="px-3 py-3 text-xs font-mono text-lg-text-secondary">No repositories found</div>
                  )}
                  {!reposLoading && !reposError && filteredRepos.map((repo) => (
                    <button
                      key={repo.fullName}
                      type="button"
                      onClick={() => pickRepo(repo)}
                      className="w-full text-left px-3 py-2 text-xs font-mono text-lg-text-primary hover:bg-lg-bg-elevated transition-colors flex items-center gap-2"
                    >
                      <span className="truncate flex-1">{repo.fullName}</span>
                      {repo.private && (
                        <span className="text-[10px] text-lg-text-secondary uppercase tracking-wider shrink-0">Private</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo.git"
                disabled={isCloning}
                autoFocus
                className="w-full bg-lg-bg-secondary border border-lg-border rounded px-3 py-2 text-sm font-mono text-lg-text-primary placeholder:text-lg-text-secondary/40 focus:outline-none focus:border-lg-accent transition-colors disabled:opacity-50"
              />
            )}
          </div>

          {/* Destination */}
          <div className="space-y-1">
            <label className="text-[11px] font-mono text-lg-text-secondary uppercase tracking-wider">
              Clone into
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder="Parent folder..."
                disabled={isCloning}
                className="flex-1 bg-lg-bg-secondary border border-lg-border rounded px-3 py-2 text-sm font-mono text-lg-text-primary placeholder:text-lg-text-secondary/40 focus:outline-none focus:border-lg-accent transition-colors disabled:opacity-50"
              />
              <ActionBtn
                onClick={browseDir}
                disabled={isCloning}
                style={{ paddingLeft: 12, paddingRight: 12, fontSize: 12, fontFamily: 'var(--lg-font-mono)' }}
              >
                Browse…
              </ActionBtn>
            </div>
            {targetDir && (
              <p className="text-[10px] font-mono text-lg-text-secondary">
                → {targetDir}
              </p>
            )}
          </div>

          {/* Progress */}
          {isCloning && latestStep && (
            <div className="bg-lg-bg-secondary border border-lg-border rounded px-3 py-2 space-y-1">
              <div className="text-xs font-mono text-lg-accent">{latestStep.label}</div>
              {latestStep.detail && (
                <div className="text-[10px] font-mono text-lg-text-secondary truncate">
                  {latestStep.detail}
                </div>
              )}
              {latestStep.progress !== undefined && (
                <div className="h-1 bg-lg-border rounded-full overflow-hidden">
                  <div
                    className="h-full bg-lg-accent rounded-full transition-all duration-300"
                    style={{ width: `${latestStep.progress}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-lg-error/10 border border-lg-error/40 rounded px-3 py-2 text-xs font-mono text-lg-error whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-lg-border">
          <ActionBtn
            onClick={onClose}
            disabled={isCloning}
            style={{ paddingLeft: 16, paddingRight: 16, fontSize: 12, fontFamily: 'var(--lg-font-mono)' }}
          >
            Cancel
          </ActionBtn>
          <ActionBtn
            onClick={handleClone}
            disabled={isCloning || !url.trim() || !dir.trim()}
            style={{ paddingLeft: 16, paddingRight: 16, fontSize: 12, fontFamily: 'var(--lg-font-mono)', fontWeight: 600 }}
          >
            {isCloning ? 'Cloning…' : 'Clone'}
          </ActionBtn>
        </div>
      </div>
    </div>
  )
}
