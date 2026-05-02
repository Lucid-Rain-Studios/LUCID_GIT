import React, { useState, useEffect, useCallback, useRef } from 'react'
import lucidGitIcon from '@/lib/icons/lucid_git.svg'
import { ipc, OperationStep, FileStatus, DiffContent, Lock, AppNotification } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { useAuthStore } from '@/stores/authStore'
import { useLockStore } from '@/stores/lockStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useStatusToastStore } from '@/stores/statusToastStore'
import { StatusToastStack } from '@/components/notifications/StatusToastStack'
import { useErrorStore } from '@/stores/errorStore'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { StatusBar } from './StatusBar'
import { CloneDialog } from '@/components/repo/CloneDialog'
import { DeviceFlowLogin } from '@/components/auth/DeviceFlowLogin'
import { FileTree } from '@/components/changes/FileTree'
import { CommitBox } from '@/components/changes/CommitBox'
import { StashPanel } from '@/components/changes/StashPanel'
import { BranchPanel } from '@/components/branches/BranchPanel'
import { MergePreviewDialog } from '@/components/merge/MergeDialog'
import { LfsPanel } from '@/components/lfs/LfsPanel'
import { CleanupPanel } from '@/components/cleanup/CleanupPanel'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { HistoryPanel } from '@/components/history/HistoryPanel'
import { TimelinePanel } from '@/components/timeline/TimelinePanel'
import { UnrealPanel } from '@/components/unreal/UnrealPanel'
import { HooksManager } from '@/components/hooks/HooksManager'
import { ToolsPanel } from '@/components/tools/ToolsPanel'
import { PresencePanel } from '@/components/presence/PresencePanel'
import { OverviewPanel } from '@/components/overview/OverviewPanel'
import { DashboardPanel } from '@/components/dashboard/DashboardPanel'
import { PRDialog } from '@/components/pr/PRDialog'
import { RepoMapPanel } from '@/components/map/RepoMapPanel'
import { ContentBrowserPanel } from '@/components/map/ContentBrowserPanel'
import { ErrorPanel } from '@/components/errors/ErrorPanel'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { GlobalDialogs } from '@/components/ui/GlobalDialogs'
import { TextDiff } from '@/components/diff/TextDiff'
import { BinaryDiff } from '@/components/diff/BinaryDiff'
import { AssetDiffViewer } from '@/components/diff/AssetDiffViewer'
import { DependencyBlamePanel } from '@/components/blame/DependencyBlamePanel'
import { LockHeatmap } from '@/components/heatmap/LockHeatmap'
import { ForecastPanel } from '@/components/heatmap/ForecastPanel'
import { LockedFilesPanel } from '@/components/locks/LockedFilesPanel'
import { useForecastStore } from '@/stores/forecastStore'
import { AssetViewerPanel } from '@/components/viewer/AssetViewerPanel'
import { PanelErrorBoundary } from '@/components/ui/PanelErrorBoundary'
import { BugLogsPanel } from '@/components/logs/BugLogsPanel'
import { GlobalLoadingCursor } from '@/components/ui/GlobalLoadingCursor'

type TabId = 'timeline' | 'branches' | 'lfs' | 'cleanup' | 'unreal' | 'hooks' | 'settings' | 'tools' | 'presence' | 'overview' | 'map' | 'content' | 'heatmap' | 'forecast' | 'dashboard' | 'locks' | 'logs'

const ASSET_EXTS = new Set([
  'uasset', 'umap', 'upk', 'udk',
  'png', 'jpg', 'jpeg', 'tga', 'bmp', 'tiff', 'tif', 'dds', 'exr', 'hdr',
  'wav', 'mp3', 'ogg', 'flac', 'aif', 'aiff',
  'mp4', 'mov', 'avi', 'mkv',
])

function isRecognizedAsset(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return ASSET_EXTS.has(ext)
}

function RecentRepoRow({ name, path, divider, onOpen, onRemove }: {
  name: string; path: string; divider: boolean
  onOpen: () => void; onRemove: () => void
}) {
  const [hover, setHover] = React.useState(false)
  const [removeHover, setRemoveHover] = React.useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center',
        borderBottom: divider ? '1px solid #1a2030' : 'none',
        background: hover ? 'rgba(255,255,255,0.03)' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <button
        onClick={onOpen}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 10,
          height: 38, paddingLeft: 12, paddingRight: 8,
          background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, color: hover ? '#e8622f' : '#344057' }}>
          <path d="M1.5 4.5h4.2l1 1.5h7.8v7.5h-13V4.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        <span style={{
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13,
          color: hover ? '#c8cdd8' : '#7b8499', fontWeight: 500,
          letterSpacing: '-0.01em', flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {name}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
          color: '#2e3a50',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: 160, flexShrink: 0,
        }} title={path}>
          {path.replace(/\\/g, '/')}
        </span>
      </button>
      <button
        onClick={e => { e.stopPropagation(); onRemove() }}
        onMouseEnter={() => setRemoveHover(true)}
        onMouseLeave={() => setRemoveHover(false)}
        title="Remove from recent"
        style={{
          width: 30, height: 38, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: removeHover ? '#e84040' : '#283047',
          transition: 'color 0.1s',
          opacity: hover || removeHover ? 1 : 0,
        }}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
          <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}

function WelcomeBtn({ onClick, label, accent }: { onClick: () => void; label: string; accent?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 38, paddingLeft: 22, paddingRight: 22, borderRadius: 7,
        background: accent ? '#e8622f' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${accent ? '#e8622f' : '#1d2535'}`,
        color: accent ? '#fff' : '#7b8499',
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13.5,
        fontWeight: accent ? 600 : 400, cursor: 'pointer',
        boxShadow: accent ? '0 0 18px rgba(232,98,47,0.3), 0 2px 8px rgba(0,0,0,0.3)' : '0 2px 8px rgba(0,0,0,0.2)',
        letterSpacing: '-0.01em',
      }}
      onMouseEnter={e => {
        if (accent) { e.currentTarget.style.background = '#f0714d'; e.currentTarget.style.boxShadow = '0 0 28px rgba(232,98,47,0.5), 0 2px 8px rgba(0,0,0,0.3)' }
        else { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.borderColor = '#283047' }
      }}
      onMouseLeave={e => {
        if (accent) { e.currentTarget.style.background = '#e8622f'; e.currentTarget.style.boxShadow = '0 0 18px rgba(232,98,47,0.3), 0 2px 8px rgba(0,0,0,0.3)' }
        else { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor = '#1d2535' }
      }}
    >{label}</button>
  )
}

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth,     setSidebarWidth]     = useState(200)
  const [filePanelWidth,   setFilePanelWidth]   = useState(280)
  const [showCloneDialog,  setShowCloneDialog]  = useState(false)
  const [showLoginDialog,  setShowLoginDialog]  = useState(false)
  const [leftTab, setLeftTab] = useState<TabId>('dashboard')
  const [mergeTarget, setMergeTarget] = useState<string | null>(null)
  const [cmdOpen, setCmdOpen] = useState(false)
  const [authChecked, setAuthChecked] = useState(false)

  const [selectedFile, setSelectedFile] = useState<FileStatus | null>(null)
  const [diffContent,  setDiffContent]  = useState<DiffContent | null>(null)
  const [diffLoading,  setDiffLoading]  = useState(false)
  const [blameTarget,  setBlameTarget]  = useState<{ filePath: string; repoPath: string } | null>(null)

  const { repoPath, fileStatus, isLoading, error, openRepo, refreshStatus, silentRefresh, recentRepos, removeRecentRepo, clearRepo } = useRepoStore()
  const { updateStep } = useOperationStore()
  const { loadAccounts, accounts, currentAccountId } = useAuthStore()
  const { locks, loadLocks, setLocks } = useLockStore()

  const { notifications, push: pushNotification, resolveRequest, clearResolveRequest } = useNotificationStore()
  const showStatusToast = useStatusToastStore(s => s.show)

  const pushError = useErrorStore(s => s.pushRaw)
  const { conflicts: forecastConflicts, enabled: forecastEnabled, lastPolledAt, setConflicts: setForecastConflicts, setEnabled: setForecastEnabled, setLastPolledAt } = useForecastStore()

  const currentUserName = accounts.find(a => a.userId === currentAccountId)?.login ?? null
  const isSignedIn = Boolean(currentAccountId)
  const didAttemptSessionRestore = useRef(false)

  // ── Drag resize — file panel ───────────────────────────────────────────────
  const filePanelRef   = useRef<HTMLDivElement>(null)
  const fileDragging   = useRef(false)
  const fileDragStartX = useRef(0)
  const fileDragStartW = useRef(0)

  const onFileDragStart = useCallback((e: React.MouseEvent) => {
    fileDragging.current   = true
    fileDragStartX.current = e.clientX
    fileDragStartW.current = filePanelWidth
    document.body.style.cursor     = 'col-resize'
    document.body.style.userSelect = 'none'
    const clamp = (v: number) => Math.max(180, Math.min(520, v))
    const onMove = (ev: MouseEvent) => {
      if (!fileDragging.current) return
      const w = clamp(fileDragStartW.current + (ev.clientX - fileDragStartX.current))
      if (filePanelRef.current) filePanelRef.current.style.width = `${w}px`
    }
    const onUp = (ev: MouseEvent) => {
      fileDragging.current = false
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
      setFilePanelWidth(clamp(fileDragStartW.current + (ev.clientX - fileDragStartX.current)))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [filePanelWidth])

  // ── Keyboard shortcut — command palette ────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdOpen(o => !o) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // ── IPC events ────────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = ipc.onOperationProgress((step: OperationStep) => updateStep(step))
    return unsub
  }, [updateStep])

  useEffect(() => {
    const unsub = ipc.onLockChanged((updated: Lock[]) => setLocks(updated))
    return unsub
  }, [setLocks])

  useEffect(() => {
    const unsub = ipc.onNotification((n: AppNotification) => {
      pushNotification(n)
      if (n.type === 'pr-merged') showStatusToast('PR has been approved.')
    })
    return unsub
  }, [pushNotification, showStatusToast])

  useEffect(() => {
    if (!resolveRequest) return
    setLeftTab('locks')
  }, [resolveRequest])

  useEffect(() => {
    loadAccounts().finally(() => setAuthChecked(true))
  }, [loadAccounts])

  // ── Restore previous session — auto-open last repo on launch ──────────────
  useEffect(() => {
    if (didAttemptSessionRestore.current) return
    if (!authChecked || !isSignedIn) return
    didAttemptSessionRestore.current = true
    if (!repoPath && recentRepos.length > 0) {
      openRepo(recentRepos[0]).catch(() => {})
    }
  }, [authChecked, isSignedIn, repoPath, recentRepos, openRepo])

  useEffect(() => {
    if (authChecked && !isSignedIn) {
      clearRepo()
    }
  }, [authChecked, isSignedIn, clearRepo])

  useEffect(() => {
    setSelectedFile(null); setDiffContent(null)
    if (repoPath) {
      loadLocks(repoPath)
      ipc.startLockPolling(repoPath)
      ipc.prMonitorStart(repoPath).catch(() => {})
      ipc.notificationList(repoPath).then(persisted => {
        const existingIds = new Set(notifications.map(n => n.id))
        persisted.filter(n => !existingIds.has(n.id)).forEach(n => pushNotification(n))
      }).catch(() => {})
    }
  }, [repoPath])

  // ── File-system watcher — auto-refresh when working tree changes ───────────
  useEffect(() => {
    if (!repoPath) return
    const timer = window.setTimeout(() => {
      ipc.watchStatusChanges(repoPath).catch(() => {})
    }, 1500)
    const unsub = ipc.onStatusChanged(() => silentRefresh())
    return () => {
      window.clearTimeout(timer)
      unsub()
      ipc.unwatchStatusChanges(repoPath).catch(() => {})
    }
  }, [repoPath])

  // ── Forecast — subscribe to conflict events ────────────────────────────────
  useEffect(() => {
    const unsub = ipc.onForecastConflict((conflicts) => {
      setForecastConflicts(conflicts)
      setLastPolledAt(Date.now())
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!repoPath) return
    // Restore forecast status from backend on repo change
    ipc.forecastStatus(repoPath).then(st => {
      if (st) {
        setForecastEnabled(true)
        setForecastConflicts(st.conflicts)
        if (st.lastPolledAt) setLastPolledAt(st.lastPolledAt)
      }
    }).catch(() => {})
  }, [repoPath])

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleOpenRepo = async () => {
    if (!isSignedIn) {
      setShowLoginDialog(true)
      return
    }
    const dir = await ipc.openDirectory()
    if (dir) openRepo(dir)
  }

  const handleCloneRepo = () => {
    if (!isSignedIn) {
      setShowLoginDialog(true)
      return
    }
    setShowCloneDialog(true)
  }

  const handleRefresh = () => {
    setSelectedFile(null); setDiffContent(null)
    refreshStatus()
    if (repoPath) loadLocks(repoPath)
  }

  const handleSelectFile = async (file: FileStatus) => {
    setSelectedFile(file); setDiffLoading(true); setDiffContent(null)
    try {
      const diff = await ipc.diff(repoPath!, file.path, file.staged)
      setDiffContent(diff)
    } catch { /* ignore */ }
    finally { setDiffLoading(false) }
  }

  // ── Drag handle component ─────────────────────────────────────────────────
  const DragHandle = ({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) => {
    const [hover, setHover] = useState(false)
    return (
      <div
        onMouseDown={onMouseDown}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: 3, flexShrink: 0, cursor: 'col-resize',
          background: hover ? 'rgba(232,98,47,0.5)' : 'transparent',
          transition: 'background 0.15s', zIndex: 5,
        }}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--lg-bg-primary)', color: 'var(--lg-text-primary)', overflow: 'hidden' }}>
      <TopBar
        onOpen={handleOpenRepo}
        onClone={handleCloneRepo}
        onAddAccount={() => setShowLoginDialog(true)}
        onSynced={handleRefresh}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {repoPath && (
          <Sidebar
            active={leftTab}
            onChange={tab => setLeftTab(tab as TabId)}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(c => !c)}
            width={sidebarWidth}
            onWidthChange={setSidebarWidth}
            repoPath={repoPath}
            onOpenTerminal={() => { if (repoPath) ipc.openTerminal(repoPath) }}
            onOpenRepo={handleOpenRepo}
            onOpenExplorer={() => { if (repoPath) ipc.showInFolder(repoPath) }}
          />
        )}

        <main style={{ display: 'flex', flex: 1, overflow: 'hidden', flexDirection: 'column', position: 'relative' }}>
          {/* Settings is always accessible — even without a repo */}
          {leftTab === 'settings' ? (
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <SettingsPage repoPath={repoPath} />
            </PanelErrorBoundary>
          ) : !repoPath ? (
            /* ── Welcome ── */
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', background: 'var(--lg-bg-primary)' }}>
              {/* Radial ambient glow */}
              <div style={{
                position: 'absolute', width: 560, height: 560, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(232,98,47,0.07) 0%, transparent 70%)',
                pointerEvents: 'none',
              }} />
              {/* Dot grid */}
              <div className="lg-dot-grid" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
              <div style={{ textAlign: 'center', position: 'relative', zIndex: 1, animation: 'fade-in 0.4s ease both' }}>
                {/* Logo cluster */}
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 18 }}>
                  <img
                    src={lucidGitIcon}
                    alt="Lucid Git"
                    width={72}
                    height={72}
                    style={{ display: 'block', borderRadius: 18, boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)' }}
                  />
                </div>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 28, fontWeight: 700,
                  color: '#e2e6f4', letterSpacing: '0.12em',
                  textShadow: '0 2px 20px rgba(0,0,0,0.5)',
                }}>
                  LUCID GIT
                </div>
                <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#3d4a60', marginTop: 7, letterSpacing: '0.02em' }}>
                  Git client for game development teams
                </div>
                {error && (
                  <div style={{
                    marginTop: 18, background: 'rgba(232,64,64,0.08)', border: '1px solid rgba(232,64,64,0.25)',
                    borderRadius: 7, padding: '10px 16px',
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#e84040',
                    maxWidth: 400, textAlign: 'left', whiteSpace: 'pre-wrap',
                  }}>{error}</div>
                )}
                {!isSignedIn ? (
                  <div style={{ display: 'flex', justifyContent: 'center', marginTop: 28 }}>
                    <WelcomeBtn onClick={() => setShowLoginDialog(true)} label="Sign In to Continue" accent />
                  </div>
                ) : (
                  <>
                    <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: '50%',
                        background: '#1d2535', border: '1px solid #2b364d',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#7b8499', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 600,
                        textTransform: 'uppercase',
                      }}>
                        {(currentUserName ?? '?').slice(0, 1)}
                      </div>
                      <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#a8b1c2' }}>
                        {currentUserName}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 18 }}>
                      <WelcomeBtn onClick={handleOpenRepo} label="Open Repository" />
                      <WelcomeBtn onClick={handleCloneRepo} label="Clone Repository" accent />
                    </div>
                  </>
                )}
                <div style={{ marginTop: 20, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#253040', letterSpacing: '0.05em' }}>
                  Press ⌘K to open command palette
                </div>

                {isSignedIn && recentRepos.length > 0 && (
                  <div style={{ marginTop: 32, width: 340, textAlign: 'left' }}>
                    <div style={{
                      fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700,
                      color: '#344057', letterSpacing: '0.1em', textTransform: 'uppercase',
                      marginBottom: 6,
                    }}>
                      Recent
                    </div>
                    <div style={{
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid #1a2030',
                      borderRadius: 8, overflow: 'hidden',
                    }}>
                      {recentRepos.map((path, i) => {
                        const name = path.replace(/\\/g, '/').split('/').pop() ?? path
                        return (
                          <RecentRepoRow
                            key={path}
                            name={name}
                            path={path}
                            divider={i < recentRepos.length - 1}
                            onOpen={() => openRepo(path)}
                            onRemove={() => removeRecentRepo(path)}
                          />
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : leftTab === 'dashboard' ? (
            /* ── Member dashboard ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <DashboardPanel repoPath={repoPath} onNavigate={tab => setLeftTab(tab as TabId)} />
            </PanelErrorBoundary>
          ) : leftTab === 'overview' ? (
            /* ── Admin overview ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <OverviewPanel repoPath={repoPath} onNavigate={tab => setLeftTab(tab as TabId)} onRefresh={handleRefresh} />
            </PanelErrorBoundary>
          ) : leftTab === 'timeline' ? (
            /* ── Timeline — full width ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <TimelinePanel repoPath={repoPath} />
            </PanelErrorBoundary>
          ) : leftTab === 'tools' ? (
            /* ── Tools — full width ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <ToolsPanel repoPath={repoPath} onRefresh={handleRefresh} />
            </PanelErrorBoundary>
          ) : leftTab === 'content' ? (
            /* ── Content Browser — full width ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <ContentBrowserPanel repoPath={repoPath} onNavigate={tab => setLeftTab(tab as TabId)} />
            </PanelErrorBoundary>
          ) : leftTab === 'map' ? (
            /* ── File Map — full width ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <RepoMapPanel repoPath={repoPath} />
            </PanelErrorBoundary>
          ) : leftTab === 'presence' ? (
            /* ── Team Presence — full width ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <PresencePanel repoPath={repoPath} />
            </PanelErrorBoundary>
          ) : leftTab === 'heatmap' ? (
            /* ── Lock Heatmap — full width ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <LockHeatmap repoPath={repoPath} />
            </PanelErrorBoundary>
          ) : leftTab === 'forecast' ? (
            /* ── Conflict Forecast — full width ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <ForecastPanel
                repoPath={repoPath}
                conflicts={forecastConflicts}
                enabled={forecastEnabled}
                lastPolledAt={lastPolledAt}
                onStart={async () => {
                  const st = await ipc.forecastStart(repoPath)
                  setForecastEnabled(true)
                  setForecastConflicts(st.conflicts)
                }}
                onStop={async () => {
                  await ipc.forecastStop(repoPath)
                  setForecastEnabled(false)
                  setForecastConflicts([])
                }}
              />
            </PanelErrorBoundary>
          ) : leftTab === 'locks' ? (
            /* ── Locked Files — full width ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <LockedFilesPanel repoPath={repoPath} resolveRequest={resolveRequest} onResolvedViewed={clearResolveRequest} />
            </PanelErrorBoundary>
          ) : leftTab === 'logs' ? (
            /* ── Bug Logs — full width, no repo required ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <BugLogsPanel />
            </PanelErrorBoundary>
          ) : leftTab === 'branches' ? (
            /* ── Branches — full width (no outer split) ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <BranchPanel onMergePreview={branch => setMergeTarget(branch)} onRefresh={handleRefresh} />
            </PanelErrorBoundary>
          ) : leftTab === 'lfs' ? (
            /* ── LFS — full width ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
              <LfsPanel repoPath={repoPath} />
            </PanelErrorBoundary>
          ) : (
            /* ── Split: left panel | diff (branches, lfs, cleanup, unreal, hooks) ── */
            <PanelErrorBoundary tabId={leftTab} onGoHome={() => setLeftTab('dashboard')}>
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
              <div ref={filePanelRef} style={{ width: filePanelWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {leftTab === 'cleanup' ? (
                  <CleanupPanel repoPath={repoPath} />
                ) : leftTab === 'unreal' ? (
                  <UnrealPanel repoPath={repoPath} />
                ) : leftTab === 'hooks' ? (
                  <HooksManager repoPath={repoPath} />
                ) : null}
              </div>
              <DragHandle onMouseDown={onFileDragStart} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--lg-bg-primary)' }} />
            </div>
            </PanelErrorBoundary>
          )}

          {/* Asset viewer overlay — absolute within main */}
          {repoPath && <AssetViewerPanel />}
        </main>
      </div>

      <StatusBar />
      <GlobalLoadingCursor />

      {showCloneDialog && <CloneDialog onClose={() => setShowCloneDialog(false)} />}
      {showLoginDialog && <DeviceFlowLogin onClose={() => setShowLoginDialog(false)} />}
      {mergeTarget && (
        <MergePreviewDialog
          targetBranch={mergeTarget}
          onClose={() => setMergeTarget(null)}
          onMerged={() => { setMergeTarget(null); handleRefresh() }}
        />
      )}

      <PRDialog />
      <GlobalDialogs />
      <ErrorPanel
        onReauth={() => setShowLoginDialog(true)}
        onNavigateTab={(tab) => setLeftTab(tab as TabId)}
      />
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onNavigateTab={(tab) => setLeftTab(tab as TabId)}
        onOpenRepo={handleOpenRepo}
        onClone={handleCloneRepo}
        onAddAccount={() => setShowLoginDialog(true)}
      />
      <StatusToastStack />
    </div>
  )
}
