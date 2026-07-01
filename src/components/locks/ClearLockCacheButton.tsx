import React, { useState } from 'react'
import { ipc } from '@/ipc'
import { useStatusToastStore } from '@/stores/statusToastStore'
import { useOperationStore } from '@/stores/operationStore'
import { useDialogStore } from '@/stores/dialogStore'

// Toolbar action: clears the local Git LFS lock cache and re-lists locks from
// the server. Mirrors the Locked Files panel's "Clear Cache & Refresh" UX — a
// confirm dialog explaining what it does, then the operation overlay/loading bar
// while it runs. The backend broadcasts the refreshed locks (EVT_LOCK_CHANGED),
// so the rest of the UI updates without any extra round-trip here.
export function ClearLockCacheButton({ repoPath }: { repoPath: string }) {
  const showToast = useStatusToastStore(s => s.show)
  const opRun     = useOperationStore(s => s.run)
  const dialog    = useDialogStore()
  const [busy, setBusy] = useState(false)

  const onClick = async () => {
    if (busy) return
    const ok = await dialog.confirm({
      title: 'Clear LFS lock cache',
      message: 'Clear Git LFS lockcache.db and refresh locks from the server?',
      detail: 'This only removes local LFS lock cache database files. It does not unlock files or change commits.',
      confirmLabel: 'Clear & Refresh',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    try {
      const locks = await opRun('Refreshing LFS locks…', () => ipc.clearLockCache(repoPath))
      showToast(`Lock cache cleared — ${locks.length} lock${locks.length !== 1 ? 's' : ''} refreshed.`)
    } catch {
      showToast('Failed to clear lock cache.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="lg-toolbar-control lg-icon-control flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-50 disabled:cursor-default"
      style={{ color: '#e84545' }}
      onMouseEnter={e => { if (!busy) e.currentTarget.style.background = 'rgba(232,69,69,0.10)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
      title="Clear lock cache"
    >
      {busy ? (
        // Spinner while clearing + refreshing.
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ animation: 'spin 0.8s linear infinite' }}
        >
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
      ) : (
        // Padlock — clears the lock cache.
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <rect x="4" y="11" width="16" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      )}
    </button>
  )
}
