import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ipc, CommitEntry, CommitFileChange, BranchInfo, BlameEntry, StashEntry } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { useDialogStore } from '@/stores/dialogStore'
import { useRepoStore } from '@/stores/repoStore'
import { computeGraph, GraphNode, LANE_W, ROW_H, DOT_R, GRAPH_PAD, LineSegment } from './graphLayout'
import { AppCheckbox } from '@/components/ui/AppCheckbox'
import { AppTooltip } from '@/components/ui/AppTooltip'
import { AppRightSelectionItem, AppRightSelectionOptions, AppRightSelectionSeparator } from '@/components/ui/AppRightSelectionOptions'

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

// Shared SVG filter defs rendered once; all GraphCell SVGs reference them.
function GraphDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute', overflow: 'hidden' }}>
      <defs>
        <filter id="gc-glow-main" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
    </svg>
  )
}

function linePath(seg: LineSegment, isTop: boolean): string {
  const x1 = GRAPH_PAD + seg.from * LANE_W + LANE_W / 2
  const x2 = GRAPH_PAD + seg.to   * LANE_W + LANE_W / 2
  const y1 = isTop ? 0         : ROW_H / 2
  const y2 = isTop ? ROW_H / 2 : ROW_H
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  return `M ${x1} ${y1} C ${x1} ${y2} ${x2} ${y1} ${x2} ${y2}`
}

function GraphCell({ node, graphColW, emphasize, branchNamesByColor }: {
  node: GraphNode; graphColW: number; emphasize?: boolean; branchNamesByColor: Map<string, string[]>
}) {
  const isMain  = node.lane === 0
  const isMerge = node.commit.parentHashes.length > 1
  const cx = GRAPH_PAD + node.lane * LANE_W + LANE_W / 2
  const cy = ROW_H / 2
  const dotR = DOT_R + 0.5

  return (
    <svg width={graphColW} height={ROW_H} style={{ flexShrink: 0, overflow: 'visible', display: 'block' }}>
      {/* Lines — top half */}
      {node.topLines.map((seg, i) => (
        <path key={`t${i}`} d={linePath(seg, true)}
          stroke={seg.color} fill="none"
          strokeWidth={emphasize ? (seg.from === 0 ? 2.8 : 2.3) : (seg.from === 0 ? 2.2 : 1.6)}
          strokeOpacity={emphasize ? 1 : (seg.from === 0 ? 0.88 : 0.52)}
          filter={emphasize ? 'url(#gc-glow-main)' : undefined}
        >
          <title>{`Branch lane: ${(branchNamesByColor.get(seg.color) ?? ['unlabeled lane']).join(', ')}`}</title>
        </path>
      ))}
      {/* Lines — bottom half */}
      {node.bottomLines.map((seg, i) => (
        <path key={`b${i}`} d={linePath(seg, false)}
          stroke={seg.color} fill="none"
          strokeWidth={emphasize ? (seg.from === 0 ? 2.8 : 2.3) : (seg.from === 0 ? 2.2 : 1.6)}
          strokeOpacity={emphasize ? 1 : (seg.from === 0 ? 0.88 : 0.52)}
          filter={emphasize ? 'url(#gc-glow-main)' : undefined}
        >
          <title>{`Branch lane: ${(branchNamesByColor.get(seg.color) ?? ['unlabeled lane']).join(', ')}`}</title>
        </path>
      ))}
      {/* Main-lane halo */}
      {isMain && (
        <circle cx={cx} cy={cy} r={dotR + 5} fill={`${node.color}14`} stroke="none" />
      )}
      {/* Commit node */}
      {isMerge ? (
        <g filter={isMain ? 'url(#gc-glow-main)' : undefined}>
          <polygon
            points={`${cx},${cy - dotR - 1} ${cx + dotR + 1},${cy} ${cx},${cy + dotR + 1} ${cx - dotR - 1},${cy}`}
            fill="#10131c" stroke={node.color} strokeWidth={isMain ? 2 : 1.8}
          />
          <circle cx={cx} cy={cy} r={2} fill={node.color} />
        </g>
      ) : (
        <circle cx={cx} cy={cy} r={dotR}
          fill="#10131c" stroke={node.color}
          strokeWidth={isMain ? 2.5 : 2}
          filter={isMain ? 'url(#gc-glow-main)' : undefined}
        />
      )}
    </svg>
  )
}

// ── Context menu helpers ────────────────────────────────────────────────────────

// ── Branch tip helpers ─────────────────────────────────────────────────────────

const BRANCH_COLORS = ['#4d9dff', '#e8622f', '#2ec573', '#a27ef0', '#f5a832', '#1abc9c', '#e91e63', '#00bcd4']

function branchShortName(name: string): string {
  const parts = name.split('/')
  const last = parts[parts.length - 1]
  return last.length > 10 ? last.slice(0, 10) + '…' : last
}

// ── Commit row ─────────────────────────────────────────────────────────────────

function CommitRow({ node, selected, isPrimary, repoPath, remoteUrl, onRefresh, onClick, onMultiContextMenu,
  graphColW, branchTips, branchColors, defaultBranch }: {
  node: GraphNode
  selected: boolean
  isPrimary: boolean
  repoPath: string
  remoteUrl: string | null
  onRefresh: () => void
  onClick: (e: React.MouseEvent) => void
  onMultiContextMenu?: (e: React.MouseEvent) => void
  graphColW: number
  branchTips: Map<string, BranchInfo[]>
  branchColors: Map<string, string>
  branchNamesByColor: Map<string, string[]>
  defaultBranch: string
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
  const tipBranches = branchTips.get(commit.hash) ?? []
  const isHeadTip = tipBranches.some(b => b.current)

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
        onContextMenu={e => {
          e.preventDefault()
          if (onMultiContextMenu) {
            onMultiContextMenu(e)
          } else {
            setCtx({ x: e.clientX, y: e.clientY })
          }
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', height: ROW_H,
          background: isPrimary ? '#242a3d' : selected ? '#1c2236' : hover ? '#1e2436' : 'transparent',
          borderLeft: `2px solid ${isPrimary ? '#e8622f' : selected ? 'rgba(232,98,47,0.4)' : 'transparent'}`,
          borderBottom: '1px solid #252d42',
          cursor: 'pointer', transition: 'background 0.1s',
        }}
      >
        {/* Graph */}
        <div style={{ width: graphColW, height: ROW_H, flexShrink: 0, overflow: 'hidden' }}>
          <GraphCell
            node={node}
            graphColW={graphColW}
            emphasize={hover || selected || isPrimary}
            branchNamesByColor={branchNamesByColor}
          />
        </div>

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: 6, paddingRight: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3, overflow: 'hidden' }}>
            {/* Branch tip pills */}
            {tipBranches.map(b => {
              const bCol = branchColors.get(b.name) ?? '#4d9dff'
              const isDefault = b.name === defaultBranch
              const icon = isDefault ? '★' : b.current ? '◉' : '•'
              return (
                <span key={b.name} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
                  background: `${bCol}16`, color: bCol,
                  border: `1px solid ${bCol}45`,
                  borderRadius: 4, padding: '1px 6px',
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 500,
                }}>
                  <span style={{ fontSize: 9 }}>{icon}</span>
                  {branchShortName(b.name)}
                  {b.current && (
                    <span style={{
                      background: `${bCol}28`, color: bCol,
                      border: `1px solid ${bCol}55`,
                      borderRadius: 3, padding: '0 4px',
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 8, fontWeight: 700,
                      letterSpacing: '0.04em',
                    }}>HEAD</span>
                  )}
                </span>
              )
            })}
            {isHeadTip && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
                background: 'rgba(245,168,50,0.14)', color: '#f5a832',
                border: '1px solid rgba(245,168,50,0.4)', borderRadius: 4, padding: '1px 6px',
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600,
              }} title="Working tree is attached to this commit on HEAD">
                ⌂ WT
              </span>
            )}
            <span style={{
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13,
              fontWeight: isPrimary ? 600 : 400, color: selected ? '#dde1f0' : '#b0b8cc',
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
              background: `${col}22`, border: `1px solid ${col}44`,
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
        <AppRightSelectionOptions x={ctx.x} y={ctx.y} minWidth={230} menuRef={ctxRef}>
          <AppRightSelectionItem label="Undo commit (soft reset)"      onClick={handleUndoCommit} />
          <AppRightSelectionItem label="Reset to commit…"            onClick={handleResetTo}    danger />
          <AppRightSelectionItem label="Checkout commit"             onClick={handleCheckout} />
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label="Revert changes in commit"    onClick={handleRevert} />
          <AppRightSelectionItem label="Create branch from commit…"  onClick={handleCreateBranch} />
          <AppRightSelectionItem label="Cherry-pick commit…"         onClick={handleCherryPick} />
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label="Copy SHA"                    onClick={handleCopySHA} />
          <AppRightSelectionItem
            label="View on GitHub"
            onClick={ghSlug ? handleViewOnGitHub : undefined}
            disabled={!ghSlug}
            title={ghSlug ? undefined : 'No GitHub remote detected'}
          />
        </AppRightSelectionOptions>
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
        <AppRightSelectionOptions x={ctxMenu.x} y={ctxMenu.y} minWidth={230} menuRef={ctxRef}>
          <AppRightSelectionItem label="Blame" onClick={() => { setBlameTarget(ctxMenu.file); closeCtx() }} />
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label="Show in Explorer"           onClick={() => { ipc.showInFolder(absPath(ctxMenu.file)); closeCtx() }} />
          <AppRightSelectionItem label="Open in Visual Studio Code" onClick={() => { ipc.openExternal('vscode://file/' + absPath(ctxMenu.file)); closeCtx() }} />
          <AppRightSelectionItem label="Open with default program"  onClick={() => { ipc.openPath(absPath(ctxMenu.file)); closeCtx() }} />
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label="Copy file path"          onClick={() => { navigator.clipboard.writeText(absPath(ctxMenu.file)); closeCtx() }} />
          <AppRightSelectionItem label="Copy relative file path" onClick={() => { navigator.clipboard.writeText(ctxMenu.file.path); closeCtx() }} />
          <AppRightSelectionSeparator />
          <AppRightSelectionItem
            label="View on GitHub"
            onClick={ghSlug ? () => { ipc.openExternal(`https://github.com/${ghSlug}/blob/${commit.hash}/${ctxMenu.file.path}`); closeCtx() } : undefined}
            disabled={!ghSlug}
            title={ghSlug ? undefined : 'No GitHub remote detected'}
          />
        </AppRightSelectionOptions>
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

function CollapseBtn({ isCollapsed, onClick }: { isCollapsed: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={isCollapsed ? 'Show all branches' : 'Collapse to main + HEAD'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 24, paddingLeft: 7, paddingRight: 7, borderRadius: 4,
        background: isCollapsed ? 'rgba(232,98,47,0.15)' : hover ? '#242a3d' : 'transparent',
        border: `1px solid ${isCollapsed ? 'rgba(232,98,47,0.55)' : '#252d42'}`,
        color: isCollapsed ? '#e8622f' : '#8b94b0',
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11,
        cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0,
      }}
    >
      <svg width="12" height="13" viewBox="0 0 12 13" fill="none">
        <circle cx="2.5" cy="2.5" r="2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="2.5" cy="10.5" r="2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="9.5" cy="6.5" r="2" stroke="currentColor" strokeWidth="1.3" opacity={isCollapsed ? 0.35 : 1} />
        <line x1="2.5" y1="4.5" x2="2.5" y2="8.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M2.5 4.5 Q2.5 6.5 9.5 6.5" stroke="currentColor" strokeWidth="1.3" fill="none" opacity={isCollapsed ? 0.35 : 1} />
      </svg>
      {isCollapsed ? 'Core' : 'All'}
    </button>
  )
}

function BranchDropdownRow({ branch, checked, locked, bCol, onToggle }: {
  branch: BranchInfo; checked: boolean; locked?: boolean; bCol: string; onToggle: () => void
}) {
  const [hover, setHover] = useState(false)
  const isDefault = locked
  return (
    <div
      onClick={locked ? undefined : onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 12px', borderBottom: '1px solid #1e2438',
        cursor: locked ? 'default' : 'pointer',
        background: hover && !locked ? '#1e2436' : 'transparent',
        opacity: !checked && !locked ? 0.5 : 1,
        transition: 'opacity 0.12s, background 0.1s',
      }}
    >
      <AppCheckbox checked={checked} onChange={onToggle} color={bCol} size={14} />
      {/* Lane color bar */}
      <AppTooltip content={`Branch lane: ${branch.name}`} side="top" delay={250}><span style={{ width: 3, height: 16, borderRadius: 2, background: bCol, flexShrink: 0, boxShadow: hover ? `0 0 8px ${bCol}` : 'none' }} /></AppTooltip>
      {/* Branch name */}
      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#dde1f0',
        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{branch.name}</span>
      {/* Badges */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {isDefault && (
          <span style={{
            background: 'rgba(77,157,255,0.14)', color: '#4d9dff',
            border: '1px solid rgba(77,157,255,0.35)',
            borderRadius: 3, padding: '0 5px',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
          }}>default</span>
        )}
        {branch.isRemote && (
          <span style={{
            background: 'rgba(162,126,240,0.14)', color: '#a27ef0',
            border: '1px solid rgba(162,126,240,0.35)', borderRadius: 3, padding: '0 5px',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
          }}>remote</span>
        )}
        {!branch.isRemote && (
          <span style={{
            background: 'rgba(46,197,115,0.14)', color: '#2ec573',
            border: '1px solid rgba(46,197,115,0.35)', borderRadius: 3, padding: '0 5px',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
          }}>local</span>
        )}
        {branch.current && (
          <span style={{
            background: `${bCol}22`, color: bCol,
            border: `1px solid ${bCol}45`,
            borderRadius: 3, padding: '0 5px',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
          }}>HEAD</span>
        )}
      </div>
    </div>
  )
}

function BranchDropdown({ open, onToggleOpen, branches, selectedBranches, defaultBranch, branchColors, onToggleBranch, onShowAll }: {
  open: boolean
  onToggleOpen: () => void
  branches: BranchInfo[]
  selectedBranches: Set<string>
  defaultBranch: string
  branchColors: Map<string, string>
  onToggleBranch: (name: string) => void
  onShowAll: () => void
}) {
  const allShown = selectedBranches.size === 0
  const visibleCount = allShown ? branches.length : branches.filter(b => b.name === defaultBranch || selectedBranches.has(b.name)).length
  const swatchBranches = [
    ...branches.filter(b => b.name === defaultBranch),
    ...branches.filter(b => b.name !== defaultBranch),
  ]

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={onToggleOpen}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          height: 24, paddingLeft: 9, paddingRight: 7, borderRadius: 4,
          background: open ? '#242a3d' : 'transparent',
          border: `1px solid ${open ? '#2f3a54' : '#252d42'}`,
          color: '#8b94b0',
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, fontWeight: 500,
          cursor: 'pointer', transition: 'all 0.12s', flexShrink: 0,
        }}
      >
        {/* Mini lane swatches */}
        <span style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          {swatchBranches.map(b => {
            const bCol = branchColors.get(b.name) ?? '#4d9dff'
            const isShown = allShown || b.name === defaultBranch || selectedBranches.has(b.name)
            return (
              <span key={b.name} style={{
                width: 5, height: 12, borderRadius: 2,
                background: isShown ? bCol : '#252d42',
                opacity: isShown ? 0.85 : 0.35,
                transition: 'background 0.15s, opacity 0.15s',
              }} />
            )
          })}
        </span>
        <span>{visibleCount} branch{visibleCount !== 1 ? 'es' : ''}</span>
        <svg width="8" height="5" viewBox="0 0 8 5" fill="none"
          style={{ transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>
          <path d="M1 1L4 4L7 1" stroke="#4e5870" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <>
          <div onClick={onToggleOpen} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 91,
            background: '#1d2235', border: '1px solid #2f3a54',
            borderRadius: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
            minWidth: 240, overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px 6px', borderBottom: '1px solid #252d42',
            }}>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
                color: '#4e5870', letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>Filter branches</span>
              <button
                onClick={onShowAll}
                style={{
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#e8622f',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                }}
              >Show all</button>
            </div>
            {swatchBranches.map(b => {
              const bCol = branchColors.get(b.name) ?? '#4d9dff'
              const isLocked = b.name === defaultBranch
              const isChecked = allShown || isLocked || selectedBranches.has(b.name)
              return (
                <BranchDropdownRow
                  key={b.name}
                  branch={b}
                  checked={isChecked}
                  locked={isLocked}
                  bCol={bCol}
                  onToggle={() => onToggleBranch(b.name)}
                />
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function LegendItem({ symbol, label, color }: { symbol: string; label: string; color: string }) {
  const [hover, setHover] = useState(false)
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        color: hover ? '#dde1f0' : '#8b94b0',
        background: hover ? 'rgba(77,157,255,0.12)' : 'transparent',
        border: `1px solid ${hover ? '#3a4a70' : 'transparent'}`,
        borderRadius: 4,
        padding: '1px 5px',
        transition: 'color 0.1s',
      }}
    >
      <span style={{ color }}>{symbol}</span>
      <span>{label}</span>
    </span>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────────

const INITIAL_LIMIT  = 300
const MORE_INCREMENT = 300

export function HistoryPanel({ repoPath }: HistoryPanelProps) {
  const opRun        = useOperationStore(s => s.run)
  const dialog       = useDialogStore()
  const { historyTick, bumpSyncTick, fileStatus, currentBranch } = useRepoStore()

  const [activeTab,    setActiveTab]    = useState<'commits' | 'stashes'>('commits')
  const [nodes,        setNodes]        = useState<GraphNode[]>([])
  const [totalLoaded,  setTotalLoaded]  = useState(0)
  const [loading,      setLoading]      = useState(false)
  const [limitRef]                      = useState({ current: INITIAL_LIMIT })
  const [remoteUrl,    setRemoteUrl]    = useState<string | null>(null)

  // ── Selection (single primary + multi-select set) ────────────────────────────
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set())
  const [primaryCommit,  setPrimaryCommit]  = useState<CommitEntry | null>(null)
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null)
  const [files,          setFiles]          = useState<CommitFileChange[]>([])
  const [filesLoading,   setFilesLoading]   = useState(false)

  // ── Multi-select context menu ────────────────────────────────────────────────
  const [multiCtx,  setMultiCtx]  = useState<{ x: number; y: number } | null>(null)
  const multiCtxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!multiCtx) return
    const handler = (e: MouseEvent) => {
      if (multiCtxRef.current && !multiCtxRef.current.contains(e.target as Node)) setMultiCtx(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [multiCtx])

  // Escape clears multi-selection
  useEffect(() => {
    if (selectedHashes.size < 2) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedHashes(new Set(primaryCommit ? [primaryCommit.hash] : []))
        setMultiCtx(null)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedHashes, primaryCommit])

  // ── Branch filter ────────────────────────────────────────────────────────────
  const [branches,       setBranches]       = useState<BranchInfo[]>([])
  const [defaultBranch,  setDefaultBranch]  = useState('main')
  const [selectedBranches, setSelectedBranches] = useState<Set<string>>(new Set())
  const [filterOpen,     setFilterOpen]     = useState(false)
  const [branchTips,     setBranchTips]     = useState<Map<string, BranchInfo[]>>(new Map())

  // Branch colors: default branch = index 0 → blue, others follow palette order
  const branchColors = React.useMemo(() => {
    const sorted = [
      ...branches.filter(b => b.name === defaultBranch),
      ...branches.filter(b => b.name !== defaultBranch),
    ]
    const map = new Map<string, string>()
    sorted.forEach((b, i) => map.set(b.name, BRANCH_COLORS[i % BRANCH_COLORS.length]))
    return map
  }, [branches, defaultBranch])
  const branchNamesByColor = React.useMemo(() => {
    const next = new Map<string, string[]>()
    for (const b of branches) {
      const c = branchColors.get(b.name)
      if (!c) continue
      const names = next.get(c) ?? []
      if (!names.includes(b.name)) names.push(b.name)
      next.set(c, names)
    }
    return next
  }, [branches, branchColors])

  // Dynamic graph column width — fits the widest lane across all nodes
  const graphColW = React.useMemo(() => {
    if (nodes.length === 0) return GRAPH_PAD * 2 + LANE_W
    const maxLane = nodes.reduce((m, n) => Math.max(m, n.maxLane), 0)
    return GRAPH_PAD + (maxLane + 1) * LANE_W + GRAPH_PAD
  }, [nodes])

  const isCollapsed = selectedBranches.size > 0

  const fetchBranchTips = useCallback(async (branchList: BranchInfo[]) => {
    const tips = new Map<string, BranchInfo[]>()
    const locals = branchList.filter(b => !b.isRemote)
    await Promise.all(locals.map(async b => {
      try {
        const [tip] = await ipc.log(repoPath, { limit: 1, refs: [b.name] })
        if (tip) {
          const arr = tips.get(tip.hash) ?? []
          arr.push(b)
          tips.set(tip.hash, arr)
        }
      } catch {}
    }))
    setBranchTips(new Map(tips))
  }, [repoPath])


  const [syncStatus, setSyncStatus] = useState<{ ahead: number; behind: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    ipc.getSyncStatus(repoPath)
      .then(st => { if (!cancelled) setSyncStatus({ ahead: st.ahead, behind: st.behind }) })
      .catch(() => { if (!cancelled) setSyncStatus(null) })
    return () => { cancelled = true }
  }, [repoPath, historyTick])

  const stagedCount = fileStatus.filter(f => f.staged).length
  const unstagedCount = fileStatus.length - stagedCount

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
    setSelectedHashes(new Set())
    setPrimaryCommit(null)
    setLastClickedIdx(null)
    setFiles([])
    ipc.getRemoteUrl(repoPath).then(setRemoteUrl).catch(() => {})
    Promise.all([
      ipc.branchList(repoPath),
      ipc.gitDefaultBranch(repoPath),
    ]).then(([bList, def]) => {
      const locals = bList.filter(b => !b.isRemote)
      setBranches(bList)
      setDefaultBranch(def)
      fetchBranchTips(locals)
    }).catch(() => {})
    loadHistory(INITIAL_LIMIT, new Set())
  }, [repoPath])

  // ── Refresh history when a git op changes HEAD (fetch, pull, push, checkout, etc.) ──
  const historyTickRef  = useRef(historyTick)
  const loadHistoryRef  = useRef(loadHistory)
  useEffect(() => { loadHistoryRef.current = loadHistory }, [loadHistory])
  useEffect(() => {
    if (historyTick === historyTickRef.current) return
    historyTickRef.current = historyTick
    loadHistoryRef.current(limitRef.current)
  }, [historyTick])

  const handleLoadMore = () => {
    limitRef.current += MORE_INCREMENT
    loadHistory(limitRef.current)
  }

  const toggleBranch = (name: string) => {
    if (name === defaultBranch) return
    const next = new Set(selectedBranches)
    next.has(name) ? next.delete(name) : next.add(name)
    setSelectedBranches(next)
    limitRef.current = INITIAL_LIMIT
    loadHistory(INITIAL_LIMIT, next)
  }

  const toggleCollapse = () => {
    if (isCollapsed) {
      // Expand: show all branches
      const next = new Set<string>()
      setSelectedBranches(next)
      limitRef.current = INITIAL_LIMIT
      loadHistory(INITIAL_LIMIT, next)
    } else {
      // Collapse to core: only default + current branch
      const currentBranch = branches.find(b => b.current)?.name
      const core = currentBranch && currentBranch !== defaultBranch
        ? new Set([currentBranch])
        : new Set<string>()
      setSelectedBranches(core)
      limitRef.current = INITIAL_LIMIT
      loadHistory(INITIAL_LIMIT, core)
    }
  }

  const showAllBranches = () => {
    const next = new Set<string>()
    setSelectedBranches(next)
    setFilterOpen(false)
    limitRef.current = INITIAL_LIMIT
    loadHistory(INITIAL_LIMIT, next)
  }

  // Load files for whichever commit is the primary (detail panel)
  const loadPrimary = useCallback(async (commit: CommitEntry) => {
    setPrimaryCommit(commit)
    setFiles([])
    setFilesLoading(true)
    try {
      setFiles(await ipc.commitFiles(repoPath, commit.hash))
    } catch {
      setFiles([])
    } finally {
      setFilesLoading(false)
    }
  }, [repoPath])

  // Click handler — supports single click, Ctrl+click (toggle), Shift+click (range)
  const handleCommitClick = useCallback((commit: CommitEntry, nodeIdx: number, e: React.MouseEvent) => {
    if (e.shiftKey && lastClickedIdx !== null) {
      // Range select: extend selection from anchor to this row
      const min = Math.min(lastClickedIdx, nodeIdx)
      const max = Math.max(lastClickedIdx, nodeIdx)
      setSelectedHashes(new Set(nodes.slice(min, max + 1).map(n => n.commit.hash)))
      // Primary stays as the anchor commit (don't reload files)
    } else if (e.ctrlKey || e.metaKey) {
      // Toggle this commit in/out of selection
      setSelectedHashes(prev => {
        const next = new Set(prev)
        if (next.has(commit.hash)) {
          next.delete(commit.hash)
          if (primaryCommit?.hash === commit.hash) {
            setPrimaryCommit(null); setFiles([])
          }
        } else {
          next.add(commit.hash)
          loadPrimary(commit)
        }
        return next
      })
      setLastClickedIdx(nodeIdx)
    } else {
      // Plain click: single selection
      setSelectedHashes(new Set([commit.hash]))
      setLastClickedIdx(nodeIdx)
      if (primaryCommit?.hash !== commit.hash) loadPrimary(commit)
    }
  }, [lastClickedIdx, nodes, primaryCommit, loadPrimary])

  // ── Multi-select actions ──────────────────────────────────────────────────────

  // Sorted nodes from the selection (oldest → newest unless noted)
  const selectedNodes = useCallback((order: 'asc' | 'desc' = 'asc') => {
    const picked = nodes.filter(n => selectedHashes.has(n.commit.hash))
    return picked.sort((a, b) => order === 'asc'
      ? a.commit.timestamp - b.commit.timestamp
      : b.commit.timestamp - a.commit.timestamp)
  }, [nodes, selectedHashes])

  const handleMultiCherryPick = async () => {
    setMultiCtx(null)
    const sorted = selectedNodes('asc')
    const ok = await dialog.confirm({
      title: `Cherry-pick ${sorted.length} commits`,
      message: `Apply ${sorted.length} commits to the current branch?`,
      confirmLabel: 'Cherry-pick all',
    })
    if (!ok) return
    try {
      for (const n of sorted)
        await opRun(`Cherry-picking ${n.commit.hash.slice(0, 7)}…`, () => ipc.gitCherryPick(repoPath, n.commit.hash))
      bumpSyncTick()
      loadHistoryRef.current(limitRef.current)
    } catch (e) { await dialog.alert({ title: 'Cherry-pick failed', message: String(e) }) }
  }

  const handleMultiRevert = async () => {
    setMultiCtx(null)
    const sorted = selectedNodes('desc') // newest first for clean revert chain
    const ok = await dialog.confirm({
      title: `Revert ${sorted.length} commits`,
      message: `Create ${sorted.length} revert commits on the current branch?`,
      confirmLabel: 'Revert all',
      danger: true,
    })
    if (!ok) return
    try {
      for (const n of sorted)
        await opRun(`Reverting ${n.commit.hash.slice(0, 7)}…`, () => ipc.gitRevert(repoPath, n.commit.hash, false))
      bumpSyncTick()
      loadHistoryRef.current(limitRef.current)
    } catch (e) { await dialog.alert({ title: 'Revert failed', message: String(e) }) }
  }

  const handleMultiStageChanges = async () => {
    setMultiCtx(null)
    const sorted = selectedNodes('asc')
    const ok = await dialog.confirm({
      title: `Stage changes from ${sorted.length} commits`,
      message: `Apply the diff of ${sorted.length} commits to the staging area without committing?`,
      confirmLabel: 'Stage changes',
    })
    if (!ok) return
    try {
      for (const n of sorted)
        await opRun(`Staging ${n.commit.hash.slice(0, 7)}…`, () => ipc.gitCherryPick(repoPath, n.commit.hash, true))
      bumpSyncTick()
    } catch (e) { await dialog.alert({ title: 'Stage failed', message: String(e) }) }
  }

  const handleMultiStashChanges = async () => {
    setMultiCtx(null)
    const sorted = selectedNodes('asc')
    const ok = await dialog.confirm({
      title: `Stash changes from ${sorted.length} commits`,
      message: `Apply the diff of ${sorted.length} commits then stash the result?`,
      confirmLabel: 'Stash changes',
    })
    if (!ok) return
    try {
      for (const n of sorted)
        await opRun(`Staging ${n.commit.hash.slice(0, 7)}…`, () => ipc.gitCherryPick(repoPath, n.commit.hash, true))
      await opRun('Stashing…', () => ipc.stashSave(repoPath, `Changes from ${sorted.length} commits`))
      bumpSyncTick()
    } catch (e) { await dialog.alert({ title: 'Stash failed', message: String(e) }) }
  }

  const handleMultiCopySHAs = () => {
    setMultiCtx(null)
    const sorted = selectedNodes('asc')
    navigator.clipboard.writeText(sorted.map(n => n.commit.hash).join('\n'))
  }

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

      {/* Shared SVG filter defs for the graph */}
      <GraphDefs />

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
          display: 'flex', alignItems: 'center',
          height: 38, paddingLeft: 14, paddingRight: 8,
          borderBottom: '1px solid #252d42', background: '#161a27', flexShrink: 0, gap: 6,
        }}>
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 600,
            color: '#8b94b0', letterSpacing: '0.04em', flexShrink: 0,
          }}>
            {totalLoaded > 0 ? `${totalLoaded} COMMITS` : 'HISTORY'}
          </span>

          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870' }}>
            {currentBranch || 'HEAD'}
          </span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#f5a832' }}>
            WT {stagedCount} staged · {unstagedCount} unstaged
          </span>
          {syncStatus && (
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4d9dff' }}>
              ↑{syncStatus.ahead} ↓{syncStatus.behind}
            </span>
          )}

          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#4e5870',
            display: 'inline-flex', alignItems: 'center', gap: 8,
            minWidth: 0, flex: '1 1 auto', overflow: 'hidden', whiteSpace: 'nowrap',
          }}>
            <span>Legend:</span>
            <LegendItem symbol="★" label="default" color="#4d9dff" />
            <LegendItem symbol="◉" label="head" color="#e8622f" />
            <LegendItem symbol="•" label="branch" color="#2ec573" />
            <LegendItem symbol="⌂" label="working tree" color="#f5a832" />
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <CollapseBtn isCollapsed={isCollapsed} onClick={toggleCollapse} />

            <BranchDropdown
              open={filterOpen}
              onToggleOpen={() => setFilterOpen(o => !o)}
              branches={branches}
              selectedBranches={selectedBranches}
              defaultBranch={defaultBranch}
              branchColors={branchColors}
              onToggleBranch={toggleBranch}
              onShowAll={showAllBranches}
            />

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
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && nodes.length === 0 && (
            <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#4e5870', padding: '16px 12px' }}>
              Loading history…
            </p>
          )}

          {nodes.map((node, idx) => (
            <CommitRow
              key={node.commit.hash}
              node={node}
              selected={selectedHashes.has(node.commit.hash)}
              isPrimary={primaryCommit?.hash === node.commit.hash}
              repoPath={repoPath}
              remoteUrl={remoteUrl}
              onRefresh={() => loadHistory(limitRef.current)}
              onClick={(e) => handleCommitClick(node.commit, idx, e)}
              onMultiContextMenu={selectedHashes.size > 1 && selectedHashes.has(node.commit.hash)
                ? (e) => { e.preventDefault(); setMultiCtx({ x: e.clientX, y: e.clientY }) }
                : undefined}
              graphColW={graphColW}
              branchTips={branchTips}
              branchColors={branchColors}
              branchNamesByColor={branchNamesByColor}
              defaultBranch={defaultBranch}
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
        {selectedHashes.size > 1 && (
          <div style={{
            padding: '6px 14px', background: '#1a1f2e', borderBottom: '1px solid #252d42',
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11.5, color: '#8b94b0',
            display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
          }}>
            <span style={{ fontWeight: 600, color: '#e8622f' }}>{selectedHashes.size}</span>
            commits selected — right-click to act on selection · Esc to clear
          </div>
        )}
        {primaryCommit ? (
          <CommitDetail commit={primaryCommit} files={files} filesLoading={filesLoading} repoPath={repoPath} remoteUrl={remoteUrl} />
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

      {/* Multi-select context menu */}
      {multiCtx && (
        <AppRightSelectionOptions x={multiCtx.x} y={multiCtx.y} minWidth={260} menuRef={multiCtxRef}>
          <div style={{ padding: '4px 12px 6px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#4e5870', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            {selectedHashes.size} commits selected
          </div>
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label={`Cherry-pick ${selectedHashes.size} commits`}    onClick={handleMultiCherryPick} />
          <AppRightSelectionItem label={`Revert ${selectedHashes.size} commits`}         onClick={handleMultiRevert}    danger />
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label={`Stage changes from ${selectedHashes.size} commits`}  onClick={handleMultiStageChanges} />
          <AppRightSelectionItem label={`Stash changes from ${selectedHashes.size} commits`}  onClick={handleMultiStashChanges} />
          <AppRightSelectionSeparator />
          <AppRightSelectionItem label="Copy SHAs"     onClick={handleMultiCopySHAs} />
          <AppRightSelectionItem label="Clear selection" onClick={() => { setMultiCtx(null); setSelectedHashes(new Set()); setPrimaryCommit(null); setFiles([]) }} />
        </AppRightSelectionOptions>
      )}
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
