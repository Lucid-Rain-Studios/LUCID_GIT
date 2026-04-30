import React, { useState, useEffect, useCallback, useRef } from 'react'
import lucidGitIcon from '@/lib/icons/lucid_git.svg'
import { ipc, SyncStatus, UpdateInfo, PresenceEntry, GitIdentity } from '@/ipc'
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

const CONFIRM_BRANCH_KEY = 'lucid-git:confirm-branch-switch'
const sessionTopBarFetched = new Set<string>()

export function TopBar({ onOpen, onClone, onAddAccount, onSynced }: TopBarProps) {
  const { repoPath, currentBranch, refreshStatus, recentRepos, openRepo, removeRecentRepo, clearRepo, branches, checkout, fileStatus } = useRepoStore()
  const { accounts, currentAccountId, permissionErrors, fetchRepoPermission, viewAsRole, setViewAsRole } = useAuthStore()
  const opRun   = useOperationStore(s => s.run)
  const pushErr = useErrorStore(s => s.pushRaw)

  const [sync, setSync]       = useState<SyncStatus | null>(null)
  const [syncOp, setSyncOp]   = useState<'idle' | 'fetching' | 'pulling' | 'pushing'>('idle')
  const [syncErr, setSyncErr] = useState<string | null>(null)
  const [updatingFromMain, setUpdatingFromMain] = useState(false)
  const [defaultBranch, setDefaultBranch] = useState<string>('main')
  const [hasFetched, setHasFetched] = useState(() => repoPath ? sessionTopBarFetched.has(repoPath) : false)
  const [isMaximized, setIsMaximized] = useState(false)
  const [repoMenuOpen, setRepoMenuOpen] = useState(false)
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [branchConfirm, setBranchConfirm] = useState<string | null>(null)

  const localBranches  = branches.filter(b => !b.isRemote)
  const remoteBranches = branches.filter(b => b.isRemote)

  const hasChanges = fileStatus.length > 0

  const handleBranchSelect = (branchName: string) => {
    setBranchMenuOpen(false)
    if (branchName === currentBranch) return
    // Always show dialog when there are uncommitted changes (stash choice)
    // Otherwise respect "don't ask again" preference
    if (!hasChanges && localStorage.getItem(CONFIRM_BRANCH_KEY) === 'false') {
      checkout(branchName)
    } else {
      setBranchConfirm(branchName)
    }
  }

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
    setHasFetched(repoPath ? sessionTopBarFetched.has(repoPath) : false)
    if (repoPath) loadSync()
  }, [repoPath, currentBranch])

  useEffect(() => {
    ipc.windowIsMaximized().then(setIsMaximized).catch(() => {})
  }, [])

  useEffect(() => {
    if (!repoPath) return
    ipc.gitDefaultBranch(repoPath).then(b => setDefaultBranch(b)).catch(() => {})
  }, [repoPath])

  useEffect(() => {
    const unsubAvail = ipc.onUpdateAvailable((info: UpdateInfo) => { setUpdateInfo(info); setUpdateDismissed(false) })
    const unsubReady = ipc.onUpdateReady(() => { setUpdateReady(true); setDownloading(false) })
    return () => { unsubAvail(); unsubReady() }
  }, [])

  const doPush = async () => {
    if (!repoPath || syncOp !== 'idle') return
    setSyncOp('pushing'); setSyncErr(null)
    try { await opRun('Pushing…', () => ipc.push(repoPath)); await loadSync() }
    catch (e) { const s = String(e); setSyncErr(s); pushErr(s) }
    finally { setSyncOp('idle') }
  }

  const doUpdateFromMain = async () => {
    if (!repoPath || updatingFromMain || syncOp !== 'idle') return
    setUpdatingFromMain(true)
    try {
      await opRun(`Updating from ${defaultBranch}…`, async () => {
        await ipc.fetch(repoPath)
        await ipc.updateFromMain(repoPath)
      })
      await loadSync()
      await refreshStatus()
    } catch (e) {
      const s = String(e); pushErr(s)
    } finally {
      setUpdatingFromMain(false)
    }
  }

  const isIdle    = syncOp === 'idle'
  const hasBehind = (sync?.behind ?? 0) > 0
  const hasAhead  = (sync?.ahead  ?? 0) > 0

  const doFetch = async () => {
    if (!repoPath || syncOp !== 'idle') return
    setSyncOp('fetching'); setSyncErr(null)
    try {
      await opRun('Fetching…', () => ipc.fetch(repoPath))
      await loadSync()
      sessionTopBarFetched.add(repoPath)
      setHasFetched(true)
      onSynced?.()
    } catch (e) { const s = String(e); setSyncErr(s); pushErr(s) }
    finally { setSyncOp('idle') }
  }

  const doTopBarPull = async () => {
    if (!repoPath || syncOp !== 'idle') return
    setSyncOp('pulling'); setSyncErr(null)
    try {
      await opRun('Pulling…', () => ipc.pull(repoPath))
      await loadSync()
      await refreshStatus()
      onSynced?.()
    } catch (e) { const s = String(e); setSyncErr(s); pushErr(s) }
    finally { setSyncOp('idle') }
  }

  const repoName = repoPath
    ? (repoPath.replace(/\\/g, '/').split('/').pop() ?? repoPath)
    : null

  const currentAccount = accounts.find(a => a.userId === currentAccountId)

  const [branchPresence, setBranchPresence] = useState<Record<string, PresenceEntry[]>>({})

  useEffect(() => {
    if (!branchMenuOpen || !repoPath) return
    ipc.presenceRead(repoPath).then(file => {
      const cutoff = Date.now() - 30 * 60 * 1000
      const byBranch: Record<string, PresenceEntry[]> = {}
      Object.values(file.entries)
        .filter(e => new Date(e.lastSeen).getTime() > cutoff)
        .forEach(e => {
          if (!byBranch[e.branch]) byBranch[e.branch] = []
          byBranch[e.branch].push(e)
        })
      setBranchPresence(byBranch)
    }).catch(() => {})
  }, [branchMenuOpen, repoPath])

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

      {/* Role preview banner — visible whenever an admin is viewing as another role */}
      {viewAsRole && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 16px', height: 28, fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace", flexShrink: 0,
          background: 'rgba(167,139,250,0.08)',
          borderBottom: '1px solid rgba(167,139,250,0.2)',
          color: '#a78bfa',
        }}>
          <span>
            Previewing as {viewAsRole === 'write' ? 'Collaborator' : 'Read-only'} — admin features are restricted.
          </span>
          <button
            onClick={() => setViewAsRole(null)}
            style={{
              padding: '0 8px', height: 20, borderRadius: 4,
              border: '1px solid currentColor', background: 'transparent',
              color: 'inherit', fontFamily: 'inherit', fontSize: 10,
              fontWeight: 600, cursor: 'pointer',
            }}
          >
            Switch back to Admin
          </button>
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

      {/* Branch switch confirmation */}
      {branchConfirm && (
        <BranchConfirmDialog
          from={currentBranch}
          to={branchConfirm}
          hasChanges={hasChanges}
          onConfirm={async ({ dontAskAgain, stash }) => {
            if (dontAskAgain) localStorage.setItem(CONFIRM_BRANCH_KEY, 'false')
            if (stash && repoPath) await ipc.stashSave(repoPath, `Auto-stash before switching to ${branchConfirm}`)
            checkout(branchConfirm)
            setBranchConfirm(null)
          }}
          onCancel={() => setBranchConfirm(null)}
        />
      )}

      {/* Main bar */}
      <header className="drag-region" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 46, paddingLeft: 14, paddingRight: 0,
        background: 'var(--lg-bg-secondary)',
        borderBottom: '1px solid var(--lg-border)',
        boxShadow: '0 1px 0 rgba(0,0,0,0.3), 0 4px 20px rgba(0,0,0,0.2)',
        flexShrink: 0, gap: 12, zIndex: 20, position: 'relative',
      }}>
        {/* Left: wordmark + repo + branch */}
        <div className="no-drag-region" style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {/* Logo mark + wordmark — clickable when repo is open to return to welcome */}
          <LogoWordmark hasRepo={!!repoPath} onClick={() => repoPath && clearRepo()} />

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
                      background: 'var(--lg-bg-elevated)',
                      border: '1px solid var(--lg-border)',
                      borderRadius: 8,
                      boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
                      minWidth: 210, overflow: 'hidden',
                      animation: 'slide-down 0.14s ease both',
                    }}>
                      {/* Current repo path label */}
                      <div style={{
                        padding: '9px 12px 7px',
                        borderBottom: '1px solid var(--lg-border)',
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

                      {/* Recent repos (excluding current) */}
                      {recentRepos.filter(p => p !== repoPath).length > 0 && (
                        <>
                          <div style={{ height: 1, background: 'var(--lg-border)' }} />
                          <div style={{ padding: '7px 12px 3px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#344057', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                            Recent
                          </div>
                          <div style={{ padding: '2px 0 4px' }}>
                            {recentRepos.filter(p => p !== repoPath).map(p => {
                              const name = p.replace(/\\/g, '/').split('/').pop() ?? p
                              return (
                                <RepoMenuItemWithRemove
                                  key={p}
                                  name={name}
                                  path={p}
                                  onClick={() => { setRepoMenuOpen(false); openRepo(p) }}
                                  onRemove={() => removeRecentRepo(p)}
                                />
                              )
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>

              {currentBranch && (
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <button
                    onClick={() => setBranchMenuOpen(o => !o)}
                    title="Switch branch"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      background: branchMenuOpen ? 'rgba(74,158,255,0.18)' : 'rgba(74,158,255,0.1)',
                      border: '1px solid rgba(74,158,255,0.2)',
                      borderRadius: 20, paddingLeft: 8, paddingRight: 7, height: 22,
                      cursor: 'pointer', transition: 'background 0.12s',
                    }}
                    onMouseEnter={e => { if (!branchMenuOpen) e.currentTarget.style.background = 'rgba(74,158,255,0.16)' }}
                    onMouseLeave={e => { if (!branchMenuOpen) e.currentTarget.style.background = 'rgba(74,158,255,0.1)' }}
                  >
                    <BranchIconSm />
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5,
                      color: '#4a9eff', fontWeight: 500, letterSpacing: '0.01em',
                    }}>
                      {currentBranch}
                    </span>
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" style={{ color: '#4a9eff', opacity: 0.7, transform: branchMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
                      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>

                  {branchMenuOpen && (
                    <>
                      <div onClick={() => setBranchMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
                      <div style={{
                        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100,
                        background: 'var(--lg-bg-elevated)', border: '1px solid var(--lg-border)',
                        borderRadius: 8, boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)',
                        minWidth: 240, maxHeight: 380, overflowY: 'auto',
                        animation: 'slide-down 0.14s ease both',
                      }}>
                        {/* Local */}
                        <BranchGroupHeader label="Local" />
                        {localBranches.length === 0 ? (
                          <div style={{ padding: '6px 12px 8px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#4a566a' }}>No local branches</div>
                        ) : (
                          <div style={{ padding: '2px 0 4px' }}>
                            {localBranches.map(b => (
                              <BranchMenuItem
                                key={b.name}
                                name={b.displayName}
                                current={b.current}
                                presence={branchPresence[b.displayName] ?? []}
                                onClick={() => handleBranchSelect(b.displayName)}
                              />
                            ))}
                          </div>
                        )}

                        {/* Remote (origin) */}
                        {remoteBranches.length > 0 && (
                          <>
                            <div style={{ height: 1, background: 'var(--lg-border)' }} />
                            <BranchGroupHeader label="Origin" />
                            <div style={{ padding: '2px 0 6px' }}>
                              {remoteBranches.map(b => (
                                <BranchMenuItem
                                  key={b.name}
                                  name={b.displayName}
                                  current={false}
                                  remote
                                  hasLocal={b.hasLocal}
                                  presence={branchPresence[b.displayName] ?? []}
                                  onClick={() => handleBranchSelect(b.displayName)}
                                />
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          ) : (
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#344057' }}>
              No repository open
            </span>
          )}
        </div>

        {/* Right: sync + notifs + account + window controls */}
        <div className="no-drag-region" style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>

          {/* Welcome buttons when no repo */}
          {!repoPath && (
            <>
              <TopBtn onClick={onOpen} label="Open" />
              <TopBtn onClick={onClone} label="Clone" accent />
            </>
          )}

          {/* Split Fetch | Pull button */}
          {repoPath && (
            <FetchPullSplitBtn
              fetchLabel={syncOp === 'fetching' ? 'Fetching…' : 'Fetch'}
              pullLabel={syncOp === 'pulling' ? 'Pulling…' : 'Pull'}
              behindCount={hasBehind && isIdle ? (sync?.behind ?? 0) : 0}
              hasFetched={hasFetched}
              error={!!syncErr}
              disabled={!isIdle}
              onFetch={doFetch}
              onPull={doTopBarPull}
            />
          )}

          {/* Push button */}
          {repoPath && (
            <SyncBtn
              label={syncOp === 'pushing' ? 'Pushing…' : 'Push'}
              icon={<ArrowUp />}
              count={hasAhead && isIdle ? (sync?.ahead ?? 0) : 0}
              countColor="#2dbd6e"
              active={hasAhead}
              error={false}
              disabled={!isIdle}
              onClick={doPush}
            />
          )}

          {/* Update from main button */}
          {repoPath && (
            <UpdateFromMainBtn
              defaultBranch={defaultBranch}
              currentBranch={currentBranch ?? ''}
              busy={updatingFromMain}
              disabled={syncOp !== 'idle'}
              onClick={doUpdateFromMain}
            />
          )}

          {repoPath && <div style={{ width: 1, height: 18, background: 'var(--lg-border)', flexShrink: 0, marginLeft: 2, marginRight: 2 }} />}

          {/* Notification bell */}
          <NotificationBell />

          {/* Account */}
          {currentAccount ? (
            <AccountMenu
              account={currentAccount}
              onSignOut={() => useAuthStore.getState().logout(currentAccount.userId)}
            />
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

          {/* Window controls */}
          <WindowControls isMaximized={isMaximized} onMaximizeToggle={() => setIsMaximized(m => !m)} />
        </div>
      </header>
    </>
  )
}

// ── Avatar helpers ─────────────────────────────────────────────────────────────

function avatarColor(login: string): string {
  const palette = ['#4d9dff', '#a27ef0', '#2ec573', '#f5a832', '#e8622f', '#1abc9c', '#e91e63']
  let h = 0
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function AccountAvatar({ login, avatarUrl, size = 24 }: { login: string; avatarUrl: string; size?: number }) {
  const [failed, setFailed] = React.useState(false)
  if (failed) {
    return (
      <span style={{
        width: size, height: size, borderRadius: '50%',
        background: 'linear-gradient(135deg, #4a9eff, #a27ef0)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: "'JetBrains Mono', monospace", fontSize: Math.round(size * 0.37), fontWeight: 700, color: '#fff',
        flexShrink: 0, boxShadow: '0 0 0 1.5px rgba(74,158,255,0.3)',
      }}>
        {login.slice(0, 2).toUpperCase()}
      </span>
    )
  }
  return (
    <img
      src={avatarUrl}
      alt={login}
      onError={() => setFailed(true)}
      style={{
        width: size, height: size, borderRadius: '50%', objectFit: 'cover',
        flexShrink: 0, boxShadow: '0 0 0 1.5px rgba(74,158,255,0.3)',
      }}
    />
  )
}

function GhAvatar({ login, size = 20 }: { login: string; size?: number }) {
  const [failed, setFailed] = React.useState(false)
  const col = avatarColor(login)
  if (failed) {
    return (
      <div
        title={login}
        style={{
          width: size, height: size, borderRadius: '50%', flexShrink: 0,
          background: `linear-gradient(135deg, ${col}88, ${col}44)`,
          border: `1.5px solid var(--lg-bg-elevated)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: "'JetBrains Mono', monospace", fontSize: Math.round(size * 0.38), fontWeight: 700, color: col,
        }}
      >
        {login.slice(0, 2).toUpperCase()}
      </div>
    )
  }
  return (
    <img
      src={`https://github.com/${login}.png?size=${size * 2}`}
      alt={login}
      title={login}
      onError={() => setFailed(true)}
      style={{
        width: size, height: size, borderRadius: '50%', objectFit: 'cover',
        flexShrink: 0, border: '1.5px solid var(--lg-bg-elevated)',
      }}
    />
  )
}

// ── Logo + wordmark (clickable when repo open) ────────────────────────────────

function LogoWordmark({ hasRepo, onClick }: { hasRepo: boolean; onClick: () => void }) {
  const [hover, setHover] = React.useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => hasRepo && setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={hasRepo ? 'Close repository' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
        cursor: hasRepo ? 'pointer' : 'default',
        borderRadius: 6, padding: '2px 5px', margin: '-2px -5px',
        background: hover ? 'rgba(255,255,255,0.04)' : 'transparent',
        transition: 'background 0.12s',
      }}
    >
      <img
        src={lucidGitIcon}
        alt="Lucid Git"
        width={22}
        height={22}
        style={{ display: 'block', flexShrink: 0, opacity: hover ? 1 : 0.85, transition: 'opacity 0.12s' }}
      />
    </div>
  )
}

// ── Branch group header ────────────────────────────────────────────────────────

function BranchGroupHeader({ label }: { label: string }) {
  return (
    <div style={{ padding: '7px 12px 3px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#344057', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
      {label}
    </div>
  )
}

// ── Branch menu item ───────────────────────────────────────────────────────────

function BranchMenuItem({ name, current, remote, hasLocal, presence = [], onClick }: {
  name: string
  current: boolean
  remote?: boolean
  hasLocal?: boolean
  presence?: PresenceEntry[]
  onClick: () => void
}) {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={current}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', height: 32, paddingLeft: 12, paddingRight: 10,
        background: current ? 'rgba(74,158,255,0.08)' : hover ? 'rgba(255,255,255,0.05)' : 'transparent',
        border: 'none',
        color: current ? '#4a9eff' : hover ? '#e2e6f4' : '#7b8499',
        cursor: current ? 'default' : 'pointer',
        transition: 'background 0.1s, color 0.1s',
      }}
    >
      <span style={{ flexShrink: 0, display: 'flex', color: current ? '#4a9eff' : remote ? '#4a566a' : hover ? '#7b8499' : '#344057' }}>
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <circle cx="5" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="5" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="11" cy="5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5 5.6V10.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M5 5.6C5 7.2 11 7.2 11 5.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name}
      </span>

      {/* Teammate avatars on this branch */}
      {presence.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', marginRight: 2 }}>
          {presence.slice(0, 4).map((p, i) => (
            <div key={p.login} style={{ marginLeft: i === 0 ? 0 : -5, zIndex: presence.length - i }}>
              <GhAvatar login={p.login} size={16} />
            </div>
          ))}
          {presence.length > 4 && (
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#4a566a', marginLeft: 3 }}>
              +{presence.length - 4}
            </span>
          )}
        </div>
      )}

      {/* Remote-only indicator */}
      {remote && !hasLocal && (
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#344057', flexShrink: 0 }}>
          remote
        </span>
      )}

      {current && (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
          <path d="M2 6l3 3 5-5" stroke="#4a9eff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  )
}

// ── Branch confirmation dialog ─────────────────────────────────────────────────

function BranchConfirmDialog({ from, to, hasChanges, onConfirm, onCancel }: {
  from: string; to: string; hasChanges: boolean
  onConfirm: (opts: { dontAskAgain: boolean; stash: boolean }) => void
  onCancel: () => void
}) {
  const [dontAsk, setDontAsk] = React.useState(false)
  const [stash, setStash]     = React.useState(false)
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 500,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
    }}>
      <div style={{
        background: 'var(--lg-bg-elevated)',
        border: '1px solid var(--lg-border)',
        borderRadius: 10,
        boxShadow: '0 20px 60px rgba(0,0,0,0.7), 0 4px 16px rgba(0,0,0,0.4)',
        width: 380, padding: '20px 20px 16px',
        animation: 'slide-down 0.16s ease both',
      }}>
        <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--lg-text-primary)', marginBottom: 10 }}>
          Switch Branch
        </div>
        <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12.5, color: 'var(--lg-text-secondary)', lineHeight: 1.5, marginBottom: 16 }}>
          Switch from{' '}
          <code style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11.5, background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 5px', color: '#f5a832' }}>{from}</code>
          {' '}to{' '}
          <code style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11.5, background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 5px', color: '#4a9eff' }}>{to}</code>
          ?
        </div>

        {/* Stash choice — only when uncommitted changes exist */}
        {hasChanges && (
          <div style={{ marginBottom: 16, borderRadius: 7, border: '1px solid var(--lg-border)', overflow: 'hidden' }}>
            {[
              { value: false, label: 'Bring changes over', desc: 'Carry uncommitted changes to the new branch' },
              { value: true,  label: 'Stash changes',      desc: 'Save changes to the stash, switch cleanly' },
            ].map(opt => (
              <label
                key={String(opt.value)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                  cursor: 'pointer', borderBottom: opt.value ? 'none' : '1px solid var(--lg-border)',
                  background: stash === opt.value ? 'rgba(74,158,255,0.06)' : 'transparent',
                  transition: 'background 0.1s',
                }}
              >
                <input
                  type="radio"
                  checked={stash === opt.value}
                  onChange={() => setStash(opt.value)}
                  style={{ accentColor: 'var(--lg-accent)', marginTop: 2, cursor: 'pointer' }}
                />
                <div>
                  <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12.5, color: 'var(--lg-text-primary)', fontWeight: 500 }}>{opt.label}</div>
                  <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: 'var(--lg-text-secondary)', marginTop: 2 }}>{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={e => setDontAsk(e.target.checked)}
            style={{ accentColor: 'var(--lg-accent)', width: 13, height: 13, cursor: 'pointer' }}
          />
          <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11.5, color: 'var(--lg-text-secondary)' }}>
            Don't ask again
          </span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              height: 30, paddingLeft: 14, paddingRight: 14, borderRadius: 5,
              background: 'transparent', border: '1px solid var(--lg-border)',
              color: 'var(--lg-text-secondary)', fontFamily: 'var(--lg-font-ui)', fontSize: 12.5,
              cursor: 'pointer',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm({ dontAskAgain: dontAsk, stash })}
            style={{
              height: 30, paddingLeft: 14, paddingRight: 14, borderRadius: 5,
              background: 'rgba(74,158,255,0.15)', border: '1px solid rgba(74,158,255,0.4)',
              color: '#4a9eff', fontFamily: 'var(--lg-font-ui)', fontSize: 12.5, fontWeight: 600,
              cursor: 'pointer',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(74,158,255,0.25)'}
            onMouseLeave={e => e.currentTarget.style.background = 'rgba(74,158,255,0.15)'}
          >
            Switch Branch
          </button>
        </div>
      </div>
    </div>
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

function RepoMenuItemWithRemove({
  name, path, onClick, onRemove,
}: {
  name: string; path: string; onClick: () => void; onRemove: () => void
}) {
  const [hover, setHover] = React.useState(false)
  const [removeHover, setRemoveHover] = React.useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', background: hover ? 'rgba(255,255,255,0.05)' : 'transparent', transition: 'background 0.1s' }}
    >
      <button
        onClick={onClick}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 9,
          height: 34, paddingLeft: 12, paddingRight: 6,
          background: 'transparent', border: 'none', cursor: 'pointer',
        }}
      >
        <span style={{ flexShrink: 0, display: 'flex', color: hover ? '#e8622f' : '#4a566a', transition: 'color 0.1s' }}>
          <FolderOpenIcon />
        </span>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, flex: 1, textAlign: 'left', letterSpacing: '-0.01em', color: hover ? '#e2e6f4' : '#7b8499', transition: 'color 0.1s', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </span>
      </button>
      <button
        onClick={e => { e.stopPropagation(); onRemove() }}
        onMouseEnter={() => setRemoveHover(true)}
        onMouseLeave={() => setRemoveHover(false)}
        title="Remove from recent"
        style={{
          width: 28, height: 34, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: removeHover ? '#e84040' : '#344057',
          transition: 'color 0.1s',
          opacity: hover || removeHover ? 1 : 0,
        }}
      >
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
          <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

// ── Update-from-main button ────────────────────────────────────────────────────

function UpdateFromMainBtn({
  defaultBranch, currentBranch, busy, disabled, onClick,
}: {
  defaultBranch: string; currentBranch: string; busy: boolean; disabled: boolean; onClick: () => void
}) {
  const [hover, setHover] = React.useState(false)
  const onDefault = currentBranch === defaultBranch
  const isDisabled = onDefault || busy || disabled

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={onClick}
        disabled={isDisabled}
        onMouseEnter={() => !isDisabled && setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={onDefault ? `Already on ${defaultBranch}` : `Fetch and merge ${defaultBranch} into this branch`}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          height: 28, paddingLeft: 10, paddingRight: 10,
          borderRadius: 5,
          border: `1px solid ${onDefault ? '#1a2030' : hover ? 'rgba(74,158,255,0.35)' : '#1d2535'}`,
          background: onDefault
            ? 'transparent'
            : hover
              ? 'rgba(74,158,255,0.1)'
              : 'rgba(255,255,255,0.03)',
          color: onDefault ? '#344057' : busy ? '#7b8499' : hover ? '#4a9eff' : '#6b7590',
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 500,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.6 : 1,
          transition: 'border-color 0.12s, background 0.12s, color 0.12s',
          whiteSpace: 'nowrap',
        }}
      >
        <MergeDownIcon color={onDefault ? '#283047' : busy ? '#7b8499' : hover ? '#4a9eff' : '#4a566a'} />
        <span>
          {busy
            ? `Updating…`
            : onDefault
              ? `On ${defaultBranch}`
              : `Update from ${defaultBranch}`}
        </span>
      </button>
    </div>
  )
}

function MergeDownIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
      <circle cx="4" cy="3"  r="1.5" stroke={color} strokeWidth="1.3" />
      <circle cx="4" cy="11" r="1.5" stroke={color} strokeWidth="1.3" />
      <circle cx="10" cy="3" r="1.5" stroke={color} strokeWidth="1.3" />
      <path d="M4 4.5v5" stroke={color} strokeWidth="1.3" strokeLinecap="round" />
      <path d="M10 4.5v2a3 3 0 0 1-3 3H4" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 8.5L2.5 10l1.5 1.5" stroke={color} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Small inline components ─────────────────────────────────────────────────────

// ── Sync button (Fetch & Pull / Push) ─────────────────────────────────────────

function SyncBtn({
  label, icon, count, countColor, active, error, disabled, onClick,
}: {
  label: string; icon: React.ReactNode; count: number; countColor: string
  active: boolean; error: boolean; disabled: boolean; onClick: () => void
}) {
  const [hover, setHover] = React.useState(false)
  const borderColor = error ? '#e84040' : active ? countColor : 'var(--lg-border)'
  const bgColor     = error ? 'rgba(232,64,64,0.1)' : active ? `${countColor}18` : 'transparent'
  const textColor   = error ? '#e84040' : active ? countColor : '#7b8499'
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => !disabled && setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        height: 28, paddingLeft: 10, paddingRight: 10,
        borderRadius: 5, border: `1px solid ${hover && !disabled ? borderColor + 'cc' : borderColor}`,
        background: hover && !disabled ? `${bgColor}` : bgColor,
        color: textColor,
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !active ? 0.5 : 1,
        boxShadow: active && !disabled ? `0 0 12px ${countColor}25` : 'none',
        animation: active && !disabled ? 'glow-pulse 2.5s ease-in-out infinite' : 'none',
        transition: 'border-color 0.12s, background 0.12s',
      }}
    >
      {icon}
      <span>{label}</span>
      {count > 0 && (
        <span style={{
          background: `${countColor}28`, color: countColor,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fontWeight: 700,
          borderRadius: 9, paddingLeft: 5, paddingRight: 5, lineHeight: '17px',
          border: `1px solid ${countColor}40`,
        }}>{count}</span>
      )}
    </button>
  )
}

// ── Account menu (avatar + dropdown: git config + sign out) ───────────────────

function AccountMenu({ account, onSignOut }: { account: { userId: string; login: string; avatarUrl: string }; onSignOut: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [gitName, setGitName]   = React.useState('')
  const [gitEmail, setGitEmail] = React.useState('')
  const [saving, setSaving]     = React.useState(false)
  const [saved, setSaved]       = React.useState(false)
  const menuRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    ipc.getGlobalGitIdentity().then(id => {
      setGitName(id.name)
      setGitEmail(id.email)
      setSaved(false)
    }).catch(() => {})
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleSave = async () => {
    if (!gitName.trim() || !gitEmail.trim()) return
    setSaving(true)
    try {
      await ipc.setGlobalGitIdentity(gitName.trim(), gitEmail.trim())
      setSaved(true)
    } catch { } finally { setSaving(false) }
  }

  return (
    <div ref={menuRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          height: 32, paddingLeft: 6, paddingRight: 10,
          borderRadius: 6, border: `1px solid ${open ? '#283047' : 'transparent'}`,
          background: open ? 'rgba(255,255,255,0.05)' : 'transparent', cursor: 'pointer',
        }}
        onMouseEnter={e => { if (!open) { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = '#1d2535' } }}
        onMouseLeave={e => { if (!open) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' } }}
      >
        <AccountAvatar login={account.login} avatarUrl={account.avatarUrl} size={24} />
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, color: '#7b8499', fontWeight: 500, letterSpacing: '-0.01em' }}>
          {account.login}
        </span>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" style={{ color: '#344057', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
          <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 200,
          background: 'var(--lg-bg-elevated)', border: '1px solid var(--lg-border)',
          borderRadius: 9, boxShadow: '0 12px 36px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)',
          width: 240, overflow: 'hidden',
          animation: 'slide-down 0.14s ease both',
        }}>
          {/* Git config section */}
          <div style={{ padding: '10px 12px 12px', borderBottom: '1px solid var(--lg-border)' }}>
            <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#344057', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
              Global Git Config
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                value={gitName}
                onChange={e => { setGitName(e.target.value); setSaved(false) }}
                placeholder="user.name"
                style={{
                  height: 28, paddingLeft: 9, paddingRight: 9, borderRadius: 5,
                  background: 'rgba(255,255,255,0.04)', border: '1px solid #1d2535',
                  color: '#c8d0e8', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12,
                  outline: 'none', width: '100%', boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = '#4a9eff55'}
                onBlur={e => e.target.style.borderColor = '#1d2535'}
              />
              <input
                value={gitEmail}
                onChange={e => { setGitEmail(e.target.value); setSaved(false) }}
                placeholder="user.email"
                style={{
                  height: 28, paddingLeft: 9, paddingRight: 9, borderRadius: 5,
                  background: 'rgba(255,255,255,0.04)', border: '1px solid #1d2535',
                  color: '#c8d0e8', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12,
                  outline: 'none', width: '100%', boxSizing: 'border-box',
                }}
                onFocus={e => e.target.style.borderColor = '#4a9eff55'}
                onBlur={e => e.target.style.borderColor = '#1d2535'}
              />
              <button
                onClick={handleSave}
                disabled={saving || !gitName.trim() || !gitEmail.trim()}
                style={{
                  height: 27, borderRadius: 5, cursor: 'pointer',
                  background: saved ? 'rgba(45,189,110,0.12)' : 'rgba(74,158,255,0.1)',
                  border: `1px solid ${saved ? 'rgba(45,189,110,0.35)' : 'rgba(74,158,255,0.3)'}`,
                  color: saved ? '#2dbd6e' : '#4a9eff',
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 600,
                  opacity: saving || !gitName.trim() || !gitEmail.trim() ? 0.5 : 1,
                }}
              >
                {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
              </button>
            </div>
          </div>

          {/* Sign out */}
          <button
            onClick={() => { setOpen(false); onSignOut() }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              width: '100%', height: 38, paddingLeft: 12, paddingRight: 12,
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: '#5a6880', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5,
              textAlign: 'left',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(232,69,69,0.08)'; e.currentTarget.style.color = '#e84545' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#5a6880' }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M11 5l3 3-3 3M14 8H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sign Out
          </button>
        </div>
      )}
    </div>
  )
}

function TopBtn({ onClick, label, accent }: { onClick: () => void; label: string; accent?: boolean }) {
  return (
    <button onClick={onClick} style={{
      height: 28, paddingLeft: 13, paddingRight: 13, borderRadius: 5,
      background: accent ? 'var(--lg-accent)' : 'rgba(255,255,255,0.04)',
      border: `1px solid ${accent ? 'var(--lg-accent)' : 'var(--lg-border)'}`,
      color: accent ? '#fff' : 'var(--lg-text-secondary)',
      fontFamily: 'var(--lg-font-ui)', fontSize: 12.5,
      fontWeight: accent ? 600 : 400, cursor: 'pointer',
      boxShadow: accent ? '0 0 12px rgba(var(--lg-accent-rgb), 0.3)' : 'none',
    }}
    onMouseEnter={e => { if (accent) { e.currentTarget.style.background = 'var(--lg-accent-hover)'; e.currentTarget.style.boxShadow = '0 0 18px rgba(var(--lg-accent-rgb), 0.45)' } else { e.currentTarget.style.background = 'rgba(255,255,255,0.07)' } }}
    onMouseLeave={e => { if (accent) { e.currentTarget.style.background = 'var(--lg-accent)'; e.currentTarget.style.boxShadow = '0 0 12px rgba(var(--lg-accent-rgb), 0.3)' } else { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' } }}
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

function FetchPullIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <path d="M7 1v8M4.5 6.5L7 9l2.5-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 11.5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M11 4.5c0-2.2-1.8-4-4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="1.5 1.5" />
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

// ── Split Fetch | Pull button ─────────────────────────────────────────────────

function FetchPullSplitBtn({
  fetchLabel, pullLabel, behindCount, hasFetched, error, disabled, onFetch, onPull,
}: {
  fetchLabel: string; pullLabel: string; behindCount: number
  hasFetched: boolean; error: boolean; disabled: boolean
  onFetch: () => void; onPull: () => void
}) {
  const [hoverFetch, setHoverFetch] = React.useState(false)
  const [hoverPull,  setHoverPull]  = React.useState(false)
  const pullDisabled = disabled || !hasFetched
  const hasBehind   = behindCount > 0
  const borderColor = error ? '#e84040' : hasBehind ? '#f5a832' : '#1d2535'

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      border: `1px solid ${borderColor}`,
      borderRadius: 5, overflow: 'hidden', height: 28,
      boxShadow: hasBehind ? '0 0 10px rgba(245,168,50,0.15)' : 'none',
      animation: hasBehind ? 'glow-pulse 2.5s ease-in-out infinite' : 'none',
    }}>
      <button
        onClick={disabled ? undefined : onFetch}
        disabled={disabled}
        onMouseEnter={() => !disabled && setHoverFetch(true)}
        onMouseLeave={() => setHoverFetch(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          paddingLeft: 10, paddingRight: 10,
          background: hoverFetch && !disabled ? 'rgba(74,158,255,0.08)' : 'transparent',
          border: 'none',
          color: disabled ? '#344057' : hoverFetch ? '#4a9eff' : '#6b7590',
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 500,
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'background 0.12s, color 0.12s', whiteSpace: 'nowrap',
        }}
      >
        <FetchIcon />
        {fetchLabel}
      </button>

      <div style={{ width: 1, background: borderColor, flexShrink: 0 }} />

      <button
        onClick={pullDisabled ? undefined : onPull}
        disabled={pullDisabled}
        onMouseEnter={() => !pullDisabled && setHoverPull(true)}
        onMouseLeave={() => setHoverPull(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          paddingLeft: 10, paddingRight: hasBehind ? 7 : 10,
          background: hoverPull && !pullDisabled ? (hasBehind ? 'rgba(245,168,50,0.08)' : 'rgba(74,158,255,0.08)') : 'transparent',
          border: 'none',
          color: pullDisabled ? '#283047' : hasBehind ? '#f5a832' : hoverPull ? '#4a9eff' : '#6b7590',
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 500,
          cursor: pullDisabled ? 'not-allowed' : 'pointer',
          opacity: pullDisabled && !hasBehind ? 0.5 : 1,
          transition: 'background 0.12s, color 0.12s', whiteSpace: 'nowrap',
        }}
      >
        <ArrowDown />
        {pullLabel}
        {hasBehind && (
          <span style={{
            background: 'rgba(245,168,50,0.2)', color: '#f5a832',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
            borderRadius: 8, paddingLeft: 5, paddingRight: 5, lineHeight: '15px',
            border: '1px solid rgba(245,168,50,0.4)',
          }}>{behindCount}</span>
        )}
      </button>
    </div>
  )
}

// ── Window controls (frameless) ───────────────────────────────────────────────

function WindowControls({ isMaximized, onMaximizeToggle }: { isMaximized: boolean; onMaximizeToggle: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', height: 46, marginLeft: 4 }}>
      <WinCtrlBtn onClick={() => ipc.windowMinimize()} title="Minimize">
        <MinimizeWinIcon />
      </WinCtrlBtn>
      <WinCtrlBtn
        onClick={() => { onMaximizeToggle(); ipc.windowMaximizeToggle() }}
        title={isMaximized ? 'Restore' : 'Maximize'}
      >
        {isMaximized ? <RestoreWinIcon /> : <MaximizeWinIcon />}
      </WinCtrlBtn>
      <WinCtrlBtn onClick={() => ipc.windowClose()} title="Close" isClose>
        <CloseWinIcon />
      </WinCtrlBtn>
    </div>
  )
}

function WinCtrlBtn({ onClick, title, isClose, children }: {
  onClick: () => void; title: string; isClose?: boolean; children: React.ReactNode
}) {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 42, height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover ? (isClose ? 'rgba(196,43,28,0.85)' : 'rgba(255,255,255,0.07)') : 'transparent',
        border: 'none', cursor: 'pointer',
        color: hover ? '#fff' : '#344057',
        transition: 'background 0.1s, color 0.1s', flexShrink: 0,
      }}
    >
      {children}
    </button>
  )
}

function MinimizeWinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function MaximizeWinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <rect x="1.5" y="1.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function RestoreWinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <rect x="3" y="1.5" width="5.5" height="5.5" rx="0.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M1.5 3.5V8.5h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CloseWinIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}
