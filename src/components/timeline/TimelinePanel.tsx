import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ipc, CommitEntry, CommitFileChange, BranchInfo, BlameEntry, FileStatus, DiffContent } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { useRepoStore } from '@/stores/repoStore'
import { useLockStore } from '@/stores/lockStore'
import { useAuthStore } from '@/stores/authStore'
import { useDialogStore } from '@/stores/dialogStore'
import { computeGraph, GraphNode, ROW_H, DOT_R, GRAPH_PAD, LineSegment } from '@/components/history/graphLayout'
import { TextDiff } from '@/components/diff/TextDiff'
import { FileTree } from '@/components/changes/FileTree'
import { CommitBox } from '@/components/changes/CommitBox'
import { StashPanel } from '@/components/changes/StashPanel'

// ── Types ─────────────────────────────────────────────────────────────────────

type LeftSel =
  | { kind: 'working-tree' }
  | { kind: 'commit'; commit: CommitEntry }

type CenterFile =
  | { kind: 'working'; file: FileStatus }
  | { kind: 'commit'; file: CommitFileChange; commitHash: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

const INITIAL_LIMIT = 300
const MORE_INC = 300
const MAIN_BRANCH_COLOR = '#7dd3fc'
const TL_LANE_W = 10
const LEFT_WIDTH_MAX = 860
const CENTER_WIDTH_MIN = 240
const CENTER_WIDTH_MAX = 520
const DEFAULT_LEFT_WIDTH = 360

const ASSET_EXTS = new Set([
  'uasset', 'umap', 'upk', 'udk',
  'png', 'jpg', 'jpeg', 'tga', 'bmp', 'tiff', 'tif', 'dds', 'exr', 'hdr',
  'wav', 'mp3', 'ogg', 'flac',
  'mp4', 'mov', 'avi', 'mkv',
])

function isAsset(filePath: string): boolean {
  return ASSET_EXTS.has(filePath.split('.').pop()?.toLowerCase() ?? '')
}

function parseGHSlug(url: string): string | null {
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)
  return m ? m[1] : null
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

function compactFilePath(filePath: string, parentCount = 2): string {
  const parts = filePath.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= parentCount + 1) return filePath
  return `.../${parts.slice(-(parentCount + 1)).join('/')}`
}

// Shared SVG filter defs; placed once above the list.
function GraphDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute', overflow: 'hidden' }}>
      <defs>
        <filter id="tl-glow-main" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.8" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
    </svg>
  )
}

function linePath(seg: LineSegment, isTop: boolean): string {
  const x1 = GRAPH_PAD + seg.from * TL_LANE_W + TL_LANE_W / 2
  const x2 = GRAPH_PAD + seg.to   * TL_LANE_W + TL_LANE_W / 2
  const y1 = isTop ? 0         : ROW_H / 2
  const y2 = isTop ? ROW_H / 2 : ROW_H
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`
  return `M ${x1} ${y1} C ${x1} ${y2} ${x2} ${y1} ${x2} ${y2}`
}

function firstParentHashes(commits: CommitEntry[], tipHash: string | undefined): Set<string> {
  const hashes = new Set<string>()
  if (!tipHash) return hashes

  const byHash = new Map(commits.map(commit => [commit.hash, commit]))
  let cursor: string | undefined = tipHash
  while (cursor && !hashes.has(cursor)) {
    const commit = byHash.get(cursor)
    if (!commit) break
    hashes.add(cursor)
    cursor = commit.parentHashes[0]
  }
  return hashes
}

function remapGraphWithMainLeft(graph: GraphNode[], mainHashes: Set<string>): GraphNode[] {
  if (graph.length === 0 || mainHashes.size === 0) return graph

  const allLanes = new Set<number>()
  const mainTipIndex = graph.findIndex(node => mainHashes.has(node.commit.hash))
  if (mainTipIndex === -1) return graph

  const mainLane = graph[mainTipIndex].lane
  for (const node of graph) {
    allLanes.add(node.lane)
    for (const seg of [...node.topLines, ...node.bottomLines]) {
      allLanes.add(seg.from)
      allLanes.add(seg.to)
    }
  }

  const orderedNonMain = [...allLanes].filter(lane => lane !== mainLane).sort((a, b) => a - b)
  const nonMainLaneMap = new Map(orderedNonMain.map((lane, index) => [lane, index + 1]))
  const mapNonMainLane = (lane: number) => nonMainLaneMap.get(lane) ?? orderedNonMain.length + 1

  return graph.map((node, rowIndex) => {
    const nodeIsMain = mainHashes.has(node.commit.hash)
    const mapSegment = (seg: LineSegment): LineSegment => {
      const isMain = rowIndex >= mainTipIndex && seg.from === mainLane && seg.to === mainLane
      const fromMainNode = nodeIsMain && seg.from === mainLane
      const toMainNode = nodeIsMain && seg.to === mainLane
      return {
        ...seg,
        from: isMain || fromMainNode ? 0 : mapNonMainLane(seg.from),
        to: isMain || toMainNode ? 0 : mapNonMainLane(seg.to),
        color: isMain ? MAIN_BRANCH_COLOR : seg.color,
        branchKey: isMain ? 'main' : seg.branchKey,
        isMain,
      }
    }
    const topLines = node.topLines.map(mapSegment)
    const bottomLines = node.bottomLines.map(mapSegment)
    const isMain = nodeIsMain
    const lane = isMain ? 0 : mapNonMainLane(node.lane)
    const maxLane = Math.max(
      lane,
      ...topLines.flatMap(l => [l.from, l.to]),
      ...bottomLines.flatMap(l => [l.from, l.to]),
      0,
    )
    return {
      ...node,
      lane,
      color: isMain ? MAIN_BRANCH_COLOR : node.color,
      isMain,
      topLines,
      bottomLines,
      maxLane,
    }
  })
}

function compactGraphLanes(graph: GraphNode[]): GraphNode[] {
  if (graph.length === 0) return graph

  const visibleLanes = new Set<number>()
  for (const node of graph) {
    visibleLanes.add(node.lane)
    for (const seg of [...node.topLines, ...node.bottomLines]) {
      visibleLanes.add(seg.from)
      visibleLanes.add(seg.to)
    }
  }

  const branchLanes = [...visibleLanes].filter(lane => lane !== 0).sort((a, b) => a - b)
  const laneMap = new Map(branchLanes.map((lane, index) => [lane, index + 1]))
  const mapLane = (lane: number) => lane === 0 ? 0 : laneMap.get(lane) ?? branchLanes.length + 1

  return graph.map(node => {
    const topLines = node.topLines.map(seg => ({ ...seg, from: mapLane(seg.from), to: mapLane(seg.to) }))
    const bottomLines = node.bottomLines.map(seg => ({ ...seg, from: mapLane(seg.from), to: mapLane(seg.to) }))
    const lane = mapLane(node.lane)
    const maxLane = Math.max(
      lane,
      ...topLines.flatMap(l => [l.from, l.to]),
      ...bottomLines.flatMap(l => [l.from, l.to]),
      0,
    )
    return { ...node, lane, topLines, bottomLines, maxLane }
  })
}

function pruneGraphToBranchKeys(graph: GraphNode[], allowedBranchKeys: Set<string>): GraphNode[] {
  const rows = allowedBranchKeys.size === 0
    ? graph.filter(node => node.isMain)
    : graph.filter(node => node.isMain || allowedBranchKeys.has(node.color))

  return compactGraphLanes(rows
    .map(node => {
      const mapSegment = (seg: LineSegment): LineSegment | null => {
        const branchVisible = seg.isMain || allowedBranchKeys.has(seg.branchKey ?? seg.color)
        if (!branchVisible) return null
        if (seg.isMain || seg.from === seg.to) return seg
        const fromVisibleNode = seg.from === node.lane
        const toVisibleNode = seg.to === node.lane
        if (fromVisibleNode || toVisibleNode) {
          return { ...seg, from: fromVisibleNode ? seg.from : 0, to: toVisibleNode ? seg.to : 0 }
        }
        return null
      }
      const topLines = node.topLines.map(mapSegment).filter((seg): seg is LineSegment => !!seg)
      const bottomLines = node.bottomLines.map(mapSegment).filter((seg): seg is LineSegment => !!seg)
      const maxLane = Math.max(
        node.lane,
        ...topLines.flatMap(l => [l.from, l.to]),
        ...bottomLines.flatMap(l => [l.from, l.to]),
        0,
      )
      return { ...node, topLines, bottomLines, maxLane }
    }))
}

function GraphCell({ node, graphColW, hoveredBranchKey, branchHoverLabels, onHoverBranch }: {
  node: GraphNode
  graphColW: number
  hoveredBranchKey: string | null
  branchHoverLabels: Map<string, string>
  onHoverBranch: (branchKey: string | null) => void
}) {
  const [hoveredSeg, setHoveredSeg] = useState<{ x: number; label: string } | null>(null)
  const isMerge = node.commit.parentHashes.length > 1
  const cx = GRAPH_PAD + node.lane * TL_LANE_W + TL_LANE_W / 2
  const cy = ROW_H / 2
  const dotR = DOT_R + 0.5
  const renderLine = (seg: LineSegment, isTop: boolean, key: string) => {
    const branchKey = seg.branchKey ?? seg.color
    const branchLabel = branchHoverLabels.get(branchKey) ?? (seg.isMain ? 'Main branch' : 'Branch lane')
    const isHovered = hoveredBranchKey === branchKey
    const isDimmed = !!hoveredBranchKey && !isHovered
    const strokeWidth = isHovered ? (seg.isMain ? 4.2 : 3.4) : seg.isMain ? 2.7 : 1.65
    const strokeOpacity = isDimmed ? 0.2 : isHovered ? 0.98 : seg.isMain ? 0.86 : 0.56
    const path = linePath(seg, isTop)
    return (
      <g key={key}>
        <path d={path}
          stroke={seg.color} fill="none"
          strokeWidth={strokeWidth}
          strokeOpacity={strokeOpacity}
          strokeLinecap="round"
          pointerEvents="none"
          style={{
            transition: 'stroke-opacity 90ms ease, stroke-width 90ms ease, filter 90ms ease',
            filter: seg.isMain
              ? 'drop-shadow(0 0 4px rgba(125,211,252,0.5))'
              : isHovered ? 'drop-shadow(0 0 3px rgba(255,255,255,0.3))' : 'none',
          }}
        />
        <path d={path}
          stroke="transparent" fill="none"
          strokeWidth={10}
          strokeLinecap="round"
          style={{ cursor: 'help' }}
          onMouseEnter={() => {
            setHoveredSeg({
              x: GRAPH_PAD + ((seg.from + seg.to) / 2) * TL_LANE_W + TL_LANE_W / 2,
              label: branchLabel,
            })
            onHoverBranch(branchKey)
          }}
          onMouseMove={() => {
            if (hoveredBranchKey !== branchKey) onHoverBranch(branchKey)
          }}
          onMouseLeave={() => {
            setHoveredSeg(null)
            onHoverBranch(null)
          }}
        />
      </g>
    )
  }
  return (
    <svg width={graphColW} height={ROW_H} style={{ flexShrink: 0, overflow: 'visible', display: 'block', position: 'relative', zIndex: 1 }}>
      {node.topLines.map((seg, i) => renderLine(seg, true, `t${i}`))}
      {node.bottomLines.map((seg, i) => renderLine(seg, false, `b${i}`))}
      {isMerge ? (
        <g>
          <polygon
            points={`${cx},${cy - dotR - 1} ${cx + dotR + 1},${cy} ${cx},${cy + dotR + 1} ${cx - dotR - 1},${cy}`}
            fill="#10131c" stroke={node.color} strokeWidth={node.isMain ? 2.6 : 1.8}
            filter={node.isMain ? 'url(#tl-glow-main)' : undefined}
          />
          <circle cx={cx} cy={cy} r={2} fill={node.color} />
        </g>
      ) : (
        <circle cx={cx} cy={cy} r={dotR}
          fill="#10131c" stroke={node.color}
          strokeWidth={node.isMain ? 3 : 2}
          filter={node.isMain ? 'url(#tl-glow-main)' : undefined}
        />
      )}
      {hoveredSeg && (
        <g style={{ pointerEvents: 'none' }}>
          {(() => {
            const padX = 8
            const charW = 6.2
            const tooltipW = Math.min(Math.max(92, hoveredSeg.label.length * charW + padX * 2), Math.max(92, graphColW - 4))
            const tooltipX = Math.max(2, Math.min(graphColW - tooltipW - 2, hoveredSeg.x - tooltipW / 2))
            return (
              <>
                <rect x={tooltipX} y={2} width={tooltipW} height={20} rx={5} fill="#0f1420f5" stroke={hoveredBranchKey === 'main' ? MAIN_BRANCH_COLOR : '#3b4b6d'} />
                <text x={tooltipX + tooltipW / 2} y={15} textAnchor="middle" fill="#e7ecfa" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
                  {hoveredSeg.label}
                </text>
              </>
            )
          })()}
        </g>
      )}
    </svg>
  )
}

const FILE_STATUS_COLOR: Record<string, string> = {
  M: '#f5a832', A: '#2ec573', D: '#e84545', R: '#4d9dff', C: '#4d9dff',
}
const FILE_STATUS_BG: Record<string, string> = {
  M: 'rgba(245,168,50,0.12)', A: 'rgba(46,197,115,0.12)', D: 'rgba(232,69,69,0.12)',
  R: 'rgba(77,157,255,0.12)', C: 'rgba(77,157,255,0.12)',
}

function DragHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 3, flexShrink: 0, cursor: 'col-resize', zIndex: 5,
        background: hover ? 'rgba(232,98,47,0.5)' : 'transparent',
        transition: 'background 0.15s',
      }}
    />
  )
}

// ── Context menu primitives ────────────────────────────────────────────────────

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
        whiteSpace: 'nowrap',
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

const CTX_MENU_STYLE: React.CSSProperties = {
  position: 'fixed', zIndex: 200,
  background: '#1d2235', border: '1px solid #2f3a54',
  borderRadius: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
  padding: '4px 0', minWidth: 230,
}

// ── Blame modal ────────────────────────────────────────────────────────────────

function BlameModal({ filePath, commitHash, repoPath, onClose }: {
  filePath: string; commitHash: string; repoPath: string; onClose: () => void
}) {
  const [lines,   setLines]   = useState<BlameEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    setLoading(true); setError(null)
    ipc.gitBlame(repoPath, filePath, commitHash)
      .then(entries => { setLines(entries); setLoading(false) })
      .catch(e => { setError(String(e)); setLoading(false) })
  }, [repoPath, filePath, commitHash])

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: 'min(920px, 92vw)', height: 'min(700px, 88vh)',
        background: '#161a27', border: '1px solid #2f3a54',
        borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          height: 44, paddingLeft: 16, paddingRight: 12, flexShrink: 0,
          borderBottom: '1px solid #252d42', background: '#10131c',
        }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#8b94b0' }}>
            blame: {filePath}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#4e5870', fontSize: 20, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#dde1f0')}
            onMouseLeave={e => (e.currentTarget.style.color = '#4e5870')}
          >×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
          {loading ? (
            <p style={{ padding: 16, color: '#4e5870' }}>Loading blame…</p>
          ) : error ? (
            <p style={{ padding: 16, color: '#e84545' }}>{error}</p>
          ) : lines.length === 0 ? (
            <p style={{ padding: 16, color: '#4e5870' }}>No blame data available</p>
          ) : lines.map((entry, i) => {
            const prev = lines[i - 1]
            const sameBlock = !!prev && prev.hash === entry.hash
            const col = authorColor(entry.author)
            return (
              <div key={i} style={{ display: 'flex', minHeight: 22, borderBottom: '1px solid #0d0f1560', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)' }}>
                <div style={{
                  width: 210, flexShrink: 0, paddingLeft: 10, paddingRight: 8,
                  display: 'flex', alignItems: 'center', gap: 6,
                  borderRight: `2px solid ${sameBlock ? '#1e2436' : col + '55'}`,
                  background: sameBlock ? 'transparent' : col + '0c',
                  opacity: sameBlock ? 0.35 : 1,
                }}>
                  <span style={{ color: col, fontSize: 10, flexShrink: 0 }}>{sameBlock ? '' : entry.hash.slice(0, 7)}</span>
                  {!sameBlock && <>
                    <span style={{ color: '#8b94b0', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{entry.author}</span>
                    <span style={{ color: '#4e5870', fontSize: 9, flexShrink: 0 }}>{new Date(entry.timestamp).toLocaleDateString()}</span>
                  </>}
                </div>
                <div style={{ width: 42, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 8, color: '#3a4260', fontSize: 11, borderRight: '1px solid #1e2436' }}>
                  {entry.lineNo}
                </div>
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

// ── Working tree graph row ────────────────────────────────────────────────────

const WT_ROW_H = 58

function WorkingTreeGraphRow({ selected, changeCount, graphColW, lane = 0, onClick }: {
  selected: boolean; changeCount: number; graphColW: number; lane?: number; onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const hasChanges = changeCount > 0
  const accent = hasChanges ? '#e8622f' : '#2ec573'
  const cx = GRAPH_PAD + lane * TL_LANE_W + TL_LANE_W / 2
  const cy = Math.round(WT_ROW_H * 0.40)

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', height: WT_ROW_H, flexShrink: 0,
        borderLeft: `2px solid ${selected ? accent : 'transparent'}`,
        borderBottom: '1px solid #1e2436',
        background: selected ? 'rgba(232,98,47,0.06)' : hover ? '#191d2a' : 'transparent',
        cursor: 'pointer', transition: 'background 0.1s',
      }}
    >
      {/* Graph column — diamond + connecting line down to first commit */}
      <svg width={graphColW} height={WT_ROW_H} style={{ flexShrink: 0, overflow: 'visible', display: 'block' }}>
        <line
          x1={cx} y1={cy + 6} x2={cx} y2={WT_ROW_H}
          stroke={accent} strokeWidth={1.75} strokeOpacity={0.45}
        />
        <polygon
          points={`${cx},${cy - 6} ${cx + 5.5},${cy} ${cx},${cy + 6} ${cx - 5.5},${cy}`}
          fill={accent} fillOpacity={selected ? 0.9 : 0.65}
        />
      </svg>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0, paddingLeft: 5, paddingRight: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12.5, fontWeight: 600,
            color: selected ? '#dde1f0' : '#9ba4bc',
          }}>Working Tree</span>
          {hasChanges && (
            <span style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, fontWeight: 700,
              background: 'rgba(232,98,47,0.15)', color: '#e8622f',
              border: '1px solid rgba(232,98,47,0.3)', borderRadius: 8,
              minWidth: 18, height: 16, paddingLeft: 5, paddingRight: 5,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>{changeCount}</span>
          )}
        </div>
        <span style={{
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5,
          color: hasChanges ? `${accent}bb` : '#2e3a4e',
        }}>
          {hasChanges
            ? `${changeCount} uncommitted change${changeCount !== 1 ? 's' : ''}`
            : 'Nothing to commit'}
        </span>
      </div>
    </div>
  )
}

// ── Branch filter components ──────────────────────────────────────────────────

const TL_BRANCH_COLORS = ['#4d9dff', '#e8622f', '#2ec573', '#a27ef0', '#f5a832', '#1abc9c', '#e91e63', '#00bcd4']

function isLiveOriginBranch(branch: BranchInfo): boolean {
  return branch.isRemote && (branch.remoteName === 'origin' || branch.name.startsWith('origin/'))
}

function tlBranchShortName(name: string): string {
  const last = name.split('/').pop() ?? name
  return last.length > 10 ? last.slice(0, 10) + '…' : last
}

function TLBranchDropdownRow({ branch, checked, isDefault, bCol, onToggle }: {
  branch: BranchInfo; checked: boolean; isDefault?: boolean; bCol: string; onToggle: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9,
        padding: '6px 12px', borderBottom: '1px solid #1a1f2e',
        cursor: 'pointer',
        background: hover ? '#1e2436' : 'transparent',
        opacity: checked ? 1 : 0.5,
        transition: 'opacity 0.12s, background 0.1s',
      }}
    >
      <label
        style={{ width: 13, height: 13, position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
      >
        <input
          type="checkbox"
          checked={checked}
          onClick={e => e.stopPropagation()}
          onChange={e => {
            e.stopPropagation()
            onToggle()
          }}
          style={{
            appearance: 'none',
            margin: 0,
            width: 13,
            height: 13,
            borderRadius: 3,
            border: `1.5px solid ${checked ? bCol : '#2f3a54'}`,
            background: checked ? bCol : 'transparent',
            transition: 'all 0.12s',
            cursor: 'pointer',
          }}
        />
        {checked && (
          <svg width="8" height="6" viewBox="0 0 8 6" fill="none" style={{ position: 'absolute', pointerEvents: 'none' }}>
            <path d="M1 3L3 5L7 1" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </label>
      <span style={{ width: 3, height: 14, borderRadius: 2, background: bCol, flexShrink: 0 }} />
      <button
        type="button"
        onClick={onToggle}
        style={{
          all: 'unset',
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#c8cdd8',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          cursor: 'pointer',
        }}
        title={branch.name}
      >{branch.displayName || branch.name}</button>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {isDefault && (
          <span style={{
            background: 'rgba(125,211,252,0.14)', color: MAIN_BRANCH_COLOR,
            border: '1px solid rgba(125,211,252,0.45)',
            borderRadius: 3, padding: '0 4px',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
          }}>main</span>
        )}
        {branch.hasLocal && (
          <span style={{
            background: `${bCol}22`, color: bCol, border: `1px solid ${bCol}45`,
            borderRadius: 3, padding: '0 4px',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
          }}>local</span>
        )}
      </div>
    </div>
  )
}

function TLBranchDropdown({ open, onToggleOpen, branches, selectedBranches, defaultBranch, branchColors, onToggleBranch, onShowAll, onHideAll }: {
  open: boolean; onToggleOpen: () => void
  branches: BranchInfo[]; selectedBranches: Set<string>; defaultBranch: string
  branchColors: Map<string, string>; onToggleBranch: (name: string) => void; onShowAll: () => void; onHideAll: () => void
}) {
  const allBranches = branches
  const visibleCount = allBranches.filter(b => selectedBranches.has(b.name)).length
  const sorted = [
    ...allBranches.filter(b => b.name === defaultBranch),
    ...allBranches.filter(b => b.name !== defaultBranch),
  ]
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={onToggleOpen}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          height: 22, paddingLeft: 8, paddingRight: 6, borderRadius: 4,
          background: open ? '#1e2436' : 'transparent',
          border: `1px solid ${open ? '#2f3a54' : '#252d42'}`,
          color: '#4e5870',
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10.5, fontWeight: 500,
          cursor: 'pointer', transition: 'all 0.12s', flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        <span>{visibleCount} branch{visibleCount !== 1 ? 'es' : ''}</span>
        <svg width="7" height="4" viewBox="0 0 8 5" fill="none"
          style={{ transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>
          <path d="M1 1L4 4L7 1" stroke="#3a4260" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <>
          <div onClick={onToggleOpen} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 91,
            background: '#1d2235', border: '1px solid #2f3a54',
            borderRadius: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
            minWidth: 230, overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 12px 5px', borderBottom: '1px solid #1e2436',
            }}>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700,
                color: '#3a4260', letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>Filter branches</span>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={onHideAll} style={{
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#8f99b3',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  whiteSpace: 'nowrap',
                }}>Hide all</button>
                <button onClick={onShowAll} style={{
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#e8622f',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  whiteSpace: 'nowrap',
                }}>Show all</button>
              </div>
            </div>
            {sorted.map(b => {
              const bCol = branchColors.get(b.name) ?? '#4d9dff'
              const isChecked = selectedBranches.has(b.name)
              return (
                <TLBranchDropdownRow key={b.name} branch={b} checked={isChecked} isDefault={b.displayName === defaultBranch || b.name === defaultBranch}
                  bCol={bCol} onToggle={() => onToggleBranch(b.name)} />
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// ── Left commit row ───────────────────────────────────────────────────────────

function LeftCommitRow({ node, selected, repoPath, remoteUrl, onRefresh, onClick,
  graphColW, branchTips, branchColors, defaultBranch, hoveredBranchKey, branchHoverLabels, onHoverBranch, needsPush, needsPull }: {
  node: GraphNode; selected: boolean
  repoPath: string; remoteUrl: string | null
  onRefresh: () => void; onClick: () => void
  graphColW: number
  branchTips: Map<string, BranchInfo[]>
  branchColors: Map<string, string>
  defaultBranch: string
  hoveredBranchKey: string | null
  branchHoverLabels: Map<string, string>
  onHoverBranch: (branchKey: string | null) => void
  needsPush: boolean
  needsPull: boolean
}) {
  const [hover, setHover] = useState(false)
  const [ctx, setCtx]     = useState<{ x: number; y: number } | null>(null)
  const ctxRef = useRef<HTMLDivElement>(null)
  const dialog = useDialogStore()
  const opRun  = useOperationStore(s => s.run)
  const bumpSyncTick = useRepoStore(s => s.bumpSyncTick)

  const { commit } = node
  const col        = authorColor(commit.author)
  const ini        = initials(commit.author)
  const isMerge    = commit.parentHashes.length > 1
  const shortHash  = commit.hash.slice(0, 7)
  const ghSlug     = remoteUrl ? parseGHSlug(remoteUrl) : null
  const tipBranches = branchTips.get(commit.hash) ?? []

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
      placeholder: 'soft / mixed / hard', defaultValue: 'mixed', confirmLabel: 'Reset',
    })
    if (!mode) return
    const m = mode.trim().toLowerCase()
    if (m !== 'soft' && m !== 'mixed' && m !== 'hard') {
      await dialog.alert({ title: 'Invalid mode', message: `"${mode}" is not valid. Enter soft, mixed, or hard.` })
      return
    }
    try {
      await opRun(`Resetting to ${shortHash} (${m})…`, () => ipc.gitResetTo(repoPath, commit.hash, m as 'soft' | 'mixed' | 'hard'))
      bumpSyncTick(); onRefresh()
    } catch (e) { await dialog.alert({ title: 'Reset failed', message: String(e) }) }
  }

  const handleCheckout = async () => {
    close()
    const ok = await dialog.confirm({
      title: 'Checkout commit', message: `Checkout ${shortHash}?`,
      detail: 'This creates a detached HEAD state. Create a branch if you want to keep changes from here.',
      confirmLabel: 'Checkout',
    })
    if (!ok) return
    try {
      await opRun('Checking out commit…', () => ipc.checkout(repoPath, commit.hash))
      bumpSyncTick(); onRefresh()
    } catch (e) { await dialog.alert({ title: 'Checkout failed', message: String(e) }) }
  }

  const handleRevert = async () => {
    close()
    const ok = await dialog.confirm({
      title: 'Revert commit', message: `Create a new commit that undoes ${shortHash}?`,
      detail: commit.message, confirmLabel: 'Revert',
    })
    if (!ok) return
    try {
      await opRun('Reverting commit…', () => ipc.gitRevert(repoPath, commit.hash, false))
      bumpSyncTick(); onRefresh()
    } catch (e) { await dialog.alert({ title: 'Revert failed', message: String(e) }) }
  }

  const handleCreateBranch = async () => {
    close()
    const name = await dialog.prompt({
      title: 'Create branch from commit', message: `New branch starting at ${shortHash}`,
      placeholder: 'branch-name', confirmLabel: 'Create',
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
      title: 'Cherry-pick commit', message: `Apply changes from ${shortHash} onto the current branch?`,
      detail: commit.message, confirmLabel: 'Cherry-pick',
    })
    if (!ok) return
    try {
      await opRun('Cherry-picking…', () => ipc.gitCherryPick(repoPath, commit.hash))
      bumpSyncTick(); onRefresh()
    } catch (e) { await dialog.alert({ title: 'Cherry-pick failed', message: String(e) }) }
  }

  const handleUndoCommit = async () => {
    close()
    if (commit.parentHashes.length === 0) {
      await dialog.alert({ title: 'Cannot undo', message: 'This is the initial commit and has no parent to reset to.' })
      return
    }
    const ok = await dialog.confirm({
      title: 'Undo commit', message: `Undo "${commit.message.slice(0, 60)}"?`,
      detail: `Soft-resets HEAD to the parent commit (${commit.parentHashes[0].slice(0, 7)}), keeping all changes staged.`,
      confirmLabel: 'Undo commit',
    })
    if (!ok) return
    try {
      await opRun('Undoing commit…', () => ipc.gitResetTo(repoPath, commit.parentHashes[0], 'soft'))
      bumpSyncTick(); onRefresh()
    } catch (e) { await dialog.alert({ title: 'Undo failed', message: String(e) }) }
  }

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={onClick}
        onContextMenu={e => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }) }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={`${commit.author} · ${new Date(commit.timestamp).toLocaleString()}`}
        style={{
          display: 'flex', alignItems: 'center', height: ROW_H,
          borderLeft: `2px solid ${selected ? '#e8622f' : 'transparent'}`,
          borderBottom: '1px solid #1a1f2e',
          background: selected ? '#1e2539' : hover ? '#191d2a' : 'transparent',
          cursor: 'pointer', transition: 'background 0.1s',
        }}
      >
        <div style={{ width: graphColW, height: ROW_H, flexShrink: 0, overflow: 'hidden' }}>
          <GraphCell
            node={node}
            graphColW={graphColW}
            hoveredBranchKey={hoveredBranchKey}
            branchHoverLabels={branchHoverLabels}
            onHoverBranch={onHoverBranch}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0, paddingLeft: 5, paddingRight: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, overflow: 'hidden' }}>
            {/* Branch tip pills */}
            {tipBranches.map(b => {
              const bCol = branchColors.get(b.name) ?? '#4d9dff'
              const isDefaultTip = b.name === defaultBranch
              const icon = b.name === defaultBranch ? '★' : b.current ? '◉' : '•'
              return (
                <span key={b.name} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0,
                  background: isDefaultTip ? `${MAIN_BRANCH_COLOR}22` : `${bCol}16`,
                  color: isDefaultTip ? MAIN_BRANCH_COLOR : bCol,
                  border: `1px solid ${isDefaultTip ? MAIN_BRANCH_COLOR : bCol}${isDefaultTip ? '80' : '40'}`,
                  borderRadius: 3, padding: '0 5px',
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: isDefaultTip ? 800 : 500,
                  boxShadow: isDefaultTip ? '0 0 8px rgba(125,211,252,0.2)' : 'none',
                }}>
                  <span style={{ fontSize: 8 }}>{icon}</span>
                  {tlBranchShortName(b.name)}
                </span>
              )
            })}
            <span style={{
              fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12,
              fontWeight: selected ? 600 : 400, color: '#c8cdd8',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>{commit.message}</span>
            {needsPush && (
              <span
                title="Needs push"
                style={{
                  width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(125, 211, 252, 0.14)',
                  border: '1px solid rgba(125, 211, 252, 0.5)',
                  color: '#c4eeff', fontSize: 11, fontWeight: 700, lineHeight: 1,
                  boxShadow: '0 0 0 1px rgba(9, 12, 19, 0.35) inset',
                }}
              >↑</span>
            )}
            {needsPull && (
              <span
                title="Needs pull"
                style={{
                  width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(252, 165, 165, 0.14)',
                  border: '1px solid rgba(252, 165, 165, 0.5)',
                  color: '#ffd1d1', fontSize: 11, fontWeight: 700, lineHeight: 1,
                  boxShadow: '0 0 0 1px rgba(9, 12, 19, 0.35) inset',
                }}
              >↓</span>
            )}
            {isMerge && (
              <span style={{
                background: 'rgba(162,126,240,0.12)', color: '#a27ef0',
                border: '1px solid rgba(162,126,240,0.25)', borderRadius: 3,
                fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 600, flexShrink: 0,
                paddingLeft: 4, paddingRight: 4,
              }}>M</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              background: `${col}22`, border: `1px solid ${col}44`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, fontWeight: 700, color: col,
            }}>{ini}</span>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#4e5870' }}>
              {timeAgo(commit.timestamp)}
            </span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#3a4260', marginLeft: 'auto', paddingRight: 2, flexShrink: 0 }}>
              {shortHash}
            </span>
          </div>
        </div>
      </div>

      {ctx && (
        <div ref={ctxRef} style={{ ...CTX_MENU_STYLE, top: ctx.y, left: ctx.x }}>
          <CtxItem label="Undo commit (soft reset)"     onClick={handleUndoCommit} />
          <CtxItem label="Reset to commit…"             onClick={handleResetTo} danger />
          <CtxItem label="Checkout commit"              onClick={handleCheckout} />
          <CtxSep />
          <CtxItem label="Revert changes in commit"     onClick={handleRevert} />
          <CtxItem label="Create branch from commit…"   onClick={handleCreateBranch} />
          <CtxItem label="Cherry-pick commit…"          onClick={handleCherryPick} />
          <CtxSep />
          <CtxItem label="Copy SHA"                     onClick={() => { navigator.clipboard.writeText(commit.hash); close() }} />
          <CtxItem
            label="View on GitHub"
            onClick={ghSlug ? () => { ipc.openExternal(`https://github.com/${ghSlug}/commit/${commit.hash}`); close() } : undefined}
            disabled={!ghSlug}
            title={ghSlug ? undefined : 'No GitHub remote detected'}
          />
        </div>
      )}
    </div>
  )
}

// ── Center: commit file row ───────────────────────────────────────────────────

function CommitFileRow({ f, selected, repoPath, commitHash, remoteUrl, onClick }: {
  f: CommitFileChange; selected: boolean
  repoPath: string; commitHash: string; remoteUrl: string | null
  onClick: () => void
}) {
  const [hover,  setHover]  = useState(false)
  const [ctx,    setCtx]    = useState<{ x: number; y: number } | null>(null)
  const [blame,  setBlame]  = useState(false)
  const ctxRef = useRef<HTMLDivElement>(null)
  const ghSlug = remoteUrl ? parseGHSlug(remoteUrl) : null

  useEffect(() => {
    if (!ctx) return
    const handler = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtx(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctx])

  const close = () => setCtx(null)

  const absPath = repoPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + f.path

  const label = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
  const displayLabel = f.oldPath
    ? `${compactFilePath(f.oldPath)} → ${compactFilePath(f.path)}`
    : compactFilePath(f.path)
  const sc = FILE_STATUS_COLOR[f.status] ?? '#8b94b0'
  const sb = FILE_STATUS_BG[f.status]   ?? 'transparent'

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={onClick}
        onContextMenu={e => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }) }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          height: 34, paddingLeft: 14, paddingRight: 12,
          borderBottom: '1px solid #1a1f2e',
          borderLeft: `2px solid ${selected ? '#e8622f' : 'transparent'}`,
          background: selected ? '#1e2539' : hover ? '#191d2a' : 'transparent',
          cursor: 'pointer', transition: 'background 0.1s',
        }}
      >
        <span style={{
          width: 16, height: 16, borderRadius: 3, flexShrink: 0,
          background: sb, color: sc,
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{f.status}</span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5,
          color: '#c8cdd8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }} title={label}>{displayLabel}</span>
      </div>

      {ctx && (
        <div ref={ctxRef} style={{ ...CTX_MENU_STYLE, top: ctx.y, left: ctx.x }}>
          <CtxItem label="Blame" onClick={() => { setBlame(true); close() }} />
          <CtxSep />
          <CtxItem label="Show in Explorer"            onClick={() => { ipc.showInFolder(absPath); close() }} />
          <CtxItem label="Open in Visual Studio Code"  onClick={() => { ipc.openExternal('vscode://file/' + absPath); close() }} />
          <CtxItem label="Open with default program"   onClick={() => { ipc.openPath(absPath); close() }} />
          <CtxSep />
          <CtxItem label="Copy file path"              onClick={() => { navigator.clipboard.writeText(absPath); close() }} />
          <CtxItem label="Copy relative file path"     onClick={() => { navigator.clipboard.writeText(f.path); close() }} />
          <CtxSep />
          <CtxItem
            label="View on GitHub"
            onClick={ghSlug ? () => { ipc.openExternal(`https://github.com/${ghSlug}/blob/${commitHash}/${f.path}`); close() } : undefined}
            disabled={!ghSlug}
            title={ghSlug ? undefined : 'No GitHub remote detected'}
          />
        </div>
      )}

      {blame && (
        <BlameModal filePath={f.path} commitHash={commitHash} repoPath={repoPath} onClose={() => setBlame(false)} />
      )}
    </div>
  )
}

// ── Blame section ─────────────────────────────────────────────────────────────

interface BlameBlock {
  hash: string
  author: string
  timestamp: number
  summary: string
  fromLine: number
  toLine: number
}

function groupBlame(entries: BlameEntry[]): BlameBlock[] {
  const blocks: BlameBlock[] = []
  for (const e of entries) {
    const last = blocks[blocks.length - 1]
    if (last && last.hash === e.hash) {
      last.toLine = e.lineNo
    } else {
      blocks.push({ hash: e.hash, author: e.author, timestamp: e.timestamp, summary: e.summary, fromLine: e.lineNo, toLine: e.lineNo })
    }
  }
  return blocks
}

function BlameSection({ entries, loading }: { entries: BlameEntry[]; loading: boolean }) {
  const blocks = groupBlame(entries)
  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid #1e2436', background: '#0d0f15', maxHeight: 220, overflowY: 'auto' }}>
      <div style={{
        display: 'flex', alignItems: 'center', height: 30, paddingLeft: 12, paddingRight: 10,
        borderBottom: '1px solid #1e2436', position: 'sticky', top: 0, background: '#0d0f15', zIndex: 1,
      }}>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#3a4260', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Blame
        </span>
        {!loading && entries.length > 0 && (
          <span style={{ marginLeft: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#3a4260' }}>
            {blocks.length} block{blocks.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      {loading ? (
        <div style={{ padding: '10px 12px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#3a4260' }}>Loading…</div>
      ) : blocks.length === 0 ? (
        <div style={{ padding: '10px 12px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#3a4260' }}>No blame data</div>
      ) : blocks.map((b, i) => {
        const col = authorColor(b.author)
        const lines = b.fromLine === b.toLine ? `L${b.fromLine}` : `L${b.fromLine}–${b.toLine}`
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            height: 28, paddingLeft: 12, paddingRight: 10,
            borderBottom: '1px solid #0d0f1580',
            borderLeft: `3px solid ${col}55`,
            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
          }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: col, flexShrink: 0, minWidth: 50 }}>
              {b.hash.slice(0, 7)}
            </span>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#8b94b0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {b.author}
            </span>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#3a4260', flexShrink: 0 }}>
              {timeAgo(b.timestamp)}
            </span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#2a3040', flexShrink: 0, minWidth: 60, textAlign: 'right' }}>
              {lines}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Right panel ───────────────────────────────────────────────────────────────

function RightPanel({ centerFile, repoPath, diff, diffLoading, blame, blameLoading }: {
  centerFile: CenterFile | null
  repoPath: string
  diff: DiffContent | null
  diffLoading: boolean
  blame: BlameEntry[]
  blameLoading: boolean
}) {
  if (!centerFile) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 11,
          background: 'rgba(255,255,255,0.02)', border: '1px solid #1d2535',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="22" height="22" viewBox="0 0 36 36" fill="none">
            <rect x="7" y="5" width="22" height="26" rx="3" stroke="#283047" strokeWidth="1.5" />
            <path d="M12 12h12M12 17h8M12 22h10" stroke="#283047" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#2e3a50' }}>
          Select a file to preview
        </span>
      </div>
    )
  }

  const filePath = centerFile.file.path
  const binary = isAsset(filePath)

  if (binary) {
    const hash = centerFile.kind === 'commit' ? centerFile.commitHash : 'HEAD'
    return <AssetPanel repoPath={repoPath} filePath={filePath} hash={hash} />
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Diff */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {diffLoading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0d0f15' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#344057' }}>Loading diff…</span>
          </div>
        )}
        {!diffLoading && diff && <TextDiff diff={diff} />}
        {!diffLoading && !diff && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#2e3a50' }}>No diff available</span>
          </div>
        )}
      </div>
      {/* Blame */}
      <BlameSection entries={blame} loading={blameLoading} />
    </div>
  )
}

// ── UE asset type icons ───────────────────────────────────────────────────────

interface UEType { bg: string; accent: string; label: string; Icon: () => JSX.Element }

function WorldIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <ellipse cx="32" cy="32" rx="22" ry="22" stroke="currentColor" strokeWidth="2" />
      <ellipse cx="32" cy="32" rx="9" ry="22" stroke="currentColor" strokeWidth="1.5" />
      <line x1="10" y1="32" x2="54" y2="32" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13 20 Q32 26 51 20" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M13 44 Q32 38 51 44" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  )
}

function MaterialIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <circle cx="32" cy="32" r="20" stroke="currentColor" strokeWidth="2" />
      <ellipse cx="32" cy="32" rx="20" ry="6" stroke="currentColor" strokeWidth="1.25" strokeDasharray="3 3" />
      <ellipse cx="32" cy="32" rx="6" ry="20" stroke="currentColor" strokeWidth="1.25" strokeDasharray="3 3" />
      <circle cx="32" cy="32" r="5" fill="currentColor" fillOpacity="0.35" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="22" cy="24" r="2" fill="currentColor" fillOpacity="0.5" />
    </svg>
  )
}

function TextureIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <rect x="10" y="10" width="44" height="44" rx="4" stroke="currentColor" strokeWidth="2" />
      <rect x="10" y="10" width="22" height="22" fill="currentColor" fillOpacity="0.2" />
      <rect x="32" y="32" width="22" height="22" fill="currentColor" fillOpacity="0.2" />
      <line x1="10" y1="32" x2="54" y2="32" stroke="currentColor" strokeWidth="1.5" />
      <line x1="32" y1="10" x2="32" y2="54" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function BlueprintIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <circle cx="16" cy="20" r="5" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="48" cy="20" r="5" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="16" cy="44" r="5" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="48" cy="44" r="5" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="32" cy="32" r="5" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.75" />
      <line x1="21" y1="20" x2="27" y2="28" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="43" y1="20" x2="37" y2="28" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="21" y1="44" x2="27" y2="36" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="43" y1="44" x2="37" y2="36" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function MeshIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <path d="M32 10 L54 22 L54 42 L32 54 L10 42 L10 22 Z" stroke="currentColor" strokeWidth="2" fill="none" />
      <path d="M32 10 L32 54" stroke="currentColor" strokeWidth="1.25" strokeDasharray="3 3" />
      <path d="M10 22 L54 42" stroke="currentColor" strokeWidth="1.25" strokeDasharray="3 3" />
      <path d="M54 22 L10 42" stroke="currentColor" strokeWidth="1.25" strokeDasharray="3 3" />
    </svg>
  )
}

function SoundIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <line x1="10" y1="32" x2="16" y2="32" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="20" y1="20" x2="20" y2="44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="28" y1="14" x2="28" y2="50" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="36" y1="22" x2="36" y2="42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="44" y1="18" x2="44" y2="46" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="52" y1="26" x2="52" y2="38" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function ParticleIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <circle cx="32" cy="32" r="4" fill="currentColor" />
      <circle cx="32" cy="14" r="2.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="32" cy="50" r="2.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="14" cy="32" r="2.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="50" cy="32" r="2.5" fill="currentColor" fillOpacity="0.7" />
      <circle cx="18" cy="18" r="2" fill="currentColor" fillOpacity="0.5" />
      <circle cx="46" cy="18" r="2" fill="currentColor" fillOpacity="0.5" />
      <circle cx="18" cy="46" r="2" fill="currentColor" fillOpacity="0.5" />
      <circle cx="46" cy="46" r="2" fill="currentColor" fillOpacity="0.5" />
      <line x1="32" y1="18" x2="32" y2="28" stroke="currentColor" strokeWidth="1.25" strokeOpacity="0.4" />
      <line x1="32" y1="36" x2="32" y2="46" stroke="currentColor" strokeWidth="1.25" strokeOpacity="0.4" />
      <line x1="18" y1="32" x2="28" y2="32" stroke="currentColor" strokeWidth="1.25" strokeOpacity="0.4" />
      <line x1="36" y1="32" x2="46" y2="32" stroke="currentColor" strokeWidth="1.25" strokeOpacity="0.4" />
    </svg>
  )
}

function AnimIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <line x1="10" y1="32" x2="54" y2="32" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16 32 L28 18 L40 32 L52 22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="16" cy="32" r="3" fill="currentColor" />
      <circle cx="28" cy="18" r="3" fill="currentColor" />
      <circle cx="40" cy="32" r="3" fill="currentColor" />
      <circle cx="52" cy="22" r="3" fill="currentColor" />
      <line x1="16" y1="44" x2="16" y2="52" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="28" y1="44" x2="28" y2="52" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="40" y1="44" x2="40" y2="52" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="52" y1="44" x2="52" y2="52" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function GenericUEIcon() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <rect x="12" y="12" width="40" height="40" rx="6" stroke="currentColor" strokeWidth="2" />
      <path d="M22 24 L32 38 L42 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <line x1="32" y1="38" x2="32" y2="44" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function getUEType(filePath: string, assetClass: string | undefined): UEType {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const cls = (assetClass ?? '').toLowerCase()

  if (ext === 'umap' || cls === 'world' || cls.includes('worldsettings'))
    return { bg: '#061a0c', accent: '#2ec573', label: 'World', Icon: WorldIcon }
  if (cls.includes('material'))
    return { bg: '#1a0e00', accent: '#f5a832', label: 'Material', Icon: MaterialIcon }
  if (cls.includes('texture') || cls.includes('rendertarget') || ['png','jpg','jpeg','tga','bmp','tiff','tif','dds','exr','hdr'].includes(ext))
    return { bg: '#061220', accent: '#4d9dff', label: 'Texture', Icon: TextureIcon }
  if (cls.includes('blueprint') || cls.includes('bpgc'))
    return { bg: '#070d2a', accent: '#7da8ff', label: 'Blueprint', Icon: BlueprintIcon }
  if (cls.includes('staticmesh'))
    return { bg: '#0e0720', accent: '#a27ef0', label: 'Static Mesh', Icon: MeshIcon }
  if (cls.includes('skeletalmesh') || cls.includes('skeleton'))
    return { bg: '#120520', accent: '#c27ef0', label: 'Skeletal Mesh', Icon: MeshIcon }
  if (cls.includes('sound') || cls.includes('audio') || ['wav','mp3','ogg','flac'].includes(ext))
    return { bg: '#061418', accent: '#1abc9c', label: 'Sound', Icon: SoundIcon }
  if (cls.includes('niagara') || cls.includes('particle'))
    return { bg: '#091606', accent: '#8bc34a', label: 'Particle System', Icon: ParticleIcon }
  if (cls.includes('anim') || cls.includes('blendspace') || cls.includes('montage'))
    return { bg: '#191200', accent: '#f5c832', label: 'Animation', Icon: AnimIcon }
  if (['mp4','mov','avi','mkv'].includes(ext))
    return { bg: '#0d0a1a', accent: '#e91e63', label: 'Video', Icon: GenericUEIcon }
  return { bg: '#0f1118', accent: '#5a6480', label: 'Asset', Icon: GenericUEIcon }
}

// ── Asset panel (binary / UE files) ───────────────────────────────────────────

function AssetPanel({ repoPath, filePath, hash }: { repoPath: string; filePath: string; hash: string }) {
  const [thumbSrc,     setThumbSrc]     = useState<string | null>(null)
  const [thumbLoading, setThumbLoading] = useState(true)
  const [assetClass,   setAssetClass]   = useState<string | undefined>(undefined)
  const [history,      setHistory]      = useState<CommitEntry[]>([])
  const [histLoading,  setHistLoading]  = useState(true)

  useEffect(() => {
    setThumbSrc(null); setThumbLoading(true)
    setAssetClass(undefined)
    setHistory([]); setHistLoading(true)

    ipc.assetRenderThumbnail(repoPath, filePath, hash)
      .then(p => setThumbSrc(p))
      .catch(() => setThumbSrc(null))
      .finally(() => setThumbLoading(false))

    ipc.assetExtractMetadata(repoPath, filePath, hash)
      .then(meta => setAssetClass(meta['AssetClass'] ?? meta['Class'] ?? meta['ObjectClass']))
      .catch(() => {})

    ipc.gitFileLog(repoPath, filePath, 50)
      .then(setHistory)
      .catch(() => setHistory([]))
      .finally(() => setHistLoading(false))
  }, [repoPath, filePath, hash])

  const ueType = getUEType(filePath, assetClass)
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath
  const ext = (filePath.split('.').pop() ?? '').toLowerCase()

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0d0f15' }}>

      {/* Thumbnail / icon area */}
      <div style={{
        flexShrink: 0, height: 240,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        background: thumbSrc ? '#000' : ueType.bg,
        borderBottom: '1px solid #1e2436', position: 'relative', overflow: 'hidden',
      }}>
        {thumbLoading ? (
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#2a3040' }}>Loading…</span>
        ) : thumbSrc ? (
          <img
            src={`file://${thumbSrc}`}
            alt={fileName}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        ) : (
          <>
            {/* Subtle radial glow behind icon */}
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              background: `radial-gradient(ellipse 60% 60% at 50% 45%, ${ueType.accent}18 0%, transparent 70%)`,
            }} />
            <div style={{ color: ueType.accent, opacity: 0.85, position: 'relative' }}>
              <ueType.Icon />
            </div>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, position: 'relative' }}>
              <span style={{
                fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 600,
                color: ueType.accent, opacity: 0.9,
              }}>{assetClass ?? ueType.label}</span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                color: `${ueType.accent}66`,
                background: `${ueType.accent}12`, borderRadius: 4, padding: '1px 7px',
              }}>.{ext}</span>
            </div>
          </>
        )}
      </div>

      {/* File name bar */}
      <div style={{
        flexShrink: 0, height: 32, paddingLeft: 12, paddingRight: 10,
        display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid #1e2436', background: '#0d0f15',
      }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, color: '#8b94b0',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }} title={filePath}>{fileName}</span>
        {!thumbLoading && !thumbSrc && (
          <span style={{
            fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 600,
            background: `${ueType.accent}14`, color: ueType.accent,
            border: `1px solid ${ueType.accent}30`, borderRadius: 3, padding: '1px 6px', flexShrink: 0,
          }}>{ueType.label}</span>
        )}
      </div>

      {/* File version history */}
      <div style={{
        display: 'flex', alignItems: 'center', height: 28, paddingLeft: 12, paddingRight: 10,
        borderBottom: '1px solid #181e2e', flexShrink: 0,
      }}>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#2a3040', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          File History
        </span>
        {!histLoading && history.length > 0 && (
          <span style={{ marginLeft: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#2a3040' }}>
            {history.length}
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {histLoading ? (
          <div style={{ padding: '10px 12px', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#2a3040' }}>Loading…</div>
        ) : history.length === 0 ? (
          <div style={{ padding: '10px 12px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#2a3040' }}>No history available</div>
        ) : history.map((c, i) => {
          const col = authorColor(c.author)
          const ini = initials(c.author)
          return (
            <div key={c.hash} style={{
              display: 'flex', alignItems: 'center', gap: 9,
              height: 38, paddingLeft: 12, paddingRight: 12, flexShrink: 0,
              borderBottom: '1px solid #0f1320',
              background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
            }}>
              <span style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                background: `linear-gradient(135deg, ${col}55, ${col}22)`,
                border: `1px solid ${col}44`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: "'JetBrains Mono', monospace", fontSize: 7.5, fontWeight: 700, color: col,
              }}>{ini}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#9ba4bc',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{c.message}</div>
                <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#3e4a60', marginTop: 1 }}>
                  {c.author}
                </div>
              </div>
              <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
                <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#3a4260' }}>
                  {timeAgo(c.timestamp)}
                </span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#252d3e' }}>
                  {c.hash.slice(0, 7)}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Commit detail header ──────────────────────────────────────────────────────

function CommitHeader({ commit }: { commit: CommitEntry }) {
  const col = authorColor(commit.author)
  const ini = initials(commit.author)
  return (
    <div style={{ padding: '12px 14px', borderBottom: '1px solid #252d42', background: '#131720', flexShrink: 0 }}>
      <div style={{ marginBottom: 6 }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#3a4260',
          background: '#1a1f2e', borderRadius: 4, padding: '1px 7px',
        }}>{commit.hash.slice(0, 7)}</span>
      </div>
      <p style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13.5, fontWeight: 600, color: '#dde1f0', margin: '0 0 8px', lineHeight: 1.4 }}>
        {commit.message}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
          background: `linear-gradient(135deg, ${col}88, ${col}44)`, border: `1px solid ${col}55`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: "'JetBrains Mono', monospace", fontSize: 8, fontWeight: 700, color: col,
        }}>{ini}</span>
        <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#8b94b0' }}>{commit.author}</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870' }}>{timeAgo(commit.timestamp)}</span>
      </div>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

const STASH_KEY = 'lucid-git:timeline-stash-open'
const LEFT_WIDTH_KEY = 'lucid-git:timeline-left-width'

export function TimelinePanel({ repoPath }: { repoPath: string }) {
  const opRun        = useOperationStore(s => s.run)
  const { fileStatus, isLoading, refreshStatus, historyTick } = useRepoStore()
  const { locks }    = useLockStore()
  const { accounts, currentAccountId } = useAuthStore()
  const currentUserName = accounts.find(a => a.userId === currentAccountId)?.login ?? null

  // ── Selection ──────────────────────────────────────────────────────────────
  const [leftSel,    setLeftSel]    = useState<LeftSel>({ kind: 'working-tree' })
  const [centerFile, setCenterFile] = useState<CenterFile | null>(null)
  const [timelineStagePaths, setTimelineStagePaths] = useState<Set<string>>(new Set())
  const knownTimelineStagePaths = useRef<Set<string>>(new Set())

  useEffect(() => {
    const currentPaths = new Set(fileStatus.map(f => f.path))
    const knownPaths = knownTimelineStagePaths.current
    setTimelineStagePaths(prev => {
      const next = new Set([...prev].filter(path => currentPaths.has(path)))
      for (const path of currentPaths) {
        if (!knownPaths.has(path)) next.add(path)
      }
      return next
    })
    knownTimelineStagePaths.current = currentPaths
  }, [fileStatus])

  // ── Left column — history ──────────────────────────────────────────────────
  const [nodes,       setNodes]       = useState<GraphNode[]>([])
  const [totalLoaded, setTotalLoaded] = useState(0)
  const [histLoading, setHistLoading] = useState(false)
  const [limitRef]                    = useState({ current: INITIAL_LIMIT })
  const [remoteUrl,   setRemoteUrl]   = useState<string | null>(null)
  const [branches,     setBranches]     = useState<BranchInfo[]>([])
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [selBranches,  setSelBranches]  = useState<Set<string>>(new Set())
  const [filterOpen,   setFilterOpen]   = useState(false)
  const [branchTips,   setBranchTips]   = useState<Map<string, BranchInfo[]>>(new Map())
  const [hoveredBranchKey, setHoveredBranchKey] = useState<string | null>(null)

  const filterBranches = React.useMemo(() => {
    const originBranches = branches.filter(isLiveOriginBranch)
    const remoteBranches = originBranches.length > 0 ? originBranches : branches.filter(b => b.isRemote)
    return [...remoteBranches].sort((a, b) => {
      const aDefault = a.displayName === defaultBranch || a.name === defaultBranch
      const bDefault = b.displayName === defaultBranch || b.name === defaultBranch
      if (aDefault !== bDefault) return aDefault ? -1 : 1
      return (a.displayName || a.name).localeCompare(b.displayName || b.name)
    })
  }, [branches, defaultBranch])

  const branchColors = React.useMemo(() => {
    const sorted = [
      ...filterBranches.filter(b => b.displayName === defaultBranch || b.name === defaultBranch),
      ...filterBranches.filter(b => b.displayName !== defaultBranch && b.name !== defaultBranch),
    ]
    const map = new Map<string, string>()
    sorted.forEach((b, i) => map.set(b.name, TL_BRANCH_COLORS[i % TL_BRANCH_COLORS.length]))
    return map
  }, [filterBranches, defaultBranch])
  const graphColW = React.useMemo(() => {
    if (nodes.length === 0) return GRAPH_PAD * 2 + TL_LANE_W
    const maxLane = nodes.reduce((m, n) => Math.max(m, n.maxLane), 0)
    return GRAPH_PAD + (maxLane + 1) * TL_LANE_W + GRAPH_PAD
  }, [nodes])
  const branchHoverLabels = React.useMemo(() => {
    const labels = new Map<string, string>([['main', defaultBranch || 'main']])
    for (const node of nodes) {
      const tips = branchTips.get(node.commit.hash) ?? []
      for (const branch of tips) {
        const key = branch.displayName === defaultBranch || branch.name === defaultBranch ? 'main' : node.color
        const existing = labels.get(key)
        if (existing && !existing.split(' / ').includes(branch.name)) {
          labels.set(key, `${existing} / ${branch.name}`)
        } else if (!existing) {
          labels.set(key, branch.name)
        }
      }
    }
    return labels
  }, [nodes, branchTips, defaultBranch])
  const minLeftWidth = React.useMemo(() => Math.max(320, graphColW + 260), [graphColW])
  const maxLeftWidth = Math.max(LEFT_WIDTH_MAX, minLeftWidth)

  const branchNames = React.useMemo(
    () => filterBranches.map(b => b.name),
    [filterBranches]
  )
  const fetchBranchTips = useCallback(async (branchList: BranchInfo[]) => {
    const tips = new Map<string, BranchInfo[]>()
    await Promise.all(branchList.map(async b => {
      try {
        const [tip] = await ipc.log(repoPath, { limit: 1, refs: [b.name] })
        if (tip) {
          const arr = tips.get(tip.hash) ?? []
          if (!arr.some(existing => existing.name === b.name)) arr.push(b)
          tips.set(tip.hash, arr)
        }
      } catch {
        return
      }
    }))
    setBranchTips(new Map(tips))
  }, [repoPath])
  const [stashOpen,   setStashOpen]   = useState(() => {
    try { return localStorage.getItem(STASH_KEY) === '1' } catch { return false }
  })
  const [syncStatus,  setSyncStatus]  = useState<{ ahead: number; behind: number } | null>(null)
  const [prReadyCommits, setPrReadyCommits] = useState<CommitEntry[]>([])
  const [needsPushHashes, setNeedsPushHashes] = useState<Set<string>>(new Set())
  const [needsPullHashes, setNeedsPullHashes] = useState<Set<string>>(new Set())

  // ── Center column — commit files ───────────────────────────────────────────
  const [commitFiles,   setCommitFiles]   = useState<CommitFileChange[]>([])
  const [commitFilesLoading, setCommitFilesLoading] = useState(false)

  // ── Right column ───────────────────────────────────────────────────────────
  const [diff,        setDiff]        = useState<DiffContent | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [blame,       setBlame]       = useState<BlameEntry[]>([])
  const [blameLoading, setBlameLoading] = useState(false)

  // ── Layout ─────────────────────────────────────────────────────────────────
  const [leftWidth,   setLeftWidth]   = useState(() => {
    try {
      const saved = Number(localStorage.getItem(LEFT_WIDTH_KEY))
      return Number.isFinite(saved) && saved > 0 ? Math.min(LEFT_WIDTH_MAX, Math.max(DEFAULT_LEFT_WIDTH, saved)) : DEFAULT_LEFT_WIDTH
    } catch {
      return DEFAULT_LEFT_WIDTH
    }
  })
  const [graphWidth,  setGraphWidth]  = useState<number | null>(null)
  const [centerWidth, setCenterWidth] = useState(370)
  const dragging   = useRef<'left' | 'center' | 'graph' | null>(null)
  const dragStartX = useRef(0)
  const dragStartW = useRef(0)

  useEffect(() => {
    setLeftWidth(w => Math.min(maxLeftWidth, Math.max(w, minLeftWidth)))
  }, [maxLeftWidth, minLeftWidth])

  useEffect(() => {
    try { localStorage.setItem(LEFT_WIDTH_KEY, String(Math.round(leftWidth))) } catch {
      return
    }
  }, [leftWidth])

  useEffect(() => {
    setGraphWidth(graphColW)
  }, [graphColW])

  const effectiveGraphWidth = Math.max(graphColW, graphWidth ?? graphColW)

  const makeDragStart = useCallback((which: 'left' | 'center' | 'graph', currentW: number) => (e: React.MouseEvent) => {
    dragging.current   = which
    dragStartX.current = e.clientX
    dragStartW.current = currentW
    document.body.style.cursor     = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = ev.clientX - dragStartX.current
      if (which === 'graph') {
        const maxGraphW = Math.max(graphColW, leftWidth - 180)
        const next = Math.max(graphColW, Math.min(maxGraphW, dragStartW.current + delta))
        setGraphWidth(next)
        return
      }
      const w = Math.max(CENTER_WIDTH_MIN, Math.min(which === 'left' ? maxLeftWidth : CENTER_WIDTH_MAX, dragStartW.current + delta))
      if (which === 'left') setLeftWidth(Math.max(w, minLeftWidth))
      else setCenterWidth(w)
    }
    const onUp = () => {
      dragging.current = null
      document.body.style.cursor     = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [graphColW, leftWidth, maxLeftWidth, minLeftWidth])

  // ── Load history ───────────────────────────────────────────────────────────
  const loadHistory = useCallback(async (
    limit: number,
    branches?: Set<string>,
    defaultBranchOverride?: string,
    filterBranchesOverride?: BranchInfo[],
  ) => {
    setHistLoading(true)
    try {
      const active = branches ?? selBranches
      const mainBranch = defaultBranchOverride ?? defaultBranch
      const branchPool = filterBranchesOverride ?? filterBranches
      const refs = [...active].filter(Boolean)
      if (refs.length === 0) {
        setNodes([])
        setTotalLoaded(0)
        return
      }
      const commits = await opRun('Loading history…', () => ipc.log(repoPath, { limit, all: !refs, refs }))
      const defaultRef = branchPool.find(b => active.has(b.name) && (b.displayName === mainBranch || b.name === mainBranch))?.name
      const defaultCommits = defaultRef
        ? await ipc.log(repoPath, { limit, all: false, refs: [defaultRef] }).catch(() => [])
        : []
      const defaultHashes = firstParentHashes(commits, defaultCommits[0]?.hash)
      const graph = remapGraphWithMainLeft(computeGraph(commits), defaultHashes)
      const tipCommits = await Promise.all(refs.map(async ref => {
        try {
          const [tip] = await ipc.log(repoPath, { limit: 1, all: false, refs: [ref] })
          return tip ? { ref, hash: tip.hash } : null
        } catch {
          return null
        }
      }))
      const selectedTipRefs = new Map(tipCommits.filter(tip => !!tip).map(tip => [tip!.hash, tip!.ref]))
      const allowedKeys = new Set<string>()
      for (const node of graph) {
        const ref = selectedTipRefs.get(node.commit.hash)
        if (!ref) continue
        const branch = branchPool.find(b => b.name === ref)
        if (branch && (branch.displayName === mainBranch || branch.name === mainBranch)) allowedKeys.add('main')
        else allowedKeys.add(node.color)
      }
      const pruned = pruneGraphToBranchKeys(graph, allowedKeys)
      setNodes(pruned)
      setTotalLoaded(pruned.length)
    } finally {
      setHistLoading(false)
    }
  }, [repoPath, opRun, selBranches, defaultBranch, filterBranches])

  // ── Initial load ───────────────────────────────────────────────────────────
  useEffect(() => {
    limitRef.current = INITIAL_LIMIT
    setCenterFile(null); setDiff(null); setBlame([])
    setLeftSel({ kind: 'working-tree' })
    ipc.getRemoteUrl(repoPath).then(setRemoteUrl).catch(() => {})
    Promise.all([ipc.branchList(repoPath), ipc.gitDefaultBranch(repoPath)]).then(async ([bl, def]) => {
      setBranches(bl)
      setDefaultBranch(def)
      const originBranches = bl.filter(isLiveOriginBranch)
      const liveBranches = originBranches.length > 0 ? originBranches : bl.filter(b => b.isRemote)
      fetchBranchTips(liveBranches)
      const nextSel = new Set(liveBranches.map(b => b.name))
      setSelBranches(nextSel)
      limitRef.current = INITIAL_LIMIT
      loadHistory(INITIAL_LIMIT, nextSel, def, liveBranches)
    }).catch(() => {})
  }, [repoPath])

  // ── Refresh history when a git operation changes HEAD (fetch, pull, push, checkout, merge, commit) ──
  const historyTickRef   = useRef(historyTick)
  const loadHistoryRef   = useRef(loadHistory)
  useEffect(() => { loadHistoryRef.current = loadHistory }, [loadHistory])
  useEffect(() => {
    if (historyTick === historyTickRef.current) return
    historyTickRef.current = historyTick
    loadHistoryRef.current(limitRef.current)
  }, [historyTick])

  useEffect(() => {
    let cancelled = false
    ipc.getSyncStatus(repoPath)
      .then(async st => {
        if (cancelled) return
        setSyncStatus({ ahead: st.ahead, behind: st.behind })
        if (!st.hasUpstream || !st.remoteBranch) {
          setNeedsPushHashes(new Set())
          setNeedsPullHashes(new Set())
          return
        }
        try {
          const [aheadCommits, behindCommits] = await Promise.all([
            ipc.log(repoPath, { limit: 200, all: false, refs: [`${st.remoteBranch}..HEAD`] }),
            ipc.log(repoPath, { limit: 200, all: false, refs: [`HEAD..${st.remoteBranch}`] }),
          ])
          if (cancelled) return
          setNeedsPushHashes(new Set(aheadCommits.map(c => c.hash)))
          setNeedsPullHashes(new Set(behindCommits.map(c => c.hash)))
        } catch {
          if (cancelled) return
          setNeedsPushHashes(new Set())
          setNeedsPullHashes(new Set())
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSyncStatus(null)
          setNeedsPushHashes(new Set())
          setNeedsPullHashes(new Set())
        }
      })
    return () => { cancelled = true }
  }, [repoPath, historyTick])

  useEffect(() => {
    let cancelled = false
    if (!defaultBranch) {
      setPrReadyCommits([])
      return () => { cancelled = true }
    }
    ipc.log(repoPath, { limit: 30, all: false, refs: [`${defaultBranch}..HEAD`] })
      .then(commits => { if (!cancelled) setPrReadyCommits(commits) })
      .catch(() => { if (!cancelled) setPrReadyCommits([]) })
    return () => { cancelled = true }
  }, [repoPath, defaultBranch, historyTick])

  // ── Select left item ───────────────────────────────────────────────────────
  const selectWorkingTree = () => {
    setLeftSel({ kind: 'working-tree' })
    setCenterFile(null); setDiff(null); setBlame([])
    setCommitFiles([])
  }

  const selectCommit = async (commit: CommitEntry) => {
    setLeftSel({ kind: 'commit', commit })
    setCenterFile(null); setDiff(null); setBlame([])
    setCommitFiles([]); setCommitFilesLoading(true)
    try { setCommitFiles(await ipc.commitFiles(repoPath, commit.hash)) }
    catch { setCommitFiles([]) }
    finally { setCommitFilesLoading(false) }
  }

  // ── Select center file ─────────────────────────────────────────────────────
  const selectCenterFile = async (cf: CenterFile) => {
    setCenterFile(cf)
    setDiff(null); setBlame([])
    const fp = cf.file.path
    const hash = cf.kind === 'commit' ? cf.commitHash : 'HEAD'

    // Load diff
    if (!isAsset(fp)) {
      setDiffLoading(true)
      try {
        const d = cf.kind === 'working'
          ? await ipc.diff(repoPath, fp, cf.file.staged)
          : await ipc.gitCommitFileDiff(repoPath, fp, cf.commitHash)
        setDiff(d)
      } catch { setDiff(null) }
      finally { setDiffLoading(false) }

      // Load blame
      setBlameLoading(true)
      try { setBlame(await ipc.gitBlame(repoPath, fp, hash)) }
      catch { setBlame([]) }
      finally { setBlameLoading(false) }
    }
  }

  const toggleBranch = (name: string) => {
    const branch = filterBranches.find(b => b.name === name)
    if (!branch) return
    const next = new Set(selBranches)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setSelBranches(next)
    limitRef.current = INITIAL_LIMIT
    loadHistory(INITIAL_LIMIT, next)
  }

  const showAllBranches = () => {
    const next = new Set(branchNames)
    setSelBranches(next)
    setFilterOpen(false)
    limitRef.current = INITIAL_LIMIT
    loadHistory(INITIAL_LIMIT, next)
  }

  const hideAllBranches = () => {
    const next = new Set<string>()
    setSelBranches(next)
    setFilterOpen(false)
    limitRef.current = INITIAL_LIMIT
    loadHistory(INITIAL_LIMIT, next)
  }

  const toggleStash = () => {
    const next = !stashOpen
    setStashOpen(next)
    try { localStorage.setItem(STASH_KEY, next ? '1' : '0') } catch {
      return
    }
  }

  const selectedCommit = leftSel.kind === 'commit' ? leftSel.commit : null
  const legendHasMain = nodes.some(node => node.isMain)
  const legendHasMerge = nodes.some(node => node.commit.parentHashes.length > 1)
  const legendHasBranchTip = nodes.some(node => (branchTips.get(node.commit.hash) ?? []).some(branch => branch.displayName !== defaultBranch && branch.name !== defaultBranch))
  const legendHasPush = nodes.some(node => needsPushHashes.has(node.commit.hash))
  const legendHasPull = nodes.some(node => needsPullHashes.has(node.commit.hash))
  const legendHasWorkingTree = leftSel.kind === 'working-tree'
  const currentHeadLane = React.useMemo(() => {
    const currentBranch = branches.find(b => b.current)?.name
    if (!currentBranch) return 0
    for (const node of nodes) {
      const tips = branchTips.get(node.commit.hash) ?? []
      if (tips.some(t => t.name === currentBranch)) return node.lane
    }
    return nodes[0]?.lane ?? 0
  }, [nodes, branches, branchTips])
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

      {/* Shared SVG filter defs */}
      <GraphDefs />

      {/* ── Left column ──────────────────────────────────────────────────── */}
      <div style={{ width: leftWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #252d42', position: 'relative' }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center',
          height: 32, paddingLeft: 12, paddingRight: 8, flexShrink: 0,
          borderBottom: '1px solid #1e2436', background: '#0d0f15', gap: 5,
        }}>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#2a3040', letterSpacing: '0.1em', textTransform: 'uppercase', flexShrink: 0 }}>
            {totalLoaded > 0 ? `${totalLoaded} Commits` : 'Commits'}
          </span>
          <div style={{ flex: 1 }} />
          <TLBranchDropdown
            open={filterOpen}
            onToggleOpen={() => setFilterOpen(o => !o)}
            branches={filterBranches}
            selectedBranches={selBranches}
            defaultBranch={defaultBranch}
            branchColors={branchColors}
            onToggleBranch={toggleBranch}
            onShowAll={showAllBranches}
            onHideAll={hideAllBranches}
          />
          <button
            onClick={() => loadHistory(limitRef.current)}
            disabled={histLoading}
            style={{ background: 'none', border: 'none', color: histLoading ? '#2a3040' : '#3a4260', cursor: histLoading ? 'default' : 'pointer', fontSize: 14, padding: '0 2px', flexShrink: 0 }}
            onMouseEnter={e => { if (!histLoading) e.currentTarget.style.color = '#e8622f' }}
            onMouseLeave={e => { if (!histLoading) e.currentTarget.style.color = '#3a4260' }}
          >{histLoading ? '…' : '↺'}</button>
        </div>

        <div style={{ padding: '8px 10px', borderBottom: '1px solid #1e2436', background: '#0b0e16' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: '#8b96b8', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Ready for PR
            </span>
            <span style={{ fontSize: 11, color: prReadyCommits.length ? '#2ec573' : '#59607a', fontWeight: 700 }}>
              {prReadyCommits.length}
            </span>
          </div>
          {prReadyCommits.length === 0 ? (
            <div style={{ fontSize: 11, color: '#59607a' }}>No commits ahead of {defaultBranch}.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 92, overflow: 'auto', paddingRight: 2 }}>
              {prReadyCommits.slice(0, 4).map(c => (
                <button
                  key={c.hash}
                  onClick={() => selectCommit(c)}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                    color: '#bcc5e1',
                    fontSize: 11,
                  }}
                  title={c.message}
                >
                  <span style={{ color: '#4d9dff', fontFamily: 'monospace', fontSize: 10 }}>{c.hash.slice(0, 7)}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.message}</span>
                </button>
              ))}
              {prReadyCommits.length > 4 && (
                <div style={{ fontSize: 10, color: '#59607a' }}>+{prReadyCommits.length - 4} more commits</div>
              )}
            </div>
          )}
          {syncStatus && (
            <div style={{ marginTop: 6, fontSize: 10, color: '#59607a' }}>
              Upstream: {syncStatus.ahead} ahead / {syncStatus.behind} behind
            </div>
          )}
        </div>

        {/* Working tree — pinned above commit list */}
        <WorkingTreeGraphRow
          selected={leftSel.kind === 'working-tree'}
          changeCount={fileStatus.length}
          graphColW={effectiveGraphWidth}
          lane={currentHeadLane}
          onClick={selectWorkingTree}
        />

        {/* Commit list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {histLoading && nodes.length === 0 && (
            <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#2a3040', padding: '16px 12px' }}>Loading…</p>
          )}
          {nodes.map(node => (
            <LeftCommitRow
              key={node.commit.hash}
              node={node}
              selected={selectedCommit?.hash === node.commit.hash}
              repoPath={repoPath}
              remoteUrl={remoteUrl}
              onRefresh={() => loadHistory(limitRef.current)}
              onClick={() => selectCommit(node.commit)}
              graphColW={effectiveGraphWidth}
              branchTips={branchTips}
              branchColors={branchColors}
              defaultBranch={defaultBranch}
              hoveredBranchKey={hoveredBranchKey}
              branchHoverLabels={branchHoverLabels}
              onHoverBranch={setHoveredBranchKey}
              needsPush={needsPushHashes.has(node.commit.hash)}
              needsPull={needsPullHashes.has(node.commit.hash)}
            />
          ))}
          {!histLoading && totalLoaded >= limitRef.current && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 10 }}>
              <button
                onClick={() => { limitRef.current += MORE_INC; loadHistory(limitRef.current) }}
                style={{
                  fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#3a4260',
                  background: 'none', border: '1px solid #1e2436', borderRadius: 5, padding: '5px 14px', cursor: 'pointer',
                }}
                onMouseEnter={e => { e.currentTarget.style.color = '#8b94b0'; e.currentTarget.style.borderColor = '#2f3a54' }}
                onMouseLeave={e => { e.currentTarget.style.color = '#3a4260'; e.currentTarget.style.borderColor = '#1e2436' }}
              >Load more…</button>
            </div>
          )}
        </div>
        <div style={{
          minHeight: 28, flexShrink: 0, borderTop: '1px solid #1e2436', background: '#0d0f15',
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
          fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#4e5870',
          flexWrap: 'wrap', lineHeight: 1.3,
        }}>
          <span>Legend:</span>
          {legendHasMain && <span style={{ color: MAIN_BRANCH_COLOR }}>━ main path</span>}
          {legendHasMain && <span style={{ color: '#4d9dff' }}>★ default</span>}
          {legendHasBranchTip && <span style={{ color: '#2ec573' }}>• branch</span>}
          {legendHasMerge && <span style={{ color: '#a27ef0' }}>◇ merge</span>}
          {legendHasPush && <span style={{ color: '#7dd3fc' }}>↑ push</span>}
          {legendHasPull && <span style={{ color: '#fca5a5' }}>↓ pull</span>}
          {legendHasWorkingTree && <span style={{ color: '#f5a832' }}>⌂ working tree</span>}
        </div>
        <div
          onMouseDown={makeDragStart('graph', effectiveGraphWidth)}
          title="Resize graph column"
          style={{
            position: 'absolute',
            left: effectiveGraphWidth - 1,
            top: 80,
            bottom: 24,
            width: 3,
            cursor: 'col-resize',
            background: 'transparent',
            zIndex: 10,
          }}
        />
      </div>

      <DragHandle onMouseDown={makeDragStart('left', leftWidth)} />

      {/* ── Center column ─────────────────────────────────────────────────── */}
      <div style={{ width: centerWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #252d42' }}>
        {leftSel.kind === 'working-tree' ? (
          /* Working tree: staging view */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
              <FileTree
                files={fileStatus}
                repoPath={repoPath}
                selectedPath={centerFile?.kind === 'working' ? centerFile.file.path : null}
                locks={locks}
                currentUserName={currentUserName}
                isLoading={isLoading}
                onSelect={file => selectCenterFile({ kind: 'working', file })}
                onRefresh={() => refreshStatus()}
                deferredStagePaths={timelineStagePaths}
                onToggleDeferredStagePath={path => setTimelineStagePaths(prev => {
                  const next = new Set(prev)
                  if (next.has(path)) next.delete(path)
                  else next.add(path)
                  return next
                })}
                onSetDeferredStagePaths={paths => setTimelineStagePaths(new Set(paths))}
                onBlameDeps={() => {}}
              />
            </div>
            <CommitBox deferredStagePaths={[...timelineStagePaths]} />
            {/* Stash section */}
            <div style={{ borderTop: '1px solid #1e2436', flexShrink: 0 }}>
              <button
                onClick={toggleStash}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                  height: 30, paddingLeft: 12, paddingRight: 10,
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#3a4260', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                }}
                onMouseEnter={e => (e.currentTarget.style.color = '#6a7490')}
                onMouseLeave={e => (e.currentTarget.style.color = '#3a4260')}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" style={{ transition: 'transform 0.15s', transform: stashOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                  <path d="M2 1.5l3 2.5-3 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Stashes
              </button>
              {stashOpen && (
                <div style={{ maxHeight: 260, overflowY: 'auto', borderTop: '1px solid #1a1f2e' }}>
                  <StashPanel repoPath={repoPath} onRefresh={() => refreshStatus()} />
                </div>
              )}
            </div>
          </div>
        ) : selectedCommit ? (
          /* Commit detail */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <CommitHeader commit={selectedCommit} />
            <div style={{
              display: 'flex', alignItems: 'center', height: 30, paddingLeft: 12, paddingRight: 10,
              borderBottom: '1px solid #1e2436', background: '#0d0f15', flexShrink: 0,
            }}>
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, fontWeight: 700, color: '#2a3040', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Files changed
                {!commitFilesLoading && commitFiles.length > 0 && (
                  <span style={{ marginLeft: 8, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, background: '#1a1f2e', color: '#3a4260', borderRadius: 8, padding: '1px 5px' }}>
                    {commitFiles.length}
                  </span>
                )}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {commitFilesLoading ? (
                <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#2a3040', padding: '12px 14px' }}>Loading…</p>
              ) : commitFiles.length === 0 ? (
                <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#2a3040', padding: '12px 14px' }}>No file changes</p>
              ) : commitFiles.map((f, i) => (
                <CommitFileRow
                  key={i}
                  f={f}
                  selected={centerFile?.kind === 'commit' && centerFile.file.path === f.path}
                  repoPath={repoPath}
                  commitHash={selectedCommit.hash}
                  remoteUrl={remoteUrl}
                  onClick={() => selectCenterFile({ kind: 'commit', file: f, commitHash: selectedCommit.hash })}
                />
              ))}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#2e3a50' }}>Select a commit</span>
          </div>
        )}
      </div>

      <DragHandle onMouseDown={makeDragStart('center', centerWidth)} />

      {/* ── Right column ──────────────────────────────────────────────────── */}
      <RightPanel
        centerFile={centerFile}
        repoPath={repoPath}
        diff={diff}
        diffLoading={diffLoading}
        blame={blame}
        blameLoading={blameLoading}
      />
    </div>
  )
}

// ── Branch filter row ─────────────────────────────────────────────────────────
