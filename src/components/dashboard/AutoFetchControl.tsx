import React, { useEffect, useRef, useState } from 'react'
import { ipc, AppSettings } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { getLastFetch, markFetchPerformed, onFetchPerformed, formatFetchAgo } from '@/lib/fetchState'
import type { SyncBusyState } from '@/lib/syncButtonLogic'

// Interval options mirror Settings → Sync → "Auto-fetch interval".
const INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 0,  label: 'Auto-fetch off' },
  { value: 1,  label: 'Every 1 min' },
  { value: 2,  label: 'Every 2 min' },
  { value: 5,  label: 'Every 5 min' },
  { value: 15, label: 'Every 15 min' },
  { value: 30, label: 'Every 30 min' },
  { value: 60, label: 'Every hour' },
]

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// Header control that displays the auto-fetch countdown + last-fetched time and
// owns the actual background auto-fetch scheduler driven by the global
// `autoFetchIntervalMinutes` setting. The fetch is silent (no operation overlay);
// the FETCH IPC handler runs the PR-merge check afterwards, so an auto-fetch can
// also surface the "PR accepted" dialog on its own.
export function AutoFetchControl({ repoPath, busy }: { repoPath: string; busy: SyncBusyState }) {
  const bumpSyncTick = useRepoStore(s => s.bumpSyncTick)

  const [settings, setSettings]       = useState<AppSettings | null>(null)
  const [now, setNow]                 = useState(() => Date.now())
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(() => getLastFetch(repoPath))
  const [refreshing, setRefreshing]   = useState(false)

  const refreshingRef  = useRef(false)
  const lastAttemptRef = useRef(0)

  const interval = settings?.autoFetchIntervalMinutes ?? 0

  // Load the persisted setting on mount.
  useEffect(() => { ipc.settingsGet().then(setSettings).catch(() => {}) }, [])

  // Reset the stored last-fetch timestamp when the active repo changes.
  useEffect(() => { setLastFetchAt(getLastFetch(repoPath)) }, [repoPath])

  // Mirror fetches performed anywhere (manual button, TopBar, this scheduler).
  useEffect(() => onFetchPerformed((path, at) => {
    if (path === repoPath) setLastFetchAt(at)
  }), [repoPath])

  // 1-second tick: drives the countdown display and the auto-fetch trigger.
  useEffect(() => {
    if (!repoPath) return
    const id = setInterval(() => {
      setNow(Date.now())
      if (interval <= 0 || busy !== 'idle' || refreshingRef.current) return
      const base = Math.max(getLastFetch(repoPath) ?? 0, lastAttemptRef.current)
      if (Date.now() - base < interval * 60_000) return
      // Time to auto-fetch. Throttle attempts to once per interval even if the
      // fetch fails, so a failing remote doesn't trigger a once-a-second retry storm.
      lastAttemptRef.current = Date.now()
      refreshingRef.current = true
      setRefreshing(true)
      ipc.fetch(repoPath)
        .then(() => { markFetchPerformed(repoPath); bumpSyncTick() })
        .catch(() => {})
        .finally(() => { refreshingRef.current = false; setRefreshing(false) })
    }, 1000)
    return () => clearInterval(id)
  }, [repoPath, interval, busy, bumpSyncTick])

  const changeInterval = (value: number) => {
    if (!settings) return
    const next = { ...settings, autoFetchIntervalMinutes: value }
    setSettings(next)
    lastAttemptRef.current = 0  // re-evaluate against the new interval immediately
    ipc.settingsSave(next).catch(() => {})
  }

  // Countdown text.
  let countdown: string
  if (!settings) {
    countdown = 'Auto-fetch…'
  } else if (interval <= 0) {
    countdown = 'Auto-fetch off'
  } else if (refreshing) {
    countdown = 'Auto-refreshing…'
  } else {
    const base = Math.max(lastFetchAt ?? 0, lastAttemptRef.current)
    const remaining = base + interval * 60_000 - now
    countdown = `Auto-refresh in ${formatRemaining(remaining)}`
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <select
        value={interval}
        onChange={e => changeInterval(Number(e.target.value))}
        disabled={!settings}
        title="Auto-fetch interval (synced with Settings)"
        style={{
          background: '#0d1117', border: '1px solid #1e2a3d', borderRadius: 6,
          padding: '5px 8px', fontFamily: 'var(--lg-font-ui)', fontSize: 11,
          color: '#c8d0e8', outline: 'none', cursor: settings ? 'pointer' : 'default',
          opacity: settings ? 1 : 0.5,
        }}
      >
        {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.3, minWidth: 148 }}>
        <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10.5, color: '#5a6880', whiteSpace: 'nowrap' }}>
          {countdown}
        </span>
        <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#344057', whiteSpace: 'nowrap' }}>
          Last {formatFetchAgo(lastFetchAt, now)}
        </span>
      </div>
    </div>
  )
}
