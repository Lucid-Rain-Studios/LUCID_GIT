import React, { useEffect, useState } from 'react'
import { ipc, PresenceEntry } from '@/ipc'
import { useAuthStore } from '@/stores/authStore'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { presenceStatus } from '@/lib/presence'

const labels = { active: 'Active', away: 'Away', offline: 'Offline' }
const colors = { active: '#2ec573', away: '#f5a832', offline: '#8b94b0' }

export function PresencePanel({ repoPath, onConfigure }: { repoPath: string; onConfigure?: () => void }) {
  const isAdmin = useAuthStore(s => s.isAdmin(repoPath))
  const accountId = useAuthStore(s => s.currentAccountId)
  const [entries, setEntries] = useState<PresenceEntry[]>([])
  const [source, setSource] = useState<'local' | 'firebase' | 'unavailable'>('local')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    let cancelled = false
    let inFlight = false
    setEntries([])
    setSource('local')
    setError(null)
    if (!isAdmin) return
    const load = async () => {
      if (inFlight) return
      inFlight = true
      setLoading(true)
      try {
        const file = await ipc.presenceRead(repoPath)
        if (!cancelled) { setEntries(Object.values(file.entries)); setSource(file.source ?? 'local'); setError(null) }
      } catch (e) {
        if (!cancelled) { setEntries([]); setSource('unavailable'); setError(String(e)) }
      } finally {
        inFlight = false
        if (!cancelled) { setLoading(false); setNow(Date.now()) }
      }
    }
    void load()
    const interval = setInterval(() => { setNow(Date.now()); void load() }, 15_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [repoPath, isAdmin, accountId, refresh])

  if (!isAdmin) return <div role="alert">Admin access is required to view Team activity.</div>

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 20, background: '#0b0d13', color: '#dde1f0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, margin: 0, flex: 1 }}>Team activity</h2>
        {onConfigure && <ActionBtn size="sm" onClick={onConfigure}>Connection settings</ActionBtn>}
        <ActionBtn size="sm" onClick={() => setRefresh(n => n + 1)} disabled={loading}>Refresh</ActionBtn>
      </div>
      <p style={{ color: '#8b94b0', fontSize: 12 }}>
        Only admins can view this activity. Active and Away apply while Lucid Git is running.
        Away means the computer is locked or idle for five minutes. Offline means the app has
        closed or its last update is at least 90 seconds old.
      </p>
      <div role="status" style={{ padding: 12, border: '1px solid #252d42', borderRadius: 6, marginBottom: 16 }}>
        {source === 'unavailable' ? 'Activity could not be loaded. Check connection settings or retry.' : source === 'firebase' ? 'Connected to Firebase. Shared activity refreshes every 15 seconds.' :
          'Shared team presence is not connected. These are local app sessions on this computer; activity from teammates on other computers is unavailable.'}
      </div>
      {error ? (
        <div role="alert">Activity is unavailable. {error} <ActionBtn size="sm" onClick={() => setRefresh(n => n + 1)}>Retry</ActionBtn></div>
      ) : loading && entries.length === 0 ? (
        <p>Loading activity…</p>
      ) : entries.length === 0 ? (
        <p>{source === 'firebase' ? 'No approved team members have been registered in Firebase.' : 'No local app sessions have been recorded.'}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {[...entries].sort((a, b) => {
            const rank = { active: 0, away: 1, offline: 2 }
            return rank[presenceStatus(a, now)] - rank[presenceStatus(b, now)] || a.login.localeCompare(b.login)
          }).map(entry => {
            const status = presenceStatus(entry, now)
            return (
              <li key={entry.login} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid #252d42' }}>
                <span style={{ flex: 1 }}>{entry.name || entry.login} <span style={{ color: '#8b94b0' }}>@{entry.login}</span></span>
                <span style={{ color: colors[status] }}>● {labels[status]}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
