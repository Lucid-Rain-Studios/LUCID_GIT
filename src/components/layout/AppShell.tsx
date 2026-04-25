import React, { useState, useEffect, useCallback, useRef } from 'react'
import { ipc, OperationStep, FileStatus, DiffContent, Lock, AppNotification } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useOperationStore } from '@/stores/operationStore'
import { useAuthStore } from '@/stores/authStore'
import { useLockStore } from '@/stores/lockStore'
import { useNotificationStore } from '@/stores/notificationStore'
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
import { MergePreviewDialog } from '@/components/merge/MergePreviewDialog'
import { LfsPanel } from '@/components/lfs/LfsPanel'
import { CleanupPanel } from '@/components/cleanup/CleanupPanel'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { HistoryPanel } from '@/components/history/HistoryPanel'
import { UnrealPanel } from '@/components/unreal/UnrealPanel'
import { HooksManager } from '@/components/hooks/HooksManager'
import { ToolsPanel } from '@/components/tools/ToolsPanel'
import { PresencePanel } from '@/components/presence/PresencePanel'
import { OverviewPanel } from '@/components/overview/OverviewPanel'
import { RepoMapPanel } from '@/components/map/RepoMapPanel'
import { ContentBrowserPanel } from '@/components/map/ContentBrowserPanel'
import { ErrorPanel } from '@/components/errors/ErrorPanel'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { TextDiff } from '@/components/diff/TextDiff'
import { BinaryDiff } from '@/components/diff/BinaryDiff'
import { AssetDiffViewer } from '@/components/diff/AssetDiffViewer'
import { DependencyBlamePanel } from '@/components/blame/DependencyBlamePanel'
import { LockHeatmap } from '@/components/heatmap/LockHeatmap'
import { ForecastPanel } from '@/components/heatmap/ForecastPanel'
import { useForecastStore } from '@/stores/forecastStore'

type TabId = 'changes' | 'stash' | 'branches' | 'lfs' | 'cleanup' | 'unreal' | 'hooks' | 'settings' | 'history' | 'tools' | 'presence' | 'overview' | 'map' | 'content' | 'heatmap' | 'forecast'

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
  const [leftTab, setLeftTab] = useState<TabId>('overview')
  const [mergeTarget, setMergeTarget] = useState<string | null>(null)
  const [cmdOpen, setCmdOpen] = useState(false)

  const [selectedFile, setSelectedFile] = useState<FileStatus | null>(null)
  const [diffContent,  setDiffContent]  = useState<DiffContent | null>(null)
  const [diffLoading,  setDiffLoading]  = useState(false)
  const [blameTarget,  setBlameTarget]  = useState<{ filePath: string; repoPath: string } | null>(null)

  const { repoPath, fileStatus, isLoading, error, openRepo, refreshStatus, silentRefresh } = useRepoStore()
  const { updateStep } = useOperationStore()
  const { loadAccounts, accounts, currentAccountId } = useAuthStore()
  const { locks, loadLocks, setLocks } = useLockStore()
  const { notifications, push: pushNotification } = useNotificationStore()
  const pushError = useErrorStore(s => s.pushRaw)
  const { conflicts: forecastConflicts, enabled: forecastEnabled, lastPolledAt, setConflicts: setForecastConflicts, setEnabled: setForecastEnabled, setLastPolledAt } = useForecastStore()

  const currentUserName = accounts.find(a => a.userId === currentAccountId)?.login ?? null

  // ── Drag resize — file panel ───────────────────────────────────────────────
  const fileDragging   = useRef(false)
  const fileDragStartX = useRef(0)
  const fileDragStartW = useRef(0)

  const onFileDragStart = useCallback((e: React.MouseEvent) => {
    fileDragging.current   = true
    fileDragStartX.current = e.clientX
    fileDragStartW.current = filePanelWidth
    document.body.style.cursor     = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!fileDragging.current) return
      setFilePanelWidth(Math.max(180, Math.min(520, fileDragStartW.current + (ev.clientX - fileDragStartX.current))))
    }
    const onUp = () => {
      fileDragging.current = false
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
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
    const unsub = ipc.onNotification((n: AppNotification) => pushNotification(n))
    return unsub
  }, [pushNotification])

  useEffect(() => { loadAccounts() }, [])

  useEffect(() => {
    setSelectedFile(null); setDiffContent(null)
    if (repoPath) {
      loadLocks(repoPath)
      ipc.startLockPolling(repoPath)
      ipc.notificationList(repoPath).then(persisted => {
        const existingIds = new Set(notifications.map(n => n.id))
        persisted.filter(n => !existingIds.has(n.id)).forEach(n => pushNotification(n))
      }).catch(() => {})
    }
  }, [repoPath])

  // ── File-system watcher — auto-refresh when working tree changes ───────────
  useEffect(() => {
    if (!repoPath) return
    ipc.watchStatusChanges(repoPath).catch(() => {})
    const unsub = ipc.onStatusChanged(() => silentRefresh())
    return () => {
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
    const dir = await ipc.openDirectory()
    if (dir) openRepo(dir)
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0d0f15', color: '#e2e6f4', overflow: 'hidden' }}>
      <TopBar
        onOpen={handleOpenRepo}
        onClone={() => setShowCloneDialog(true)}
        onAddAccount={() => setShowLoginDialog(true)}
        onSynced={handleRefresh}
      />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar handles its own drag resize internally */}
        <Sidebar
          active={leftTab}
          onChange={tab => setLeftTab(tab as TabId)}
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(c => !c)}
          width={sidebarWidth}
          onWidthChange={setSidebarWidth}
          repoPath={repoPath}
          onOpenTerminal={() => { if (repoPath) ipc.openTerminal(repoPath) }}
        />

        <main style={{ display: 'flex', flex: 1, overflow: 'hidden', flexDirection: 'column' }}>
          {/* Settings is always accessible — even without a repo */}
          {leftTab === 'settings' ? (
            <SettingsPage repoPath={repoPath} />
          ) : !repoPath ? (
            /* ── Welcome ── */
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden', background: '#0d0f15' }}>
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
                  <div style={{
                    width: 52, height: 52, borderRadius: 14,
                    background: 'linear-gradient(145deg, #1c2235, #131720)',
                    border: '1px solid #1d2535',
                    boxShadow: '0 0 0 1px rgba(232,98,47,0.1), 0 8px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <svg width="26" height="26" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="3" r="2.2" fill="#e8622f" />
                      <circle cx="3" cy="12.5" r="1.6" fill="#e8622f" fillOpacity="0.55" />
                      <circle cx="13" cy="12.5" r="1.6" fill="#e8622f" fillOpacity="0.55" />
                      <line x1="8" y1="5.2" x2="3.6" y2="11" stroke="#e8622f" strokeWidth="1.1" strokeOpacity="0.45" strokeLinecap="round" />
                      <line x1="8" y1="5.2" x2="12.4" y2="11" stroke="#e8622f" strokeWidth="1.1" strokeOpacity="0.45" strokeLinecap="round" />
                    </svg>
                  </div>
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
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 28 }}>
                  <WelcomeBtn onClick={handleOpenRepo} label="Open Repository" />
                  <WelcomeBtn onClick={() => setShowCloneDialog(true)} label="Clone Repository" accent />
                </div>
                <div style={{ marginTop: 20, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#253040', letterSpacing: '0.05em' }}>
                  Press ⌘K to open command palette
                </div>
              </div>
            </div>
          ) : leftTab === 'overview' ? (
            /* ── Overview dashboard ── */
            <OverviewPanel repoPath={repoPath} onNavigate={tab => setLeftTab(tab as TabId)} onRefresh={handleRefresh} />
          ) : leftTab === 'history' ? (
            /* ── History — full width ── */
            <HistoryPanel repoPath={repoPath} />
          ) : leftTab === 'tools' ? (
            /* ── Tools — full width ── */
            <ToolsPanel repoPath={repoPath} onRefresh={handleRefresh} />
          ) : leftTab === 'content' ? (
            /* ── Content Browser — full width ── */
            <ContentBrowserPanel repoPath={repoPath} onNavigate={tab => setLeftTab(tab as TabId)} />
          ) : leftTab === 'map' ? (
            /* ── File Map — full width ── */
            <RepoMapPanel repoPath={repoPath} />
          ) : leftTab === 'presence' ? (
            /* ── Team Presence — full width ── */
            <PresencePanel repoPath={repoPath} />
          ) : leftTab === 'heatmap' ? (
            /* ── Lock Heatmap — full width ── */
            <LockHeatmap repoPath={repoPath} />
          ) : leftTab === 'forecast' ? (
            /* ── Conflict Forecast — full width ── */
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
          ) : (
            /* ── Split: left panel | diff ── */
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
              {/* Left panel */}
              <div style={{ width: filePanelWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {leftTab === 'changes' ? (
                  <>
                    <FileTree
                      files={fileStatus}
                      repoPath={repoPath}
                      selectedPath={selectedFile?.path ?? null}
                      locks={locks}
                      currentUserName={currentUserName}
                      isLoading={isLoading}
                      onSelect={handleSelectFile}
                      onRefresh={handleRefresh}
                      onBlameDeps={file => setBlameTarget({ filePath: file.path, repoPath: repoPath! })}
                    />
                    <CommitBox />
                  </>
                ) : leftTab === 'stash' ? (
                  <StashPanel repoPath={repoPath} onRefresh={handleRefresh} />
                ) : leftTab === 'branches' ? (
                  <BranchPanel onMergePreview={branch => setMergeTarget(branch)} onRefresh={handleRefresh} />
                ) : leftTab === 'lfs' ? (
                  <LfsPanel repoPath={repoPath} />
                ) : leftTab === 'cleanup' ? (
                  <CleanupPanel repoPath={repoPath} />
                ) : leftTab === 'unreal' ? (
                  <UnrealPanel repoPath={repoPath} />
                ) : leftTab === 'hooks' ? (
                  <HooksManager repoPath={repoPath} />
                ) : null}
              </div>

              <DragHandle onMouseDown={onFileDragStart} />

              {/* Right: diff or blame */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0d0f15' }}>
                {blameTarget ? (
                  <DependencyBlamePanel
                    repoPath={blameTarget.repoPath}
                    filePath={blameTarget.filePath}
                    onClose={() => setBlameTarget(null)}
                  />
                ) : (
                  <>
                    {diffLoading && (
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#344057', animation: 'pulse 1.5s infinite' }}>
                          Loading diff…
                        </span>
                      </div>
                    )}
                    {!diffLoading && diffContent && (
                      diffContent.isBinary
                        ? isRecognizedAsset(selectedFile!.path)
                          ? <AssetDiffViewer file={selectedFile!} repoPath={repoPath!} staged={selectedFile!.staged} />
                          : <BinaryDiff file={selectedFile!} repoPath={repoPath!} />
                        : <TextDiff diff={diffContent} />
                    )}
                    {!diffLoading && !diffContent && (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                        <div style={{
                          width: 44, height: 44, borderRadius: 11,
                          background: 'rgba(255,255,255,0.025)',
                          border: '1px solid #1d2535',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <svg width="22" height="22" viewBox="0 0 36 36" fill="none">
                            <rect x="7" y="5" width="22" height="26" rx="3" stroke="#283047" strokeWidth="1.5" />
                            <path d="M12 12h12M12 17h8M12 22h10" stroke="#283047" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </div>
                        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, color: '#2e3a50', letterSpacing: '-0.01em' }}>
                          Select a file to view diff
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      <StatusBar />

      {showCloneDialog && <CloneDialog onClose={() => setShowCloneDialog(false)} />}
      {showLoginDialog && <DeviceFlowLogin onClose={() => setShowLoginDialog(false)} />}
      {mergeTarget && (
        <MergePreviewDialog
          targetBranch={mergeTarget}
          onClose={() => setMergeTarget(null)}
          onMerged={() => { setMergeTarget(null); handleRefresh() }}
        />
      )}

      <ErrorPanel
        onReauth={() => setShowLoginDialog(true)}
        onNavigateTab={(tab) => setLeftTab(tab as TabId)}
      />
      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onNavigateTab={(tab) => setLeftTab(tab as TabId)}
        onOpenRepo={handleOpenRepo}
        onClone={() => setShowCloneDialog(true)}
        onAddAccount={() => setShowLoginDialog(true)}
      />
    </div>
  )
}
