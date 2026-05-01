import React, { useState, useEffect, useRef } from 'react'
import { FileStatus, Lock, ipc } from '@/ipc'
import { useLockStore } from '@/stores/lockStore'
import { useForecastStore } from '@/stores/forecastStore'
import { useAuthStore } from '@/stores/authStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useAssetViewerStore } from '@/stores/assetViewerStore'
import { AppCheckbox } from '@/components/ui/AppCheckbox'
import { AppTooltip } from '@/components/ui/AppTooltip'
import { AppRightSelectionItem, AppRightSelectionOptions, AppRightSelectionSeparator } from '@/components/ui/AppRightSelectionOptions'

interface FileRowProps {
  file: FileStatus
  repoPath: string
  selected: boolean
  lock: Lock | null
  currentUserName: string | null
  isMultiSelected?: boolean
  onSelect: (e: React.MouseEvent) => void
  onRefresh: () => void
  onBlameDeps?: (file: FileStatus) => void
  onMultiContextMenu?: (e: React.MouseEvent) => void
}

const STATUS_COLOR: Record<string, string> = {
  M: '#f5a832', A: '#2ec573', D: '#e84545',
  R: '#4d9dff', C: '#4d9dff', U: '#e84545',
  '?': '#a27ef0', '!': '#8b94b0',
}
const STATUS_BG: Record<string, string> = {
  M: 'rgba(245,168,50,0.15)',  A: 'rgba(46,197,115,0.15)',  D: 'rgba(232,69,69,0.15)',
  R: 'rgba(77,157,255,0.15)',  C: 'rgba(77,157,255,0.15)',  U: 'rgba(232,69,69,0.15)',
  '?': 'rgba(162,126,240,0.15)', '!': 'rgba(139,148,176,0.1)',
}


function LockIcon({ color }: { color: string }) {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
      <rect x="2.2" y="5.4" width="7.6" height="5" rx="1.4" stroke={color} strokeWidth="1.2" />
      <path d="M3.8 5.4V4a2.2 2.2 0 1 1 4.4 0v1.4" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

export function FileRow({
  file, repoPath, selected, lock, currentUserName, isMultiSelected, onSelect, onRefresh, onBlameDeps, onMultiContextMenu,
}: FileRowProps) {
  const isUEAsset = /\.(uasset|umap|udk|upk)$/i.test(file.path)
  const isImgAsset = /\.(png|jpg|jpeg|tga|bmp|tiff|tif|dds|exr|hdr)$/i.test(file.path)
  const isPreviewable = isUEAsset || isImgAsset
  const forecastConflicts = useForecastStore(s => s.conflicts)
  const openViewer = useAssetViewerStore(s => s.open)
  const [thumbnail, setThumbnail] = useState<string | null>(null)

  useEffect(() => {
    if (!isPreviewable) return
    const ref = file.staged ? 'INDEX' : 'WORKING'
    ipc.assetRenderThumbnail(repoPath, file.path, ref)
      .then(p => setThumbnail(p))
      .catch(() => {})
  }, [repoPath, file.path, isPreviewable, file.staged])
  const fileConflicts = forecastConflicts.filter(c => c.filePath === file.path || c.filePath.endsWith('/' + file.path))
  const { lockFile, unlockFile, watchFile } = useLockStore()
  const isAdmin = useAuthStore(s => s.isAdmin(repoPath))
  const dialog  = useDialogStore()

  const effectiveStatus = file.staged ? file.indexStatus : file.workingStatus
  const statusColor     = STATUS_COLOR[effectiveStatus] ?? '#8b94b0'
  const statusBg        = STATUS_BG[effectiveStatus]    ?? 'transparent'
  const isUntracked     = effectiveStatus === '?'

  const fileName = file.path.includes('/') || file.path.includes('\\')
    ? file.path.replace(/\\/g, '/').split('/').pop()!
    : file.path
  const dir = file.path.replace(/\\/g, '/').includes('/')
    ? file.path.replace(/\\/g, '/').slice(0, file.path.replace(/\\/g, '/').lastIndexOf('/'))
    : ''

  const fullPath   = `${repoPath.replace(/\\/g, '/')}/${file.path.replace(/\\/g, '/')}`
  const isLockedByMe    = lock !== null && lock.owner.login === currentUserName
  const isLockedByOther = lock !== null && !isLockedByMe

  const [ctx, setCtx]   = useState<{ x: number; y: number } | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ctx) return
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtx(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctx])

  const toggleStage = async () => {
    if (isLockedByOther) { alert(`Cannot stage "${file.path}" — locked by ${lock!.owner.name}`); return }
    try {
      if (file.staged) await ipc.unstage(repoPath, [file.path])
      else             await ipc.stage(repoPath, [file.path])
      onRefresh()
    } catch { /* ignore */ }
  }

  const close = () => setCtx(null)
  const doDiscard = async () => {
    close()
    const ok = await dialog.confirm({
      title: isUntracked ? 'Delete file' : 'Discard changes',
      message: `${isUntracked ? 'Delete' : 'Discard changes to'} "${file.path}"?`,
      detail: 'This cannot be undone.',
      confirmLabel: isUntracked ? 'Delete' : 'Discard',
      danger: true,
    })
    if (!ok) return
    try {
      await ipc.discard(repoPath, [file.path], isUntracked)
      onRefresh()
      // Release my lock when I explicitly discard this file's local changes.
      if (isLockedByMe) unlockFile(repoPath, file.path).catch(() => {})
    } catch (e) { await dialog.alert({ title: 'Error', message: String(e) }) }
  }
  const doIgnoreFile   = async () => { close(); try { await ipc.addToGitignore(repoPath, file.path); onRefresh() } catch (e) { await dialog.alert({ title: 'Error', message: String(e) }) } }
  const doIgnoreFolder = async () => { close(); if (!dir) return; try { await ipc.addToGitignore(repoPath, dir + '/'); onRefresh() } catch (e) { await dialog.alert({ title: 'Error', message: String(e) }) } }
  const doCopyFullPath = () => { close(); navigator.clipboard.writeText(fullPath.replace(/\//g, '\\')) }
  const doCopyRelPath  = () => { close(); navigator.clipboard.writeText(file.path.replace(/\//g, '\\')) }
  const doShowInExplorer = () => { close(); ipc.showInFolder(fullPath.replace(/\//g, '\\')) }
  const doOpenVSCode     = () => { close(); ipc.openExternal(`vscode://file/${fullPath}`) }
  const doOpenDefault    = () => { close(); ipc.openPath(fullPath.replace(/\//g, '\\')) }
  const doLock    = async () => { close(); try { await lockFile(repoPath, file.path) } catch (e) { await dialog.alert({ title: 'Error', message: String(e) }) } }
  const doUnlock  = async (force = false) => {
    close()
    if (force) {
      const ok = await dialog.confirm({ title: 'Force unlock', message: `Force-unlock "${file.path}"?`, detail: 'The current lock owner will lose their lock.', confirmLabel: 'Force Unlock', danger: true })
      if (!ok) return
    }
    try { await unlockFile(repoPath, file.path, force) } catch (e) { await dialog.alert({ title: 'Error', message: String(e) }) }
  }
  const doWatch = async () => { close(); await watchFile(repoPath, file.path) }

  const checkColor = file.staged ? '#2ec573' : '#f5a832'

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={onSelect}
        onContextMenu={e => {
          e.preventDefault()
          if (isMultiSelected && onMultiContextMenu) onMultiContextMenu(e)
          else setCtx({ x: e.clientX, y: e.clientY })
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          height: 36, paddingLeft: 10, paddingRight: 10,
          background: selected ? '#242a3d' : isMultiSelected ? '#1b2035' : 'transparent',
          borderLeft: `2px solid ${selected ? '#e8622f' : isMultiSelected ? 'rgba(232,98,47,0.4)' : 'transparent'}`,
          borderBottom: '1px solid #252d42',
          cursor: 'pointer', transition: 'background 0.1s',
          opacity: isLockedByOther ? 0.75 : 1,
        }}
        onMouseEnter={e => { if (!selected && !isMultiSelected) e.currentTarget.style.background = '#1e2436' }}
        onMouseLeave={e => { if (!selected && !isMultiSelected) e.currentTarget.style.background = 'transparent' }}
      >
        <AppCheckbox checked={file.staged} onChange={toggleStage} color={checkColor} />

        {/* Status pill */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 18, borderRadius: 4, flexShrink: 0,
          background: statusBg, color: statusColor,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
        }}>{effectiveStatus}</span>

        {/* Asset thumbnail — clickable to open viewer */}
        {isPreviewable && thumbnail && (
          <AppTooltip content="Preview file" side="top" delay={250}><button
            onClick={e => { e.stopPropagation(); openViewer(repoPath, file.path) }}
            style={{
              width: 24, height: 24, borderRadius: 4, overflow: 'hidden', flexShrink: 0,
              border: '1px solid rgba(255,255,255,0.07)',
              backgroundImage: 'repeating-conic-gradient(#1a2030 0% 25%, transparent 0% 50%)',
              backgroundSize: '6px 6px',
              padding: 0, cursor: 'pointer', transition: 'border-color 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(232,98,47,0.5)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)' }}
          >
            <img
              src={`file:///${thumbnail.replace(/\\/g, '/').replace(/^\/+/, '')}`}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          </button></AppTooltip>
        )}

        {/* Name + dir */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 500,
              color: '#dde1f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{fileName}</span>

            {/* Forecast warning badge */}
            {fileConflicts.length > 0 && (
              <span
                title={`${fileConflicts.length} remote branch${fileConflicts.length !== 1 ? 'es' : ''} ahead — possible conflict`}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                  background: fileConflicts[0].severity === 'high' ? 'rgba(232,69,69,0.2)' : 'rgba(245,168,50,0.2)',
                  color: fileConflicts[0].severity === 'high' ? '#e84545' : '#f5a832',
                  fontSize: 9, fontWeight: 700, cursor: 'default',
                }}
              >!</span>
            )}

            {/* Lock badge */}
            {isLockedByMe && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                paddingLeft: 4, paddingRight: 6, height: 16, borderRadius: 10, flexShrink: 0,
                background: 'rgba(46,197,115,0.15)', border: '1px solid rgba(46,197,115,0.4)',
                color: '#2ec573', fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600,
              }} title="Locked by you">
                <LockIcon color="#2ec573" />
                You
              </span>
            )}
            {isLockedByOther && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                paddingLeft: 4, paddingRight: 6, height: 16, borderRadius: 10, flexShrink: 0,
                background: 'rgba(232,98,47,0.15)', border: '1px solid rgba(232,98,47,0.4)',
                color: '#e8622f', fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600,
              }} title={`Locked by ${lock!.owner.name}`}>
                <LockIcon color="#e8622f" />
                {lock!.owner.login}
              </span>
            )}
          </div>
          {dir && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870',
              display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{dir}</span>
          )}
        </div>
      </div>

      {/* Context menu */}
      {ctx && (
        <AppRightSelectionOptions x={ctx.x} y={ctx.y} minWidth={200} menuRef={ctxRef}>
          <AppRightSelectionItem label={isUntracked ? 'Delete file…' : 'Discard changes…'} onClick={doDiscard} danger />
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label="Ignore file"                onClick={doIgnoreFile} />
          {dir && <AppRightSelectionItem label="Ignore folder"      onClick={doIgnoreFolder} />}
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label="Copy file path"             onClick={doCopyFullPath} />
          <AppRightSelectionItem label="Copy relative path"         onClick={doCopyRelPath} />
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label="Show in Explorer"           onClick={doShowInExplorer} />
          <AppRightSelectionItem label="Open in VS Code"            onClick={doOpenVSCode} />
          <AppRightSelectionItem label="Open with default app"      onClick={doOpenDefault} />
          <AppRightSelectionSeparator />
          {!lock && <AppRightSelectionItem label="Lock file"        onClick={doLock} />}
          {isLockedByMe && <AppRightSelectionItem label="Unlock"   onClick={() => doUnlock(false)} />}
          {isLockedByOther && <>
            <AppRightSelectionItem label={`Locked by ${lock!.owner.name}`} disabled />
            <AppRightSelectionItem
              label="Force unlock…"
              onClick={isAdmin ? () => doUnlock(true) : undefined}
              disabled={!isAdmin}
              danger={isAdmin}
              title={isAdmin ? undefined : 'Admin access required'}
            />
            <AppRightSelectionItem label="Notify me when unlocked"  onClick={doWatch} />
          </>}
          {isPreviewable && <>
            <AppRightSelectionSeparator />
            <AppRightSelectionItem label="Preview file" onClick={() => { close(); openViewer(repoPath, file.path) }} />
          </>}
          {isUEAsset && onBlameDeps && <>
            <AppRightSelectionItem label="Blame with dependencies" onClick={() => { close(); onBlameDeps(file) }} />
          </>}
        </AppRightSelectionOptions>
      )}
    </div>
  )
}
