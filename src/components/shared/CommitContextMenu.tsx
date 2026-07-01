import React, { useEffect, useRef } from 'react'
import { ipc, CommitEntry } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useRepoStore } from '@/stores/repoStore'
import { AppRightSelectionItem, AppRightSelectionOptions, AppRightSelectionSeparator } from '@/components/ui/AppRightSelectionOptions'

function parseGitHubSlug(url: string): string | null {
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

// Right-click menu for a single commit: undo/reset/checkout/revert/branch/
// cherry-pick + copy SHA / view on GitHub. Shared between the History graph
// and any other place that lists commits (e.g. a file's commit history).
export function CommitContextMenu({ commit, repoPath, remoteUrl, x, y, onClose, onRefresh }: {
  commit: CommitEntry
  repoPath: string
  remoteUrl: string | null
  x: number
  y: number
  onClose: () => void
  onRefresh: () => void
}) {
  const dialog = useDialogStore()
  const opRun  = useOperationStore(s => s.run)
  const bumpSyncTick = useRepoStore(s => s.bumpSyncTick)
  const menuRef   = useRef<HTMLDivElement>(null)
  const shortHash = commit.hash.slice(0, 7)
  const ghSlug    = remoteUrl ? parseGitHubSlug(remoteUrl) : null

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const handleResetTo = async () => {
    onClose()
    const mode = await dialog.prompt({
      title: `Reset to ${shortHash}`,
      message: 'soft — keep changes staged\nmixed — keep changes unstaged\nhard — discard all changes',
      placeholder: 'soft / mixed / hard',
      defaultValue: 'mixed',
      confirmLabel: 'Reset',
    })
    if (!mode) return
    const m = mode.trim().toLowerCase()
    if (m !== 'soft' && m !== 'mixed' && m !== 'hard') {
      await dialog.alert({ title: 'Invalid mode', message: `"${mode}" is not valid. Enter soft, mixed, or hard.` })
      return
    }
    try {
      await opRun(`Resetting to ${shortHash} (${m})…`, () => ipc.gitResetTo(repoPath, commit.hash, m as 'soft' | 'mixed' | 'hard'))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Reset failed', message: String(e) }) }
  }

  const handleCheckout = async () => {
    onClose()
    const ok = await dialog.confirm({
      title: 'Checkout commit',
      message: `Checkout ${shortHash}?`,
      detail: 'This creates a detached HEAD state. Create a branch if you want to keep changes from here.',
      confirmLabel: 'Checkout',
    })
    if (!ok) return
    try {
      await opRun('Checking out commit…', () => ipc.checkout(repoPath, commit.hash))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Checkout failed', message: String(e) }) }
  }

  const handleRevert = async () => {
    onClose()
    const ok = await dialog.confirm({
      title: 'Revert commit',
      message: `Create a new commit that undoes ${shortHash}?`,
      detail: commit.message,
      confirmLabel: 'Revert',
    })
    if (!ok) return
    try {
      await opRun('Reverting commit…', () => ipc.gitRevert(repoPath, commit.hash, false))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Revert failed', message: String(e) }) }
  }

  const handleCreateBranch = async () => {
    onClose()
    const name = await dialog.prompt({
      title: 'Create branch from commit',
      message: `New branch starting at ${shortHash}`,
      placeholder: 'branch-name',
      confirmLabel: 'Create',
    })
    if (!name?.trim()) return
    try {
      await opRun('Creating branch…', () => ipc.createBranch(repoPath, name.trim(), commit.hash))
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Failed to create branch', message: String(e) }) }
  }

  const handleCherryPick = async () => {
    onClose()
    const ok = await dialog.confirm({
      title: 'Cherry-pick commit',
      message: `Apply changes from ${shortHash} onto the current branch?`,
      detail: commit.message,
      confirmLabel: 'Cherry-pick',
    })
    if (!ok) return
    try {
      await opRun('Cherry-picking…', () => ipc.gitCherryPick(repoPath, commit.hash))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Cherry-pick failed', message: String(e) }) }
  }

  const handleUndoCommit = async () => {
    onClose()
    if (commit.parentHashes.length === 0) {
      await dialog.alert({ title: 'Cannot undo', message: 'This is the initial commit and has no parent to reset to.' })
      return
    }
    const ok = await dialog.confirm({
      title: 'Undo commit',
      message: `Undo "${commit.message.slice(0, 60)}"?`,
      detail: `This will soft-reset HEAD to the parent commit (${commit.parentHashes[0].slice(0, 7)}), keeping all changes staged. Only use this on the topmost commit.`,
      confirmLabel: 'Undo commit',
    })
    if (!ok) return
    try {
      await opRun('Undoing commit…', () => ipc.gitResetTo(repoPath, commit.parentHashes[0], 'soft'))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Undo failed', message: String(e) }) }
  }

  const handleCopySHA = () => { onClose(); navigator.clipboard.writeText(commit.hash) }

  const handleViewOnGitHub = () => {
    onClose()
    if (ghSlug) ipc.openExternal(`https://github.com/${ghSlug}/commit/${commit.hash}`)
  }

  return (
    <AppRightSelectionOptions x={x} y={y} minWidth={230} menuRef={menuRef}>
      <AppRightSelectionItem label="Undo commit (soft reset)"      onClick={handleUndoCommit} />
      <AppRightSelectionItem label="Reset to commit…"            onClick={handleResetTo}    danger />
      <AppRightSelectionItem label="Checkout commit"             onClick={handleCheckout} />
      <AppRightSelectionSeparator />
      <AppRightSelectionItem label="Revert changes in commit"    onClick={handleRevert} />
      <AppRightSelectionItem label="Create branch from commit…"  onClick={handleCreateBranch} />
      <AppRightSelectionItem label="Cherry-pick commit…"         onClick={handleCherryPick} />
      <AppRightSelectionSeparator />
      <AppRightSelectionItem label="Copy SHA"                    onClick={handleCopySHA} />
      <AppRightSelectionItem
        label="View on GitHub"
        onClick={ghSlug ? handleViewOnGitHub : undefined}
        disabled={!ghSlug}
        title={ghSlug ? undefined : 'No GitHub remote detected'}
      />
    </AppRightSelectionOptions>
  )
}
