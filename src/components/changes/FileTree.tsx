import React, { useState, useRef, useEffect, useCallback } from 'react'
import { FileStatus, Lock, ipc } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { FileRow } from './FileRow'
import { AppCheckbox } from '@/components/ui/AppCheckbox'
import { useDialogStore } from '@/stores/dialogStore'
import { useLockStore } from '@/stores/lockStore'
import { useAuthStore } from '@/stores/authStore'

// ── Content Browser tree types ────────────────────────────────────────────────

interface FolderNode {
  name: string
  fullPath: string
  children: FolderNode[]
  files: FileStatus[]
}

type FlatRow =
  | { type: 'folder'; name: string; depth: number; fullPath: string; count: number; collapsed: boolean }
  | { type: 'file'; file: FileStatus; depth: number }

function buildTree(files: FileStatus[]): FolderNode {
  const root: FolderNode = { name: '', fullPath: '', children: [], files: [] }
  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      let child = node.children.find(c => c.name === seg)
      if (!child) {
        child = { name: seg, fullPath: parts.slice(0, i + 1).join('/'), children: [], files: [] }
        node.children.push(child)
      }
      node = child
    }
    node.files.push(file)
  }
  return root
}

function countFiles(node: FolderNode): number {
  return node.files.length + node.children.reduce((sum, c) => sum + countFiles(c), 0)
}

function flattenTree(node: FolderNode, depth: number, collapsed: Set<string>): FlatRow[] {
  const rows: FlatRow[] = []
  for (const child of node.children) {
    const isCollapsed = collapsed.has(child.fullPath)
    rows.push({ type: 'folder', name: child.name, depth, fullPath: child.fullPath, count: countFiles(child), collapsed: isCollapsed })
    if (!isCollapsed) rows.push(...flattenTree(child, depth + 1, collapsed))
  }
  for (const file of node.files) {
    rows.push({ type: 'file', file, depth })
  }
  return rows
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M0.5 3h4.8l0.9 1.5h7.3v6.5H0.5V3z"
        fill={open ? 'rgba(245,168,50,0.22)' : 'rgba(245,168,50,0.1)'}
        stroke="#f5a832" strokeWidth="0.9" strokeLinejoin="round"
      />
      {open && <path d="M0.5 5h13" stroke="rgba(245,168,50,0.4)" strokeWidth="0.7" />}
    </svg>
  )
}

function FolderRow({ name, depth, count, collapsed, onToggle }: {
  name: string; depth: number; count: number; collapsed: boolean; onToggle: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        height: 28, paddingLeft: 10 + depth * 14, paddingRight: 10,
        background: hover ? '#181d2e' : 'transparent',
        borderBottom: '1px solid #181d2e',
        cursor: 'pointer', userSelect: 'none',
      }}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{
        transition: 'transform 0.1s', transform: collapsed ? 'rotate(-90deg)' : 'none', flexShrink: 0,
      }}>
        <path d="M1 2.5L4 5.5L7 2.5" stroke="#4e5870" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <FolderIcon open={!collapsed} />
      <span style={{
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#c4cad8',
        flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{name}</span>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870',
        background: '#1a2030', borderRadius: 8, padding: '1px 5px', flexShrink: 0,
      }}>{count}</span>
    </div>
  )
}

interface FileTreeProps {
  files: FileStatus[]
  repoPath: string
  selectedPath: string | null
  locks: Lock[]
  currentUserName: string | null
  isLoading: boolean
  onSelect: (file: FileStatus) => void
  onRefresh: () => void
  onBlameDeps?: (file: FileStatus) => void
}

function SectionCheckbox({ allChecked, onToggle, color }: {
  allChecked: boolean
  onToggle: () => void
  color: string
}) {
  return (
    <AppCheckbox checked={allChecked} onChange={onToggle} color={color} showHoverDash />
  )
}

export function FileTree({
  files, repoPath, selectedPath, locks, currentUserName, isLoading, onSelect, onRefresh, onBlameDeps,
}: FileTreeProps) {
  const staged   = files.filter(f => f.staged)
  const unstaged = files.filter(f => !f.staged)
  const [busy, setBusy] = useState(false)
  const dialog = useDialogStore()
  const [treeMode, setTreeMode] = useState(false)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const opRun = useOperationStore(s => s.run)
  const unlockFile = useLockStore(s => s.unlockFile)
  const { accounts, currentAccountId } = useAuthStore()
  const currentLogin = accounts.find(a => a.userId === currentAccountId)?.login ?? null

  // ── Multi-select state ─────────────────────────────────────────────────────
  const [multiPaths, setMultiPaths]         = useState<Set<string>>(new Set())
  const [lastClickedKey, setLastClickedKey] = useState<string | null>(null)
  const [multiCtx, setMultiCtx]             = useState<{ x: number; y: number } | null>(null)
  const multiCtxRef                          = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!multiCtx) return
    const handler = (e: MouseEvent) => {
      if (multiCtxRef.current && !multiCtxRef.current.contains(e.target as Node)) setMultiCtx(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [multiCtx])

  useEffect(() => {
    if (multiPaths.size === 0) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setMultiPaths(new Set()) }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [multiPaths.size])

  // Stable key per file row (staged and unstaged can have the same path)
  const pathKey = (file: FileStatus) => `${file.staged ? 's' : 'u'}:${file.path}`

  // Flat ordered list for range selection (staged first, then unstaged)
  const allFlatFiles = useCallback(() => [...staged, ...unstaged], [staged, unstaged])

  const handleFileClick = useCallback((file: FileStatus, e: React.MouseEvent) => {
    const key = pathKey(file)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const next = new Set(multiPaths)
      next.has(key) ? next.delete(key) : next.add(key)
      setMultiPaths(next)
      setLastClickedKey(key)
    } else if (e.shiftKey && lastClickedKey) {
      e.preventDefault()
      const flat = allFlatFiles()
      const keys = flat.map(pathKey)
      const i1 = keys.indexOf(lastClickedKey)
      const i2 = keys.indexOf(key)
      if (i1 >= 0 && i2 >= 0) {
        const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1]
        setMultiPaths(new Set(keys.slice(lo, hi + 1)))
      }
      setLastClickedKey(key)
    } else {
      setMultiPaths(new Set())
      setLastClickedKey(key)
      onSelect(file)
    }
  }, [multiPaths, lastClickedKey, allFlatFiles, onSelect])

  const lockFor = (file: FileStatus): Lock | null =>
    locks.find(l => l.path.replace(/\\/g, '/') === file.path.replace(/\\/g, '/')) ?? null

  const toggleFolder = (path: string) =>
    setCollapsedFolders(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true)
    try { await opRun(label, fn) } catch (e) { alert(String(e)) } finally { setBusy(false) }
    onRefresh()
  }

  // Bulk action helpers
  const multiSelected = allFlatFiles().filter(f => multiPaths.has(pathKey(f)))
  const multiUnstaged = multiSelected.filter(f => !f.staged)
  const multiStaged   = multiSelected.filter(f => f.staged)
  const multiUntrackedPaths = multiUnstaged.filter(f => f.workingStatus === '?').map(f => f.path)
  const multiTrackedUnstagedPaths = multiUnstaged.filter(f => f.workingStatus !== '?').map(f => f.path)

  const handleMultiBulkStage = async () => {
    setMultiCtx(null)
    if (multiUnstaged.length === 0) return
    await run(`Staging ${multiUnstaged.length} files…`, () => ipc.stage(repoPath, multiUnstaged.map(f => f.path)))
    setMultiPaths(new Set())
  }

  const handleMultiBulkUnstage = async () => {
    setMultiCtx(null)
    if (multiStaged.length === 0) return
    await run(`Unstaging ${multiStaged.length} files…`, () => ipc.unstage(repoPath, multiStaged.map(f => f.path)))
    setMultiPaths(new Set())
  }

  const handleMultiBulkDiscard = async () => {
    setMultiCtx(null)
    if (multiUnstaged.length === 0) return
    const ok = await dialog.confirm({
      title: `Discard ${multiUnstaged.length} files`,
      message: `Discard changes to ${multiUnstaged.length} selected file${multiUnstaged.length !== 1 ? 's' : ''}?`,
      detail: 'This cannot be undone.',
      confirmLabel: 'Discard', danger: true,
    })
    if (!ok) return
    await run(`Discarding ${multiUnstaged.length} files…`, async () => {
      const trackedPaths = multiTrackedUnstagedPaths
      const untrackedPaths = multiUntrackedPaths
      if (trackedPaths.length > 0) await ipc.discard(repoPath, trackedPaths, false)
      if (untrackedPaths.length > 0) await ipc.discard(repoPath, untrackedPaths, true)
      // Release locks we own only for newly created files that are being discarded
      if (currentLogin) {
        for (const f of multiUnstaged) {
          if (f.workingStatus !== '?') continue
          const lk = lockFor(f)
          if (lk && lk.owner.login === currentLogin) unlockFile(repoPath, f.path).catch(() => {})
        }
      }
    })
    setMultiPaths(new Set())
  }

  const handleMultiBulkStash = async () => {
    setMultiCtx(null)
    const stashablePaths = multiTrackedUnstagedPaths
    if (stashablePaths.length === 0) return
    const msg = await dialog.prompt({ title: 'Stash selected files', placeholder: 'Message (optional)' })
    if (msg === null) return
    await run(`Stashing ${stashablePaths.length} files…`, () =>
      ipc.stashSave(repoPath, msg || undefined, stashablePaths)
    )
    setMultiPaths(new Set())
  }

  if (files.length === 0) {
    if (isLoading) {
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#4e5870' }}>Loading changes…</span>
        </div>
      )
    }
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <span style={{ fontSize: 20, color: '#2ec573' }}>✓</span>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#2ec573' }}>Working directory clean</span>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#4e5870' }}>No changes detected</span>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        height: 38, paddingLeft: 10, paddingRight: 10,
        borderBottom: '1px solid #252d42', background: '#10131c', flexShrink: 0,
      }}>
        <ActionBtn
          label="Stage All"
          disabled={busy || unstaged.length === 0}
          onClick={() => run('Staging all…', () => ipc.stage(repoPath, unstaged.map(f => f.path)))}
        />
        <ActionBtn
          label="Discard All"
          danger
          disabled={busy || unstaged.filter(f => f.workingStatus !== '?').length === 0}
          onClick={async () => {
            const ok = await dialog.confirm({ title: 'Discard all changes', message: 'This will discard all working-tree changes. This cannot be undone.', confirmLabel: 'Discard All', danger: true })
            if (!ok) return
            // Capture newly created files locked by us before discarding
            const myLockedFiles = currentLogin
              ? unstaged.filter(f => f.workingStatus === '?' && locks.some(
                  l => l.path.replace(/\\/g, '/') === f.path.replace(/\\/g, '/') &&
                       l.owner.login === currentLogin
                ))
              : []
            run('Discarding changes…', async () => {
              await ipc.discardAll(repoPath)
              for (const file of myLockedFiles) {
                await unlockFile(repoPath, file.path).catch(() => {})
              }
            })
          }}
        />
        <ActionBtn
          label="Stash…"
          disabled={busy}
          onClick={async () => {
            const msg = await dialog.prompt({ title: 'Stash changes', placeholder: 'Message (optional)' })
            if (msg === null) return
            run('Stashing…', () => ipc.stashSave(repoPath, msg || undefined))
          }}
        />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
          <ViewToggleBtn active={!treeMode} title="Flat list" onClick={() => setTreeMode(false)}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M1 2.5h11M1 6.5h11M1 10.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </ViewToggleBtn>
          <ViewToggleBtn active={treeMode} title="Content Browser" onClick={() => setTreeMode(true)}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <rect x="0.5" y="0.5" width="4" height="3" rx="0.8" stroke="currentColor" strokeWidth="1.1" />
              <rect x="7.5" y="4.5" width="5" height="2.5" rx="0.8" stroke="currentColor" strokeWidth="1.1" />
              <rect x="7.5" y="9.5" width="5" height="2.5" rx="0.8" stroke="currentColor" strokeWidth="1.1" />
              <path d="M4.5 2H6V11H4.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 5.75h1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
              <path d="M6 10.75h1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </ViewToggleBtn>
        </div>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>

        {/* ── Content Browser (tree) mode ── */}
        {treeMode && (() => {
          const tree = buildTree(files)
          const rows = flattenTree(tree, 0, collapsedFolders)
          return rows.map((row, _i) =>
            row.type === 'folder'
              ? <FolderRow
                  key={`folder-${row.fullPath}`}
                  name={row.name} depth={row.depth} count={row.count} collapsed={row.collapsed}
                  onToggle={() => toggleFolder(row.fullPath)}
                />
              : <div key={`file-${row.file.staged ? 's' : 'u'}-${row.file.path}`}
                  style={{ paddingLeft: row.depth * 14 }}>
                  <FileRow
                    file={row.file} repoPath={repoPath}
                    selected={selectedPath === row.file.path}
                    isMultiSelected={multiPaths.has(pathKey(row.file))}
                    lock={lockFor(row.file)} currentUserName={currentUserName}
                    onSelect={(e) => handleFileClick(row.file, e)} onRefresh={onRefresh}
                    onBlameDeps={onBlameDeps}
                    onMultiContextMenu={multiPaths.size >= 2 && multiPaths.has(pathKey(row.file))
                      ? (e) => setMultiCtx({ x: e.clientX, y: e.clientY })
                      : undefined}
                  />
                </div>
          )
        })()}

        {/* ── Flat list mode ── */}
        {!treeMode && <>
          {staged.length > 0 && (
            <section>
              <SectionHeader
                label="Staged" count={staged.length}
                allChecked onToggleAll={() => run('Unstaging all…', () => ipc.unstage(repoPath, staged.map(f => f.path)))}
                color="#2ec573"
              />
              {staged.map(file => (
                <FileRow
                  key={`staged-${file.path}`}
                  file={file} repoPath={repoPath}
                  selected={selectedPath === file.path && file.staged}
                  isMultiSelected={multiPaths.has(pathKey(file))}
                  lock={lockFor(file)} currentUserName={currentUserName}
                  onSelect={(e) => handleFileClick(file, e)} onRefresh={onRefresh}
                  onBlameDeps={onBlameDeps}
                  onMultiContextMenu={multiPaths.size >= 2 && multiPaths.has(pathKey(file))
                    ? (e) => setMultiCtx({ x: e.clientX, y: e.clientY })
                    : undefined}
                />
              ))}
            </section>
          )}

          {unstaged.length > 0 && (
            <section>
              <SectionHeader
                label="Changes" count={unstaged.length}
                allChecked={false} onToggleAll={() => run('Staging all…', () => ipc.stage(repoPath, unstaged.map(f => f.path)))}
                color="#f5a832"
              />
              {unstaged.map(file => (
                <FileRow
                  key={`unstaged-${file.path}`}
                  file={file} repoPath={repoPath}
                  selected={selectedPath === file.path && !file.staged}
                  isMultiSelected={multiPaths.has(pathKey(file))}
                  lock={lockFor(file)} currentUserName={currentUserName}
                  onSelect={(e) => handleFileClick(file, e)} onRefresh={onRefresh}
                  onBlameDeps={onBlameDeps}
                  onMultiContextMenu={multiPaths.size >= 2 && multiPaths.has(pathKey(file))
                    ? (e) => setMultiCtx({ x: e.clientX, y: e.clientY })
                    : undefined}
                />
              ))}
            </section>
          )}
        </>}

      </div>

      {/* Multi-select status bar */}
      {multiPaths.size >= 2 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          height: 30, paddingLeft: 10, paddingRight: 10, flexShrink: 0,
          borderTop: '1px solid #252d42', background: '#0f1220',
        }}>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#8b94b0', flex: 1 }}>
            {multiPaths.size} files selected
          </span>
          <button
            onClick={() => setMultiPaths(new Set())}
            style={{ background: 'none', border: 'none', color: '#4e5870', fontSize: 11, cursor: 'pointer', fontFamily: "'IBM Plex Sans', system-ui", padding: '0 2px' }}
            onMouseEnter={e => (e.currentTarget.style.color = '#dde1f0')}
            onMouseLeave={e => (e.currentTarget.style.color = '#4e5870')}
          >Clear</button>
        </div>
      )}

      {/* Bulk context menu */}
      {multiCtx && (
        <div ref={multiCtxRef} style={{
          position: 'fixed', top: multiCtx.y, left: multiCtx.x, zIndex: 200,
          background: '#1d2235', border: '1px solid #2f3a54',
          borderRadius: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          padding: '4px 0', minWidth: 230,
        }}>
          <div style={{ padding: '3px 12px 5px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#3a4260', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {multiPaths.size} files selected
          </div>
          {multiUnstaged.length > 0 && (
            <BulkCtxItem
              label={`Stage ${multiUnstaged.length} file${multiUnstaged.length !== 1 ? 's' : ''}`}
              onClick={handleMultiBulkStage}
            />
          )}
          {multiStaged.length > 0 && (
            <BulkCtxItem
              label={`Unstage ${multiStaged.length} file${multiStaged.length !== 1 ? 's' : ''}`}
              onClick={handleMultiBulkUnstage}
            />
          )}
          {multiUnstaged.length > 0 && <BulkCtxSep />}
          {multiUnstaged.length > 0 && (
            <BulkCtxItem
              label={`Discard ${multiUnstaged.length} file${multiUnstaged.length !== 1 ? 's' : ''}…`}
              onClick={handleMultiBulkDiscard}
              danger
            />
          )}
          {multiTrackedUnstagedPaths.length > 0 && (
            <BulkCtxItem
              label={`Stash ${multiTrackedUnstagedPaths.length} file${multiTrackedUnstagedPaths.length !== 1 ? 's' : ''}…`}
              onClick={handleMultiBulkStash}
            />
          )}
        </div>
      )}
    </div>
  )
}

function BulkCtxItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', textAlign: 'left', padding: '5px 12px',
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12,
        background: 'transparent', border: 'none',
        color: danger ? '#e84545' : '#dde1f0',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = '#242a3d' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >{label}</button>
  )
}

function BulkCtxSep() {
  return <div style={{ margin: '4px 0', borderTop: '1px solid #252d42' }} />
}

function ViewToggleBtn({ active, title, onClick, children }: {
  active: boolean; title: string; onClick: () => void; children: React.ReactNode
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 26, height: 26, borderRadius: 4, border: 'none', padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: active ? '#242a3d' : hover ? '#1a2030' : 'transparent',
        color: active ? '#e8622f' : hover ? '#8b94b0' : '#4e5870',
        cursor: 'pointer', transition: 'all 0.1s',
      }}
    >{children}</button>
  )
}

function ActionBtn({ label, onClick, disabled, danger }: {
  label: string; onClick: () => void; disabled?: boolean; danger?: boolean
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 24, paddingLeft: 8, paddingRight: 8, borderRadius: 4,
        border: `1px solid ${danger
          ? (hover ? '#e84545' : 'rgba(232,69,69,0.4)')
          : (hover ? '#2f3a54' : '#252d42')}`,
        background: danger && hover ? 'rgba(232,69,69,0.1)' : hover ? '#242a3d' : 'transparent',
        color: danger
          ? (hover ? '#e84545' : 'rgba(232,69,69,0.7)')
          : hover ? '#dde1f0' : '#8b94b0',
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.12s ease',
      }}
    >{label}</button>
  )
}
