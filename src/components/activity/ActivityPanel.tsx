import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ipc, AppNotification } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'

interface ActivityPanelProps {
  repoPath: string
}

// ── Normalized activity event ─────────────────────────────────────────────────

type ActivityKind =
  | 'commit'
  | 'lock'
  | 'unlock'
  | 'pr-merged'
  | 'pr-closed'
  | 'error'
  | 'event'

interface ActivityEvent {
  id: string
  kind: ActivityKind
  actor: string          // author/login; empty when the title is already a full sentence
  title: string
  detail?: string
  time: number           // unix ms
  hash?: string          // commits
  htmlUrl?: string       // PR events
}

type FilterId = 'all' | 'commit' | 'lock' | 'pr' | 'error'

const FILTERS: { id: FilterId; label: string }[] = [
  { id: 'all',    label: 'All' },
  { id: 'commit', label: 'Commits' },
  { id: 'lock',   label: 'Locks' },
  { id: 'pr',     label: 'Pull Requests' },
  { id: 'error',  label: 'Errors' },
]

const KIND_META: Record<ActivityKind, { icon: string; color: string }> = {
  commit:      { icon: '',   color: '#4d9dff' },  // commits use an initials avatar instead
  lock:        { icon: '🔒', color: '#f5a832' },
  unlock:      { icon: '🔓', color: '#2ec573' },
  'pr-merged': { icon: '✅', color: '#2ec573' },
  'pr-closed': { icon: '🚫', color: '#e8622f' },
  error:       { icon: '⚠️', color: '#e8622f' },
  event:       { icon: '●',  color: '#8b94b0' },
}

function mapNotificationKind(type: string): ActivityKind {
  switch (type) {
    case 'lock':      return 'lock'
    case 'unlock':    return 'unlock'
    case 'pr-merged': return 'pr-merged'
    case 'pr-closed': return 'pr-closed'
    case 'error':     return 'error'
    default:          return 'event'
  }
}

function matchesFilter(kind: ActivityKind, filter: FilterId): boolean {
  switch (filter) {
    case 'all':    return true
    case 'commit': return kind === 'commit'
    case 'lock':   return kind === 'lock' || kind === 'unlock'
    case 'pr':     return kind === 'pr-merged' || kind === 'pr-closed'
    case 'error':  return kind === 'error'
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function timeAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60)     return 'just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ms).toLocaleDateString()
}

function dayLabel(ms: number): string {
  const d = new Date(ms)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7)  return d.toLocaleDateString(undefined, { weekday: 'long' })
  return d.toLocaleDateString()
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

// ── Leading icon: initials avatar for commits, tinted emoji for the rest ───────

function EventIcon({ event }: { event: ActivityEvent }) {
  if (event.kind === 'commit') {
    const col = authorColor(event.actor || '?')
    return (
      <div style={{
        width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
        background: `linear-gradient(135deg, ${col}88, ${col}44)`,
        border: `1px solid ${col}55`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: 700, color: col,
      }}>{initials(event.actor || '?')}</div>
    )
  }
  const { icon, color } = KIND_META[event.kind]
  return (
    <div style={{
      width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
      background: `${color}1f`, border: `1px solid ${color}44`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
    }}>{icon}</div>
  )
}

// ── Single event row ───────────────────────────────────────────────────────────

function EventRow({ event }: { event: ActivityEvent }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '9px 16px', borderBottom: '1px solid #1d2235',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = '#1e2436')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ marginTop: 1 }}>
        <EventIcon event={event} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {event.actor && (
            <span style={{
              fontFamily: 'var(--lg-font-ui)', fontSize: 12, fontWeight: 600, color: '#dde1f0', flexShrink: 0,
            }}>{event.actor}</span>
          )}
          <span style={{
            fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: event.actor ? '#8b94b0' : '#dde1f0',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{event.title}</span>
        </div>
        {event.detail && (
          <div style={{
            fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#4e5870', marginTop: 2,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{event.detail}</div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {event.hash && (
          <span style={{
            fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870',
            background: '#1d2235', borderRadius: 4, padding: '1px 5px',
          }}>{event.hash.slice(0, 7)}</span>
        )}
        {event.htmlUrl && (
          <button
            onClick={() => ipc.openExternal(event.htmlUrl!)}
            style={{
              fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#e8622f',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}
          >View PR</button>
        )}
        <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870' }}>
          {timeAgo(event.time)}
        </span>
      </div>
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function ActivityPanel({ repoPath }: ActivityPanelProps) {
  const { syncTick } = useRepoStore()
  const [events, setEvents]   = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter]   = useState<FilterId>('all')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [commits, notifications] = await Promise.all([
        ipc.log(repoPath, { limit: 150, all: true }),
        ipc.notificationList(repoPath).catch(() => [] as AppNotification[]),
      ])

      const commitEvents: ActivityEvent[] = commits.map(c => ({
        id: `commit:${c.hash}`,
        kind: 'commit',
        actor: c.author,
        title: c.message.split('\n')[0],
        detail: c.email || undefined,
        time: c.timestamp,
        hash: c.hash,
      }))

      const notifEvents: ActivityEvent[] = notifications.map(n => ({
        id: `notif:${n.id}`,
        kind: mapNotificationKind(n.type),
        actor: '',
        title: n.title,
        detail: n.body || undefined,
        time: new Date(n.createdAt).getTime(),
        htmlUrl: typeof n.meta?.htmlUrl === 'string' ? (n.meta.htmlUrl as string) : undefined,
      }))

      const merged = [...commitEvents, ...notifEvents]
        .filter(e => Number.isFinite(e.time))
        .sort((a, b) => b.time - a.time)

      setEvents(merged)
    } catch {
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 30_000)
    return () => clearInterval(interval)
  }, [loadData, syncTick])

  const visible = useMemo(
    () => events.filter(e => matchesFilter(e.kind, filter)),
    [events, filter],
  )

  // Group visible events under day headers, preserving the sorted order.
  const groups = useMemo(() => {
    const out: { label: string; items: ActivityEvent[] }[] = []
    for (const ev of visible) {
      const label = dayLabel(ev.time)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(ev)
      else out.push({ label, items: [ev] })
    }
    return out
  }, [visible])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', background: '#0b0d13' }}>
      {/* Filter bar */}
      <div style={{
        display: 'flex', alignItems: 'center', height: 38,
        paddingLeft: 14, paddingRight: 14, gap: 2,
        borderBottom: '1px solid #252d42', background: '#10131c', flexShrink: 0,
      }}>
        {FILTERS.map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              height: 26, paddingLeft: 12, paddingRight: 12, borderRadius: 5,
              background: filter === f.id ? 'rgba(232,98,47,0.15)' : 'transparent',
              border: `1px solid ${filter === f.id ? 'rgba(232,98,47,0.4)' : 'transparent'}`,
              color: filter === f.id ? '#e8622f' : '#8b94b0',
              fontFamily: 'var(--lg-font-ui)', fontSize: 12, fontWeight: filter === f.id ? 600 : 400,
              cursor: 'pointer', transition: 'all 0.12s',
            }}
          >{f.label}</button>
        ))}

        <div style={{ flex: 1 }} />
        <button
          className="lg-compact-icon-button"
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

      {/* Event stream */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && events.length === 0 ? (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870' }}>Loading activity…</span>
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870' }}>
              {events.length === 0
                ? 'No activity yet. Commits, locks and pull-request events will show up here.'
                : 'No activity matches this filter.'}
            </span>
          </div>
        ) : (
          groups.map(group => (
            <div key={group.label}>
              <div style={{
                display: 'flex', alignItems: 'center', height: 30,
                paddingLeft: 16, paddingRight: 16,
                borderBottom: '1px solid #252d42', background: '#10131c',
                position: 'sticky', top: 0, zIndex: 1,
              }}>
                <span style={{
                  fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 600,
                  color: '#4e5870', letterSpacing: '0.1em', textTransform: 'uppercase', flex: 1,
                }}>{group.label}</span>
                <span style={{
                  fontFamily: 'var(--lg-font-mono)', fontSize: 10,
                  background: '#1d2235', color: '#4e5870', borderRadius: 8, padding: '1px 6px',
                }}>{group.items.length}</span>
              </div>
              {group.items.map(ev => <EventRow key={ev.id} event={ev} />)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
