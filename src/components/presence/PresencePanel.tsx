import React, { useEffect, useState, useCallback } from 'react'
import { ipc, PresenceEntry, BranchActivity } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useAuthStore } from '@/stores/authStore'

interface PresencePanelProps {
  repoPath: string
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime()
  const s = ms / 1000
  if (s < 60)     return 'just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function authorColor(name: string): string {
  const palette = ['#4d9dff', '#a27ef0', '#2ec573', '#f5a832', '#e8622f', '#1abc9c', '#e91e63']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

// ── GitHub avatar with initials fallback ──────────────────────────────────────

function UserAvatar({ login, size, color, stale }: { login: string; size: number; color: string; stale?: boolean }) {
  const [failed, setFailed] = React.useState(false)
  const ini = initials(login)
  const fontSize = Math.round(size * 0.38)
  const shared: React.CSSProperties = {
    width: size, height: size, borderRadius: '50%', flexShrink: 0,
    opacity: stale ? 0.5 : 1,
  }
  if (failed) {
    return (
      <div style={{
        ...shared,
        background: `linear-gradient(135deg, ${color}88, ${color}44)`,
        border: `1.5px solid ${stale ? '#252d42' : color + '55'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'JetBrains Mono', monospace", fontSize, fontWeight: 700, color,
      }}>
        {ini}
      </div>
    )
  }
  return (
    <img
      src={`https://github.com/${login}.png?size=${size * 2}`}
      alt={login}
      onError={() => setFailed(true)}
      style={{
        ...shared,
        objectFit: 'cover',
        border: `1.5px solid ${stale ? '#252d42' : color + '55'}`,
      }}
    />
  )
}

// ── Section header ─────────────────────────────────────────────────────────────

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', height: 32,
      paddingLeft: 16, paddingRight: 16,
      borderBottom: '1px solid #252d42',
      background: '#10131c', flexShrink: 0,
    }}>
      <span style={{
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 600,
        color: '#4e5870', letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1,
      }}>{label}</span>
      {count !== undefined && (
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
          background: '#1d2235', color: '#4e5870', borderRadius: 8, padding: '1px 6px',
        }}>{count}</span>
      )}
    </div>
  )
}

// ── Presence card ──────────────────────────────────────────────────────────────

function PresenceCard({ entry, isMe }: { entry: PresenceEntry; isMe: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const col = authorColor(entry.name || entry.login)
  const isStale = Date.now() - new Date(entry.lastSeen).getTime() > 10 * 60 * 1000

  return (
    <div style={{ borderBottom: '1px solid #252d42' }}>
      {/* Main row */}
      <div
        onClick={() => entry.modifiedCount > 0 && setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 16px',
          cursor: entry.modifiedCount > 0 ? 'pointer' : 'default',
          transition: 'background 0.1s',
        }}
        onMouseEnter={e => { if (entry.modifiedCount > 0) e.currentTarget.style.background = '#1e2436' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
      >
        {/* Avatar */}
        <UserAvatar login={entry.login} size={28} color={col} stale={isStale} />

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, fontWeight: 600,
              color: isStale ? '#4e5870' : '#dde1f0',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {entry.name || entry.login}
            </span>
            {isMe && (
              <span style={{
                fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 600,
                background: 'rgba(77,157,255,0.12)', color: '#4d9dff',
                border: '1px solid rgba(77,157,255,0.25)', borderRadius: 3, padding: '1px 5px', flexShrink: 0,
              }}>you</span>
            )}
            {isStale && (
              <span style={{
                fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9,
                color: '#4e5870', flexShrink: 0,
              }}>away</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4d9dff',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{entry.branch}</span>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#4e5870', flexShrink: 0 }}>
              {timeAgo(entry.lastSeen)}
            </span>
          </div>
        </div>

        {/* Modified count badge */}
        {entry.modifiedCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
              background: 'rgba(245,168,50,0.15)', color: '#f5a832',
              border: '1px solid rgba(245,168,50,0.3)',
              borderRadius: 8, padding: '1px 7px',
            }}>{entry.modifiedCount} files</span>
            <svg
              width="10" height="10" viewBox="0 0 10 10" fill="none"
              style={{ color: '#4e5870', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
            >
              <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}

        {/* Last push */}
        {entry.lastPush && (
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10,
            color: '#4e5870', flexShrink: 0,
          }}>pushed {timeAgo(entry.lastPush)}</span>
        )}
      </div>

      {/* Modified files list */}
      {expanded && entry.modifiedFiles.length > 0 && (
        <div style={{ background: '#0d1019', borderTop: '1px solid #1d2235' }}>
          {entry.modifiedFiles.slice(0, 20).map((f, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center',
                height: 26, paddingLeft: 54, paddingRight: 16,
                borderBottom: '1px solid #1d2235',
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                color: '#8b94b0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              title={f}
            >{f}</div>
          ))}
          {entry.modifiedFiles.length > 20 && (
            <div style={{
              height: 26, paddingLeft: 54, display: 'flex', alignItems: 'center',
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#4e5870',
            }}>+{entry.modifiedFiles.length - 20} more</div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Branch activity row ────────────────────────────────────────────────────────

function ActivityRow({ item }: { item: BranchActivity }) {
  const col = authorColor(item.author)
  const ini = initials(item.author)
  const branch = item.ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '')

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 16px', borderBottom: '1px solid #1d2235',
      transition: 'background 0.1s',
    }}
      onMouseEnter={e => (e.currentTarget.style.background = '#1e2436')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {/* git commit author — no GitHub login available, use colored initials */}
      <div style={{
        width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
        background: `linear-gradient(135deg, ${col}88, ${col}44)`,
        border: `1px solid ${col}55`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'JetBrains Mono', monospace", fontSize: 8, fontWeight: 700, color: col,
      }}>{ini}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4d9dff',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140,
          }}>{branch}</span>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#8b94b0', flexShrink: 0 }}>
            {item.author}
          </span>
        </div>
        <div style={{
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#4e5870',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{item.message}</div>
      </div>

      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870',
        flexShrink: 0,
      }}>{timeAgo(item.date)}</span>
    </div>
  )
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ padding: '24px 16px', textAlign: 'center' }}>
      <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#4e5870' }}>
        {message}
      </span>
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function PresencePanel({ repoPath }: PresencePanelProps) {
  const { fileStatus } = useRepoStore()
  const { accounts, currentAccountId } = useAuthStore()

  const [entries, setEntries]   = useState<PresenceEntry[]>([])
  const [activity, setActivity] = useState<BranchActivity[]>([])
  const [loading,  setLoading]  = useState(false)
  const [tab, setTab]           = useState<'presence' | 'activity'>('presence')

  const currentAccount = accounts.find(a => a.userId === currentAccountId) ?? null

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [presenceFile, branchActivity] = await Promise.all([
        ipc.presenceRead(repoPath),
        ipc.gitBranchActivity(repoPath),
      ])
      // Remove stale entries (> 30 minutes)
      const cutoff = Date.now() - 30 * 60 * 1000
      const fresh = Object.values(presenceFile.entries).filter(
        e => new Date(e.lastSeen).getTime() > cutoff,
      )
      setEntries(fresh)
      setActivity(branchActivity.slice(0, 50))
    } catch {
      setEntries([])
      setActivity([])
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  // Write own presence entry on mount and on file status changes
  useEffect(() => {
    if (!currentAccount) return
    const modifiedFiles = fileStatus.map(f => f.path)
    ipc.currentBranch(repoPath).then(branch => {
      const entry: PresenceEntry = {
        login: currentAccount.login,
        name: currentAccount.name,
        branch,
        modifiedCount: modifiedFiles.length,
        modifiedFiles,
        lastSeen: new Date().toISOString(),
      }
      return ipc.presenceUpdate(repoPath, currentAccount.login, entry)
    }).catch(() => {})
  }, [repoPath, currentAccount, fileStatus])

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 30_000)
    return () => clearInterval(interval)
  }, [loadData])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: '#0b0d13' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex', alignItems: 'center', height: 38,
        paddingLeft: 14, paddingRight: 14, gap: 2,
        borderBottom: '1px solid #252d42', background: '#10131c', flexShrink: 0,
      }}>
        {(['presence', 'activity'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              height: 26, paddingLeft: 12, paddingRight: 12, borderRadius: 5,
              background: tab === t ? 'rgba(232,98,47,0.15)' : 'transparent',
              border: `1px solid ${tab === t ? 'rgba(232,98,47,0.4)' : 'transparent'}`,
              color: tab === t ? '#e8622f' : '#8b94b0',
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: tab === t ? 600 : 400,
              cursor: 'pointer', transition: 'all 0.12s',
              textTransform: 'capitalize',
            }}
          >
            {t === 'presence' ? 'Team' : 'Branch Activity'}
          </button>
        ))}

        <div style={{ flex: 1 }} />
        <button
          onClick={loadData}
          disabled={loading}
          title="Refresh"
          style={{
            background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer',
            color: loading ? '#4e5870' : '#8b94b0', fontSize: 14, opacity: loading ? 0.5 : 1,
            padding: '0 4px',
          }}
          onMouseEnter={e => { if (!loading) e.currentTarget.style.color = '#e8622f' }}
          onMouseLeave={e => { if (!loading) e.currentTarget.style.color = '#8b94b0' }}
        >{loading ? '…' : '↺'}</button>
      </div>

      {tab === 'presence' ? (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <SectionHeader label="Active teammates" count={entries.length} />
          {loading && entries.length === 0 ? (
            <EmptyState message="Loading presence data…" />
          ) : entries.length === 0 ? (
            <EmptyState message="No active teammates found. Presence data is stored in .lucid-git/presence.json — make sure teammates have Lucid Git open." />
          ) : (
            entries
              .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
              .map(e => (
                <PresenceCard
                  key={e.login}
                  entry={e}
                  isMe={e.login === currentAccount?.login}
                />
              ))
          )}

          {/* Info callout */}
          <div style={{
            margin: '12px 16px', padding: '10px 14px', borderRadius: 8,
            background: 'rgba(77,157,255,0.06)', border: '1px solid rgba(77,157,255,0.15)',
          }}>
            <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#4d9dff', fontWeight: 600, marginBottom: 4 }}>
              How presence works
            </div>
            <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#8b94b0', lineHeight: 1.6 }}>
              Presence is shared via <code style={{ fontFamily: "'JetBrains Mono', monospace", background: '#1d2235', padding: '0 3px', borderRadius: 2 }}>.lucid-git/presence.json</code>.
              Push this file to your remote so teammates can see each other. It is excluded from git commits automatically.
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <SectionHeader label="Recent pushes per branch" count={activity.length} />
          {loading && activity.length === 0 ? (
            <EmptyState message="Loading branch activity…" />
          ) : activity.length === 0 ? (
            <EmptyState message="No branch activity found." />
          ) : (
            activity.map((item, i) => <ActivityRow key={i} item={item} />)
          )}
        </div>
      )}
    </div>
  )
}
