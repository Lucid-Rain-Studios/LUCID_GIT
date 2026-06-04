import React, { useEffect, useState } from 'react'
import { ipc } from '@/ipc'
import { usePRUnlockStore } from '@/stores/prUnlockStore'
import { useLockStore } from '@/stores/lockStore'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'
import { FilePathText } from '@/components/ui/FilePathText'

// Dialog that pops up automatically when a tracked PR is detected as merged.
// It offers to unlock the files that were merged in and that the user is NOT
// currently editing — files with uncommitted local changes are shown but kept
// locked so the user can keep working on them.
export function PRUnlockDialog() {
  const { dialogOpen, target, repoPath, closeDialog, markResolved, refresh } = usePRUnlockStore()
  const { unlockFile, locks } = useLockStore()

  const [unlocking, setUnlocking] = useState<Set<string>>(new Set())
  const [unlocked,  setUnlocked]  = useState<Set<string>>(new Set())

  // Reset transient state whenever a different target is shown.
  const targetKey = target ? (target.kind === 'pr' ? `pr-${target.prNumber}` : 'main') : null
  useEffect(() => {
    setUnlocking(new Set())
    setUnlocked(new Set())
  }, [targetKey])

  // Close on Escape (does not mark resolved — reopen via the dashboard pill).
  useEffect(() => {
    if (!dialogOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDialog() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogOpen, closeDialog])

  const overlayDismiss = useDialogOverlayDismiss(closeDialog)

  if (!dialogOpen || !target || !repoPath) return null

  const { availableToUnlock, containsLocalChanges } = target
  const isPr    = target.kind === 'pr'
  const prNumber = isPr ? target.prNumber : null
  const htmlUrl  = isPr ? target.htmlUrl  : ''

  // A file that's no longer in the live lock list was released elsewhere — treat
  // it as already unlocked rather than offering a no-op button.
  const liveLockedPaths = new Set(locks.map(l => l.path.replace(/\\/g, '/')))
  const isStillLocked = (p: string) => liveLockedPaths.has(p.replace(/\\/g, '/'))

  const isDone = (p: string) => unlocked.has(p) || !isStillLocked(p)
  const remaining = availableToUnlock.filter(p => !isDone(p))
  const allUnlocked = availableToUnlock.length > 0 && remaining.length === 0

  const handleUnlock = async (filePath: string) => {
    if (unlocking.has(filePath) || isDone(filePath)) return
    setUnlocking(prev => new Set([...prev, filePath]))
    try {
      await unlockFile(repoPath, filePath)
      setUnlocked(prev => new Set([...prev, filePath]))
      refresh(repoPath).catch(() => {})
    } catch { /* surfaced via lock store error */ }
    setUnlocking(prev => { const s = new Set(prev); s.delete(filePath); return s })
  }

  const handleUnlockAll = async () => {
    await Promise.allSettled(remaining.map(p => handleUnlock(p)))
  }

  const handleDone = async () => {
    if (isPr && prNumber !== null) await markResolved(repoPath, prNumber)
    closeDialog()
  }

  return (
    <div
      {...overlayDismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--lg-font-ui)',
      }}
    >
      <div style={{
        width: 560, maxWidth: '94vw', background: '#131720',
        border: '1px solid #1e2a3d', borderRadius: 12,
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)', overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid #18202e', background: 'rgba(0,0,0,0.15)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span style={{ fontSize: 16, color: '#2dbd6e' }}>✓</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: '#c8d0e8', letterSpacing: '-0.02em' }}>
              {isPr ? 'Pull Request Accepted' : 'Changes Merged Into Main'}
            </span>
          </div>
          <button
            className="lg-compact-icon-button"
            onClick={closeDialog}
            style={{
              width: 22, height: 22, borderRadius: 5, border: 'none',
              background: 'transparent', color: '#4a566a', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = '#c8d0e8'; e.currentTarget.style.background = '#1e2a3d' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#4a566a'; e.currentTarget.style.background = 'transparent' }}
          >×</button>
        </div>

        {/* Body */}
        <div style={{ padding: '18px 20px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            {isPr && (
              <span style={{
                fontFamily: 'var(--lg-font-mono)', fontSize: 11, fontWeight: 700,
                color: '#a27ef0', background: 'rgba(162,126,240,0.12)',
                border: '1px solid rgba(162,126,240,0.25)', borderRadius: 4, padding: '1px 6px',
              }}>#{prNumber}</span>
            )}
            <span style={{ fontSize: 13, color: '#c8d0e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {target.title}
            </span>
          </div>
          <div style={{ fontSize: 12, color: '#5a6880', lineHeight: 1.5, marginBottom: 16 }}>
            {isPr
              ? "Your pull request was merged. Unlock the files you're no longer editing so your teammates can lock them."
              : "These files are now in the main branch. Unlock the ones you're no longer editing so your teammates can lock them."}
          </div>

          {/* Ready to unlock */}
          <SectionLabel color="#5fbf7f">
            Ready to unlock ({remaining.length})
          </SectionLabel>
          {availableToUnlock.length === 0 ? (
            <EmptyRow text="No merged files are currently locked by you." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14, maxHeight: 320, overflowY: 'auto', paddingRight: 2 }}>
              {availableToUnlock.map(p => {
                const done = isDone(p)
                const busy = unlocking.has(p)
                return (
                  <div key={p} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    border: '1px solid #1b2433', borderRadius: 6, padding: '7px 9px',
                    background: done ? 'rgba(45,189,110,0.05)' : '#0f141d',
                  }}>
                    <FilePathText path={p} style={{
                      flex: 1, fontFamily: 'var(--lg-font-mono)', fontSize: 11,
                      color: done ? '#5fbf7f' : '#9aa3b7',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }} />
                    {done ? (
                      <span style={{ fontSize: 11, color: '#5fbf7f', flexShrink: 0 }}>✓ Unlocked</span>
                    ) : (
                      <ActionBtn
                        onClick={() => handleUnlock(p)}
                        disabled={busy}
                        size="sm"
                        style={{ height: 22, paddingLeft: 9, paddingRight: 9, fontSize: 11 }}
                      >
                        {busy ? '…' : 'Unlock'}
                      </ActionBtn>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Still editing — kept locked */}
          {containsLocalChanges.length > 0 && (
            <>
              <SectionLabel color="#e8622f">
                Still editing — kept locked ({containsLocalChanges.length})
              </SectionLabel>
              <div style={{ fontSize: 11, color: '#5a6880', lineHeight: 1.5, marginBottom: 6 }}>
                These files have uncommitted changes, so they stay locked while you keep working on them.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 14, maxHeight: 140, overflowY: 'auto', paddingRight: 2 }}>
                {containsLocalChanges.map(p => (
                  <FilePathText key={p} path={p} style={{
                    fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#6a7488',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }} />
                ))}
              </div>
            </>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
            {htmlUrl && (
              <ActionBtn
                onClick={() => ipc.openExternal(htmlUrl)}
                ghost
                style={{ height: 32, paddingLeft: 14, paddingRight: 14, fontSize: 12.5, fontWeight: 600, marginRight: 'auto' }}
              >
                View PR ↗
              </ActionBtn>
            )}
            {remaining.length > 0 && (
              <ActionBtn
                onClick={handleUnlockAll}
                color="#2dbd6e"
                style={{ height: 32, paddingLeft: 16, paddingRight: 16, fontSize: 12.5, fontWeight: 600 }}
              >
                Unlock all ({remaining.length})
              </ActionBtn>
            )}
            <ActionBtn
              onClick={handleDone}
              color={allUnlocked || availableToUnlock.length === 0 ? '#a78bfa' : undefined}
              ghost={!(allUnlocked || availableToUnlock.length === 0)}
              style={{ height: 32, paddingLeft: 16, paddingRight: 16, fontSize: 12.5, fontWeight: 600 }}
            >
              Done
            </ActionBtn>
          </div>
        </div>
      </div>
    </div>
  )
}

function SectionLabel({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div style={{
      fontFamily: 'var(--lg-font-ui)', fontSize: 11, fontWeight: 600,
      color, letterSpacing: '0.04em', marginBottom: 6,
    }}>
      {children}
    </div>
  )
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14,
      fontSize: 11.5, color: '#344057',
    }}>
      <span style={{ color: '#2dbd6e', fontSize: 12 }}>✓</span>
      {text}
    </div>
  )
}
