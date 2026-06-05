import React, { useState, useEffect, useMemo, useRef, useLayoutEffect, useCallback } from 'react'
import { ipc, Lock, BlameEntry } from '@/ipc'
import { useLockStore } from '@/stores/lockStore'
import { useAuthStore } from '@/stores/authStore'
import { useOperationStore } from '@/stores/operationStore'
import { useStatusToastStore } from '@/stores/statusToastStore'
import { FileDetailsSidePanel } from '@/components/shared/FileDetailsSidePanel'
import { FilePathText } from '@/components/ui/FilePathText'

// ── Constants ─────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 26
const OVERSCAN   = 12

// ── Tree types ────────────────────────────────────────────────────────────────

interface FolderNode {
  name: string
  fullPath: string
  children: FolderNode[]
  files: string[]
}

type FlatRow =
  | { type: 'folder'; name: string; depth: number; fullPath: string; count: number; collapsed: boolean }
  | { type: 'file'; path: string; depth: number }

function buildTree(paths: string[]): FolderNode {
  const root: FolderNode = { name: '', fullPath: '', children: [], files: [] }
  for (const filePath of paths) {
    const parts = filePath.replace(/\\/g, '/').split('/')
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
    node.files.push(filePath)
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
    rows.push({ type: 'file', path: file, depth })
  }
  return rows
}

// ── Icons ─────────────────────────────────────────────────────────────────────

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

function fileColor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (['uasset', 'umap', 'udk', 'ubulk', 'upk', 'uexp', 'ucas'].includes(ext)) return '#a78bfa'
  if (['png', 'jpg', 'jpeg', 'tga', 'bmp', 'psd', 'tiff', 'gif'].includes(ext))  return '#34d399'
  if (['wav', 'mp3', 'ogg', 'flac', 'wem', 'aiff'].includes(ext))                 return '#f59e0b'
  if (['fbx', 'obj', 'dae'].includes(ext))                                         return '#60a5fa'
  if (['ts', 'tsx', 'js', 'jsx'].includes(ext))                                    return '#38bdf8'
  if (['cs', 'cpp', 'c', 'h', 'hpp', 'cc'].includes(ext))                         return '#818cf8'
  if (['json', 'yaml', 'yml', 'toml', 'ini', 'cfg'].includes(ext))                return '#fb923c'
  if (['md', 'txt'].includes(ext))                                                  return '#94a3b8'
  if (['pak', 'zip', '7z', 'rar', 'tar', 'gz'].includes(ext))                     return '#f87171'
  return '#4e5870'
}

function FileIcon({ filePath }: { filePath: string }) {
  const color = fileColor(filePath)
  return (
    <svg width="11" height="13" viewBox="0 0 11 13" fill="none" style={{ flexShrink: 0 }}>
      <path d="M1.5 0.5h5.5l3 3v9H1.5V0.5z" fill={`${color}18`} stroke={color} strokeWidth="0.9" strokeLinejoin="round" />
      <path d="M7 0.5V3.5h3" stroke={color} strokeWidth="0.9" strokeLinejoin="round" />
    </svg>
  )
}

function LockBadge() {
  return (
    <svg width="10" height="11" viewBox="0 0 10 11" fill="none" style={{ flexShrink: 0 }}>
      <rect x="1.5" y="5" width="7" height="5.5" rx="1" stroke="#f59e0b" strokeWidth="1" />
      <path d="M3 5V3.5a2 2 0 1 1 4 0V5" stroke="#f59e0b" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

// ── Context menu ──────────────────────────────────────────────────────────────

interface MenuState { x: number; y: number; filePath: string }

function ContextMenu({ menu, repoPath, locks, currentUserName, onClose, onNavigate }: {
  menu: MenuState
  repoPath: string
  locks: Lock[]
  currentUserName: string | null
  onClose: () => void
  onNavigate: (tab: string) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const { lockFile, unlockFile } = useLockStore()

  const normPath = menu.filePath.replace(/\\/g, '/')
  const lock = locks.find(l => l.path.replace(/\\/g, '/') === normPath)
  const isLockedByMe    = lock && lock.owner.login === currentUserName
  const isLockedByOther = lock && !isLockedByMe

  // Clamp to viewport
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const { right, bottom } = el.getBoundingClientRect()
    if (right  > window.innerWidth)  el.style.left = `${menu.x - el.offsetWidth}px`
    if (bottom > window.innerHeight) el.style.top  = `${menu.y - el.offsetHeight}px`
  }, [menu.x, menu.y])

  // Dismiss on outside click or Escape
  useEffect(() => {
    const onDown  = (e: MouseEvent)    => { if (!menuRef.current?.contains(e.target as Node)) onClose() }
    const onKey   = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown',   onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const fullPath = [repoPath, normPath].join('/').replace(/\//g, '\\')

  const act = (fn: () => void) => { fn(); onClose() }

  const items: ({ label: string; icon?: React.ReactNode; danger?: boolean; disabled?: boolean; action: () => void } | null)[] = [
    {
      label: 'Open File',
      icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="1" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1"/><path d="M4.5 6.5h4M7 4.5l2 2-2 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>,
      action: () => act(() => ipc.openPath(fullPath)),
    },
    {
      label: 'Show in Explorer',
      icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M1.5 2.5h4l1 1.5h5v7h-10V2.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>,
      action: () => act(() => ipc.showInFolder(fullPath)),
    },
    {
      label: 'Copy Path',
      icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.1"/><path d="M3 9H2a.5.5 0 0 1-.5-.5v-7A.5.5 0 0 1 2 1h7a.5.5 0 0 1 .5.5V3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>,
      action: () => act(() => navigator.clipboard.writeText(menu.filePath)),
    },
    null,
    {
      label: 'View History',
      icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.1"/><path d="M6.5 4V6.5l2 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>,
      action: () => act(() => onNavigate('history')),
    },
    null,
    isLockedByOther
      ? { label: `Locked by ${lock!.owner.name}`, disabled: true, action: () => {} }
      : isLockedByMe
        ? {
            label: 'Unlock File',
            icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="2" y="6" width="9" height="6" rx="1" stroke="#f59e0b" strokeWidth="1.1"/><path d="M4.5 6V4.5a2 2 0 0 1 4 0" stroke="#f59e0b" strokeWidth="1.1" strokeLinecap="round"/><path d="M9.5 3.5l2-2M8.5 2.5l2-2" stroke="#f59e0b" strokeWidth="1" strokeLinecap="round"/></svg>,
            action: () => act(() => unlockFile(repoPath, menu.filePath).catch(e => alert(String(e)))),
          }
        : {
            label: 'Lock File',
            icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="2" y="6" width="9" height="6" rx="1" stroke="currentColor" strokeWidth="1.1"/><path d="M4.5 6V4.5a2 2 0 0 1 4 0V6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>,
            action: () => act(() => lockFile(repoPath, menu.filePath).catch(e => alert(String(e)))),
          },
    null,
    {
      label: 'Add to .gitignore',
      icon: <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.1"/><path d="M4 6.5h5M6.5 4v5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>,
      action: () => act(() => ipc.addToGitignore(repoPath, menu.filePath).catch(e => alert(String(e)))),
    },
  ]

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed', left: menu.x, top: menu.y, zIndex: 9999,
        background: '#151921', border: '1px solid #2f3a54', borderRadius: 6,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)', padding: '3px 0', minWidth: 180,
      }}
    >
      {items.map((item, i) =>
        item === null
          ? <div key={`sep-${i}`} style={{ height: 1, background: '#252d42', margin: '3px 0' }} />
          : <button
              key={item.label}
              onClick={item.action}
              disabled={item.disabled}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', height: 30, paddingLeft: 10, paddingRight: 12,
                background: 'transparent', border: 'none', textAlign: 'left',
                color: item.disabled ? '#4e5870' : item.danger ? '#e84545' : '#c4cad8',
                fontFamily: 'var(--lg-font-ui)', fontSize: 12,
                cursor: item.disabled ? 'default' : 'pointer',
              }}
              onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = '#1e2a40' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{ color: item.disabled ? '#4e5870' : '#4e5870', flexShrink: 0, display: 'flex', width: 14, justifyContent: 'center' }}>
                {item.icon}
              </span>
              {item.label}
            </button>
      )}
    </div>
  )
}

// ── Row components ────────────────────────────────────────────────────────────

function FolderRow({ name, depth, count, collapsed, onToggle, onContextMenu }: {
  name: string; depth: number; count: number; collapsed: boolean; onToggle: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onToggle}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        height: ROW_HEIGHT, paddingLeft: 10 + depth * 14, paddingRight: 10,
        background: hover ? '#181d2e' : 'transparent',
        borderBottom: '1px solid #11141f',
        cursor: 'pointer', userSelect: 'none', boxSizing: 'border-box',
      }}
    >
      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{
        transition: 'transform 0.1s', transform: collapsed ? 'rotate(-90deg)' : 'none', flexShrink: 0,
      }}>
        <path d="M1 2.5L4 5.5L7 2.5" stroke="#4e5870" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <FolderIcon open={!collapsed} />
      <span style={{
        fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#c4cad8',
        flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{name}</span>
      <span style={{
        fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870',
        background: '#1a2030', borderRadius: 8, padding: '1px 5px', flexShrink: 0,
      }}>{count}</span>
    </div>
  )
}

function FileRow({ filePath, depth, locked, selected, onSelect, onContextMenu }: {
  filePath: string; depth: number; locked: boolean; selected: boolean; onSelect: () => void; onContextMenu: (e: React.MouseEvent) => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        height: ROW_HEIGHT, paddingLeft: 10 + depth * 14, paddingRight: 10,
        background: selected ? '#1e2539' : hover ? '#181d2e' : 'transparent',
        borderLeft: `2px solid ${selected ? '#e8622f' : 'transparent'}`,
        borderBottom: '1px solid #11141f',
        cursor: 'pointer', boxSizing: 'border-box',
      }}
    >
      <FileIcon filePath={filePath} />
      <FilePathText path={filePath} style={{
        fontFamily: 'var(--lg-font-ui)', fontSize: 12,
        color: selected || hover ? '#dde1f0' : '#8b94b0',
        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }} />
      {locked && <LockBadge />}
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

interface ContentBrowserPanelProps {
  repoPath: string
  onNavigate: (tab: string) => void
}

export function ContentBrowserPanel({ repoPath, onNavigate }: ContentBrowserPanelProps) {
  const [files,    setFiles]    = useState<string[] | null>(null)
  const [search,   setSearch]   = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [blame, setBlame] = useState<BlameEntry[]>([])
  const [blameLoading, setBlameLoading] = useState(false)

  const { locks }           = useLockStore()
  const { accounts, currentAccountId } = useAuthStore()
  const currentUserName     = accounts.find(a => a.userId === currentAccountId)?.login ?? null

  useEffect(() => {
    setFiles(null)
    setSelectedFile(null)
    setBlame([])
    ipc.gitLsFiles(repoPath).then(setFiles).catch(() => setFiles([]))
  }, [repoPath])

  useEffect(() => {
    if (!selectedFile) {
      setBlame([])
      setBlameLoading(false)
      return
    }

    let cancelled = false
    setBlame([])
    setBlameLoading(true)
    ipc.gitBlame(repoPath, selectedFile, 'HEAD')
      .then(entries => { if (!cancelled) setBlame(entries) })
      .catch(() => { if (!cancelled) setBlame([]) })
      .finally(() => { if (!cancelled) setBlameLoading(false) })

    return () => { cancelled = true }
  }, [repoPath, selectedFile])

  const filtered = useMemo(() => {
    if (!files) return []
    if (!search.trim()) return files
    const q = search.toLowerCase()
    return files.filter(f => f.toLowerCase().includes(q))
  }, [files, search])

  const tree = useMemo(() => buildTree(filtered), [filtered])

  const toggleFolder = useCallback((fullPath: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(fullPath)) next.delete(fullPath); else next.add(fullPath)
      return next
    })
  }, [])

  const collapseAll = useCallback(() => {
    const all = new Set<string>()
    const collect = (node: FolderNode) => node.children.forEach(c => { all.add(c.fullPath); collect(c) })
    collect(tree)
    setCollapsed(all)
  }, [tree])

  const expandAll = useCallback(() => setCollapsed(new Set()), [])

  const rowsWithToggle = useMemo<(FlatRow & { onToggle?: () => void })[]>(() =>
    flattenTree(tree, 0, collapsed).map(r =>
      r.type === 'folder' ? { ...r, onToggle: () => toggleFolder(r.fullPath) } : r
    ),
    [tree, collapsed, toggleFolder]
  )

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', background: '#0b0d13' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        height: 40, paddingLeft: 12, paddingRight: 10,
        borderBottom: '1px solid #252d42', background: '#10131c', flexShrink: 0,
      }}>
        <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 13, fontWeight: 600, color: '#dde1f0' }}>
          Content Browser
        </span>
        {files && (
          <span style={{
            fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870',
            background: '#1a2030', borderRadius: 8, padding: '1px 6px',
          }}>{files.length.toLocaleString()}</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <TinyBtn title="Collapse all" onClick={collapseAll}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 4.5L6.5 9L11 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 2h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </TinyBtn>
          <TinyBtn title="Expand all" onClick={expandAll}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 8.5L6.5 4L11 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2 11h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </TinyBtn>
          <TinyBtn title="Refresh" onClick={() => { setFiles(null); ipc.gitLsFiles(repoPath).then(setFiles).catch(() => setFiles([])) }}>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 6.5A4.5 4.5 0 1 1 6.5 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M2 4v2.5h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </TinyBtn>
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #252d42', background: '#10131c', flexShrink: 0 }}>
        <div style={{ position: 'relative' }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{
            position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none',
          }}>
            <circle cx="5" cy="5" r="3.5" stroke="#4e5870" strokeWidth="1.2" />
            <path d="M8 8L10.5 10.5" stroke="#4e5870" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter files…"
            style={{
              width: '100%', height: 26, paddingLeft: 26, paddingRight: search ? 26 : 8,
              background: '#1a2030', border: '1px solid #252d42', borderRadius: 4,
              color: '#dde1f0', fontFamily: 'var(--lg-font-ui)', fontSize: 12,
              outline: 'none', boxSizing: 'border-box',
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', color: '#4e5870', cursor: 'pointer',
                display: 'flex', alignItems: 'center', padding: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Virtual file tree */}
      {files === null ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#4e5870' }}>Loading…</span>
        </div>
      ) : rowsWithToggle.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 13, color: '#4e5870' }}>No files found</span>
        </div>
      ) : (
        <VirtualListInner
          rows={rowsWithToggle}
          repoPath={repoPath}
          locks={locks}
          currentUserName={currentUserName}
          onNavigate={onNavigate}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
        />
      )}
      </div>
      <div style={{
        width: 360, flexShrink: 0,
        borderLeft: '1px solid #252d42',
        background: '#0d0f15',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <FileDetailsSidePanel
          repoPath={repoPath}
          filePath={selectedFile}
          hash="HEAD"
          blame={blame}
          blameLoading={blameLoading}
          mode="details"
          emptyMessage="Select a file for details"
        />
      </div>
    </div>
  )
}

// ── VirtualListInner (separated so the ref/scroll state is scoped) ────────────

type RowWithToggle = FlatRow & { onToggle?: () => void }

function VirtualListInner({ rows, repoPath, locks, currentUserName, onNavigate, selectedFile, onSelectFile }: {
  rows: RowWithToggle[]
  repoPath: string
  locks: Lock[]
  currentUserName: string | null
  onNavigate: (tab: string) => void
  selectedFile: string | null
  onSelectFile: (filePath: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop,   setScrollTop]   = useState(0)
  const [containerH,  setContainerH]  = useState(600)
  const [menu,        setMenu]        = useState<MenuState | null>(null)
  const [folderMenu,  setFolderMenu]  = useState<{ x: number; y: number; folderPath: string; name: string } | null>(null)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    setContainerH(el.clientHeight)
    const ro = new ResizeObserver(() => setContainerH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const normLockPaths = useMemo(
    () => new Set(locks.map(l => l.path.replace(/\\/g, '/'))),
    [locks]
  )

  const openMenu = useCallback((e: React.MouseEvent, filePath: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, filePath })
  }, [])

  const openFolderMenu = useCallback((e: React.MouseEvent, folderPath: string, name: string) => {
    e.preventDefault()
    e.stopPropagation()
    setFolderMenu({ x: e.clientX, y: e.clientY, folderPath, name })
  }, [])

  const totalHeight = rows.length * ROW_HEIGHT
  const startIdx    = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const endIdx      = Math.min(rows.length - 1, Math.ceil((scrollTop + containerH) / ROW_HEIGHT) + OVERSCAN)
  const visible     = rows.slice(startIdx, endIdx + 1)

  return (
    <div
      ref={containerRef}
      onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
      style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: startIdx * ROW_HEIGHT, left: 0, right: 0 }}>
          {visible.map(row => {
            if (row.type === 'folder') {
              return (
                <FolderRow
                  key={`folder:${row.fullPath}`}
                  name={row.name} depth={row.depth} count={row.count} collapsed={row.collapsed}
                  onToggle={row.onToggle!}
                  onContextMenu={e => openFolderMenu(e, row.fullPath, row.name)}
                />
              )
            }
            return (
              <FileRow
                key={`file:${row.path}`}
                filePath={row.path} depth={row.depth}
                locked={normLockPaths.has(row.path.replace(/\\/g, '/'))}
                selected={selectedFile === row.path}
                onSelect={() => onSelectFile(row.path)}
                onContextMenu={e => openMenu(e, row.path)}
              />
            )
          })}
        </div>
      </div>

      {menu && (
        <ContextMenu
          menu={menu} repoPath={repoPath}
          locks={locks} currentUserName={currentUserName}
          onClose={() => setMenu(null)} onNavigate={onNavigate}
        />
      )}

      {folderMenu && (
        <FolderContextMenu
          menu={folderMenu} repoPath={repoPath}
          onClose={() => setFolderMenu(null)}
        />
      )}
    </div>
  )
}

// ── Folder context menu — bulk lock / unlock ──────────────────────────────────

function FolderContextMenu({ menu, repoPath, onClose }: {
  menu: { x: number; y: number; folderPath: string; name: string }
  repoPath: string
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const opRun     = useOperationStore(s => s.run)
  const showToast = useStatusToastStore(s => s.show)

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const { right, bottom } = el.getBoundingClientRect()
    if (right  > window.innerWidth)  el.style.left = `${menu.x - el.offsetWidth}px`
    if (bottom > window.innerHeight) el.style.top  = `${menu.y - el.offsetHeight}px`
  }, [menu.x, menu.y])

  useEffect(() => {
    const onDown = (e: MouseEvent)    => { if (!menuRef.current?.contains(e.target as Node)) onClose() }
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown',   onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const doLock = () => {
    onClose()
    opRun('Locking folder…', async () => {
      const r = await ipc.lockFolder(repoPath, menu.folderPath)
      const parts = [`${r.locked} locked`]
      if (r.skipped) parts.push(`${r.skipped} already locked`)
      if (r.failed)  parts.push(`${r.failed} failed`)
      showToast(`${menu.name}: ${parts.join(' · ')}`)
    }).catch(e => showToast(`Lock folder failed: ${String(e)}`))
  }

  const doUnlock = () => {
    onClose()
    opRun('Unlocking folder…', async () => {
      const r = await ipc.unlockFolderMine(repoPath, menu.folderPath)
      const parts = [`${r.unlocked} unlocked`]
      if (r.failed) parts.push(`${r.failed} failed`)
      showToast(`${menu.name}: ${parts.join(' · ')}`)
    }).catch(e => showToast(`Unlock folder failed: ${String(e)}`))
  }

  const items = [
    { label: 'Lock all files in folder',  danger: false, action: doLock },
    { label: 'Unlock my files in folder', danger: false, action: doUnlock },
  ]

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed', left: menu.x, top: menu.y, zIndex: 9999,
        background: '#151921', border: '1px solid #2f3a54', borderRadius: 6,
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)', padding: '3px 0', minWidth: 200,
      }}
    >
      <div style={{
        padding: '6px 12px 5px', fontFamily: 'var(--lg-font-mono)', fontSize: 10,
        color: '#4e5870', borderBottom: '1px solid #252d42', marginBottom: 3,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {menu.folderPath} — LFS files only
      </div>
      {items.map(item => (
        <button
          key={item.label}
          onClick={item.action}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            width: '100%', height: 30, paddingLeft: 10, paddingRight: 12,
            background: 'transparent', border: 'none', textAlign: 'left',
            color: '#c4cad8', fontFamily: 'var(--lg-font-ui)', fontSize: 12, cursor: 'pointer',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#1e2a40' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <LockMenuIcon />
          {item.label}
        </button>
      ))}
    </div>
  )
}

function LockMenuIcon() {
  return (
    <span style={{ color: '#4e5870', flexShrink: 0, display: 'flex', width: 14, justifyContent: 'center' }}>
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
        <rect x="2" y="6" width="9" height="6" rx="1" stroke="currentColor" strokeWidth="1.1" />
        <path d="M4.5 6V4.5a2 2 0 0 1 4 0V6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    </span>
  )
}

// ── Tiny toolbar button ───────────────────────────────────────────────────────

function TinyBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      className="lg-compact-icon-button"
      onClick={onClick} title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 26, height: 26, borderRadius: 4, border: 'none', padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hover ? '#1a2030' : 'transparent',
        color: hover ? '#8b94b0' : '#4e5870',
        cursor: 'pointer', transition: 'all 0.1s',
      }}
    >{children}</button>
  )
}
