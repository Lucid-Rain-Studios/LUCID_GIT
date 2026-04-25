import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ipc, SyncStatus, LFSStatus, Lock, StashEntry,
  CommitEntry, BranchActivity, SizeBreakdown,
} from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useAuthStore } from '@/stores/authStore'
import { useOperationStore } from '@/stores/operationStore'

interface OverviewPanelProps {
  repoPath: string
  onNavigate: (tab: string) => void
  onRefresh:  () => void
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1_048_576)    return `${(b / 1024).toFixed(1)} KB`
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
}

function timeAgoMs(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60)     return 'just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

function timeAgoStr(iso: string): string {
  return timeAgoMs(new Date(iso).getTime())
}

function authorColor(name: string): string {
  const palette = ['#4a9eff', '#a27ef0', '#2dbd6e', '#f5a832', '#e8622f', '#1abc9c', '#e91e63']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

// ── Card ──────────────────────────────────────────────────────────────────────

function Card({
  title, icon, children, actionLabel, onAction, accentColor, style: xStyle,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  actionLabel?: string
  onAction?: () => void
  accentColor?: string
  style?: React.CSSProperties
}) {
  return (
    <div style={{
      background: '#131720',
      border: '1px solid #1a2030',
      borderRadius: 10,
      boxShadow: '0 2px 8px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.025)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      ...xStyle,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 34,
        paddingLeft: 13, paddingRight: 9, flexShrink: 0,
        borderBottom: '1px solid #18202e',
        background: 'rgba(0,0,0,0.15)',
      }}>
        <span style={{ color: accentColor ?? '#344057', display: 'flex', flexShrink: 0 }}>{icon}</span>
        <span style={{
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5, fontWeight: 700,
          color: '#4a566a', flex: 1, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>{title}</span>
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            style={{
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#4a9eff',
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '2px 8px', borderRadius: 4,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = '#e8622f'; e.currentTarget.style.background = 'rgba(232,98,47,0.08)' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#4a9eff'; e.currentTarget.style.background = 'none' }}
          >{actionLabel} →</button>
        )}
      </div>
      {children}
    </div>
  )
}

// ── Inline action button ───────────────────────────────────────────────────────

function Btn({
  label, onClick, loading, color, disabled,
}: {
  label: string; onClick: () => void; loading?: boolean; color?: string; disabled?: boolean
}) {
  const [hover, setHover] = useState(false)
  const c = color ?? '#7b8499'
  const off = loading || disabled
  return (
    <button
      onClick={off ? undefined : onClick}
      onMouseEnter={() => !off && setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 25, paddingLeft: 13, paddingRight: 13, borderRadius: 5,
        background: hover ? `${c}14` : 'rgba(255,255,255,0.02)',
        border: `1px solid ${hover ? c + '55' : '#1a2030'}`,
        color: off ? '#344057' : hover ? c : '#5a6880',
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5, fontWeight: 500,
        cursor: off ? 'default' : 'pointer', opacity: off ? 0.5 : 1,
        boxShadow: hover && !off ? `0 0 12px ${c}18` : 'none',
      }}
    >{loading ? '…' : label}</button>
  )
}

// ── Status chip (health strip) ────────────────────────────────────────────────

function StatusChip({
  dot, label, onClick,
}: { dot: string; label: string; onClick?: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        height: 26, paddingLeft: 9, paddingRight: 11,
        background: hover && onClick ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${hover && onClick ? '#283047' : '#18202e'}`,
        borderRadius: 6,
        cursor: onClick ? 'pointer' : 'default',
        flexShrink: 0,
        boxShadow: hover && onClick ? `0 0 10px ${dot}18` : 'none',
      }}
    >
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: dot, boxShadow: `0 0 5px ${dot}99`, flexShrink: 0 }} />
      <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5, color: '#5a6880', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </div>
  )
}

// ── Metric within a card ──────────────────────────────────────────────────────

function Metric({ label, value, color, sub }: { label: string; value: string | number; color: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 700, color: '#344057', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 21, fontWeight: 700, color, lineHeight: 1, textShadow: `0 0 20px ${color}40` }}>{value}</span>
      {sub && <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057', marginTop: 1 }}>{sub}</span>}
    </div>
  )
}

// ── Divider ───────────────────────────────────────────────────────────────────

function Divider() {
  return <div style={{ height: 1, background: '#18202e', margin: '2px 0' }} />
}

// ── Sync card ─────────────────────────────────────────────────────────────────

function SyncCard({ sync, branch, repoPath, onDone }: {
  sync: SyncStatus | null; branch: string; repoPath: string; onDone: () => void
}) {
  const opRun = useOperationStore(s => s.run)
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try { await opRun(label, fn) } finally { setBusy(null); onDone() }
  }

  const aheadColor  = !sync || sync.ahead  === 0 ? '#344057' : '#e8622f'
  const behindColor = !sync || sync.behind === 0 ? '#344057' : '#f5a832'
  const upToDate    = sync && sync.ahead === 0 && sync.behind === 0

  return (
    <Card title="Sync Status" icon={<SyncIcon />} accentColor="#e8622f">
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Branch + remote */}
        <div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#4a9eff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 2 }}>
            {branch || '—'}
          </div>
          <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057' }}>
            {sync?.hasUpstream ? `tracking ${sync.remoteName}/${sync.remoteBranch}` : 'no upstream configured'}
          </div>
        </div>

        {/* Ahead / behind metrics */}
        <div style={{ display: 'flex', gap: 20 }}>
          <Metric label="Ahead"  value={`↑${sync?.ahead  ?? '—'}`} color={aheadColor}  sub={sync?.ahead  === 0 ? 'nothing to push' : 'commit(s) to push'} />
          <Metric label="Behind" value={`↓${sync?.behind ?? '—'}`} color={behindColor} sub={sync?.behind === 0 ? 'up to date'      : 'commit(s) to pull'} />
        </div>

        {upToDate && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#2dbd6e', fontSize: 13 }}>✓</span>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>In sync with remote</span>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 6 }}>
          <Btn label="Fetch" loading={busy === 'Fetching…'} disabled={!!busy && busy !== 'Fetching…'} onClick={() => act('Fetching…', () => ipc.fetch(repoPath))} />
          <Btn label="Pull"  loading={busy === 'Pulling…'}  disabled={!!busy && busy !== 'Pulling…'}  onClick={() => act('Pulling…',  () => ipc.pull(repoPath))}  color="#4d9dff" />
          <Btn label="Push"  loading={busy === 'Pushing…'}  disabled={!!busy && busy !== 'Pushing…'}  onClick={() => act('Pushing…',  () => ipc.push(repoPath))}  color="#e8622f" />
        </div>
      </div>
    </Card>
  )
}

// ── Working copy card ─────────────────────────────────────────────────────────

function WorkingCopyCard({
  staged, unstaged, stash, onNavigate,
}: { staged: number; unstaged: number; stash: StashEntry[]; onNavigate: (t: string) => void }) {
  const total = staged + unstaged
  return (
    <Card
      title="Working Copy"
      icon={<ChangesCardIcon />}
      accentColor="#f5a832"
      actionLabel="Changes"
      onAction={() => onNavigate('changes')}
    >
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 20 }}>
          <Metric label="Staged"   value={staged}   color={staged   > 0 ? '#2dbd6e' : '#344057'} sub={staged   === 0 ? 'nothing staged' : `file${staged   !== 1 ? 's' : ''} ready`} />
          <Metric label="Modified" value={unstaged}  color={unstaged > 0 ? '#f5a832' : '#344057'} sub={unstaged === 0 ? 'no changes'     : `file${unstaged !== 1 ? 's' : ''} changed`} />
        </div>

        {total === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#2dbd6e', fontSize: 13 }}>✓</span>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>Working directory clean</span>
          </div>
        )}

        {stash.length > 0 && (
          <>
            <Divider />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 600, color: '#344057', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 2 }}>
                {stash.length} stashed
              </span>
              {stash.slice(0, 3).map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                    background: 'rgba(162,126,240,0.12)', color: '#a27ef0',
                    border: '1px solid rgba(162,126,240,0.25)', borderRadius: 3, padding: '1px 5px', flexShrink: 0,
                  }}>stash@{`{${s.index}}`}</span>
                  <span style={{
                    fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#5a6880',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                  }}>{s.message || `WIP on ${s.branch}`}</span>
                </div>
              ))}
              {stash.length > 3 && (
                <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#344057' }}>+{stash.length - 3} more</span>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

// ── LFS health card ───────────────────────────────────────────────────────────

function LfsCard({ lfs, onNavigate }: { lfs: LFSStatus | null; onNavigate: (t: string) => void }) {
  const warnCount = lfs?.untracked.length ?? 0
  return (
    <Card
      title="LFS Health"
      icon={<LFSCardIcon />}
      accentColor="#4d9dff"
      actionLabel="Manage"
      onAction={() => onNavigate('lfs')}
    >
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {lfs ? (
          <>
            <div style={{ display: 'flex', gap: 20 }}>
              <Metric label="Objects" value={lfs.objects}                color="#4d9dff"  sub="tracked files" />
              <Metric label="Size"    value={fmtBytes(lfs.totalBytes)}   color="#dde1f0"  sub="LFS stored"    />
            </div>

            {/* Tracked patterns */}
            <div>
              <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 600, color: '#344057', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 6 }}>
                {lfs.tracked.length} tracked pattern{lfs.tracked.length !== 1 ? 's' : ''}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {lfs.tracked.slice(0, 8).map((p, i) => (
                  <span key={i} style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                    background: 'rgba(255,255,255,0.04)', color: '#5a6880', borderRadius: 4, padding: '2px 7px',
                  }}>{p}</span>
                ))}
                {lfs.tracked.length > 8 && (
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#344057', padding: '2px 0' }}>+{lfs.tracked.length - 8}</span>
                )}
                {lfs.tracked.length === 0 && (
                  <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#344057' }}>No patterns — LFS not configured</span>
                )}
              </div>
            </div>

            {/* Untracked warning */}
            {warnCount > 0 && (
              <div style={{
                background: 'rgba(245,168,50,0.08)', border: '1px solid rgba(245,168,50,0.3)',
                borderRadius: 7, padding: '9px 12px',
              }}>
                <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#f5a832', fontWeight: 600, marginBottom: 5 }}>
                  ⚠ {warnCount} large file{warnCount !== 1 ? 's' : ''} not in LFS
                </div>
                {lfs!.untracked.slice(0, 4).map((f, i) => (
                  <div key={i} style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#5a6880', padding: '1px 0' }}>{f}</div>
                ))}
                {warnCount > 4 && (
                  <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057', marginTop: 2 }}>+{warnCount - 4} more</div>
                )}
              </div>
            )}
          </>
        ) : (
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>LFS data unavailable</span>
        )}
      </div>
    </Card>
  )
}

// ── Active locks card ─────────────────────────────────────────────────────────

function LocksCard({
  locks, repoPath, currentLogin, onDone,
}: { locks: Lock[]; repoPath: string; currentLogin: string | null; onDone: () => void }) {
  const opRun    = useOperationStore(s => s.run)
  const [unlocking, setUnlocking] = useState<string | null>(null)

  const handleUnlock = async (path: string, force: boolean) => {
    setUnlocking(path)
    try { await opRun('Unlocking…', () => ipc.unlockFile(repoPath, path, force)) }
    finally { setUnlocking(null); onDone() }
  }

  const myLocks    = locks.filter(l => l.owner.login === currentLogin)
  const theirLocks = locks.filter(l => l.owner.login !== currentLogin)

  return (
    <Card
      title="Active Locks"
      icon={<LockCardIcon />}
      accentColor={locks.length > 0 ? '#e8622f' : '#2dbd6e'}
    >
      {locks.length === 0 ? (
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect x="7" y="12" width="14" height="10" rx="2" stroke="#2ec573" strokeWidth="1.3" />
            <path d="M10 12V9a4 4 0 0 1 8 0v3" stroke="#2ec573" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>No active locks</span>
        </div>
      ) : (
        <div style={{ overflowY: 'auto', maxHeight: 320 }}>
          {myLocks.length > 0 && <LockSection label="Your locks" locks={myLocks} isOwn onUnlock={p => handleUnlock(p, false)} unlocking={unlocking} />}
          {theirLocks.length > 0 && <LockSection label="Team locks" locks={theirLocks} isOwn={false} onUnlock={p => handleUnlock(p, true)} unlocking={unlocking} />}
        </div>
      )}
    </Card>
  )
}

function LockSection({ label, locks, isOwn, onUnlock, unlocking }: {
  label: string; locks: Lock[]; isOwn: boolean; onUnlock: (p: string) => void; unlocking: string | null
}) {
  return (
    <>
      <div style={{
        padding: '6px 14px 2px', fontFamily: "'IBM Plex Sans', system-ui",
        fontSize: 9, fontWeight: 600, color: '#344057', letterSpacing: '0.09em', textTransform: 'uppercase',
      }}>{label}</div>
      {locks.map(lock => <LockRow key={lock.id} lock={lock} isOwn={isOwn} onUnlock={() => onUnlock(lock.path)} loading={unlocking === lock.path} />)}
    </>
  )
}

function LockRow({ lock, isOwn, onUnlock, loading }: {
  lock: Lock; isOwn: boolean; onUnlock: () => void; loading: boolean
}) {
  const [hover, setHover] = useState(false)
  const fileName = lock.path.split('/').pop() ?? lock.path
  const lockColor = isOwn ? '#2dbd6e' : '#f5a832'

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        minHeight: 44, paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8,
        borderBottom: '1px solid #18202e',
        background: hover ? 'rgba(255,255,255,0.03)' : 'transparent', transition: 'background 0.1s',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ flexShrink: 0, color: lockColor }}>
        <rect x="3" y="6" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M5 6V4.5a2 2 0 0 1 4 0V6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="7" cy="9" r="1" fill="currentColor" />
      </svg>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#e2e6f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={lock.path}>
          {fileName}
        </div>
        <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057', marginTop: 1 }}>
          {lock.owner.name || lock.owner.login} · {timeAgoStr(lock.lockedAt)}
        </div>
        {fileName !== lock.path && (
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#344057', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
            {lock.path}
          </div>
        )}
      </div>
      {hover && (
        <button
          onClick={onUnlock}
          disabled={loading}
          style={{
            height: 22, paddingLeft: 8, paddingRight: 8, borderRadius: 4, flexShrink: 0,
            background: `${lockColor}1a`, border: `1px solid ${lockColor}55`,
            color: lockColor, fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11,
            cursor: loading ? 'default' : 'pointer',
          }}
        >{loading ? '…' : isOwn ? 'Unlock' : 'Force unlock'}</button>
      )}
    </div>
  )
}

// ── Repository size card ──────────────────────────────────────────────────────

function SizeCard({ size, onNavigate }: { size: SizeBreakdown | null; onNavigate: (t: string) => void }) {
  if (!size) return (
    <Card title="Repository Size" icon={<SizeCardIcon />} accentColor="#a27ef0">
      <div style={{ padding: 14 }}>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>Size data unavailable</span>
      </div>
    </Card>
  )

  const sizeColor = size.totalBytes > 5 * 1_073_741_824 ? '#e84545'
    : size.totalBytes > 2 * 1_073_741_824 ? '#f5a832'
    : '#2dbd6e'

  const bars: { label: string; bytes: number; color: string }[] = [
    { label: 'Git Objects', bytes: size.objectsBytes,  color: '#4a9eff' },
    { label: 'Pack Files',  bytes: size.packsBytes,    color: '#a27ef0' },
    { label: 'LFS Cache',   bytes: size.lfsCacheBytes, color: '#2dbd6e' },
    { label: 'Logs',        bytes: size.logsBytes,     color: '#344057' },
  ].filter(b => b.bytes > 0)

  const maxBytes = Math.max(...bars.map(b => b.bytes), 1)

  return (
    <Card
      title="Repository Size"
      icon={<SizeCardIcon />}
      accentColor="#a27ef0"
      actionLabel="Cleanup"
      onAction={() => onNavigate('cleanup')}
    >
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Metric label="Total on disk" value={fmtBytes(size.totalBytes)} color={sizeColor} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {bars.map(b => (
            <div key={b.label}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#5a6880' }}>{b.label}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#344057' }}>{fmtBytes(b.bytes)}</span>
              </div>
              <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }}>
                <div style={{
                  height: 4, borderRadius: 2, background: b.color,
                  width: `${(b.bytes / maxBytes) * 100}%`,
                  opacity: 0.7, transition: 'width 0.4s ease',
                }} />
              </div>
            </div>
          ))}
        </div>

        {size.totalBytes > 2 * 1_073_741_824 && (
          <div style={{
            background: 'rgba(245,168,50,0.08)', border: '1px solid rgba(245,168,50,0.25)',
            borderRadius: 6, padding: '8px 10px',
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#f5a832',
          }}>
            Repository is getting large. Run cleanup to reclaim space.
          </div>
        )}
      </div>
    </Card>
  )
}

// ── Branch activity card ──────────────────────────────────────────────────────

function ActivityCard({ activity, onNavigate }: { activity: BranchActivity[]; onNavigate: (t: string) => void }) {
  return (
    <Card
      title="Branch Activity"
      icon={<ActivityCardIcon />}
      accentColor="#4d9dff"
      actionLabel="History"
      onAction={() => onNavigate('history')}
    >
      {activity.length === 0 ? (
        <div style={{ padding: '16px 14px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>
          No recent branch activity
        </div>
      ) : (
        <div style={{ overflowY: 'auto', maxHeight: 340 }}>
          {activity.slice(0, 12).map((item, i) => {
            const branch = item.ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '')
            const col = authorColor(item.author)
            const ini = initials(item.author)
            return (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  padding: '8px 14px', borderBottom: '1px solid #18202e',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                  background: `linear-gradient(135deg, ${col}88, ${col}44)`,
                  border: `1px solid ${col}55`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 7, fontWeight: 700, color: col,
                }}>{ini}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4a9eff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>{branch}</span>
                    <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#344057', flexShrink: 0 }}>{timeAgoStr(item.date)}</span>
                  </div>
                  <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#5a6880', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.message}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ── Recent commits card ───────────────────────────────────────────────────────

function CommitsCard({ commits, onNavigate }: { commits: CommitEntry[]; onNavigate: (t: string) => void }) {
  return (
    <Card
      title="Recent Commits"
      icon={<CommitCardIcon />}
      accentColor="#a27ef0"
      actionLabel="Full History"
      onAction={() => onNavigate('history')}
    >
      {commits.length === 0 ? (
        <div style={{ padding: '16px 14px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#344057' }}>No commits yet</div>
      ) : (
        <div>
          {commits.map(c => {
            const col = authorColor(c.author)
            const ini = initials(c.author)
            const isMerge = c.parentHashes.length > 1
            return (
              <div
                key={c.hash}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  height: 46, paddingLeft: 14, paddingRight: 14,
                  borderBottom: '1px solid #18202e', transition: 'background 0.1s',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{
                  width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                  background: `linear-gradient(135deg, ${col}88, ${col}44)`,
                  border: `1px solid ${col}55`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 8, fontWeight: 700, color: col,
                }}>{ini}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{
                      fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 500, color: '#e2e6f4',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                    }}>{c.message}</span>
                    {isMerge && (
                      <span style={{
                        background: 'rgba(162,126,240,0.15)', color: '#a27ef0',
                        border: '1px solid rgba(162,126,240,0.3)',
                        borderRadius: 4, padding: '1px 5px',
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 9, flexShrink: 0,
                      }}>MERGE</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#5a6880' }}>{c.author}</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#344057' }}>{timeAgoMs(c.timestamp)}</span>
                  </div>
                </div>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#344057', flexShrink: 0 }}>
                  {c.hash.slice(0, 7)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function SyncIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M13.5 4.5A6 6 0 0 0 2.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M2.5 11.5A6 6 0 0 0 13.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M11 2.5l2.5 2-2.5 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 9.5L2.5 11.5 5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function ChangesCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5 5.5h6M5 8h4.5M5 10.5h5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
}

function LFSCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <ellipse cx="8" cy="4.5" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M3 4.5V11.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M13 4.5V11.5" stroke="currentColor" strokeWidth="1.3" />
    <ellipse cx="8" cy="11.5" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
    <ellipse cx="8" cy="8" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
  </svg>
}

function LockCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <rect x="3" y="7" width="10" height="7" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <circle cx="8" cy="10.5" r="1.2" fill="currentColor" />
  </svg>
}

function SizeCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 4v4l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function ActivityCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <polyline points="1,8 4,4 7,11 10,6 13,9 16,7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function CommitCardIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3" />
    <path d="M1 8h4.5M10.5 8H15" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
}

// ── Main panel ────────────────────────────────────────────────────────────────

export function OverviewPanel({ repoPath, onNavigate, onRefresh }: OverviewPanelProps) {
  const { fileStatus } = useRepoStore()
  const { accounts, currentAccountId } = useAuthStore()

  const [sync,       setSync]       = useState<SyncStatus     | null>(null)
  const [lfs,        setLfs]        = useState<LFSStatus      | null>(null)
  const [size,       setSize]       = useState<SizeBreakdown  | null>(null)
  const [locks,      setLocks]      = useState<Lock[]>([])
  const [stash,      setStash]      = useState<StashEntry[]>([])
  const [activity,   setActivity]   = useState<BranchActivity[]>([])
  const [commits,    setCommits]    = useState<CommitEntry[]>([])
  const [branch,     setBranch]     = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<number | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadAll = useCallback(async () => {
    setRefreshing(true)
    const [branchR, syncR, lfsR, sizeR, locksR, stashR, activityR, commitsR] = await Promise.allSettled([
      ipc.currentBranch(repoPath),
      ipc.getSyncStatus(repoPath),
      ipc.lfsStatus(repoPath),
      ipc.cleanupSize(repoPath),
      ipc.listLocks(repoPath),
      ipc.stashList(repoPath),
      ipc.gitBranchActivity(repoPath),
      ipc.log(repoPath, { limit: 10 }),
    ])
    if (!mounted.current) return
    if (branchR.status   === 'fulfilled') setBranch(branchR.value)
    if (syncR.status     === 'fulfilled') setSync(syncR.value)
    if (lfsR.status      === 'fulfilled') setLfs(lfsR.value)
    if (sizeR.status     === 'fulfilled') setSize(sizeR.value)
    if (locksR.status    === 'fulfilled') setLocks(locksR.value)
    if (stashR.status    === 'fulfilled') setStash(stashR.value)
    if (activityR.status === 'fulfilled') setActivity(activityR.value)
    if (commitsR.status  === 'fulfilled') setCommits(commitsR.value)
    setLastUpdate(Date.now())
    setRefreshing(false)
  }, [repoPath])

  useEffect(() => { loadAll() }, [loadAll])

  const stagedCount   = fileStatus.filter(f =>  f.staged).length
  const unstagedCount = fileStatus.filter(f => !f.staged).length
  const currentLogin  = accounts.find(a => a.userId === currentAccountId)?.login ?? null

  // ── Compute health status chips ──────────────────────────────────────────────
  const syncDot = !sync ? '#344057'
    : sync.behind > 0   ? '#f5a832'
    : sync.ahead  > 0   ? '#e8622f'
    : '#2dbd6e'
  const syncLabel = !sync             ? 'No upstream'
    : sync.behind > 0 && sync.ahead > 0 ? `↑${sync.ahead} ↓${sync.behind}`
    : sync.behind > 0                   ? `↓${sync.behind} behind`
    : sync.ahead  > 0                   ? `↑${sync.ahead} to push`
    : 'In sync'

  const changesDot   = (stagedCount + unstagedCount) > 0 ? '#f5a832' : '#2dbd6e'
  const changesLabel = stagedCount + unstagedCount === 0 ? 'Clean' : `${stagedCount + unstagedCount} change${stagedCount + unstagedCount !== 1 ? 's' : ''}`

  const locksDot   = locks.length > 0 ? '#e8622f' : '#344057'
  const locksLabel = locks.length === 0 ? 'No locks' : `${locks.length} lock${locks.length !== 1 ? 's' : ''}`

  const lfsWarnDot   = (lfs?.untracked.length ?? 0) > 0 ? '#f5a832' : lfs ? '#2dbd6e' : '#344057'
  const lfsLabel     = !lfs ? 'LFS —' : (lfs.untracked.length > 0 ? `⚠ ${lfs.untracked.length} untracked` : `LFS OK`)

  const sizeDot   = !size ? '#344057'
    : size.totalBytes > 5 * 1_073_741_824 ? '#e84545'
    : size.totalBytes > 2 * 1_073_741_824 ? '#f5a832'
    : '#344057'
  const sizeLabel = size ? fmtBytes(size.totalBytes) : 'Size —'

  // ── Warnings ─────────────────────────────────────────────────────────────────
  const warnings: { msg: string; color: string }[] = []
  if (sync && sync.behind > 0)
    warnings.push({ msg: `${sync.behind} commit${sync.behind !== 1 ? 's' : ''} behind ${sync.remoteName}/${sync.remoteBranch}`, color: sync.behind > 5 ? '#e84545' : '#f5a832' })
  if ((lfs?.untracked.length ?? 0) > 0)
    warnings.push({ msg: `${lfs!.untracked.length} large file${lfs!.untracked.length !== 1 ? 's' : ''} not tracked in LFS`, color: '#f5a832' })
  if (size && size.totalBytes > 5 * 1_073_741_824)
    warnings.push({ msg: `Repository is ${fmtBytes(size.totalBytes)} — consider cleanup`, color: '#f5a832' })
  if (stash.length > 5)
    warnings.push({ msg: `${stash.length} stashed changesets accumulating`, color: '#a27ef0' })
  if (sync && !sync.hasUpstream)
    warnings.push({ msg: 'Branch has no remote upstream configured', color: '#344057' })

  const repoName = repoPath.split(/[/\\]/).pop() ?? repoPath

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: '#0d0f15' }}>
      <div style={{ padding: 18, minWidth: 640, display: 'flex', flexDirection: 'column', gap: 14, animation: 'fade-in 0.25s ease both' }}>

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 17, fontWeight: 700, color: '#e2e6f4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.02em' }}>
              {repoName}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3 }}>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><circle cx="3" cy="3" r="2" stroke="#4a9eff" strokeWidth="1.2"/><circle cx="3" cy="9" r="2" stroke="#4a9eff" strokeWidth="1.2"/><path d="M3 5v2M9 6c0-1.7-1.3-3-3-3" stroke="#4a9eff" strokeWidth="1.1" strokeLinecap="round"/></svg>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4a9eff' }}>{branch || '—'}</span>
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#1e2a3a' }}>·</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#283047', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {repoPath}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {lastUpdate && (
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#283047' }}>
                {timeAgoMs(lastUpdate)}
              </span>
            )}
            <button
              onClick={() => { loadAll(); onRefresh() }}
              disabled={refreshing}
              style={{
                height: 28, paddingLeft: 12, paddingRight: 12, borderRadius: 6,
                background: 'rgba(255,255,255,0.02)', border: '1px solid #1a2030',
                color: refreshing ? '#344057' : '#5a6880',
                fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5,
                cursor: refreshing ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
              onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.borderColor = '#e8622f'; e.currentTarget.style.color = '#e8622f' } }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2030'; e.currentTarget.style.color = refreshing ? '#344057' : '#5a6880' }}
            >
              <span style={{ fontSize: 14 }}>{refreshing ? '…' : '↺'}</span>
              Refresh
            </button>
          </div>
        </div>

        {/* ── Health status strip ───────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <StatusChip dot={syncDot}   label={syncLabel}    onClick={() => {}} />
          <StatusChip dot={changesDot} label={changesLabel} onClick={() => onNavigate('changes')} />
          <StatusChip dot={locksDot}   label={locksLabel}   />
          <StatusChip dot={lfsWarnDot} label={lfsLabel}     onClick={() => onNavigate('lfs')} />
          <StatusChip dot={sizeDot}    label={sizeLabel}    onClick={() => onNavigate('cleanup')} />
        </div>

        {/* ── Warnings ─────────────────────────────────────────────────────── */}
        {warnings.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {warnings.map((w, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 11px', borderRadius: 7,
                background: `${w.color}09`, border: `1px solid ${w.color}28`,
                boxShadow: `0 0 12px ${w.color}0c`,
              }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ color: w.color, flexShrink: 0 }}>
                  <path d="M8 2 L14.5 13.5 H1.5 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  <path d="M8 6.5v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  <circle cx="8" cy="11.5" r="0.8" fill="currentColor" />
                </svg>
                <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5, color: w.color }}>{w.msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── Row 1: Sync | Working Copy | LFS ─────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
          <SyncCard sync={sync} branch={branch} repoPath={repoPath} onDone={loadAll} />
          <WorkingCopyCard staged={stagedCount} unstaged={unstagedCount} stash={stash} onNavigate={onNavigate} />
          <LfsCard lfs={lfs} onNavigate={onNavigate} />
        </div>

        {/* ── Row 2: Active Locks | Repository Size ────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 14 }}>
          <LocksCard locks={locks} repoPath={repoPath} currentLogin={currentLogin} onDone={loadAll} />
          <SizeCard size={size} onNavigate={onNavigate} />
        </div>

        {/* ── Row 3: Recent Commits | Branch Activity ───────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 14 }}>
          <CommitsCard commits={commits} onNavigate={onNavigate} />
          <ActivityCard activity={activity} onNavigate={onNavigate} />
        </div>

      </div>
    </div>
  )
}
