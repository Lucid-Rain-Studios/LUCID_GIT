import React, { useEffect } from 'react'
import { ipc } from '@/ipc'
import { usePRUnlockStore } from '@/stores/prUnlockStore'
import { useRepoStore } from '@/stores/repoStore'
import { onFetchPerformed } from '@/lib/fetchState'

// Compact dashboard-header pill reflecting the lifecycle of the user's own PRs:
// pending → merged (unlock files) → resolved, or closed-without-merging.
// Priority (highest first): merged-needs-unlock > merged-info > denied > pending.
export function MyPRStatusPill({ repoPath }: { repoPath: string }) {
  const status      = usePRUnlockStore(s => s.status)
  const refresh     = usePRUnlockStore(s => s.refresh)
  const openDialog  = usePRUnlockStore(s => s.openDialog)
  const markResolved= usePRUnlockStore(s => s.markResolved)
  const prTick      = useRepoStore(s => s.prTick)

  // Refresh on mount / repo change.
  useEffect(() => { refresh(repoPath).catch(() => {}) }, [repoPath, refresh])

  // Refresh whenever a PR is created/updated (prTick) — created PRs become "pending".
  useEffect(() => { refresh(repoPath).catch(() => {}) }, [prTick, repoPath, refresh])

  // Stay in sync with every fetch (post-fetch checkNow may have resolved a PR).
  useEffect(() => onFetchPerformed(path => {
    if (path === repoPath) refresh(repoPath).catch(() => {})
  }), [repoPath, refresh])

  if (!status) return null

  const { pending, merged, denied, mergedToMain } = status

  const prUnlock        = merged.filter(m => m.availableToUnlock.length > 0)
  const mainUnlockCount = mergedToMain?.availableToUnlock.length ?? 0
  const totalUnlock     = prUnlock.reduce((n, m) => n + m.availableToUnlock.length, 0) + mainUnlockCount

  // 1 — files ready to unlock (from a merged PR and/or work that landed in main).
  if (totalUnlock > 0) {
    const open = () => {
      if (prUnlock.length > 0) {
        const m = prUnlock[0]
        openDialog(repoPath, {
          kind: 'pr', prNumber: m.prNumber, title: m.title, htmlUrl: m.htmlUrl,
          availableToUnlock: m.availableToUnlock, containsLocalChanges: m.containsLocalChanges,
        })
      } else if (mergedToMain) {
        openDialog(repoPath, {
          kind: 'main', title: 'Changes merged into main',
          availableToUnlock: mergedToMain.availableToUnlock, containsLocalChanges: mergedToMain.containsLocalChanges,
        })
      }
    }
    const filesLabel = `unlock ${totalUnlock} file${totalUnlock !== 1 ? 's' : ''}`
    const label = prUnlock.length > 0
      ? `PR #${prUnlock[0].prNumber} merged · ${filesLabel}`
      : `Merged into main · ${filesLabel}`
    return <Pill accent="#2dbd6e" solid label={label} onClick={open} />
  }

  // 2 — a merged PR with nothing left to unlock (only kept-locked files).
  if (merged.length > 0) {
    const m = merged[0]
    return (
      <Pill
        accent="#a78bfa"
        label={`PR #${m.prNumber} merged`}
        onClick={() => openDialog(repoPath, {
          kind: 'pr', prNumber: m.prNumber, title: m.title, htmlUrl: m.htmlUrl,
          availableToUnlock: m.availableToUnlock, containsLocalChanges: m.containsLocalChanges,
        })}
      />
    )
  }

  // 3 — denied / closed without merging (dismissable).
  if (denied.length > 0) {
    const d = denied[0]
    return (
      <Pill
        accent="#f5a832"
        label={`PR #${d.prNumber} closed`}
        onClick={() => { if (d.htmlUrl) ipc.openExternal(d.htmlUrl) }}
        onDismiss={() => { markResolved(repoPath, d.prNumber).catch(() => {}) }}
      />
    )
  }

  // 4 — pending (non-actionable informational).
  if (pending > 0) {
    return (
      <Pill
        accent="#5a6880"
        label={`${pending} PR${pending !== 1 ? 's' : ''} pending`}
      />
    )
  }

  return null
}

function Pill({ accent, solid, label, onClick, onDismiss }: {
  accent: string; solid?: boolean; label: string
  onClick?: () => void; onDismiss?: () => void
}) {
  const interactive = !!onClick
  return (
    <div
      onClick={onClick}
      title={label}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        height: 28, paddingLeft: 11, paddingRight: onDismiss ? 6 : 11,
        borderRadius: 7,
        background: solid ? `${accent}1f` : `${accent}12`,
        border: `1px solid ${accent}${solid ? '55' : '33'}`,
        cursor: interactive ? 'pointer' : 'default',
        userSelect: 'none', transition: 'background 0.12s',
      }}
      onMouseEnter={e => { if (interactive) e.currentTarget.style.background = `${accent}2e` }}
      onMouseLeave={e => { if (interactive) e.currentTarget.style.background = solid ? `${accent}1f` : `${accent}12` }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: accent, flexShrink: 0, boxShadow: `0 0 6px ${accent}66` }} />
      <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11.5, fontWeight: 600, color: accent, whiteSpace: 'nowrap' }}>
        {label}
      </span>
      {onDismiss && (
        <button
          onClick={e => { e.stopPropagation(); onDismiss() }}
          title="Dismiss"
          style={{
            width: 18, height: 18, borderRadius: 4, border: 'none', flexShrink: 0,
            background: 'transparent', color: accent, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, opacity: 0.75,
          }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = `${accent}22` }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '0.75'; e.currentTarget.style.background = 'transparent' }}
        >×</button>
      )}
    </div>
  )
}
