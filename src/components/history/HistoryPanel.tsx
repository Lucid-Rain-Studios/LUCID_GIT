import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ipc, CommitEntry, CommitFileChange, BranchInfo, BlameEntry, StashEntry } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useRepoStore } from '@/stores/repoStore'
import { computeGraph, GraphNode, LANE_W, ROW_H, DOT_R, LineSegment } from './graphLayout'

function parseGitHubSlug(url: string): string | null {
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return m ? m[1] : null
}

interface HistoryPanelProps {
  repoPath: string
}

function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60)     return 'just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

function authorColor(author: string): string {
  const palette = ['#4d9dff', '#a27ef0', '#2ec573', '#f5a832', '#e8622f', '#1abc9c', '#e91e63']
  let h = 0
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function initials(author: string): string {
  const parts = author.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return author.slice(0, 2).toUpperCase()
}

// ── Graph cell ─────────────────────────────────────────────────────────────────

const GRAPH_COL_W = 96

function linePath(seg: LineSegment, isTop: boolean): string {
  const x1 = seg.from * LANE_W + LANE_W / 2
  const x2 = seg.to   * LANE_W + LANE_W / 2
  const y1 = isTop ? 0        : ROW_H / 2
  const y2 = isTop ? ROW_H / 2 : ROW_H
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  return `M ${x1} ${y1} C ${x1} ${y2} ${x2} ${y1} ${x2} ${y2}`
}

function GraphCell({ node }: { node: GraphNode }) {
  const cx = node.lane * LANE_W + LANE_W / 2
  const cy = ROW_H / 2
  return (
    <svg width={GRAPH_COL_W} height={ROW_H} style={{ flexShrink: 0, overflow: 'visible' }}>
      {node.topLines.map((seg, i) => (
        <path key={`t${i}`} d={linePath(seg, true)} stroke={seg.color} strokeWidth={1.75} fill="none" strokeOpacity={0.7} />
      ))}
      {node.bottomLines.map((seg, i) => (
        <path key={`b${i}`} d={linePath(seg, false)} stroke={seg.color} strokeWidth={1.75} fill="none" strokeOpacity={0.7} />
      ))}
      <circle cx={cx} cy={cy} r={DOT_R} fill={node.color} />
    </svg>
  )
}

// ── Context menu helpers ────────────────────────────────────────────────────────

function CtxItem({ label, onClick, disabled, danger, title }: {
  label: string; onClick?: () => void; disabled?: boolean; danger?: boolean; title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: '100%', textAlign: 'left', padding: '5px 12px',
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12,
        background: 'transparent', border: 'none',
        color: disabled ? '#4e5870' : danger ? '#e84545' : '#dde1f0',
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', gap: 6,
        opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = '#242a3d' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  )
}

function CtxSep() {
  return <div style={{ margin: '4px 0', borderTop: '1px solid #252d42' }} />
}

// ── Commit row ─────────────────────────────────────────────────────────────────

function CommitRow({ node, selected, repoPath, remoteUrl, onRefresh, onClick }: {
  node: GraphNode
  selected: boolean
  repoPath: string
  remoteUrl: string | null
  onRefresh: () => void
  onClick: () => void
}) {
  const { commit } = node
  const [hover, setHover] = useState(false)
  const [ctx, setCtx]     = useState<{ x: number; y: number } | null>(null)
  const ctxRef  = useRef<HTMLDivElement>(null)
  const dialog  = useDialogStore()
  const opRun   = useOperationStore(s => s.run)
  const bumpSyncTick = useRepoStore(s => s.bumpSyncTick)
  const col     = authorColor(commit.author)
  const ini     = initials(commit.author)
  const isMerge = commit.parentHashes.length > 1
  const ghSlug  = remoteUrl ? parseGitHubSlug(remoteUrl) : null
  const shortHash = commit.hash.slice(0, 7)

  useEffect(() => {
    if (!ctx) return
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtx(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctx])

  const close = () => setCtx(null)

  const handleResetTo = async () => {
    close()
    const mode = await dialog.prompt({
      title: `Reset to ${shortHash}`,
      message: 'soft — keep changes staged\nmixed — keep changes unstaged\nhard — discard all changes',
      placeholder: 'soft / mixed / hard',
      defaultValue: 'mixed',
      confirmLabel: 'Reset',
    })
    if (!mode) return
    const m = mode.trim().toLowerCase()
    if (m !== 'soft' && m !== 'mixed' && m !== 'hard') {
      await dialog.alert({ title: 'Invalid mode', message: `"${mode}" is not valid. Enter soft, mixed, or hard.` })
      return
    }
    try {
      await opRun(`Resetting to ${shortHash} (${m})…`, () => ipc.gitResetTo(repoPath, commit.hash, m as 'soft' | 'mixed' | 'hard'))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Reset failed', message: String(e) }) }
  }

  const handleCheckout = async () => {
    close()
    const ok = await dialog.confirm({
      title: 'Checkout commit',
      message: `Checkout ${shortHash}?`,
      detail: 'This creates a detached HEAD state. Create a branch if you want to keep changes from here.',
      confirmLabel: 'Checkout',
    })
    if (!ok) return
    try {
      await opRun('Checking out commit…', () => ipc.checkout(repoPath, commit.hash))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Checkout failed', message: String(e) }) }
  }

  const handleRevert = async () => {
    close()
    const ok = await dialog.confirm({
      title: 'Revert commit',
      message: `Create a new commit that undoes ${shortHash}?`,
      detail: commit.message,
      confirmLabel: 'Revert',
    })
    if (!ok) return
    try {
      await opRun('Reverting commit…', () => ipc.gitRevert(repoPath, commit.hash, false))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Revert failed', message: String(e) }) }
  }

  const handleCreateBranch = async () => {
    close()
    const name = await dialog.prompt({
      title: 'Create branch from commit',
      message: `New branch starting at ${shortHash}`,
      placeholder: 'branch-name',
      confirmLabel: 'Create',
    })
    if (!name?.trim()) return
    try {
      await opRun('Creating branch…', () => ipc.createBranch(repoPath, name.trim(), commit.hash))
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Failed to create branch', message: String(e) }) }
  }

  const handleCherryPick = async () => {
    close()
    const ok = await dialog.confirm({
      title: 'Cherry-pick commit',
      message: `Apply changes from ${shortHash} onto the current branch?`,
      detail: commit.message,
      confirmLabel: 'Cherry-pick',
    })
    if (!ok) return
    try {
      await opRun('Cherry-picking…', () => ipc.gitCherryPick(repoPath, commit.hash))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Cherry-pick failed', message: String(e) }) }
  }

  const handleUndoCommit = async () => {
    close()
    if (commit.parentHashes.length === 0) {
      await dialog.alert({ title: 'Cannot undo', message: 'This is the initial commit and has no parent to reset to.' })
      return
    }
    const ok = await dialog.confirm({
      title: 'Undo commit',
      message: `Undo "${commit.message.slice(0, 60)}"?`,
      detail: `This will soft-reset HEAD to the parent commit (${commit.parentHashes[0].slice(0, 7)}), keeping all changes staged. Only use this on the topmost commit.`,
      confirmLabel: 'Undo commit',
    })
    if (!ok) return
    try {
      await opRun('Undoing commit…', () => ipc.gitResetTo(repoPath, commit.parentHashes[0], 'soft'))
      bumpSyncTick()
      onRefresh()
    } catch (e) { await dialog.alert({ title: 'Undo failed', message: String(e) }) }
  }

  const handleCopySHA = () => { close(); navigator.clipboard.writeText(commit.hash) }

  const handleViewOnGitHub = () => {
    close()
    if (ghSlug) ipc.openExternal(`https://github.com/${ghSlug}/commit/${commit.hash}`)
  }

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={onClick}
        onContextMenu={e => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }) }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', height: ROW_H,
          background: selected ? '#242a3d' : hover ? '#1e2436' : 'transparent',
          borderLeft: `2px solid ${selected ? '#e8622f' : 'transparent'}`,
          borderBottom: '1px solid #252d42',
          cursor: 'pointer', transition: 'background 0.1s',
        }}
      >
        {/* Graph */}
        <div style={{ width: GRAPH_COL_W, height: ROW_H, flexShrink: 0, overflow: 'hidden' }}>
          <GraphCell node={node} />
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 6, paddingRight: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13,
              fontWeight: selected ? 600 : 400, color: '#dde1f0',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>{commit.message}</span>
            {isMerge && (
              <span style={{
                background: 'rgba(162,126,240,0.15)', color: '#a27ef0',
                border: '1px solid rgba(162,126,240,0.3)',
                borderRadius: 4, paddingLeft: 5, paddingRight: 5,
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600, flexShrink: 0,
              }}>MERGE</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
              background: `linear-gradient(135deg, ${col}88, ${col}44)`,
              border: `1px solid ${col}55`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: "'JetBrains Mono', monospace", fontSize: 8, fontWeight: 700, color: col,
            }}>{ini}</span>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#8b94b0' }}>
              {commit.author}
            </span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870' }}>
              {timeAgo(commit.timestamp)}
            </span>
          </div>
        </div>

        {/* Hash */}
        <span style={{
          flexShrink: 0, paddingRight: 12,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870',
        }}>{shortHash}</span>
      </div>

      {/* Context menu */}
      {ctx && (
        <div
          ref={ctxRef}
          style={{
            position: 'fixed', top: ctx.y, left: ctx.x, zIndex: 50,
            background: '#1d2235', border: '1px solid #2f3a54',
            borderRadius: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
            padding: '4px 0', minWidth: 230,
          }}
        >
          <CtxItem label="Undo commit (soft reset)"      onClick={handleUndoCommit} />
          <CtxItem label="Reset to commit…"            onClick={handleResetTo}    danger />
          <CtxItem label="Checkout commit"             onClick={handleCheckout} />
          <CtxSep />
          <CtxItem label="Revert changes in commit"    onClick={handleRevert} />
          <CtxItem label="Create branch from commit…"  onClick={handleCreateBranch} />
          <CtxItem label="Cherry-pick commit…"         onClick={handleCherryPick} />
          <CtxSep />
          <CtxItem label="Copy SHA"                    onClick={handleCopySHA} />
          <CtxItem
            label="View on GitHub"
            onClick={ghSlug ? handleViewOnGitHub : undefined}
            disabled={!ghSlug}
            title={ghSlug ? undefined : 'No GitHub remote detected'}
          />
        </div>
      )}
    </div>
  )
}

// ── Status colors ──────────────────────────────────────────────────────────────

const FILE_STATUS_COLOR: Record<string, string> = {
  M: '#f5a832', A: '#2ec573', D: '#e84545', R: '#4d9dff', C: '#4d9dff',
}
const FILE_STATUS_BG: Record<string, string> = {
  M: 'rgba(245,168,50,0.15)', A: 'rgba(46,197,115,0.15)', D: 'rgba(232,69,69,0.15)',
  R: 'rgba(77,157,255,0.15)', C: 'rgba(77,157,255,0.15)',
}

// ── Blame modal ────────────────────────────────────────────────────────────────

function BlameModal({ file, commitHash, repoPath, onClose }: {
  file: CommitFileChange
  commitHash: string
  repoPath: string
  onClose: () => void
}) {
  const [lines,   setLines]   = useState<BlameEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    ipc.gitBlame(repoPath, file.path, commitHash)
      .then(entries => { setLines(entries); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [repoPath, file.path, commitHash])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: 'min(920px, 92vw)', height: 'min(700px, 88vh)',
        background: '#161a27', border: '1px solid #2f3a54',
        borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          height: 44, paddingLeft: 16, paddingRight: 12, flexShrink: 0,
          borderBottom: '1px solid #252d42', background: '#10131c',
        }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#8b94b0' }}>
            blame: {file.path}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#4e5870', fontSize: 20, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#dde1f0')}
            onMouseLeave={e => (e.currentTarget.style.color = '#4e5870')}
          >×</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
          {loading ? (
            <p style={{ padding: '16px', color: '#4e5870' }}>Loading blame…</p>
          ) : error ? (
            <p style={{ padding: '16px', color: '#e84545' }}>{error}</p>
          ) : lines.length === 0 ? (
            <p style={{ padding: '16px', color: '#4e5870' }}>No blame data available</p>
          ) : lines.map((entry, i) => {
            const prev = lines[i - 1]
            const sameBlock = !!prev && prev.hash === entry.hash
            const col = authorColor(entry.author)
            const shortHash = entry.hash.slice(0, 7)
            return (
              <div key={i} style={{
                display: 'flex', minHeight: 22,
                borderBottom: '1px solid #0d0f1560',
                background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)',
              }}>
                {/* Blame annotation */}
                <div style={{
                  width: 210, flexShrink: 0, paddingLeft: 10, paddingRight: 8,
                  display: 'flex', alignItems: 'center', gap: 6,
                  borderRight: `2px solid ${sameBlock ? '#1e2436' : col + '55'}`,
                  background: sameBlock ? 'transparent' : col + '0c',
                  opacity: sameBlock ? 0.35 : 1,
                }}>
                  <span style={{ color: col, fontSize: 10, flexShrink: 0 }}>{sameBlock ? '' : shortHash}</span>
                  {!sameBlock && <>
                    <span style={{ color: '#8b94b0', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {entry.author}
                    </span>
                    <span style={{ color: '#4e5870', fontSize: 9, flexShrink: 0 }}>
                      {new Date(entry.timestamp).toLocaleDateString()}
                    </span>
                  </>}
                </div>
                {/* Line number */}
                <div style={{ width: 42, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8, color: '#3a4260', fontSize: 11, borderRight: '1px solid #1e2436' }}>
                  {entry.lineNo}
                </div>
                {/* Line content */}
                <div style={{ flex: 1, paddingLeft: 10, paddingRight: 10, color: '#dde1f0', display: 'flex', alignItems: 'center', whiteSpace: 'pre', overflow: 'hidden' }}>
                  {entry.line}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Commit detail ─────────────────────────────────────────────────────────────

function CommitDetail({ commit, files, filesLoading, repoPath, remoteUrl }: {
  commit: CommitEntry
  files: CommitFileChange[]
  filesLoading: boolean
  repoPath: string
  remoteUrl: string | null
}) {
  const fullDate = new Date(commit.timestamp).toLocaleString()
  const col = authorColor(commit.author)
  const ini = initials(commit.author)
  const ghSlug = remoteUrl ? parseGitHubSlug(remoteUrl) : null

  const [ctxMenu, setCtxMenu] = useState<{ file: CommitFileChange; x: number; y: number } | null>(null)
  const [blameTarget, setBlameTarget] = useState<CommitFileChange | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtxMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  const absPath = (f: CommitFileChange) =>
    repoPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + f.path

  const closeCtx = () => setCtxMenu(null)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '14px 18px', borderBottom: '1px solid #252d42', background: '#161a27', flexShrink: 0 }}>
        <div style={{ marginBottom: 8 }}>
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870',
            background: '#242a3d', borderRadius: 4, padding: '2px 8px',
            letterSpacing: '0.05em',
          }}>{commit.hash}</span>
        </div>
        <p style={{
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 15, fontWeight: 600,
          color: '#dde1f0', margin: '0 0 10px', lineHeight: 1.4,
        }}>{commit.message}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
            background: `linear-gradient(135deg, ${col}88, ${col}44)`,
            border: `1px solid ${col}55`,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700, color: col,
          }}>{ini}</span>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#8b94b0', fontWeight: 500 }}>
            {commit.author}
          </span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4e5870' }}>
            {fullDate}
          </span>
        </div>
      </div>

      {/* Files changed header */}
      <div style={{
        display: 'flex', alignItems: 'center', height: 34,
        paddingLeft: 16, paddingRight: 16,
        borderBottom: '1px solid #252d42', background: '#10131c', flexShrink: 0,
      }}>
        <span style={{
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, fontWeight: 600,
          color: '#4e5870', letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          Files changed
          {!filesLoading && files.length > 0 && (
            <span style={{
              marginLeft: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              background: '#242a3d', color: '#4e5870', borderRadius: 8, padding: '1px 6px',
            }}>{files.length}</span>
          )}
        </span>
      </div>

      {/* File list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filesLoading ? (
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4e5870', padding: '12px 16px' }}>
            Loading…
          </p>
        ) : files.length === 0 ? (
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4e5870', padding: '12px 16px' }}>
            No file changes
          </p>
        ) : (
          files.map((f, i) => {
            const label = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
            const sc = FILE_STATUS_COLOR[f.status] ?? '#8b94b0'
            const sb = FILE_STATUS_BG[f.status]  ?? 'transparent'
            return (
              <div
                key={i}
                onContextMenu={e => { e.preventDefault(); setCtxMenu({ file: f, x: e.clientX, y: e.clientY }) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  height: 36, paddingLeft: 16, paddingRight: 16,
                  borderBottom: '1px solid #252d42',
                  transition: 'background 0.1s', cursor: 'default',
                }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1e2436')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{
                  width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                  background: sb, color: sc,
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{f.status}</span>
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
                  color: '#dde1f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                }} title={label}>{label}</span>
              </div>
            )
          })
        )}
      </div>

      {/* File context menu */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          style={{
            position: 'fixed', top: ctxMenu.y, left: ctxMenu.x, zIndex: 100,
            background: '#1d2235', border: '1px solid #2f3a54',
            borderRadius: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
            padding: '4px 0', minWidth: 230,
          }}
        >
          <CtxItem label="Blame" onClick={() => { setBlameTarget(ctxMenu.file); closeCtx() }} />
          <CtxSep />
          <CtxItem label="Show in Explorer"           onClick={() => { ipc.showInFolder(absPath(ctxMenu.file)); closeCtx() }} />
          <CtxItem label="Open in Visual Studio Code" onClick={() => { ipc.openExternal('vscode://file/' + absPath(ctxMenu.file)); closeCtx() }} />
          <CtxItem label="Open with default program"  onClick={() => { ipc.openPath(absPath(ctxMenu.file)); closeCtx() }} />
          <CtxSep />
          <CtxItem label="Copy file path"          onClick={() => { navigator.clipboard.writeText(absPath(ctxMenu.file)); closeCtx() }} />
          <CtxItem label="Copy relative file path" onClick={() => { navigator.clipboard.writeText(ctxMenu.file.path); closeCtx() }} />
          <CtxSep />
          <CtxItem
            label="View on GitHub"
            onClick={ghSlug ? () => { ipc.openExternal(`https://github.com/${ghSlug}/blob/${commit.hash}/${ctxMenu.file.path}`); closeCtx() } : undefined}
            disabled={!ghSlug}
            title={ghSlug ? undefined : 'No GitHub remote detected'}
          />
        </div>
      )}

      {/* Blame modal */}
      {blameTarget && (
        <BlameModal
          file={blameTarget}
          commitHash={commit.hash}
          repoPath={repoPath}
          onClose={() => setBlameTarget(null)}
        />
      )}
    </div>
  )
}

// ── Stash panel ───────────────────────────────────────────────────────────────

const stashBtnStyle: React.CSSProperties = {
  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, fontWeight: 500,
  height: 24, paddingLeft: 8, paddingRight: 8, borderRadius: 4,
  border: '1px solid', cursor: 'pointer', transition: 'background 0.12s',
}

function StashPanel({ repoPath }: { repoPath: string }) {
  const [stashes, setStashes] = useState<StashEntry[]>([])
  const [loading, setLoading] = useState(false)
  const opRun        = useOperationStore(s => s.run)
  const dialog       = useDialogStore()
  const bumpSyncTick = useRepoStore(s => s.bumpSyncTick)

  const load = useCallback(async () => {
    setLoading(true)
    try { setStashes(await ipc.stashList(repoPath)) }
    catch { setStashes([]) }
    finally { setLoading(false) }
  }, [repoPath])

  useEffect(() => { load() }, [load])

  const handlePop = async (s: StashEntry) => {
    const ok = await dialog.confirm({
      title: 'Pop stash',
      message: `Apply and drop stash@{${s.index}}?`,
      detail: s.message,
      confirmLabel: 'Pop',
    })
    if (!ok) return
    try {
      await opRun('Popping stash…', () => ipc.stashPop(repoPath, s.ref))
      bumpSyncTick()
      load()
    } catch (e) { await dialog.alert({ title: 'Pop failed', message: String(e) }) }
  }

  const handleApply = async (s: StashEntry) => {
    const ok = await dialog.confirm({
      title: 'Apply stash',
      message: `Apply stash@{${s.index}} (stash is kept)?`,
      detail: s.message,
      confirmLabel: 'Apply',
    })
    if (!ok) return
    try {
      await opRun('Applying stash…', () => ipc.stashApply(repoPath, s.ref))
      bumpSyncTick()
      load()
    } catch (e) { await dialog.alert({ title: 'Apply failed', message: String(e) }) }
  }

  const handleDrop = async (s: StashEntry) => {
    const ok = await dialog.confirm({
      title: 'Drop stash',
      message: `Permanently delete stash@{${s.index}}?`,
      detail: s.message,
      confirmLabel: 'Drop',
    })
    if (!ok) return
    try {
      await opRun('Dropping stash…', () => ipc.stashDrop(repoPath, s.ref))
      load()
    } catch (e) { await dialog.alert({ title: 'Drop failed', message: String(e) }) }
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        height: 38, paddingLeft: 14, paddingRight: 8,
        borderBottom: '1px solid #252d42', background: '#161a27', flexShrink: 0,
      }}>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 600, color: '#8b94b0', letterSpacing: '0.04em' }}>
          {stashes.length > 0 ? `${stashes.length} STASH${stashes.length !== 1 ? 'ES' : ''}` : 'STASHES'}
        </span>
        <button
          onClick={load}
          disabled={loading}
          style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: loading ? '#4e5870' : '#8b94b0', background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.5 : 1 }}
          onMouseEnter={e => { if (!loading) e.currentTarget.style.color = '#e8622f' }}
          onMouseLeave={e => { if (!loading) e.currentTarget.style.color = '#8b94b0' }}
        >{loading ? '…' : '↺'}</button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && stashes.length === 0 ? (
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4e5870', padding: '16px 12px' }}>Loading…</p>
        ) : stashes.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '40px 16px' }}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <rect x="4" y="8" width="20" height="14" rx="2" stroke="#2f3a54" strokeWidth="1.5" />
              <rect x="7" y="5" width="14" height="5" rx="1.5" stroke="#2f3a54" strokeWidth="1.5" />
            </svg>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#4e5870' }}>No stashes</span>
          </div>
        ) : stashes.map(s => (
          <div
            key={s.ref}
            style={{ padding: '10px 12px 10px 14px', borderBottom: '1px solid #252d42', transition: 'background 0.1s' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#1e2436')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#dde1f0', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.message}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4d9dff' }}>{s.ref}</span>
                  <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#4e5870' }}>on {s.branch}</span>
                  <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#4e5870' }}>{s.date}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 1 }}>
                <button
                  onClick={() => handlePop(s)} title="Apply + drop"
                  style={{ ...stashBtnStyle, color: '#2ec573', borderColor: 'rgba(46,197,115,0.3)', background: 'rgba(46,197,115,0.08)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(46,197,115,0.18)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(46,197,115,0.08)')}
                >Pop</button>
                <button
                  onClick={() => handleApply(s)} title="Apply (keep stash)"
                  style={{ ...stashBtnStyle, color: '#4d9dff', borderColor: 'rgba(77,157,255,0.3)', background: 'rgba(77,157,255,0.08)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(77,157,255,0.18)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(77,157,255,0.08)')}
                >Apply</button>
                <button
                  onClick={() => handleDrop(s)} title="Delete stash"
                  style={{ ...stashBtnStyle, color: '#e84545', borderColor: 'rgba(232,69,69,0.3)', background: 'rgba(232,69,69,0.08)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(232,69,69,0.18)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(232,69,69,0.08)')}
                >Drop</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Branch filter helpers ──────────────────────────────────────────────────────

function BranchFilterIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="5" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="5" cy="12" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <line x1="5" y1="5.75" x2="5" y2="10.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11 5.75 C11 8.5 5 8.5 5 10.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function BranchFilterRow({
  name, checked, locked, isCurrent, onToggle,
}: {
  name: string; checked: boolean; locked?: boolean; isCurrent?: boolean; onToggle: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={locked ? undefined : onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        height: 32, paddingLeft: 12, paddingRight: 12,
        background: hover && !locked ? '#242a3d' : 'transparent',
        cursor: locked ? 'default' : 'pointer',
        transition: 'background 0.1s',
      }}
    >
      {/* Checkbox */}
      <div style={{
        width: 14, height: 14, borderRadius: 3, flexShrink: 0,
        background: checked ? '#e8622f' : 'transparent',
        border: `1.5px solid ${checked ? '#e8622f' : '#2f3a54'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.1s',
      }}>
        {checked && (
          <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
            <path d="M1 3.5L3.5 6L8 1" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      {/* Branch name */}
      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
        color: locked ? '#4e5870' : '#dde1f0',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
      }}>{name}</span>
      {/* Badges */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {isCurrent && (
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 600,
            background: 'rgba(46,197,115,0.15)', color: '#2ec573',
            border: '1px solid rgba(46,197,115,0.3)', borderRadius: 3, padding: '1px 5px',
          }}>HEAD</span>
        )}
        {locked && (
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 600,
            background: 'rgba(77,157,255,0.12)', color: '#4d9dff',
            border: '1px solid rgba(77,157,255,0.25)', borderRadius: 3, padding: '1px 5px',
          }}>always</span>
        )}
      </div>
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────────

const INITIAL_LIMIT  = 300
const MORE_INCREMENT = 300

export function HistoryPanel({ repoPath }: HistoryPanelProps) {
  const opRun = useOperationStore(s => s.run)

  const [activeTab,    setActiveTab]    = useState<'commits' | 'stashes'>('commits')
  const [nodes,        setNodes]        = useState<GraphNode[]>([])
  const [totalLoaded,  setTotalLoaded]  = useState(0)
  const [loading,      setLoading]      = useState(false)
  const [limitRef]                      = useState({ current: INITIAL_LIMIT })
  const [remoteUrl,    setRemoteUrl]    = useState<string | null>(null)

  const [selected,     setSelected]     = useState<CommitEntry | null>(null)
  const [files,        setFiles]        = useState<CommitFileChange[]>([])
  const [filesLoading, setFilesLoading] = useState(false)

  // ── Branch filter ────────────────────────────────────────────────────────────
  const [branches,       setBranches]       = useState<BranchInfo[]>([])
  const [defaultBranch,  setDefaultBranch]  = useState('main')
  const [selectedBranches, setSelectedBranches] = useState<Set<string>>(new Set())
  const [filterOpen,     setFilterOpen]     = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!filterOpen) return
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [filterOpen])

  // ── Drag resize ──────────────────────────────────────────────────────────────
  const [listWidth,   setListWidth]   = useState(480)
  const dragging      = useRef(false)
  const dragStartX    = useRef(0)
  const dragStartW    = useRef(0)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragging.current   = true
    dragStartX.current = e.clientX
    dragStartW.current = listWidth
    document.body.style.cursor     = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      setListWidth(Math.max(260, Math.min(700, dragStartW.current + (ev.clientX - dragStartX.current))))
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [listWidth])

  // ── Data loading ─────────────────────────────────────────────────────────────
  const loadHistory = useCallback(async (limit: number, branchFilter?: Set<string>) => {
    setLoading(true)
    try {
      const active = branchFilter ?? selectedBranches
      // Always include default branch + selected branches
      const refs = active.size > 0
        ? [...new Set([defaultBranch, ...active])]
        : undefined
      const commits = await opRun(
        'Loading history…',
        () => ipc.log(repoPath, { limit, all: !refs, refs }),
      )
      setNodes(computeGraph(commits))
      setTotalLoaded(commits.length)
    } finally {
      setLoading(false)
    }
  }, [repoPath, opRun, selectedBranches, defaultBranch])

  useEffect(() => {
    limitRef.current = INITIAL_LIMIT
    setSelected(null)
    setFiles([])
    ipc.getRemoteUrl(repoPath).then(setRemoteUrl).catch(() => {})
    // Load branches + default branch
    Promise.all([
      ipc.branchList(repoPath),
      ipc.gitDefaultBranch(repoPath),
    ]).then(([bList, def]) => {
      setBranches(bList.filter(b => !b.isRemote))
      setDefaultBranch(def)
    }).catch(() => {})
    loadHistory(INITIAL_LIMIT, new Set())
  }, [repoPath])

  const handleLoadMore = () => {
    limitRef.current += MORE_INCREMENT
    loadHistory(limitRef.current)
  }

  const toggleBranch = (name: string) => {
    if (name === defaultBranch) return // can't deselect default
    const next = new Set(selectedBranches)
    next.has(name) ? next.delete(name) : next.add(name)
    setSelectedBranches(next)
    limitRef.current = INITIAL_LIMIT
    loadHistory(INITIAL_LIMIT, next)
  }

  const handleSelect = async (commit: CommitEntry) => {
    if (selected?.hash === commit.hash) return
    setSelected(commit)
    setFiles([])
    setFilesLoading(true)
    try {
      setFiles(await ipc.commitFiles(repoPath, commit.hash))
    } catch {
      setFiles([])
    } finally {
      setFilesLoading(false)
    }
  }

  const localBranches = branches.filter(b => !b.isRemote)
  const filterActive  = selectedBranches.size > 0

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

      {/* Left: commit list / stash list */}
      <div style={{ width: listWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Tab bar */}
        <div style={{ display: 'flex', alignItems: 'stretch', height: 34, borderBottom: '1px solid #252d42', background: '#0d0f15', flexShrink: 0 }}>
          {(['commits', 'stashes'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                flex: 1, background: 'none', cursor: 'pointer',
                border: 'none', borderBottom: `2px solid ${activeTab === tab ? '#e8622f' : 'transparent'}`,
                color: activeTab === tab ? '#dde1f0' : '#4e5870',
                fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 500,
                textTransform: 'capitalize', transition: 'color 0.1s',
              }}
              onMouseEnter={e => { if (activeTab !== tab) e.currentTarget.style.color = '#8b94b0' }}
              onMouseLeave={e => { if (activeTab !== tab) e.currentTarget.style.color = '#4e5870' }}
            >{tab}</button>
          ))}
        </div>

        {activeTab === 'stashes' ? (
          <StashPanel repoPath={repoPath} />
        ) : (<>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          height: 38, paddingLeft: 14, paddingRight: 8,
          borderBottom: '1px solid #252d42', background: '#161a27', flexShrink: 0, gap: 6,
        }}>
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 600,
            color: '#8b94b0', letterSpacing: '0.04em', flexShrink: 0,
          }}>
            {totalLoaded > 0 ? `${totalLoaded} COMMITS` : 'HISTORY'}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }} ref={filterRef}>
            {/* Branch filter button */}
            <button
              onClick={() => setFilterOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                height: 24, paddingLeft: 8, paddingRight: 8, borderRadius: 5,
                background: filterActive ? 'rgba(232,98,47,0.15)' : 'transparent',
                border: `1px solid ${filterActive ? 'rgba(232,98,47,0.4)' : '#252d42'}`,
                color: filterActive ? '#e8622f' : '#8b94b0',
                fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11,
                cursor: 'pointer', transition: 'all 0.12s', flexShrink: 0,
              }}
            >
              <BranchFilterIcon />
              {filterActive ? `${selectedBranches.size + 1} branches` : 'Branches'}
            </button>

            {/* Dropdown */}
            {filterOpen && (
              <div style={{
                position: 'absolute', top: 30, right: 0, zIndex: 50, minWidth: 220,
                background: '#1d2235', border: '1px solid #2f3a54',
                borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.55)',
                padding: '6px 0',
              }}>
                <div style={{ padding: '4px 12px 8px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 600, color: '#4e5870', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  Branches — main always shown
                </div>
                {/* Default branch — always on */}
                <BranchFilterRow
                  name={defaultBranch} checked locked
                  onToggle={() => {}}
                  isCurrent={branches.find(b => b.name === defaultBranch)?.current ?? false}
                />
                {localBranches.filter(b => b.name !== defaultBranch).map(b => (
                  <BranchFilterRow
                    key={b.name}
                    name={b.name}
                    checked={selectedBranches.has(b.name)}
                    isCurrent={b.current}
                    onToggle={() => toggleBranch(b.name)}
                  />
                ))}
                {localBranches.length === 0 && (
                  <div style={{ padding: '8px 12px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#4e5870' }}>No other local branches</div>
                )}
              </div>
            )}
          </div>

          <button
            onClick={() => loadHistory(limitRef.current)}
            disabled={loading}
            style={{
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12,
              color: loading ? '#4e5870' : '#8b94b0',
              background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer',
              opacity: loading ? 0.5 : 1, flexShrink: 0,
            }}
            onMouseEnter={e => { if (!loading) e.currentTarget.style.color = '#e8622f' }}
            onMouseLeave={e => { if (!loading) e.currentTarget.style.color = '#8b94b0' }}
          >
            {loading ? '…' : '↺'}
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && nodes.length === 0 && (
            <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4e5870', padding: '16px 12px' }}>
              Loading history…
            </p>
          )}

          {nodes.map(node => (
            <CommitRow
              key={node.commit.hash}
              node={node}
              selected={selected?.hash === node.commit.hash}
              repoPath={repoPath}
              remoteUrl={remoteUrl}
              onRefresh={() => loadHistory(limitRef.current)}
              onClick={() => handleSelect(node.commit)}
            />
          ))}

          {!loading && totalLoaded >= limitRef.current && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}>
              <button
                onClick={handleLoadMore}
                style={{
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#4e5870',
                  background: 'none', border: '1px solid #252d42',
                  borderRadius: 6, padding: '6px 16px', cursor: 'pointer',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = '#8b94b0'; e.currentTarget.style.borderColor = '#2f3a54' }}
                onMouseLeave={e => { e.currentTarget.style.color = '#4e5870'; e.currentTarget.style.borderColor = '#252d42' }}
              >
                Load more…
              </button>
            </div>
          )}
        </div>
        </>)}
      </div>

      {/* Drag handle */}
      <DragHandle onMouseDown={onDragStart} />

      {/* Right: commit detail */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selected ? (
          <CommitDetail commit={selected} files={files} filesLoading={filesLoading} repoPath={repoPath} remoteUrl={remoteUrl} />
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <circle cx="16" cy="16" r="11" stroke="#2f3a54" strokeWidth="1.5" />
              <path d="M16 10v6l4 3" stroke="#2f3a54" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#4e5870' }}>
              Select a commit to view details
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function DragHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 4, flexShrink: 0, cursor: 'col-resize',
        background: hover ? '#e8622f' : '#252d42',
        transition: 'background 0.15s', zIndex: 5,
      }}
    />
  )
}
