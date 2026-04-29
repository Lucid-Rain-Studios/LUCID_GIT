import React, { useState, useCallback, useRef } from 'react'
import { ipc, Lock } from '@/ipc'
import { useLockStore } from '@/stores/lockStore'
import { useAuthStore } from '@/stores/authStore'
import { useDialogStore } from '@/stores/dialogStore'

interface LockedFilesPanelProps {
  repoPath: string
}

function timeAgoStr(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60)     return 'just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

function authorColor(name: string): string {
  const palette = ['#4a9eff', '#a27ef0', '#2dbd6e', '#f5a832', '#e8622f', '#1abc9c', '#e91e63']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase()
}

export function LockedFilesPanel({ repoPath }: LockedFilesPanelProps) {
  const { locks, loadLocks, unlockFile } = useLockStore()
  const { accounts, currentAccountId } = useAuthStore()
  const isAdmin = useAuthStore(s => s.isAdmin(repoPath))
  const dialog  = useDialogStore()

  const currentLogin = accounts.find(a => a.userId === currentAccountId)?.login ?? null

  const [tab,       setTab]       = useState<'mine' | 'team'>('mine')
  const [search,    setSearch]    = useState('')
  const [unlocking, setUnlocking] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [collapsedOwners, setCollapsedOwners] = useState<Set<string>>(new Set())

  const myLocks   = locks.filter(l => currentLogin && l.owner.login === currentLogin)
  const teamLocks = locks.filter(l => !currentLogin || l.owner.login !== currentLogin)
  const source    = tab === 'mine' ? myLocks : teamLocks

  const filtered = search.trim()
    ? source.filter(l =>
        l.path.toLowerCase().includes(search.toLowerCase()) ||
        l.owner.login.toLowerCase().includes(search.toLowerCase()) ||
        l.owner.name.toLowerCase().includes(search.toLowerCase())
      )
    : source

  // Group team locks by owner
  const ownerGroups: { login: string; name: string; locks: typeof teamLocks }[] = []
  if (tab === 'team') {
    const seen = new Map<string, typeof ownerGroups[0]>()
    for (const l of filtered) {
      if (!seen.has(l.owner.login)) {
        const group = { login: l.owner.login, name: l.owner.name, locks: [] as typeof teamLocks }
        seen.set(l.owner.login, group)
        ownerGroups.push(group)
      }
      seen.get(l.owner.login)!.locks.push(l)
    }
  }

  const toggleOwner = (login: string) => {
    setCollapsedOwners(prev => {
      const next = new Set(prev)
      next.has(login) ? next.delete(login) : next.add(login)
      return next
    })
  }

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try { await loadLocks(repoPath) } finally { setRefreshing(false) }
  }, [repoPath, loadLocks])

  const doUnlock = async (lock: Lock, force: boolean) => {
    if (force) {
      const ok = await dialog.confirm({
        title: 'Force unlock',
        message: `Force-unlock "${lock.path}"?`,
        detail: `This will release the lock held by ${lock.owner.name}.`,
        confirmLabel: 'Force Unlock',
        danger: true,
      })
      if (!ok) return
    }
    setUnlocking(lock.path)
    try {
      await unlockFile(repoPath, lock.path, force)
    } catch (e) {
      await dialog.alert({ title: 'Error', message: String(e) })
    } finally {
      setUnlocking(null)
    }
  }

  const doCopyPath = (lock: Lock) => {
    navigator.clipboard.writeText(lock.path.replace(/\//g, '\\'))
  }

  const doShowInExplorer = (lock: Lock) => {
    const full = `${repoPath.replace(/\\/g, '/')}/${lock.path}`
    ipc.showInFolder(full.replace(/\//g, '\\'))
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#0d0f15', overflow: 'hidden', fontFamily: "'IBM Plex Sans', system-ui" }}>

      {/* ── Header ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '16px 24px 0', flexShrink: 0,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#c8d0e8', letterSpacing: '-0.03em', lineHeight: 1 }}>
            Locked Files
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#344057', marginTop: 4 }}>
            {locks.length} lock{locks.length !== 1 ? 's' : ''} active across repository
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            height: 28, padding: '0 12px', borderRadius: 6,
            border: '1px solid #1a2030', background: 'transparent',
            color: refreshing ? '#344057' : '#5a6880', fontSize: 11.5,
            cursor: refreshing ? 'default' : 'pointer',
            fontFamily: "'IBM Plex Sans', system-ui",
            opacity: refreshing ? 0.5 : 1,
          }}
          onMouseEnter={e => { if (!refreshing) { e.currentTarget.style.borderColor = '#283047'; e.currentTarget.style.color = '#8a94aa' } }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2030'; e.currentTarget.style.color = refreshing ? '#344057' : '#5a6880' }}
        >
          <RefreshIcon spinning={refreshing} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* ── Tabs + Search ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '14px 24px 0', flexShrink: 0 }}>
        {/* Tab pills */}
        <div style={{
          display: 'flex', gap: 2, background: '#131720',
          border: '1px solid #1a2030', borderRadius: 8, padding: 3,
        }}>
          {(['mine', 'team'] as const).map(t => {
            const count = t === 'mine' ? myLocks.length : teamLocks.length
            const active = tab === t
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  height: 26, paddingLeft: 14, paddingRight: 14,
                  borderRadius: 6, border: 'none', cursor: 'pointer',
                  background: active ? '#1d2437' : 'transparent',
                  color: active ? '#dde1f0' : '#4a566a',
                  fontFamily: "'IBM Plex Sans', system-ui",
                  fontSize: 12, fontWeight: active ? 600 : 400,
                  boxShadow: active ? '0 1px 4px rgba(0,0,0,0.4)' : 'none',
                  transition: 'all 0.12s',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {t === 'mine' ? 'My Locks' : 'Team Locks'}
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                  background: active ? 'rgba(232,98,47,0.2)' : '#1a2030',
                  color: active ? '#e8622f' : '#4a566a',
                  borderRadius: 6, padding: '1px 5px',
                  border: active ? '1px solid rgba(232,98,47,0.3)' : '1px solid transparent',
                }}>{count}</span>
              </button>
            )
          })}
        </div>

        {/* Search */}
        <div style={{ flex: 1, marginLeft: 12, position: 'relative' }}>
          <div style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#344057', pointerEvents: 'none' }}>
            <SearchIcon />
          </div>
          <input
            type="text"
            placeholder="Filter by file or user…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', height: 32, paddingLeft: 30, paddingRight: 10,
              background: '#131720', border: '1px solid #1a2030', borderRadius: 7,
              color: '#c8d0e8', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12,
              outline: 'none', boxSizing: 'border-box',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = '#283047' }}
            onBlur={e => { e.currentTarget.style.borderColor = '#1a2030' }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: '#344057', padding: 2,
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#8a94aa' }}
              onMouseLeave={e => { e.currentTarget.style.color = '#344057' }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Stats bar ── */}
      <div style={{ display: 'flex', gap: 16, padding: '12px 24px 0', flexShrink: 0 }}>
        <StatChip label="Total" value={locks.length} color="#5a6880" />
        <StatChip label="Mine" value={myLocks.length} color="#4a9eff" />
        <StatChip label="Team" value={teamLocks.length} color="#a27ef0" />
      </div>

      {/* ── Divider ── */}
      <div style={{ margin: '14px 24px 0', height: 1, background: '#1a2030', flexShrink: 0 }} />

      {/* ── Lock list ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 24px 24px' }}>
        {filtered.length === 0 ? (
          <EmptyState
            tab={tab}
            hasSearch={!!search.trim()}
            onClearSearch={() => setSearch('')}
          />
        ) : tab === 'mine' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map(lock => (
              <LockRow
                key={lock.id}
                lock={lock}
                repoPath={repoPath}
                currentLogin={currentLogin}
                isAdmin={isAdmin}
                unlocking={unlocking}
                onUnlock={doUnlock}
                onCopyPath={doCopyPath}
                onShowInExplorer={doShowInExplorer}
              />
            ))}
          </div>
        ) : (
          /* Team tab — grouped by owner */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {ownerGroups.map(group => {
              const isCollapsed = collapsedOwners.has(group.login)
              const color = authorColor(group.name)
              return (
                <div key={group.login} style={{
                  border: '1px solid #1a2030', borderRadius: 10, overflow: 'hidden',
                }}>
                  {/* Owner header */}
                  <button
                    onClick={() => toggleOwner(group.login)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 14px',
                      background: '#131720', border: 'none', cursor: 'pointer',
                      borderBottom: isCollapsed ? 'none' : '1px solid #1a2030',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#192030' }}
                    onMouseLeave={e => { e.currentTarget.style.background = '#131720' }}
                  >
                    {/* Avatar */}
                    <div style={{
                      width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                      background: `${color}18`, border: `1.5px solid ${color}44`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, fontWeight: 700, color,
                    }}>
                      {initials(group.name)}
                    </div>
                    <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                      <div style={{
                        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 600,
                        color: '#c8d0e8',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{group.name}</div>
                      <div style={{
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#344057',
                      }}>{group.login}</div>
                    </div>
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                      background: `${color}18`, color,
                      border: `1px solid ${color}33`, borderRadius: 6,
                      padding: '2px 7px', flexShrink: 0,
                    }}>{group.locks.length}</span>
                    <svg
                      width="10" height="10" viewBox="0 0 10 10" fill="none"
                      style={{
                        color: '#4e5870', flexShrink: 0,
                        transform: isCollapsed ? 'rotate(-90deg)' : 'none',
                        transition: 'transform 0.15s ease',
                      }}
                    >
                      <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>

                  {/* Files */}
                  {!isCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '6px 8px 8px' }}>
                      {group.locks.map(lock => (
                        <LockRow
                          key={lock.id}
                          lock={lock}
                          repoPath={repoPath}
                          currentLogin={currentLogin}
                          isAdmin={isAdmin}
                          unlocking={unlocking}
                          onUnlock={doUnlock}
                          onCopyPath={doCopyPath}
                          onShowInExplorer={doShowInExplorer}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Lock Row ──────────────────────────────────────────────────────────────────

function LockRow({
  lock, repoPath, currentLogin, isAdmin, unlocking,
  onUnlock, onCopyPath, onShowInExplorer,
}: {
  lock: Lock
  repoPath: string
  currentLogin: string | null
  isAdmin: boolean
  unlocking: string | null
  onUnlock: (lock: Lock, force: boolean) => void
  onCopyPath: (lock: Lock) => void
  onShowInExplorer: (lock: Lock) => void
}) {
  const [hover, setHover] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const isOwn     = currentLogin && lock.owner.login === currentLogin
  const isBusy    = unlocking === lock.path
  const canUnlock = isOwn || isAdmin
  const force     = !isOwn
  const color     = authorColor(lock.owner.name)

  const filename = lock.path.replace(/\\/g, '/').split('/').pop() ?? lock.path
  const dir = lock.path.replace(/\\/g, '/').includes('/')
    ? lock.path.replace(/\\/g, '/').slice(0, lock.path.replace(/\\/g, '/').lastIndexOf('/'))
    : ''

  const ext = filename.split('.').pop()?.toUpperCase() ?? ''

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setMenuOpen(false) }}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 14px', borderRadius: 8,
        background: hover ? '#131720' : 'rgba(19,23,32,0.5)',
        border: `1px solid ${isOwn ? 'rgba(74,158,255,0.15)' : '#1a2030'}`,
        transition: 'all 0.1s', cursor: 'default',
        position: 'relative',
      }}
    >
      {/* Avatar */}
      <div style={{
        width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
        background: `${color}18`, border: `1.5px solid ${color}44`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700, color,
      }}>
        {initials(lock.owner.name)}
      </div>

      {/* File info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, fontWeight: 500,
            color: isOwn ? '#c8d0e8' : '#8a94aa',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }} title={lock.path}>
            {filename}
          </span>
          {ext && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
              background: 'rgba(90,104,128,0.15)', color: '#5a6880',
              border: '1px solid rgba(90,104,128,0.2)', borderRadius: 3,
              padding: '0 4px', lineHeight: '14px', flexShrink: 0,
            }}>{ext}</span>
          )}
          {isOwn && (
            <span style={{
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9.5, fontWeight: 600,
              background: 'rgba(74,158,255,0.12)', color: '#4a9eff',
              border: '1px solid rgba(74,158,255,0.25)', borderRadius: 4,
              padding: '1px 6px', flexShrink: 0,
            }}>You</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
          {dir && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: '#344057',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }} title={dir}>{dir}/</span>
          )}
          {!dir && <span style={{ flex: 1 }} />}
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5, color: '#4a566a', flexShrink: 0 }}>
            {lock.owner.login}
          </span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: '#283047', flexShrink: 0 }}>
            ·
          </span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, color: '#283047', flexShrink: 0 }}>
            {timeAgoStr(lock.lockedAt)}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {/* Copy path */}
        {hover && (
          <>
            <ActionBtn
              title="Copy path"
              onClick={() => onCopyPath(lock)}
              icon={<CopyIcon />}
            />
            <ActionBtn
              title="Show in Explorer"
              onClick={() => onShowInExplorer(lock)}
              icon={<ExplorerIcon />}
            />
          </>
        )}

        {/* Unlock button */}
        {canUnlock ? (
          <button
            onClick={() => onUnlock(lock, force)}
            disabled={isBusy}
            style={{
              height: 26, padding: '0 12px', borderRadius: 5, flexShrink: 0,
              background: 'transparent',
              border: `1px solid ${force ? 'rgba(232,69,69,0.3)' : 'rgba(74,158,255,0.3)'}`,
              color: force ? '#e84545' : '#4a9eff',
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, fontWeight: 600,
              cursor: isBusy ? 'default' : 'pointer', opacity: isBusy ? 0.5 : 1,
              transition: 'all 0.1s',
            }}
            onMouseEnter={e => { if (!isBusy) e.currentTarget.style.background = force ? 'rgba(232,69,69,0.08)' : 'rgba(74,158,255,0.08)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            {isBusy ? '…' : force ? 'Force Unlock' : 'Unlock'}
          </button>
        ) : (
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
            background: 'rgba(90,104,128,0.08)', color: '#4a566a',
            border: '1px solid rgba(90,104,128,0.15)', borderRadius: 4,
            padding: '3px 7px', flexShrink: 0,
          }}>
            {lock.owner.login.slice(0, 5).toUpperCase()}
          </span>
        )}
      </div>
    </div>
  )
}

// ── Empty State ───────────────────────────────────────────────────────────────

function EmptyState({ tab, hasSearch, onClearSearch }: {
  tab: 'mine' | 'team'; hasSearch: boolean; onClearSearch: () => void
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: '60px 24px', gap: 12,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 11,
        background: 'rgba(255,255,255,0.025)', border: '1px solid #1d2535',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="#283047" strokeWidth="1.3" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="#283047" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="10.5" r="1" fill="#283047" />
        </svg>
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#4a566a', fontWeight: 500 }}>
          {hasSearch
            ? 'No locks match your filter'
            : tab === 'mine'
              ? 'No files locked by you'
              : 'No team locks'
          }
        </div>
        <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5, color: '#283047', marginTop: 4 }}>
          {hasSearch
            ? 'Try a different search term'
            : tab === 'mine'
              ? 'Lock a file from the Changes view to reserve it for editing'
              : 'Your team has no active locks right now'
          }
        </div>
      </div>
      {hasSearch && (
        <button
          onClick={onClearSearch}
          style={{
            height: 28, padding: '0 14px', borderRadius: 6,
            background: 'transparent', border: '1px solid #1a2030',
            color: '#5a6880', fontFamily: "'IBM Plex Sans', system-ui",
            fontSize: 11.5, cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#283047'; e.currentTarget.style.color = '#8a94aa' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2030'; e.currentTarget.style.color = '#5a6880' }}
        >
          Clear filter
        </button>
      )}
    </div>
  )
}

// ── Stat Chip ─────────────────────────────────────────────────────────────────

function StatChip({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 700,
        color, lineHeight: 1, textShadow: `0 0 14px ${color}30`,
      }}>{value}</span>
      <span style={{
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5,
        color: '#344057', textTransform: 'uppercase', letterSpacing: '0.08em',
      }}>{label}</span>
    </div>
  )
}

// ── Action Button ─────────────────────────────────────────────────────────────

function ActionBtn({ title, onClick, icon }: { title: string; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 26, height: 26, borderRadius: 5, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent', border: '1px solid #1a2030',
        color: '#4a566a', cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = '#283047'; e.currentTarget.style.color = '#8a94aa'; e.currentTarget.style.background = '#1a2030' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2030'; e.currentTarget.style.color = '#4a566a'; e.currentTarget.style.background = 'transparent' }}
    >
      {icon}
    </button>
  )
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

function RefreshIcon({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="11" height="11" viewBox="0 0 16 16" fill="none"
      style={{ animation: spinning ? 'spin 0.8s linear infinite' : 'none' }}
    >
      <path d="M13.5 8a5.5 5.5 0 1 1-1.1-3.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M12.5 3v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <rect x="5.5" y="5.5" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ExplorerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3.5" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 6.5h13" stroke="currentColor" strokeWidth="0.9" strokeOpacity="0.5" />
      <path d="M5.5 9.5L7 11l3.5-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
