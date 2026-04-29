import React, { useState, useRef, useEffect } from 'react'
import { BranchInfo, BranchDiffSummary, ipc } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { useDialogStore } from '@/stores/dialogStore'
import { usePRStore } from '@/stores/prStore'
import { cn } from '@/lib/utils'

interface BranchPanelProps {
  onMergePreview: (targetBranch: string) => void
  onRefresh: () => void
}

function parseGitHubSlug(remoteUrl: string): string | null {
  const m = remoteUrl.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

function TrackPill({ n, dir }: { n: number; dir: 'ahead' | 'behind' }) {
  if (n === 0) return null
  return (
    <span className={cn(
      'shrink-0 px-1 rounded text-[9px] font-mono leading-4',
      dir === 'ahead' ? 'text-lg-success bg-lg-success/10' : 'text-lg-warning bg-lg-warning/10'
    )}>
      {dir === 'ahead' ? '↑' : '↓'}{n}
    </span>
  )
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1 bg-lg-bg-secondary border-b border-lg-border">
      <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary flex-1">
        {label}
      </span>
      <span className="text-[9px] font-mono text-lg-text-secondary/60">{count}</span>
    </div>
  )
}

export function BranchPanel({ onMergePreview, onRefresh }: BranchPanelProps) {
  const { repoPath, branches, currentBranch, checkout, loadBranches, fileStatus } = useRepoStore()
  const opRun  = useOperationStore(s => s.run)
  const dialog = useDialogStore()

  const [newName, setNewName]               = useState('')
  const [creating, setCreating]             = useState(false)
  const [renamingBranch, setRenamingBranch] = useState<string | null>(null)
  const [renameValue, setRenameValue]       = useState('')
  const [busy, setBusy]                     = useState<string | null>(null)
  const [error, setError]                   = useState<string | null>(null)
  const [updatingMain, setUpdatingMain]     = useState(false)
  const [remoteUrl, setRemoteUrl]           = useState<string | null>(null)
  const [previewBranch, setPreviewBranch]   = useState<string | null>(null)
  const [switchConfirm, setSwitchConfirm]   = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const hasChanges = fileStatus.length > 0

  useEffect(() => {
    if (!repoPath) return
    ipc.getRemoteUrl(repoPath).then(setRemoteUrl).catch(() => {})
  }, [repoPath])

  useEffect(() => {
    if (renamingBranch) renameInputRef.current?.select()
  }, [renamingBranch])

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await loadBranches()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  // ── Create ──────────────────────────────────────────────────────────────
  const doCreate = async () => {
    const name = newName.trim()
    if (!name || !repoPath) return
    setCreating(true)
    setError(null)
    try {
      await opRun(`Creating branch ${name}…`, () => ipc.createBranch(repoPath, name))
      setNewName('')
      await loadBranches()
      onRefresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setCreating(false)
    }
  }

  // ── Local branch actions ─────────────────────────────────────────────────
  const doCheckoutLocal = (branch: BranchInfo) => {
    if (branch.current || busy) return
    if (hasChanges) {
      setSwitchConfirm(branch.name)
    } else {
      executeSwitchTo(branch.name, false)
    }
  }

  const executeSwitchTo = async (branchName: string, stash: boolean) => {
    setSwitchConfirm(null)
    await withBusy(branchName, async () => {
      if (stash && repoPath) await ipc.stashSave(repoPath, `Auto-stash before switching to ${branchName}`)
      await checkout(branchName)
    })
    setPreviewBranch(null)
    onRefresh()
  }

  const startRename = (branch: BranchInfo) => {
    setRenamingBranch(branch.name)
    setRenameValue(branch.name)
  }

  const doRename = async (oldName: string) => {
    const newVal = renameValue.trim()
    setRenamingBranch(null)
    if (!newVal || newVal === oldName || !repoPath) return
    await withBusy(oldName, () => ipc.renameBranch(repoPath, oldName, newVal))
  }

  const doDeleteLocal = async (branch: BranchInfo) => {
    if (!repoPath) return
    const ok = await dialog.confirm({ title: 'Delete local branch', message: `Delete "${branch.name}"?`, confirmLabel: 'Delete', danger: true })
    if (!ok) return
    setBusy(branch.name)
    setError(null)
    try {
      await ipc.deleteBranch(repoPath, branch.name, false)
      await loadBranches()
    } catch (e) {
      const msg = String(e)
      if (msg.includes('not fully merged') || msg.includes('unmerged')) {
        const force = await dialog.confirm({ title: 'Branch not fully merged', message: `"${branch.name}" has unmerged commits. Force-delete anyway?`, confirmLabel: 'Force Delete', danger: true })
        if (force) {
          try { await ipc.deleteBranch(repoPath, branch.name, true); await loadBranches() }
          catch (e2) { setError(String(e2)) }
        }
      } else {
        setError(msg)
      }
    } finally {
      setBusy(null)
    }
  }

  // ── Remote branch actions ────────────────────────────────────────────────
  const doCheckoutRemote = (branch: BranchInfo) => {
    if (!repoPath || busy) return
    if (hasChanges) {
      setSwitchConfirm(branch.displayName)
    } else {
      executeSwitchTo(branch.displayName, false)
    }
  }

  const doDeleteRemote = async (branch: BranchInfo) => {
    if (!repoPath || !branch.remoteName) return
    const ok = await dialog.confirm({ title: 'Delete remote branch', message: `Delete "${branch.name}" from remote?`, detail: 'This cannot be undone.', confirmLabel: 'Delete Remote', danger: true })
    if (!ok) return
    await withBusy(branch.name, () =>
      opRun(`Deleting ${branch.name}…`, () =>
        ipc.deleteRemoteBranch(repoPath, branch.remoteName!, branch.displayName)
      )
    )
  }

  // ── Update from main ─────────────────────────────────────────────────────
  const doUpdateFromMain = async () => {
    if (!repoPath) return
    setUpdatingMain(true)
    setError(null)
    try {
      await opRun('Updating from main…', () => ipc.updateFromMain(repoPath))
      await loadBranches()
      onRefresh()
    } catch (e) {
      setError(String(e))
    } finally {
      setUpdatingMain(false)
    }
  }

  const openPRDialog = usePRStore(s => s.openDialog)

  const openPR = (branchName: string) => {
    if (!remoteUrl || !repoPath) return
    if (!parseGitHubSlug(remoteUrl)) return
    openPRDialog(repoPath, branchName, remoteUrl)
  }

  const ghSlug = remoteUrl ? parseGitHubSlug(remoteUrl) : null

  const localBranches  = branches.filter(b => !b.isRemote)
    .sort((a, b) => (a.current ? -1 : b.current ? 1 : a.name.localeCompare(b.name)))
  const remoteBranches = branches.filter(b => b.isRemote)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))

  return (
    <div className="flex-1 flex flex-col overflow-hidden">

      {/* ── Stash/keep dialog ──────────────────────────────────────────── */}
      {switchConfirm && (
        <BranchStashDialog
          from={currentBranch}
          to={switchConfirm}
          onConfirm={stash => executeSwitchTo(switchConfirm, stash)}
          onCancel={() => setSwitchConfirm(null)}
        />
      )}

      {/* ── Create branch ──────────────────────────────────────────────── */}
      <div className="px-3 py-2 border-b border-lg-border shrink-0 space-y-1.5">
        <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">
          New branch
        </span>
        <div className="flex gap-1">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && doCreate()}
            placeholder="branch-name"
            className="flex-1 min-w-0 bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary placeholder:text-lg-text-secondary focus:outline-none focus:border-lg-accent transition-colors"
          />
          <button
            onClick={doCreate}
            disabled={!newName.trim() || creating}
            className="shrink-0 px-2 h-7 rounded text-[10px] font-mono border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent disabled:opacity-40 transition-colors"
          >
            {creating ? '…' : '+ Create'}
          </button>
        </div>
      </div>

      {/* ── Error banner ───────────────────────────────────────────────── */}
      {error && (
        <div className="px-3 py-1.5 text-[10px] font-mono text-lg-error bg-lg-error/10 border-b border-lg-border shrink-0 whitespace-pre-wrap">
          {error}
        </div>
      )}

      {/* ── Scrollable branch lists ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">

        {/* ── LOCAL ──────────────────────────────────────────────────────── */}
        <SectionHeader label="Local" count={localBranches.length} />

        {localBranches.length === 0 && (
          <div className="px-3 py-3 text-[10px] font-mono text-lg-text-secondary">No local branches</div>
        )}

        {localBranches.map(branch => {
          const isRenaming  = renamingBranch === branch.name
          const isBusy      = busy === branch.name
          const isPreviewed = previewBranch === branch.name
          return (
            <React.Fragment key={branch.name}>
              <div
                onClick={() => { if (!branch.current && !isRenaming) setPreviewBranch(isPreviewed ? null : branch.name) }}
                className={cn(
                  'group flex items-center gap-1.5 px-3 py-2 border-b border-lg-border/40 transition-colors min-w-0',
                  branch.current   ? 'bg-lg-bg-elevated cursor-default' :
                  isPreviewed      ? 'bg-lg-bg-elevated/80 cursor-pointer' :
                  'hover:bg-lg-bg-elevated/60 cursor-pointer'
                )}
              >
                {/* Current dot */}
                <span className={cn(
                  'shrink-0 w-1.5 h-1.5 rounded-full',
                  branch.current ? 'bg-lg-accent' : isPreviewed ? 'bg-lg-accent/50' : 'bg-lg-border group-hover:bg-lg-text-secondary'
                )} />

                {/* Name / rename */}
                <div className="flex-1 min-w-0">
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter')  doRename(branch.name)
                        if (e.key === 'Escape') setRenamingBranch(null)
                      }}
                      onBlur={() => doRename(branch.name)}
                      className="w-full bg-lg-bg-primary border border-lg-accent rounded px-1 py-0 text-[11px] font-mono text-lg-text-primary focus:outline-none"
                    />
                  ) : (
                    <button
                      onClick={() => {
                        if (branch.current) return
                        setPreviewBranch(isPreviewed ? null : branch.name)
                      }}
                      className={cn(
                        'w-full text-left text-xs font-mono truncate transition-colors',
                        branch.current  ? 'text-lg-accent font-semibold cursor-default' :
                        isPreviewed     ? 'text-lg-accent' :
                        'text-lg-text-primary hover:text-lg-accent cursor-pointer'
                      )}
                      title={branch.current ? 'Current branch' : `Preview "${branch.name}"`}
                    >
                      {branch.name}
                    </button>
                  )}

                  {(branch.ahead > 0 || branch.behind > 0) && !isRenaming && (
                    <div className="flex gap-1 mt-0.5">
                      <TrackPill n={branch.ahead}  dir="ahead" />
                      <TrackPill n={branch.behind} dir="behind" />
                    </div>
                  )}
                </div>

                {isBusy && (
                  <span className="shrink-0 text-[9px] font-mono text-lg-text-secondary animate-pulse">…</span>
                )}

                {!isBusy && !isRenaming && (
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity shrink-0">
                    {ghSlug && (
                      <IconBtn title="Open PR on GitHub" onClick={() => openPR(branch.name)}>PR↗</IconBtn>
                    )}
                    {!branch.current && (
                      <IconBtn title={`Merge "${branch.name}" into ${currentBranch}`} onClick={() => onMergePreview(branch.name)}>
                        ↓merge
                      </IconBtn>
                    )}
                    <IconBtn title="Rename" onClick={() => startRename(branch)}>✎</IconBtn>
                    {!branch.current && (
                      <IconBtn title="Delete local branch" danger onClick={() => doDeleteLocal(branch)}>✕</IconBtn>
                    )}
                  </div>
                )}
              </div>

              {/* Inline diff preview */}
              {isPreviewed && (
                <BranchDiffPreview
                  repoPath={repoPath!}
                  base={currentBranch}
                  compare={branch.name}
                  onSwitch={() => doCheckoutLocal(branch)}
                  onClose={() => setPreviewBranch(null)}
                />
              )}
            </React.Fragment>
          )
        })}

        {/* ── ORIGIN (remote) ────────────────────────────────────────────── */}
        {remoteBranches.length > 0 && (
          <>
            <SectionHeader label="Origin" count={remoteBranches.length} />

            {remoteBranches.map(branch => {
              const isBusy = busy === branch.name
              return (
                <div
                  key={branch.name}
                  className="group flex items-center gap-1.5 px-3 py-2 border-b border-lg-border/40 hover:bg-lg-bg-elevated/40 transition-colors min-w-0"
                >
                  {/* Remote indicator */}
                  <span className="shrink-0 text-[9px] font-mono text-lg-text-secondary/50 leading-none">
                    ⇡
                  </span>

                  {/* Name + local indicator */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="text-xs font-mono text-lg-text-secondary truncate"
                        title={branch.name}
                      >
                        {branch.displayName}
                      </span>
                      {branch.hasLocal && (
                        <span className="shrink-0 text-[9px] font-mono text-lg-success/70" title="Local branch exists">
                          ✓ local
                        </span>
                      )}
                    </div>
                    <div className="text-[9px] font-mono text-lg-text-secondary/40 mt-0.5">
                      {branch.remoteName}/{branch.displayName}
                    </div>
                  </div>

                  {isBusy && (
                    <span className="shrink-0 text-[9px] font-mono text-lg-text-secondary animate-pulse">…</span>
                  )}

                  {!isBusy && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity shrink-0">
                      {ghSlug && (
                        <IconBtn title="Open PR on GitHub" onClick={() => openPR(branch.displayName)}>PR↗</IconBtn>
                      )}
                      {!branch.hasLocal && (
                        <IconBtn
                          title={`Checkout "${branch.displayName}" (creates local tracking branch)`}
                          onClick={() => doCheckoutRemote(branch)}
                        >
                          checkout
                        </IconBtn>
                      )}
                      {branch.hasLocal && (
                        <IconBtn
                          title={`Switch to local "${branch.displayName}"`}
                          onClick={() => {
                            const local = localBranches.find(b => b.name === branch.displayName)
                            if (local) doCheckoutLocal(local)
                          }}
                        >
                          switch
                        </IconBtn>
                      )}
                      <IconBtn
                        title={`Delete remote branch "${branch.name}"`}
                        danger
                        onClick={() => doDeleteRemote(branch)}
                      >
                        ✕
                      </IconBtn>
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}

        {remoteBranches.length === 0 && (
          <>
            <SectionHeader label="Origin" count={0} />
            <div className="px-3 py-3 text-[10px] font-mono text-lg-text-secondary">
              No remote branches — fetch to update
            </div>
          </>
        )}

      </div>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <div className="px-3 py-2 border-t border-lg-border shrink-0">
        <button
          onClick={doUpdateFromMain}
          disabled={updatingMain}
          className="w-full h-7 rounded text-[10px] font-mono border border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent disabled:opacity-40 transition-colors"
        >
          {updatingMain ? 'Updating…' : '↓ Update from main'}
        </button>
      </div>
    </div>
  )
}

function IconBtn({
  children, onClick, title, danger,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
  danger?: boolean
}) {
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick() }}
      title={title}
      className={cn(
        'px-1.5 h-5 rounded text-[9px] font-mono border transition-colors',
        danger
          ? 'border-lg-error/30 text-lg-error hover:bg-lg-error/10'
          : 'border-lg-border text-lg-text-secondary hover:border-lg-accent hover:text-lg-accent'
      )}
    >
      {children}
    </button>
  )
}

// ── Stash / keep dialog ────────────────────────────────────────────────────────

function BranchStashDialog({ from, to, onConfirm, onCancel }: {
  from: string; to: string
  onConfirm: (stash: boolean) => void
  onCancel: () => void
}) {
  const [stash, setStash] = React.useState(false)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div className="bg-lg-bg-elevated border border-lg-border rounded-lg shadow-2xl w-80 p-5" style={{ animation: 'slide-down 0.16s ease both' }}>
        <div className="text-sm font-semibold text-lg-text-primary mb-2">Uncommitted Changes</div>
        <div className="text-xs text-lg-text-secondary mb-4 leading-relaxed">
          You have uncommitted changes. What should happen to them when switching from{' '}
          <span className="font-mono text-[#f5a832]">{from}</span> to{' '}
          <span className="font-mono text-lg-accent">{to}</span>?
        </div>

        <div className="border border-lg-border rounded-md overflow-hidden mb-4">
          {[
            { value: false, label: 'Bring changes over', desc: 'Carry changes to the new branch' },
            { value: true,  label: 'Stash changes',      desc: 'Stash changes, switch cleanly' },
          ].map(opt => (
            <label
              key={String(opt.value)}
              className={cn(
                'flex items-start gap-2.5 px-3 py-2.5 cursor-pointer transition-colors',
                opt.value ? '' : 'border-b border-lg-border',
                stash === opt.value ? 'bg-lg-accent/5' : 'hover:bg-white/[0.03]'
              )}
            >
              <input
                type="radio"
                checked={stash === opt.value}
                onChange={() => setStash(opt.value)}
                className="mt-0.5 accent-lg-accent cursor-pointer"
              />
              <div>
                <div className="text-xs font-medium text-lg-text-primary">{opt.label}</div>
                <div className="text-[10px] text-lg-text-secondary mt-0.5">{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 h-7 rounded text-xs border border-lg-border text-lg-text-secondary hover:bg-white/[0.04] transition-colors">
            Cancel
          </button>
          <button onClick={() => onConfirm(stash)} className="px-3 h-7 rounded text-xs border border-lg-accent/40 bg-lg-accent/10 text-lg-accent font-semibold hover:bg-lg-accent/20 transition-colors">
            Switch Branch
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Branch diff preview panel ──────────────────────────────────────────────────

function BranchDiffPreview({ repoPath, base, compare, onSwitch, onClose }: {
  repoPath: string; base: string; compare: string
  onSwitch: () => void; onClose: () => void
}) {
  const [diff, setDiff]       = useState<BranchDiffSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [showAllFiles, setShowAllFiles]       = useState(false)
  const [showAheadLog, setShowAheadLog]       = useState(false)
  const [showBehindLog, setShowBehindLog]     = useState(false)

  useEffect(() => {
    setLoading(true); setError(null); setDiff(null)
    ipc.branchDiff(repoPath, base, compare)
      .then(setDiff)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [repoPath, base, compare])

  const statusColor = (s: string) =>
    s === 'A' ? '#2dbd6e' : s === 'D' ? '#e84040' : s === 'R' || s === 'C' ? '#a27ef0' : '#f5a832'
  const statusLabel = (s: string) =>
    s === 'A' ? 'A' : s === 'D' ? 'D' : s === 'R' ? 'R' : s === 'C' ? 'C' : 'M'
  const fmt = (n: number) => n.toLocaleString()

  const FILES_LIMIT = 8

  return (
    <div className="border-b border-lg-border bg-lg-bg-primary/60">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-lg-border/60">
        <span className="text-[10px] font-mono text-lg-text-secondary uppercase tracking-wider">
          {base} ↔ {compare}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onSwitch}
            className="px-2 h-5 rounded text-[9px] font-mono border border-lg-accent/40 bg-lg-accent/10 text-lg-accent hover:bg-lg-accent/20 transition-colors"
          >
            → switch
          </button>
          <button onClick={onClose} className="text-lg-text-secondary/50 hover:text-lg-text-secondary text-xs leading-none px-1">✕</button>
        </div>
      </div>

      {loading && (
        <div className="px-3 py-3 text-[10px] font-mono text-lg-text-secondary animate-pulse">Loading diff…</div>
      )}

      {error && (
        <div className="px-3 py-2 text-[10px] font-mono text-lg-error">{error}</div>
      )}

      {diff && (
        <div className="px-3 py-2 space-y-2.5">

          {/* Commit counts */}
          <div className="flex gap-2">
            <button
              onClick={() => setShowAheadLog(v => !v)}
              disabled={diff.aheadCommits.length === 0}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded border text-[10px] font-mono transition-colors',
                diff.aheadCommits.length > 0
                  ? 'border-lg-success/30 text-lg-success bg-lg-success/5 hover:bg-lg-success/10 cursor-pointer'
                  : 'border-lg-border text-lg-text-secondary/40 cursor-default'
              )}
            >
              <span>↑ {diff.aheadCommits.length} ahead</span>
            </button>
            <button
              onClick={() => setShowBehindLog(v => !v)}
              disabled={diff.behindCommits.length === 0}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded border text-[10px] font-mono transition-colors',
                diff.behindCommits.length > 0
                  ? 'border-lg-warning/30 text-lg-warning bg-lg-warning/5 hover:bg-lg-warning/10 cursor-pointer'
                  : 'border-lg-border text-lg-text-secondary/40 cursor-default'
              )}
            >
              <span>↓ {diff.behindCommits.length} behind</span>
            </button>
          </div>

          {/* Ahead commits */}
          {showAheadLog && diff.aheadCommits.length > 0 && (
            <div className="space-y-0.5">
              {diff.aheadCommits.slice(0, 10).map(c => (
                <div key={c.hash} className="flex items-start gap-1.5 py-0.5">
                  <span className="font-mono text-[9px] text-lg-text-secondary/50 shrink-0 mt-0.5">{c.hash.slice(0,6)}</span>
                  <span className="text-[10px] text-lg-text-primary truncate">{c.message}</span>
                </div>
              ))}
              {diff.aheadCommits.length > 10 && (
                <div className="text-[9px] font-mono text-lg-text-secondary/50">+{diff.aheadCommits.length - 10} more</div>
              )}
            </div>
          )}

          {/* Behind commits */}
          {showBehindLog && diff.behindCommits.length > 0 && (
            <div className="space-y-0.5">
              {diff.behindCommits.slice(0, 10).map(c => (
                <div key={c.hash} className="flex items-start gap-1.5 py-0.5">
                  <span className="font-mono text-[9px] text-lg-text-secondary/50 shrink-0 mt-0.5">{c.hash.slice(0,6)}</span>
                  <span className="text-[10px] text-lg-text-primary truncate">{c.message}</span>
                </div>
              ))}
              {diff.behindCommits.length > 10 && (
                <div className="text-[9px] font-mono text-lg-text-secondary/50">+{diff.behindCommits.length - 10} more</div>
              )}
            </div>
          )}

          {/* File change summary */}
          {diff.files.length > 0 && (
            <div>
              {/* Totals bar */}
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] font-mono text-lg-text-secondary uppercase tracking-wider">
                  {diff.files.length} file{diff.files.length !== 1 ? 's' : ''} changed
                </span>
                <span className="text-[9px] font-mono">
                  <span className="text-lg-success">+{fmt(diff.totalAdditions)}</span>
                  <span className="text-lg-text-secondary/40 mx-0.5">/</span>
                  <span className="text-lg-error">-{fmt(diff.totalDeletions)}</span>
                </span>
              </div>

              {/* File list */}
              <div className="space-y-px">
                {(showAllFiles ? diff.files : diff.files.slice(0, FILES_LIMIT)).map(f => (
                  <div key={f.path} className="flex items-center gap-1.5 py-0.5">
                    <span
                      className="shrink-0 w-3.5 text-center text-[9px] font-mono font-bold"
                      style={{ color: statusColor(f.status) }}
                    >
                      {statusLabel(f.status)}
                    </span>
                    <span className="flex-1 text-[10px] font-mono text-lg-text-secondary truncate" title={f.path}>
                      {f.path.split('/').pop() ?? f.path}
                    </span>
                    <span className="shrink-0 text-[9px] font-mono text-lg-success">+{f.additions}</span>
                    <span className="shrink-0 text-[9px] font-mono text-lg-error">-{f.deletions}</span>
                  </div>
                ))}
              </div>

              {diff.files.length > FILES_LIMIT && (
                <button
                  onClick={() => setShowAllFiles(v => !v)}
                  className="mt-1 text-[9px] font-mono text-lg-text-secondary/60 hover:text-lg-text-secondary transition-colors"
                >
                  {showAllFiles ? '↑ show less' : `↓ ${diff.files.length - FILES_LIMIT} more files`}
                </button>
              )}
            </div>
          )}

          {diff.files.length === 0 && diff.aheadCommits.length === 0 && diff.behindCommits.length === 0 && (
            <div className="text-[10px] font-mono text-lg-text-secondary/50 py-1">Branches are identical</div>
          )}
        </div>
      )}
    </div>
  )
}
