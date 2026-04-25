import React, { useState, useEffect, useCallback } from 'react'
import { ipc, SyncStatus, UpdateInfo } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useAuthStore } from '@/stores/authStore'
import { useOperationStore } from '@/stores/operationStore'
import { useErrorStore } from '@/stores/errorStore'
import { NotificationBell } from '@/components/notifications/NotificationBell'

interface TopBarProps {
  onOpen:       () => void
  onClone:      () => void
  onAddAccount: () => void
  onSynced?:    () => void
}

export function TopBar({ onOpen, onClone, onAddAccount, onSynced }: TopBarProps) {
  const { repoPath, currentBranch, refreshStatus } = useRepoStore()
  const { accounts, currentAccountId, permissionErrors, fetchRepoPermission } = useAuthStore()
  const opRun   = useOperationStore(s => s.run)
  const pushErr = useErrorStore(s => s.pushRaw)

  const [sync, setSync]       = useState<SyncStatus | null>(null)
  const [syncOp, setSyncOp]   = useState<'idle' | 'fetching' | 'pulling' | 'pushing'>('idle')
  const [syncErr, setSyncErr] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [repoMenuOpen, setRepoMenuOpen] = useState(false)

  const [updateInfo, setUpdateInfo]       = useState<UpdateInfo | null>(null)
  const [updateReady, setUpdateReady]     = useState(false)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [downloading, setDownloading]     = useState(false)

  const loadSync = useCallback(async () => {
    if (!repoPath) return
    try { setSync(await ipc.getSyncStatus(repoPath)) } catch { /* no upstream */ }
  }, [repoPath])

  useEffect(() => {
    setSync(null); setSyncErr(null)
    if (repoPath) loadSync()
  }, [repoPath, currentBranch])

  useEffect(() => {
    const unsubAvail = ipc.onUpdateAvailable((info: UpdateInfo) => { setUpdateInfo(info); setUpdateDismissed(false) })
    const unsubReady = ipc.onUpdateReady(() => { setUpdateReady(true); setDownloading(false) })
    return () => { unsubAvail(); unsubReady() }
  }, [])

  const doFetch = async () => {
    if (!repoPath || syncOp !== 'idle') return
    setSyncOp('fetching'); setSyncErr(null)
    try { await opRun('Fetching…', () => ipc.fetch(repoPath)); await loadSync() }
    catch (e) { const s = String(e); setSyncErr(s); pushErr(s) }
    finally { setSyncOp('idle') }
  }

  const doPull = async () => {
    if (!repoPath || syncOp !== 'idle') return
    setSyncOp('pulling'); setSyncErr(null)
    try { await opRun('Pulling…', () => ipc.pull(repoPath)); await loadSync(); await refreshStatus(); onSynced?.() }
    catch (e) { const s = String(e); setSyncErr(s); pushErr(s) }
    finally { setSyncOp('idle') }
  }

  const doPush = async () => {
    if (!repoPath || syncOp !== 'idle') return
    setSyncOp('pushing'); setSyncErr(null)
    try { await opRun('Pushing…', () => ipc.push(repoPath)); await loadSync() }
    catch (e) { const s = String(e); setSyncErr(s); pushErr(s) }
    finally { setSyncOp('idle') }
  }

  const isIdle = syncOp === 'idle'
  const hasBehind = (sync?.behind ?? 0) > 0
  const hasAhead  = (sync?.ahead  ?? 0) > 0

  type PrimaryAction = { label: string; action: (() => void) | null; color: string; colorDim: string; count: number; icon: React.ReactNode }

  const primary: PrimaryAction = !isIdle
    ? { label: syncOp === 'fetching' ? 'Fetching…' : syncOp === 'pulling' ? 'Pulling…' : 'Pushing…',
        action: null, color: '#7b8499', colorDim: 'rgba(123,132,153,0.08)', count: 0, icon: null }
    : hasBehind
      ? { label: 'Pull', action: doPull, color: '#f5a832', colorDim: 'rgba(245,168,50,0.12)', count: sync!.behind, icon: <ArrowDown /> }
      : hasAhead
        ? { label: 'Push', action: doPush, color: '#2dbd6e', colorDim: 'rgba(45,189,110,0.12)', count: sync!.ahead, icon: <ArrowUp /> }
        : { label: 'Fetch', action: doFetch, color: '#7b8499', colorDim: 'transparent', count: 0, icon: <FetchIcon /> }

  const hasPending = primary.count > 0 && !syncErr
  const borderColor = syncErr ? '#e84040' : hasPending ? primary.color : '#1d2535'
  const bgColor     = syncErr ? 'rgba(232,64,64,0.1)' : hasPending ? primary.colorDim : 'transparent'
  const labelColor  = syncErr ? '#e84040' : hasPending ? primary.color : '#7b8499'

  const repoName = repoPath
    ? (repoPath.replace(/\\/g, '/').split('/').pop() ?? repoPath)
    : null

  const currentAccount = accounts.find(a => a.userId === currentAccountId)
  const initials = currentAccount
    ? currentAccount.login.slice(0, 2).toUpperCase()
    : null

  const showBanner = !updateDismissed && (updateReady || !!updateInfo)
  const [permWarnDismissed, setPermWarnDismissed] = useState(false)
  const permError = repoPath ? permissionErrors[repoPath] : false

  useEffect(() => { setPermWarnDismissed(false) }, [repoPath])

  return (
    <>
      {/* Permission warning banner */}
      {repoPath && permError && !permWarnDismissed && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 16px', height: 28, fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace", flexShrink: 0,
          background: 'rgba(245,168,50,0.08)',
          borderBottom: '1px solid rgba(245,168,50,0.2)',
          color: '#f5a832',
        }}>
          <span>Permission check unavailable — operating in collaborator mode. Admin features are restricted.</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => fetchRepoPermission(repoPath)}
              style={{ padding: '0 8px', height: 20, borderRadius: 4, border: '1px solid currentColor',
                background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer' }}
            >Retry</button>
            <button onClick={() => setPermWarnDismissed(true)}
              style={{ background: 'none', border: 'none', color: 'inherit', opacity: 0.4, cursor: 'pointer', fontSize: 14 }}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Update banner */}
      {showBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 16px', height: 28, fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace", flexShrink: 0,
          background: updateReady ? 'rgba(45,189,110,0.1)' : 'rgba(74,158,255,0.1)',
          borderBottom: `1px solid ${updateReady ? 'rgba(45,189,110,0.2)' : 'rgba(74,158,255,0.2)'}`,
          color: updateReady ? '#2dbd6e' : '#4a9eff',
        }}>
          <span>
            {updateReady
              ? `Update v${updateInfo?.version ?? ''} downloaded — ready to install`
              : `Update v${updateInfo?.version ?? ''} available`}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {!updateReady && (
              <button onClick={() => { setDownloading(true); ipc.updateDownload().catch(() => setDownloading(false)) }}
                disabled={downloading}
                style={{ padding: '0 8px', height: 20, borderRadius: 4, border: '1px solid currentColor',
                  background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 10, cursor: 'pointer' }}>
                {downloading ? 'Downloading…' : 'Download'}
              </button>
            )}
            {updateReady && (
              <button onClick={() => ipc.updateInstall()}
                style={{ padding: '0 8px', height: 20, borderRadius: 4, border: '1px solid currentColor',
                  background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 10,
                  fontWeight: 700, cursor: 'pointer' }}>
                Restart &amp; Install
              </button>
            )}
            <button onClick={() => setUpdateDismissed(true)}
              style={{ background: 'none', border: 'none', color: 'inherit', opacity: 0.4, cursor: 'pointer', fontSize: 14 }}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Main bar */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 46, paddingLeft: 14, paddingRight: 12,
        background: 'linear-gradient(180deg, #181d2c 0%, #131720 100%)',
        borderBottom: '1px solid #1a2030',
        boxShadow: '0 1px 0 rgba(0,0,0,0.3), 0 4px 20px rgba(0,0,0,0.2)',
        flexShrink: 0, gap: 12, zIndex: 20, position: 'relative',
      }}>
        {/* Left: wordmark + repo + branch */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {/* Logo mark + wordmark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <LucidLogoMark />
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700,
              color: '#e8622f', letterSpacing: '0.1em', userSelect: 'none',
              textShadow: '0 0 18px rgba(232,98,47,0.35)',
            }}>
              LUCID GIT
            </span>
          </div>

          {repoName ? (
            <>
              <span style={{ color: '#283047', fontSize: 14, flexShrink: 0, userSelect: 'none' }}>›</span>

              {/* Repo name — clickable dropdown trigger */}
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <RepoSwitcherBtn
                  repoName={repoName}
                  repoPath={repoPath!}
                  open={repoMenuOpen}
                  onToggle={() => setRepoMenuOpen(o => !o)}
                />
                {repoMenuOpen && (
                  <>
                    <div
                      onClick={() => setRepoMenuOpen(false)}
                      style={{ position: 'fixed', inset: 0, zIndex: 90 }}
                    />
                    <div style={{
                      position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100,
                      background: 'linear-gradient(180deg, #161c2b 0%, #131720 100%)',
                      border: '1px solid #1d2535',
                      borderRadius: 8,
                      boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
                      minWidth: 210, overflow: 'hidden',
                      animation: 'slide-down 0.14s ease both',
                    }}>
                      {/* Current repo path label */}
                      <div style={{
                        padding: '9px 12px 7px',
                        borderBottom: '1px solid #18202e',
                      }}>
                        <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#344057', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 3 }}>
                          Current repository
                        </div>
                        <div style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
                          color: '#4a566a',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          maxWidth: 230,
                        }} title={repoPath!}>
                          {repoPath!.replace(/\\/g, '/')}
                        </div>
                      </div>

                      {/* Actions */}
                      <div style={{ padding: '4px 0' }}>
                        <RepoMenuItem
                          icon={<FolderOpenIcon />}
                          label="Open Repository…"
                          shortcut="⌘O"
                          onClick={() => { setRepoMenuOpen(false); onOpen() }}
                        />
                        <RepoMenuItem
                          icon={<CloneIcon />}
                          label="Clone Repository…"
                          onClick={() => { setRepoMenuOpen(false); onClone() }}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>

              {currentBranch && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  background: 'rgba(74,158,255,0.1)', border: '1px solid rgba(74,158,255,0.2)',
                  borderRadius: 20, paddingLeft: 8, paddingRight: 10, height: 22, flexShrink: 0,
                }}>
                  <BranchIconSm />
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5,
                    color: '#4a9eff', fontWeight: 500, letterSpacing: '0.01em',
                  }}>
                    {currentBranch}
                  </span>
                </div>
              )}
            </>
          ) : (
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#344057' }}>
              No repository open
            </span>
          )}
        </div>

        {/* Right: sync + notifs + account */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>

          {/* Welcome buttons when no repo */}
          {!repoPath && (
            <>
              <TopBtn onClick={onOpen} label="Open" />
              <TopBtn onClick={onClone} label="Clone" accent />
            </>
          )}

          {/* Smart sync split button */}
          {repoPath && (
            <div style={{ position: 'relative', display: 'flex' }}>
              {/* Primary action */}
              <button
                onClick={() => { if (isIdle && primary.action) primary.action() }}
                disabled={!isIdle}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  height: 28, paddingLeft: 10, paddingRight: 10,
                  borderRadius: '5px 0 0 5px', border: `1px solid ${borderColor}`, borderRight: 'none',
                  background: bgColor, color: labelColor,
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 500,
                  cursor: isIdle && primary.action ? 'pointer' : 'not-allowed',
                  opacity: !isIdle ? 0.6 : 1,
                  boxShadow: hasPending ? `0 0 12px ${primary.color}25` : 'none',
                  animation: hasPending && isIdle ? 'glow-pulse 2.5s ease-in-out infinite' : 'none',
                }}
              >
                {syncErr ? <WarnIcon /> : primary.icon}
                <span>{syncErr ? 'Sync error' : primary.label}</span>
                {primary.count > 0 && !syncErr && (
                  <span style={{
                    background: `${primary.color}28`, color: primary.color,
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fontWeight: 700,
                    borderRadius: 9, paddingLeft: 5, paddingRight: 5, lineHeight: '17px',
                    border: `1px solid ${primary.color}40`,
                  }}>{primary.count}</span>
                )}
              </button>

              {/* Chevron dropdown */}
              <button
                onClick={() => isIdle && setMenuOpen(o => !o)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 22, height: 28, borderRadius: '0 5px 5px 0',
                  border: `1px solid ${borderColor}`,
                  borderLeft: `1px solid ${primary.count > 0 ? `${primary.color}40` : '#1d2535'}`,
                  background: menuOpen ? 'rgba(255,255,255,0.06)' : bgColor, color: labelColor,
                  cursor: isIdle ? 'pointer' : 'not-allowed',
                }}
              >
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                  <path d={menuOpen ? 'M2.5 6.5L5 3.5L7.5 6.5' : 'M2.5 3.5L5 6.5L7.5 3.5'}
                    stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {/* Dropdown menu */}
              {menuOpen && (
                <>
                  <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
                  <div style={{
                    position: 'absolute', top: 34, right: 0, zIndex: 100,
                    background: '#161c2b', border: '1px solid #1d2535',
                    borderRadius: 7, boxShadow: '0 8px 28px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.35)',
                    minWidth: 152, overflow: 'hidden',
                    animation: 'slide-down 0.14s ease both',
                  }}>
                    {[
                      { label: 'Fetch', action: doFetch, color: '#7b8499', count: 0, icon: <FetchIcon /> },
                      { label: 'Pull',  action: doPull,  color: '#f5a832', count: sync?.behind ?? 0, icon: <ArrowDown /> },
                      { label: 'Push',  action: doPush,  color: '#2dbd6e', count: sync?.ahead  ?? 0, icon: <ArrowUp /> },
                    ].map((item, i, arr) => (
                      <button key={item.label}
                        onClick={() => { item.action(); setMenuOpen(false) }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          width: '100%', height: 34, paddingLeft: 12, paddingRight: 12,
                          background: 'transparent', border: 'none',
                          borderBottom: i < arr.length - 1 ? '1px solid #1a2030' : 'none',
                          color: item.count > 0 ? item.color : '#7b8499',
                          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, cursor: 'pointer',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        {item.icon}
                        <span style={{ flex: 1, textAlign: 'left' }}>{item.label}</span>
                        {item.count > 0 && (
                          <span style={{
                            background: `${item.color}22`, color: item.color,
                            border: `1px solid ${item.color}40`,
                            fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
                            borderRadius: 9, paddingLeft: 5, paddingRight: 5,
                          }}>{item.count}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {repoPath && <div style={{ width: 1, height: 18, background: '#1d2535', flexShrink: 0, marginLeft: 2, marginRight: 2 }} />}

          {/* Notification bell */}
          <NotificationBell />

          {/* Account */}
          {currentAccount ? (
            <button
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                height: 32, paddingLeft: 6, paddingRight: 10,
                borderRadius: 6, border: '1px solid transparent',
                background: 'transparent', cursor: 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = '#1d2535' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' }}
            >
              <span style={{
                width: 24, height: 24, borderRadius: '50%',
                background: 'linear-gradient(135deg, #4a9eff, #a27ef0)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700, color: '#fff',
                flexShrink: 0,
                boxShadow: '0 0 0 1.5px rgba(74,158,255,0.3)',
              }}>{initials}</span>
              <span style={{
                fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, color: '#7b8499',
                fontWeight: 500, letterSpacing: '-0.01em',
              }}>
                {currentAccount.login}
              </span>
            </button>
          ) : (
            <button onClick={onAddAccount} style={{
              height: 28, paddingLeft: 12, paddingRight: 12,
              borderRadius: 5, border: '1px solid #1d2535',
              background: 'rgba(255,255,255,0.04)', color: '#7b8499',
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
            }}>
              Sign in
            </button>
          )}
        </div>
      </header>
    </>
  )
}

// ── Logo mark ─────────────────────────────────────────────────────────────────

function LucidLogoMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="3" r="2.2" fill="#e8622f" />
      <circle cx="3" cy="12.5" r="1.6" fill="#e8622f" fillOpacity="0.55" />
      <circle cx="13" cy="12.5" r="1.6" fill="#e8622f" fillOpacity="0.55" />
      <line x1="8" y1="5.2" x2="3.6" y2="11" stroke="#e8622f" strokeWidth="1.1" strokeOpacity="0.4" strokeLinecap="round" />
      <line x1="8" y1="5.2" x2="12.4" y2="11" stroke="#e8622f" strokeWidth="1.1" strokeOpacity="0.4" strokeLinecap="round" />
    </svg>
  )
}

// ── Repo switcher button ───────────────────────────────────────────────────────

function RepoSwitcherBtn({
  repoName, repoPath, open, onToggle,
}: {
  repoName: string; repoPath: string; open: boolean; onToggle: () => void
}) {
  const [hover, setHover] = React.useState(false)
  const active = open || hover
  return (
    <button
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${repoPath}\nClick to switch repository`}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        height: 26, paddingLeft: 8, paddingRight: active ? 7 : 8,
        borderRadius: 6,
        background: active ? 'rgba(255,255,255,0.06)' : 'transparent',
        border: `1px solid ${active ? '#283047' : 'transparent'}`,
        cursor: 'pointer',
        transition: 'background 0.12s, border-color 0.12s',
      }}
    >
      <span style={{
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13.5, fontWeight: 600,
        color: active ? '#e2e6f4' : '#c8cdd8', letterSpacing: '-0.01em',
        transition: 'color 0.12s',
      }}>
        {repoName}
      </span>
      {/* Chevron — always visible but dim when not hovered */}
      <svg
        width="10" height="10" viewBox="0 0 10 10" fill="none"
        style={{
          color: active ? '#7b8499' : '#344057',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s ease, color 0.12s',
          flexShrink: 0,
        }}
      >
        <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function RepoMenuItem({
  icon, label, shortcut, onClick,
}: {
  icon: React.ReactNode; label: string; shortcut?: string; onClick: () => void
}) {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9,
        width: '100%', height: 34,
        paddingLeft: 12, paddingRight: 12,
        background: hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: 'none',
        color: hover ? '#e2e6f4' : '#7b8499',
        cursor: 'pointer',
        transition: 'background 0.1s, color 0.1s',
      }}
    >
      <span style={{ flexShrink: 0, display: 'flex', color: hover ? '#e8622f' : '#4a566a', transition: 'color 0.1s' }}>
        {icon}
      </span>
      <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, flex: 1, textAlign: 'left', letterSpacing: '-0.01em' }}>
        {label}
      </span>
      {shortcut && (
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#283047',
          background: 'rgba(255,255,255,0.04)', border: '1px solid #1d2535',
          borderRadius: 4, padding: '1px 5px',
        }}>
          {shortcut}
        </span>
      )}
    </button>
  )
}

// ── Small inline components ─────────────────────────────────────────────────────

function TopBtn({ onClick, label, accent }: { onClick: () => void; label: string; accent?: boolean }) {
  return (
    <button onClick={onClick} style={{
      height: 28, paddingLeft: 13, paddingRight: 13, borderRadius: 5,
      background: accent ? '#e8622f' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${accent ? '#e8622f' : '#1d2535'}`,
      color: accent ? '#fff' : '#7b8499',
      fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5,
      fontWeight: accent ? 600 : 400, cursor: 'pointer',
      boxShadow: accent ? '0 0 12px rgba(232,98,47,0.3)' : 'none',
    }}
    onMouseEnter={e => { if (accent) { e.currentTarget.style.background = '#f0714d'; e.currentTarget.style.boxShadow = '0 0 18px rgba(232,98,47,0.45)' } else { e.currentTarget.style.background = 'rgba(255,255,255,0.07)' } }}
    onMouseLeave={e => { if (accent) { e.currentTarget.style.background = '#e8622f'; e.currentTarget.style.boxShadow = '0 0 12px rgba(232,98,47,0.3)' } else { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' } }}
    >{label}</button>
  )
}

function BranchIconSm() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="4"  r="1.75" stroke="#4a9eff" strokeWidth="1.5" />
      <circle cx="5" cy="12" r="1.75" stroke="#4a9eff" strokeWidth="1.5" />
      <circle cx="11" cy="4" r="1.75" stroke="#4a9eff" strokeWidth="1.5" />
      <path d="M5 5.75V10.25" stroke="#4a9eff" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 5.75C5 7.5 11 7.5 11 5.75" stroke="#4a9eff" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function FetchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 13 13" fill="none">
      <path d="M6.5 1v7M4 5.5l2.5 2.5L9 5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 10.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function ArrowUp() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M6 9.5V2.5M3 5L6 2L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ArrowDown() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
      <path d="M6 2.5V9.5M3 7L6 10L9 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 13 13" fill="none">
      <path d="M6.5 2L12 11H1L6.5 2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.5 6v2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="6.5" cy="9.5" r="0.6" fill="currentColor" />
    </svg>
  )
}

function FolderOpenIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 4.5h4.2l1.1 1.5h7.7v7.5h-13V4.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M1.5 7h13" stroke="currentColor" strokeWidth="0.8" strokeOpacity="0.4" />
    </svg>
  )
}

function CloneIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="5.5" y="1.5" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.5 1.5" />
      <path d="M5.5 6.5h4M5.5 9h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
