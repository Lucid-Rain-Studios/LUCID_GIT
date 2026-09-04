import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ipc, CommitEntry, CommitFileChange, BranchInfo, BlameEntry, FileStatus, DiffContent } from '@/ipc'
import { useOperationStore } from '@/stores/operationStore'
import { useRepoStore } from '@/stores/repoStore'
import { useLockStore } from '@/stores/lockStore'
import { useAuthStore } from '@/stores/authStore'
import { useDialogStore } from '@/stores/dialogStore'
import { computeGraph, branchColor, GraphNode, ROW_H, DOT_R, GRAPH_PAD, LineSegment } from '@/components/history/graphLayout'
import { FileTree } from '@/components/changes/FileTree'
import { CommitBox } from '@/components/changes/CommitBox'
import { StashPanel } from '@/components/changes/StashPanel'
import { FilePathText } from '@/components/ui/FilePathText'
import { compactPath } from '@/lib/pathDisplay'
import { FileDetailsSidePanel } from '@/components/shared/FileDetailsSidePanel'
import { ActionBtn } from '@/components/ui/ActionBtn'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'

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

// ── Commit node glyphs ────────────────────────────────────────────────────────

/** Node background — the graph column's own backdrop, so hollow shapes read as hollow. */
const NODE_FILL = '#10131c'
/** Stand-in colour for legend swatches, where no single branch colour applies. */
const LEGEND_NEUTRAL = '#8b93a3'

type GlyphKind = 'commit' | 'tip' | 'merge' | 'working'

function diamondPoints(cx: number, cy: number, r: number): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`
}

/**
 * The commit node shapes. Both the graph and the legend draw through this, so
 * the legend cannot drift out of sync with what the graph actually renders —
 * which is exactly how it ended up advertising a green dot for branches and a
 * house for the working tree.
 *
 * Shape carries meaning; colour carries branch identity.
 */
function CommitGlyph({ kind, color, cx, cy, r = DOT_R + 0.5, strokeBoost = 0, glow = false, fillOpacity = 1 }: {
  kind: GlyphKind
  color: string
  cx: number
  cy: number
  r?: number
  strokeBoost?: number
  glow?: boolean
  fillOpacity?: number
}) {
  const filter = glow ? 'url(#tl-glow-main)' : undefined
  switch (kind) {
    case 'merge':
      return (
        <>
          <polygon points={diamondPoints(cx, cy, r + 1)}
            fill={NODE_FILL} stroke={color} strokeWidth={1.8 + strokeBoost} filter={filter} />
          <circle cx={cx} cy={cy} r={2} fill={color} />
        </>
      )
    case 'working':
      // Filled diamond — deliberately the inverse of a merge, which is hollow.
      return (
        <polygon points={diamondPoints(cx, cy, r + 1)} fill={color} fillOpacity={fillOpacity} />
      )
    case 'tip':
      return (
        <>
          <circle cx={cx} cy={cy} r={r + 3} fill="none" stroke={color} strokeWidth={1.2} strokeOpacity={0.75} />
          <circle cx={cx} cy={cy} r={r}
            fill={NODE_FILL} stroke={color} strokeWidth={2 + strokeBoost} filter={filter} />
        </>
      )
    default:
      return (
        <circle cx={cx} cy={cy} r={r}
          fill={NODE_FILL} stroke={color} strokeWidth={2 + strokeBoost} filter={filter} />
      )
  }
}

/** Working tree accent: orange while dirty, green once clean. */
function workingTreeAccent(changeCount: number): string {
  return changeCount > 0 ? '#e8622f' : '#2ec573'
}

const SYNC_BADGE = {
  up:   { rgb: '125, 211, 252', color: '#c4eeff', arrow: '↑' },
  down: { rgb: '252, 165, 165', color: '#ffd1d1', arrow: '↓' },
} as const

/** The ahead/behind badge shown on a commit row — and in the legend, from here. */
function SyncBadge({ dir, title }: { dir: 'up' | 'down'; title?: string }) {
  const s = SYNC_BADGE[dir]
  return (
    <span
      title={title}
      style={{
        width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: `rgba(${s.rgb}, 0.14)`,
        border: `1px solid rgba(${s.rgb}, 0.5)`,
        color: s.color, fontSize: 11, fontWeight: 700, lineHeight: 1,
        boxShadow: '0 0 0 1px rgba(9, 12, 19, 0.35) inset',
      }}
    >{s.arrow}</span>
  )
}

/**
 * One legend entry: the real glyph, drawn by the same code the graph uses,
 * beside its label. Swatches that stand for a whole class of branches use a
 * neutral colour, because in the graph the colour identifies *which* branch.
 */
function LegendItem({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <svg width={16} height={16} style={{ flexShrink: 0, display: 'block', overflow: 'visible' }}>
        {children}
      </svg>
      {label}
    </span>
  )
}

/** Branch tip pill, as it appears on a commit row — and in the legend, from here. */
function BranchPill({ label, color, icon, isDefault = false }: {
  label: string; color: string; icon: string; isDefault?: boolean
}) {
  const tone = isDefault ? MAIN_BRANCH_COLOR : color
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 2, flexShrink: 0,
      background: isDefault ? `${MAIN_BRANCH_COLOR}22` : `${color}16`,
      color: tone,
      border: `1px solid ${tone}${isDefault ? '80' : '40'}`,
      borderRadius: 3, padding: '0 5px',
      fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: isDefault ? 800 : 500,
      boxShadow: isDefault ? '0 0 8px rgba(125,211,252,0.2)' : 'none',
    }}>
      <span style={{ fontSize: 8 }}>{icon}</span>
      {label}
    </span>
  )
}

/** The icon a branch pill carries, by role. */
function branchPillIcon(branch: { name: string; current?: boolean }, defaultBranch: string): string {
  return branch.name === defaultBranch ? '★' : branch.current ? '◉' : '•'
}

function LegendBadge({ dir, label }: { dir: 'up' | 'down'; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <SyncBadge dir={dir} />
      {label}
    </span>
  )
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
      branchKey: isMain ? 'main' : node.branchKey,
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
  if (allowedBranchKeys.has('main')) {
    const selectedBranchKeys = new Set([...allowedBranchKeys].filter(key => key !== 'main'))
    const branchLane = new Map<string, number>()
    for (const node of graph) {
      if (selectedBranchKeys.has(node.branchKey) && !branchLane.has(node.branchKey)) {
        branchLane.set(node.branchKey, node.lane)
      }
    }

    const collapsed = graph.map(node => {
      const keepOwnLane = node.isMain || selectedBranchKeys.has(node.branchKey)
      const canonicalLane = (branchKey: string) => branchLane.get(branchKey) ?? 0
      const lane = keepOwnLane && !node.isMain ? canonicalLane(node.branchKey) : 0
      const mapSegment = (seg: LineSegment, isTop: boolean): LineSegment => {
        const branchKey = seg.branchKey ?? seg.color
        const keepSegmentLane = seg.isMain || selectedBranchKeys.has(branchKey)
        const mapEndpoint = (endpoint: number, isCommitEndpoint: boolean) => {
          if (isCommitEndpoint) return lane
          if (endpoint === 0) return 0
          return keepSegmentLane && selectedBranchKeys.has(branchKey) ? canonicalLane(branchKey) : 0
        }
        return {
          ...seg,
          from: mapEndpoint(seg.from, !isTop && seg.from === node.lane),
          to: mapEndpoint(seg.to, isTop && seg.to === node.lane),
          color: keepSegmentLane ? seg.color : MAIN_BRANCH_COLOR,
          branchKey: keepSegmentLane ? branchKey : 'main',
          isMain: seg.isMain || !keepSegmentLane,
        }
      }
      const topLines = node.topLines.map(seg => mapSegment(seg, true))
      const bottomLines = node.bottomLines.map(seg => mapSegment(seg, false))
      const isMain = node.isMain || !keepOwnLane
      const color = keepOwnLane ? node.color : MAIN_BRANCH_COLOR
      const maxLane = Math.max(
        lane,
        ...topLines.flatMap(l => [l.from, l.to]),
        ...bottomLines.flatMap(l => [l.from, l.to]),
        0,
      )
      return {
        ...node,
        lane,
        color,
        branchKey: keepOwnLane ? node.branchKey : 'main',
        isMain,
        topLines,
        bottomLines,
        maxLane,
      }
    })

    return compactGraphLanes(collapsed.map(node => {
      const dedupe = (segments: LineSegment[]) => {
        const seen = new Set<string>()
        return segments.filter(seg => {
          const key = `${seg.from}:${seg.to}:${seg.color}:${seg.branchKey ?? ''}:${seg.isMain ? 1 : 0}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      const topLines = dedupe(node.topLines)
      const bottomLines = dedupe(node.bottomLines)
      const maxLane = Math.max(
        node.lane,
        ...topLines.flatMap(l => [l.from, l.to]),
        ...bottomLines.flatMap(l => [l.from, l.to]),
        0,
      )
      return { ...node, topLines, bottomLines, maxLane }
    }))
  }

  const rows = allowedBranchKeys.size === 0
    ? graph.filter(node => node.isMain)
    : graph.filter(node => node.isMain || allowedBranchKeys.has(node.branchKey))

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

function GraphCell({ node, graphColW, hoveredBranchKey, branchHoverLabels, onHoverBranch, isTip }: {
  node: GraphNode
  graphColW: number
  hoveredBranchKey: string | null
  branchHoverLabels: Map<string, string>
  onHoverBranch: (branchKey: string | null) => void
  isTip: boolean
}) {
  // Tooltip is rendered through a portal at viewport coordinates so it can never
  // be clipped or stacked under the scrollable timeline / graph column.
  const [hoveredSeg, setHoveredSeg] = useState<{ x: number; y: number; label: string; border: string } | null>(null)
  const isMerge = node.commit.parentHashes.length > 1
  const cx = GRAPH_PAD + node.lane * TL_LANE_W + TL_LANE_W / 2
  const cy = ROW_H / 2
  const dotR = DOT_R + 0.5

  // Trace state for this commit's own node, so dots follow the same emphasis as
  // the lines: hovering a branch mutes every commit that isn't on it.
  const nodeHovered = hoveredBranchKey === node.branchKey
  const nodeDimmed  = !!hoveredBranchKey && !nodeHovered
  const nodeOpacity = nodeDimmed ? 0.18 : 1
  const nodeLabel   = branchHoverLabels.get(node.branchKey) ?? (node.isMain ? 'Main branch' : 'Branch lane')
  const enterNode = (e: React.MouseEvent) => {
    setHoveredSeg({ x: e.clientX, y: e.clientY, label: nodeLabel, border: node.isMain ? MAIN_BRANCH_COLOR : '#3b4b6d' })
    onHoverBranch(node.branchKey)
  }
  const renderLine = (seg: LineSegment, isTop: boolean, key: string) => {
    const branchKey = seg.branchKey ?? seg.color
    const branchLabel = branchHoverLabels.get(branchKey) ?? (seg.isMain ? 'Main branch' : 'Selected branch lane')
    const isHovered = hoveredBranchKey === branchKey
    const isDimmed = !!hoveredBranchKey && !isHovered
    const strokeWidth = isHovered ? (seg.isMain ? 4.2 : 3.4) : seg.isMain ? 2.7 : 1.65
    const strokeOpacity = isDimmed ? 0.2 : isHovered ? 0.98 : seg.isMain ? 0.86 : 0.56
    const path = linePath(seg, isTop)
    const border = seg.isMain ? MAIN_BRANCH_COLOR : '#3b4b6d'
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
          onMouseEnter={(e) => {
            setHoveredSeg({ x: e.clientX, y: e.clientY, label: branchLabel, border })
            onHoverBranch(branchKey)
          }}
          onMouseMove={(e) => {
            setHoveredSeg(prev => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev))
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
    <svg width={graphColW} height={ROW_H} style={{ flexShrink: 0, overflow: 'visible', display: 'block', position: 'relative' }}>
      {node.topLines.map((seg, i) => renderLine(seg, true, `t${i}`))}
      {node.bottomLines.map((seg, i) => renderLine(seg, false, `b${i}`))}
      {/* Shape encodes commit type: diamond = merge, ringed dot = branch tip,
          plain dot = ordinary commit. Readable before colour is even parsed.
          Drawn through CommitGlyph so the legend stays in step. */}
      <g
        opacity={nodeOpacity}
        style={{ transition: 'opacity 90ms ease' }}
      >
        <CommitGlyph
          kind={isMerge ? 'merge' : isTip ? 'tip' : 'commit'}
          color={node.color}
          cx={cx} cy={cy} r={dotR}
          strokeBoost={(node.isMain ? 1 : 0) + (nodeHovered ? 1 : 0)}
          glow={!!node.isMain}
        />
      </g>
      {/* Invisible hit area so the dot traces its branch on hover too, not just
          the thin connecting lines. Sized to cover the tip ring and no further:
          lanes sit TL_LANE_W apart, so a wider target would swallow hover from
          the neighbouring lane's line. Painted last, so at the dot itself the
          commit wins over any line passing behind it. */}
      <circle cx={cx} cy={cy} r={dotR + 3.5} fill="transparent"
        style={{ cursor: 'help' }}
        onMouseEnter={enterNode}
        onMouseMove={(e) => {
          setHoveredSeg(prev => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev))
          if (hoveredBranchKey !== node.branchKey) onHoverBranch(node.branchKey)
        }}
        onMouseLeave={() => { setHoveredSeg(null); onHoverBranch(null) }}
      />
      {hoveredSeg && <BranchHoverTooltip x={hoveredSeg.x} y={hoveredSeg.y} label={hoveredSeg.label} border={hoveredSeg.border} />}
    </svg>
  )
}

// Branch-lane tooltip rendered in a portal at viewport coordinates. Floating on
// document.body means no ancestor (scroll container, graph column) can clip or
// out-stack it. Positioned just above the cursor and clamped to the viewport.
function BranchHoverTooltip({ x, y, label, border }: { x: number; y: number; label: string; border: string }) {
  const margin = 8
  const left = Math.max(margin, Math.min(x, window.innerWidth - margin))
  const top = Math.max(margin, y - 14)
  return createPortal(
    <div
      style={{
        position: 'fixed', left, top, transform: 'translate(-50%, -100%)',
        zIndex: 4000, pointerEvents: 'none',
        background: '#0f1420', border: `1px solid ${border}`, borderRadius: 5,
        padding: '3px 8px', maxWidth: 'min(420px, 90vw)', whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
        fontFamily: 'var(--lg-font-mono)', fontSize: 10.5, color: '#e7ecfa',
        boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
      }}
    >
      {label}
    </div>,
    document.body,
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
        fontFamily: 'var(--lg-font-ui)', fontSize: 12,
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

  const overlayDismiss = useDialogOverlayDismiss(onClose)

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      {...overlayDismiss}
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
          <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#8b94b0' }}>
            blame: {filePath}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#4e5870', fontSize: 20, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
            onMouseEnter={e => (e.currentTarget.style.color = '#dde1f0')}
            onMouseLeave={e => (e.currentTarget.style.color = '#4e5870')}
          >×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'var(--lg-font-mono)', fontSize: 12 }}>
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

const WT_ROW_H = 66

function WorkingTreeGraphRow({ selected, changeCount, graphColW, lane = 0, onClick }: {
  selected: boolean; changeCount: number; graphColW: number; lane?: number; onClick: () => void
}) {
  const [hover, setHover] = useState(false)
  const hasChanges = changeCount > 0
  const accent = workingTreeAccent(changeCount)
  const rgb = hasChanges ? '232,98,47' : '46,197,115'
  const active = selected || hover
  const cx = GRAPH_PAD + lane * TL_LANE_W + TL_LANE_W / 2
  const cy = Math.round(WT_ROW_H * 0.42)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Open the working tree — review and stage uncommitted changes"
      style={{
        display: 'flex', alignItems: 'center', height: WT_ROW_H, flexShrink: 0,
        borderLeft: `2px solid ${selected ? accent : 'transparent'}`,
        borderBottom: '1px solid #1e2436',
        background: selected ? `rgba(${rgb},0.05)` : 'transparent',
        cursor: 'pointer', outline: 'none',
      }}
    >
      {/* Graph column — diamond + connecting line down to first commit */}
      <svg width={graphColW} height={WT_ROW_H} style={{ flexShrink: 0, overflow: 'visible', display: 'block' }}>
        <line
          x1={cx} y1={cy + 6} x2={cx} y2={WT_ROW_H}
          stroke={accent} strokeWidth={1.75} strokeOpacity={0.45}
        />
        {hasChanges && (
          <circle cx={cx} cy={cy} r={10} fill={accent} fillOpacity={active ? 0.18 : 0.1} />
        )}
        <CommitGlyph kind="working" color={accent} cx={cx} cy={cy} r={5}
          fillOpacity={active ? 1 : 0.75} />
      </svg>

      {/* Content — styled as a pressable card so it reads as a button */}
      <div style={{
        flex: 1, minWidth: 0, marginLeft: 2, marginRight: 8,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 9px 7px 10px', borderRadius: 6,
        border: `1px solid ${active ? `rgba(${rgb},0.55)` : `rgba(${rgb},0.28)`}`,
        background: active
          ? `linear-gradient(180deg, rgba(${rgb},0.16), rgba(${rgb},0.07))`
          : `linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.015))`,
        boxShadow: active
          ? `0 0 0 1px rgba(${rgb},0.12), 0 2px 10px rgba(0,0,0,0.35)`
          : '0 1px 2px rgba(0,0,0,0.3)',
        transition: 'background 0.12s, border-color 0.12s, box-shadow 0.12s',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
            <span style={{
              fontFamily: 'var(--lg-font-ui)', fontSize: 12.5, fontWeight: 700,
              letterSpacing: '0.01em',
              color: active ? '#eef1fa' : '#c3cade',
            }}>Working Tree</span>
            {hasChanges && (
              <span style={{
                fontFamily: 'var(--lg-font-mono)', fontSize: 9.5, fontWeight: 700,
                background: `rgba(${rgb},0.2)`, color: accent,
                border: `1px solid rgba(${rgb},0.4)`, borderRadius: 8,
                minWidth: 18, height: 16, paddingLeft: 5, paddingRight: 5,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}>{changeCount}</span>
            )}
          </div>
          <span style={{
            fontFamily: 'var(--lg-font-ui)', fontSize: 10.5,
            color: hasChanges ? `${accent}cc` : '#5d6883',
          }}>
            {hasChanges
              ? `${changeCount} uncommitted change${changeCount !== 1 ? 's' : ''}`
              : 'Nothing to commit'}
          </span>
        </div>

        {/* Affordance — label appears on hover/selection, chevron always visible */}
        <span style={{
          fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 600,
          letterSpacing: '0.04em', textTransform: 'uppercase',
          color: accent, opacity: active ? 0.9 : 0,
          transition: 'opacity 0.12s', flexShrink: 0, whiteSpace: 'nowrap',
        }}>
          {hasChanges ? 'Review' : 'Open'}
        </span>
        <svg width={14} height={14} viewBox="0 0 14 14" style={{ flexShrink: 0, display: 'block' }}>
          <path
            d="M5.25 3 L9 7 L5.25 11"
            fill="none" stroke={active ? accent : '#5d6883'} strokeWidth={1.6}
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  )
}

// ── Branch filter components ──────────────────────────────────────────────────

function isLiveOriginBranch(branch: BranchInfo): boolean {
  return branch.isRemote && (branch.remoteName === 'origin' || branch.name.startsWith('origin/'))
}

function mergeBranchLists(...lists: BranchInfo[][]): BranchInfo[] {
  const merged = new Map<string, BranchInfo>()
  for (const list of lists) {
    for (const branch of list) merged.set(branch.name, branch)
  }
  return [...merged.values()]
}

function selectedGraphBranches(
  selectedRemoteBranches: Set<string>,
  allBranches: BranchInfo[],
  visibleRemoteBranches: BranchInfo[],
): BranchInfo[] {
  const selected = visibleRemoteBranches.filter(branch => selectedRemoteBranches.has(branch.name))
  const current = allBranches.find(branch => branch.current && !branch.isRemote)
  const upstream = current?.upstream
    ? allBranches.find(branch => branch.name === current.upstream)
    : undefined
  return mergeBranchLists(selected, current ? [current] : [], upstream ? [upstream] : [])
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
      onClick={onToggle}
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
        onClick={e => e.stopPropagation()}
        style={{ width: 16, height: 16, position: 'relative', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
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
            width: 16,
            height: 16,
            borderRadius: 3,
            border: `1.5px solid ${checked ? bCol : '#5a6485'}`,
            background: checked ? bCol : '#0d1019',
            transition: 'all 0.12s',
            cursor: 'pointer',
          }}
        />
        {checked && (
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style={{ position: 'absolute', pointerEvents: 'none' }}>
            <path d="M1 4L4 7L9 1" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </label>
      <span style={{ width: 3, height: 16, borderRadius: 2, background: bCol, flexShrink: 0 }} />
      {/* Plain label, not a <button>: the whole row is the click target (matching
          the users dropdown), and a button here would pick up the app-wide
          control sizing and inflate the row. */}
      <span
        style={{
          fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#c8cdd8',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
        title={branch.name}
      >{branch.displayName || branch.name}</span>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {isDefault && (
          <span style={{
            background: 'rgba(125,211,252,0.14)', color: MAIN_BRANCH_COLOR,
            border: '1px solid rgba(125,211,252,0.45)',
            borderRadius: 3, padding: '0 4px',
            fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: 700,
          }}>main</span>
        )}
        {branch.hasLocal && (
          <span style={{
            background: `${bCol}22`, color: bCol, border: `1px solid ${bCol}45`,
            borderRadius: 3, padding: '0 4px',
            fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: 700,
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
      <ActionBtn
        onClick={onToggleOpen}
        size="sm"
        style={{ height: 22, paddingLeft: 8, paddingRight: 6, fontSize: 10.5, gap: 4 }}
      >
        <span>{visibleCount} branch{visibleCount !== 1 ? 'es' : ''}</span>
        <svg width="7" height="4" viewBox="0 0 8 5" fill="none"
          style={{ transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>
          <path d="M1 1L4 4L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </ActionBtn>

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
                fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: 700,
                color: '#3a4260', letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>Filter branches</span>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={onHideAll} style={{
                  fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#8f99b3',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  whiteSpace: 'nowrap',
                }}>Hide all</button>
                <button onClick={onShowAll} style={{
                  fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#e8622f',
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

// ── User filter components ────────────────────────────────────────────────────

function TLUserDropdownRow({ author, checked, color, onToggle }: {
  author: string; checked: boolean; color: string; onToggle: () => void
}) {
  const [hover, setHover] = useState(false)
  const ini = initials(author)
  return (
    <div
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '7px 12px', borderBottom: '1px solid #1a1f2e',
        cursor: 'pointer',
        background: hover ? '#1e2436' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      <label
        onClick={e => e.stopPropagation()}
        style={{ width: 16, height: 16, position: 'relative', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={e => {
            e.stopPropagation()
            onToggle()
          }}
          style={{
            appearance: 'none',
            margin: 0,
            width: 16,
            height: 16,
            borderRadius: 3,
            border: `1.5px solid ${checked ? color : '#5a6485'}`,
            background: checked ? color : '#0d1019',
            transition: 'all 0.12s',
            cursor: 'pointer',
          }}
        />
        {checked && (
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none" style={{ position: 'absolute', pointerEvents: 'none' }}>
            <path d="M1 4L4 7L9 1" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </label>
      <span style={{
        width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
        background: `${color}22`, border: `1px solid ${color}55`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--lg-font-mono)', fontSize: 9.5, fontWeight: 700, color,
        opacity: checked ? 1 : 0.45,
        transition: 'opacity 0.12s',
      }}>{ini}</span>
      <span
        style={{
          fontFamily: 'var(--lg-font-ui)', fontSize: 11.5,
          color: checked ? '#c8cdd8' : '#6a7290',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          transition: 'color 0.12s',
        }}
        title={author}
      >{author}</span>
    </div>
  )
}

function TLUserDropdown({ open, onToggleOpen, authors, hiddenUsers, onToggleUser, onShowAll, onHideAll }: {
  open: boolean; onToggleOpen: () => void
  authors: string[]; hiddenUsers: Set<string>
  onToggleUser: (author: string) => void; onShowAll: () => void; onHideAll: () => void
}) {
  const visibleCount = authors.filter(a => !hiddenUsers.has(a)).length
  const filtered = hiddenUsers.size > 0
  return (
    <div style={{ position: 'relative' }}>
      <ActionBtn
        onClick={onToggleOpen}
        size="sm"
        title="Filter by user"
        style={{
          height: 22, paddingLeft: 8, paddingRight: 6, fontSize: 10.5, gap: 4,
          color: filtered ? '#e8622f' : undefined,
        }}
      >
        <span>{visibleCount} user{visibleCount !== 1 ? 's' : ''}</span>
        <svg width="7" height="4" viewBox="0 0 8 5" fill="none"
          style={{ transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>
          <path d="M1 1L4 4L7 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </ActionBtn>

      {open && (
        <>
          <div onClick={onToggleOpen} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 91,
            background: '#1d2235', border: '1px solid #2f3a54',
            borderRadius: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
            minWidth: 248, maxHeight: 380, overflow: 'auto',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px 6px', borderBottom: '1px solid #1e2436',
              position: 'sticky', top: 0, background: '#1d2235', zIndex: 1,
            }}>
              <span style={{
                fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: 700,
                color: '#3a4260', letterSpacing: '0.1em', textTransform: 'uppercase',
              }}>Filter users</span>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={onHideAll} style={{
                  fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#8f99b3',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  whiteSpace: 'nowrap',
                }}>Hide all</button>
                <button onClick={onShowAll} style={{
                  fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#e8622f',
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  whiteSpace: 'nowrap',
                }}>Show all</button>
              </div>
            </div>
            {authors.length === 0 ? (
              <div style={{ padding: '10px 12px', fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#3a4260' }}>
                No authors loaded
              </div>
            ) : authors.map(author => (
              <TLUserDropdownRow
                key={author}
                author={author}
                checked={!hiddenUsers.has(author)}
                color={authorColor(author)}
                onToggle={() => onToggleUser(author)}
              />
            ))}
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
            isTip={tipBranches.length > 0}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0, paddingLeft: 5, paddingRight: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2, overflow: 'hidden' }}>
            {/* Branch tip pills */}
            {tipBranches.map(b => (
              <BranchPill
                key={b.name}
                label={tlBranchShortName(b.name)}
                color={branchColors.get(b.name) ?? '#4d9dff'}
                icon={branchPillIcon(b, defaultBranch)}
                isDefault={b.name === defaultBranch}
              />
            ))}
            <span style={{
              fontFamily: 'var(--lg-font-ui)', fontSize: 12,
              fontWeight: selected ? 600 : 400, color: '#c8cdd8',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>{commit.message}</span>
            {needsPush && <SyncBadge dir="up" title="Needs push" />}
            {needsPull && <SyncBadge dir="down" title="Needs pull" />}
            {isMerge && (
              <span style={{
                background: 'rgba(162,126,240,0.12)', color: '#a27ef0',
                border: '1px solid rgba(162,126,240,0.25)', borderRadius: 3,
                fontFamily: 'var(--lg-font-mono)', fontSize: 9, fontWeight: 600, flexShrink: 0,
                paddingLeft: 4, paddingRight: 4,
              }}>M</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
              background: `${col}22`, border: `1px solid ${col}44`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--lg-font-mono)', fontSize: 9.5, fontWeight: 700, color: col,
            }}>{ini}</span>
            <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870' }}>
              {timeAgo(commit.timestamp)}
            </span>
            <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 9, color: '#3a4260', marginLeft: 'auto', paddingRight: 2, flexShrink: 0 }}>
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
    ? `${compactPath(f.oldPath)} → ${compactPath(f.path)}`
    : compactPath(f.path)
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
          fontFamily: 'var(--lg-font-mono)', fontSize: 10, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>{f.status}</span>
        <FilePathText path={label} displayText={displayLabel} style={{
          fontFamily: 'var(--lg-font-mono)', fontSize: 11.5,
          color: '#c8cdd8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }} />
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

// ── Commit detail header ──────────────────────────────────────────────────────

function CommitHeader({ commit, repoPath }: { commit: CommitEntry; repoPath: string }) {
  const col = authorColor(commit.author)
  const ini = initials(commit.author)

  // The graph's CommitEntry only carries the subject line (%s). Fetch the
  // full message (%B) on demand so we can also show the body/description.
  const [fullMessage, setFullMessage] = useState<string | null>(null)
  const [bodyOpen,    setBodyOpen]    = useState(true)

  useEffect(() => {
    let cancelled = false
    setFullMessage(null)
    ipc.commitMessage(repoPath, commit.hash)
      .then(msg => { if (!cancelled) setFullMessage(msg) })
      .catch(() => { if (!cancelled) setFullMessage(null) })
    return () => { cancelled = true }
  }, [repoPath, commit.hash])

  // Split the full message into subject (first line) and body (the rest,
  // with the conventional blank separator line trimmed away).
  const subject = (fullMessage ?? commit.message).split('\n')[0] || commit.message
  const body = fullMessage
    ? fullMessage.split('\n').slice(1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
    : ''

  return (
    <div style={{ padding: '12px 14px', borderBottom: '1px solid #252d42', background: '#131720', flexShrink: 0 }}>
      <div style={{ marginBottom: 6 }}>
        <span style={{
          fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#3a4260',
          background: '#1a1f2e', borderRadius: 4, padding: '1px 7px',
        }}>{commit.hash.slice(0, 7)}</span>
      </div>
      <p style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 13.5, fontWeight: 600, color: '#dde1f0', margin: '0 0 8px', lineHeight: 1.4 }}>
        {subject}
      </p>

      {body && (
        <div style={{ margin: '0 0 8px' }}>
          <button
            onClick={() => setBodyOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontFamily: 'var(--lg-font-ui)', fontSize: 9.5, fontWeight: 700,
              color: '#4e5870', letterSpacing: '0.09em', textTransform: 'uppercase',
            }}
          >
            <svg
              width="8" height="8" viewBox="0 0 8 8" fill="none"
              style={{ transform: bodyOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.12s' }}
            >
              <path d="M2.5 1L6 4L2.5 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Description
          </button>
          {bodyOpen && (
            <pre style={{
              margin: '6px 0 0', padding: '8px 10px',
              background: '#0d0f15', border: '1px solid #1e2436', borderRadius: 5,
              fontFamily: 'var(--lg-font-mono)', fontSize: 11, lineHeight: 1.55,
              color: '#a8b0c8', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
              maxHeight: 220, overflowY: 'auto',
            }}>
              {body}
            </pre>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
          background: `linear-gradient(135deg, ${col}88, ${col}44)`, border: `1px solid ${col}55`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--lg-font-mono)', fontSize: 8, fontWeight: 700, color: col,
        }}>{ini}</span>
        <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#8b94b0' }}>{commit.author}</span>
        <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870' }}>{timeAgo(commit.timestamp)}</span>
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
  const [hasMore,     setHasMore]     = useState(false)
  const [histLoading, setHistLoading] = useState(false)
  const [limitRef]                    = useState({ current: INITIAL_LIMIT })
  const [remoteUrl,   setRemoteUrl]   = useState<string | null>(null)
  const [branches,     setBranches]     = useState<BranchInfo[]>([])
  const [defaultBranch, setDefaultBranch] = useState('main')
  const [selBranches,  setSelBranches]  = useState<Set<string>>(new Set())
  const [filterOpen,   setFilterOpen]   = useState(false)
  const [branchTips,   setBranchTips]   = useState<Map<string, BranchInfo[]>>(new Map())
  const [hoveredBranchKey, setHoveredBranchKey] = useState<string | null>(null)
  const [hiddenUsers,  setHiddenUsers]  = useState<Set<string>>(new Set())
  const [userFilterOpen, setUserFilterOpen] = useState(false)
  const [showOnlyPushReady, setShowOnlyPushReady] = useState(false)
  const [needsPushHashes, setNeedsPushHashes] = useState<Set<string>>(new Set())
  const [needsPullHashes, setNeedsPullHashes] = useState<Set<string>>(new Set())
  const autoLoadingRef = useRef(false)

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

  // Tip pills and the filter dropdown read from the same branchColor() lookup
  // the graph lanes use, so a branch is one colour everywhere. Previously this
  // was assigned by list position, which reshuffled whenever a branch appeared
  // or disappeared and never matched the lane it labelled.
  const branchColors = React.useMemo(() => {
    const colorBranches = mergeBranchLists(filterBranches, branches.filter(b => !b.isRemote))
    const map = new Map<string, string>()
    for (const b of colorBranches) {
      const isDefault = b.displayName === defaultBranch || b.name === defaultBranch
      map.set(b.name, isDefault ? MAIN_BRANCH_COLOR : branchColor(b.name))
    }
    return map
  }, [filterBranches, branches, defaultBranch])
  const allAuthors = React.useMemo(() => {
    const set = new Set<string>()
    for (const node of nodes) set.add(node.commit.author)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [nodes])

  const displayedNodes = React.useMemo(() => {
    let filtered = nodes
    let modified = false
    if (hiddenUsers.size > 0) {
      filtered = filtered.filter(n => !hiddenUsers.has(n.commit.author))
      modified = true
    }
    if (showOnlyPushReady) {
      filtered = filtered.filter(n => needsPushHashes.has(n.commit.hash))
      modified = true
    }
    return modified ? compactGraphLanes(filtered) : filtered
  }, [nodes, hiddenUsers, showOnlyPushReady, needsPushHashes])

  const graphColW = React.useMemo(() => {
    if (displayedNodes.length === 0) return GRAPH_PAD * 2 + TL_LANE_W
    const maxLane = displayedNodes.reduce((m, n) => Math.max(m, n.maxLane), 0)
    return GRAPH_PAD + (maxLane + 1) * TL_LANE_W + GRAPH_PAD
  }, [displayedNodes])
  const branchHoverLabels = React.useMemo(() => {
    const labels = new Map<string, string>([['main', defaultBranch || 'main']])
    for (const node of displayedNodes) {
      const tips = branchTips.get(node.commit.hash) ?? []
      for (const branch of tips) {
        const key = branch.displayName === defaultBranch || branch.name === defaultBranch ? 'main' : node.branchKey
        const existing = labels.get(key)
        if (existing && !existing.split(' / ').includes(branch.name)) {
          labels.set(key, `${existing} / ${branch.name}`)
        } else if (!existing) {
          labels.set(key, branch.name)
        }
      }
    }
    return labels
  }, [displayedNodes, branchTips, defaultBranch])
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
    selectedBranchesOverride?: Set<string>,
    defaultBranchOverride?: string,
    filterBranchesOverride?: BranchInfo[],
    allBranchesOverride?: BranchInfo[],
  ) => {
    setHistLoading(true)
    try {
      const active = selectedBranchesOverride ?? selBranches
      const mainBranch = defaultBranchOverride ?? defaultBranch
      const remoteBranchPool = filterBranchesOverride ?? filterBranches
      const allBranchPool = allBranchesOverride ?? branches
      const branchPool = mergeBranchLists(remoteBranchPool, selectedGraphBranches(active, allBranchPool, remoteBranchPool))
      const refs = selectedGraphBranches(active, branchPool, remoteBranchPool).map(branch => branch.name).filter(Boolean)
      if (refs.length === 0) {
        setNodes([])
        setTotalLoaded(0)
        setHasMore(false)
        return
      }
      const commits = await opRun('Loading history…', () => ipc.log(repoPath, { limit, all: !refs, refs }))
      setHasMore(commits.length >= limit)
      const defaultRef = branchPool.find(b => !b.isRemote && (b.displayName === mainBranch || b.name === mainBranch))?.name
        ?? branchPool.find(b => active.has(b.name) && (b.displayName === mainBranch || b.name === mainBranch))?.name
        ?? branchPool.find(b => b.displayName === mainBranch || b.name === mainBranch)?.name
      const defaultCommits = defaultRef
        ? await ipc.log(repoPath, { limit, all: false, refs: [defaultRef] }).catch(() => [])
        : []
      const defaultHashes = firstParentHashes(commits, defaultCommits[0]?.hash)
      const tipCommits = await Promise.all(refs.map(async ref => {
        try {
          const [tip] = await ipc.log(repoPath, { limit: 1, all: false, refs: [ref] })
          return tip ? { ref, hash: tip.hash } : null
        } catch {
          return null
        }
      }))
      const selectedTipRefs = new Map(tipCommits.filter(tip => !!tip).map(tip => [tip!.hash, tip!.ref]))
      // Key each lane by the branch name where we know one, so a branch keeps
      // its identity — and therefore its colour — as new commits move its tip.
      const graph = remapGraphWithMainLeft(
        computeGraph(commits, { branchNameByHash: selectedTipRefs }),
        defaultHashes,
      )
      const allowedKeys = new Set<string>()
      for (const node of graph) {
        const ref = selectedTipRefs.get(node.commit.hash)
        if (!ref) continue
        const branch = branchPool.find(b => b.name === ref)
        if (branch && (branch.displayName === mainBranch || branch.name === mainBranch)) allowedKeys.add('main')
        else allowedKeys.add(node.branchKey)
      }
      const pruned = pruneGraphToBranchKeys(graph, allowedKeys)
      setNodes(pruned)
      setTotalLoaded(pruned.length)
    } finally {
      setHistLoading(false)
    }
  }, [repoPath, opRun, selBranches, defaultBranch, filterBranches])

  const handleCommitListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom > 200) return
    if (autoLoadingRef.current || histLoading) return
    if (!hasMore) return
    autoLoadingRef.current = true
    const nextLimit = limitRef.current + MORE_INC
    limitRef.current = nextLimit
    Promise.resolve(loadHistory(nextLimit)).finally(() => { autoLoadingRef.current = false })
  }, [histLoading, hasMore, loadHistory, limitRef])

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
      const nextSel = new Set(liveBranches.map(b => b.name))
      fetchBranchTips(selectedGraphBranches(nextSel, bl, liveBranches))
      setSelBranches(nextSel)
      limitRef.current = INITIAL_LIMIT
      loadHistory(INITIAL_LIMIT, nextSel, def, liveBranches, bl)
    }).catch(() => {})
  }, [repoPath])

  // ── Refresh history when a git operation changes HEAD (fetch, pull, push, checkout, merge, commit) ──
  const historyTickRef   = useRef(historyTick)
  const loadHistoryRef   = useRef(loadHistory)
  useEffect(() => { loadHistoryRef.current = loadHistory }, [loadHistory])
  useEffect(() => {
    if (historyTick === historyTickRef.current) return
    historyTickRef.current = historyTick
    ipc.branchList(repoPath)
      .then(bl => {
        setBranches(bl)
        const originBranches = bl.filter(isLiveOriginBranch)
        const liveBranches = originBranches.length > 0 ? originBranches : bl.filter(b => b.isRemote)
        fetchBranchTips(selectedGraphBranches(selBranches, bl, liveBranches))
        loadHistoryRef.current(limitRef.current, selBranches, defaultBranch, liveBranches, bl)
      })
      .catch(() => {
        loadHistoryRef.current(limitRef.current)
      })
  }, [historyTick, repoPath, selBranches, defaultBranch, fetchBranchTips])

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

  const toggleUser = (author: string) => {
    setHiddenUsers(prev => {
      const next = new Set(prev)
      if (next.has(author)) next.delete(author)
      else next.add(author)
      return next
    })
  }

  const showAllUsers = () => {
    setHiddenUsers(new Set())
    setUserFilterOpen(false)
  }

  const hideAllUsers = () => {
    setHiddenUsers(new Set(allAuthors))
    setUserFilterOpen(false)
  }

  const toggleStash = () => {
    const next = !stashOpen
    setStashOpen(next)
    try { localStorage.setItem(STASH_KEY, next ? '1' : '0') } catch {
      return
    }
  }

  const selectedCommit = leftSel.kind === 'commit' ? leftSel.commit : null
  const legendHasMain = displayedNodes.some(node => node.isMain)
  const legendHasMerge = displayedNodes.some(node => node.commit.parentHashes.length > 1)
  const legendHasBranchTip = displayedNodes.some(node => (branchTips.get(node.commit.hash) ?? []).some(branch => branch.displayName !== defaultBranch && branch.name !== defaultBranch))
  const legendHasPush = displayedNodes.some(node => needsPushHashes.has(node.commit.hash))
  const legendHasPull = displayedNodes.some(node => needsPullHashes.has(node.commit.hash))
  // A "checked out" pill only shows when the current branch's tip is on screen
  // and it isn't the default — the default already has its own ★ entry.
  const legendHasCurrentBranch = displayedNodes.some(node =>
    (branchTips.get(node.commit.hash) ?? []).some(branch =>
      branch.current && branch.name !== defaultBranch && branch.displayName !== defaultBranch))
  // The working-tree row is always pinned above the list, so its glyph is always
  // on screen — unlike the entries above, which track what the graph shows.
  const currentHeadLane = React.useMemo(() => {
    const currentBranch = branches.find(b => b.current)?.name
    if (!currentBranch) return 0
    for (const node of displayedNodes) {
      const tips = branchTips.get(node.commit.hash) ?? []
      if (tips.some(t => t.name === currentBranch)) return node.lane
    }
    return displayedNodes[0]?.lane ?? 0
  }, [displayedNodes, branches, branchTips])
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
          <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 700, color: '#2a3040', letterSpacing: '0.1em', textTransform: 'uppercase', flexShrink: 0 }}>
            {(hiddenUsers.size > 0 || showOnlyPushReady)
              ? `${displayedNodes.length} of ${totalLoaded} Commits`
              : totalLoaded > 0 ? `${totalLoaded} Commits` : 'Commits'}
          </span>
          <div style={{ flex: 1 }} />
          <ActionBtn
            onClick={() => setShowOnlyPushReady(s => !s)}
            size="sm"
            title={showOnlyPushReady ? 'Showing only commits ready to push — click to show all' : 'Show only commits ready to push'}
            color={showOnlyPushReady ? '#7dd3fc' : undefined}
            style={{ height: 22, paddingLeft: 8, paddingRight: 8, fontSize: 10.5, gap: 4, flexShrink: 0 }}
          >
            <span>↑ {needsPushHashes.size}</span>
          </ActionBtn>
          <TLUserDropdown
            open={userFilterOpen}
            onToggleOpen={() => setUserFilterOpen(o => !o)}
            authors={allAuthors}
            hiddenUsers={hiddenUsers}
            onToggleUser={toggleUser}
            onShowAll={showAllUsers}
            onHideAll={hideAllUsers}
          />
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
          <ActionBtn
            onClick={() => loadHistory(limitRef.current)}
            disabled={histLoading}
            size="sm"
            title="Refresh history"
            style={{ height: 22, paddingLeft: 6, paddingRight: 6, fontSize: 12, flexShrink: 0 }}
          >{histLoading ? '…' : '↺'}</ActionBtn>
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
                  <span style={{ color: '#4d9dff', fontFamily: 'var(--lg-font-mono)', fontSize: 10 }}>{c.hash.slice(0, 7)}</span>
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
        <div onScroll={handleCommitListScroll} style={{ flex: 1, overflowY: 'auto' }}>
          {histLoading && displayedNodes.length === 0 && (
            <p style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#2a3040', padding: '16px 12px' }}>Loading…</p>
          )}
          {!histLoading && nodes.length > 0 && displayedNodes.length === 0 && (
            <p style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#2a3040', padding: '16px 12px' }}>
              {showOnlyPushReady ? 'No commits ready to push.' : 'No commits match the user filter.'}
            </p>
          )}
          {displayedNodes.map(node => (
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
          {histLoading && displayedNodes.length > 0 && (
            <div style={{
              display: 'flex', justifyContent: 'center', padding: '8px 10px',
              fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#3a4260',
            }}>
              Loading more…
            </div>
          )}
          {!histLoading && hasMore && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 10 }}>
              <ActionBtn
                onClick={() => { limitRef.current += MORE_INC; loadHistory(limitRef.current) }}
                size="sm"
                style={{ height: 26, paddingLeft: 14, paddingRight: 14, fontSize: 11 }}
              >Load more…</ActionBtn>
            </div>
          )}
        </div>
        <div style={{
          minHeight: 28, flexShrink: 0, borderTop: '1px solid #1e2436', background: '#0d0f15',
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
          fontFamily: 'var(--lg-font-mono)', fontSize: 9, color: '#4e5870',
          flexWrap: 'wrap', lineHeight: 1.3,
        }}>
          <span>Legend:</span>
          {legendHasMain && (
            <LegendItem label="main path">
              <line x1={1} y1={8} x2={15} y2={8}
                stroke={MAIN_BRANCH_COLOR} strokeWidth={2.7} strokeOpacity={0.86} strokeLinecap="round" />
            </LegendItem>
          )}
          <LegendItem label="commit">
            <CommitGlyph kind="commit" color={LEGEND_NEUTRAL} cx={8} cy={8} />
          </LegendItem>
          {legendHasBranchTip && (
            <LegendItem label="branch tip">
              <CommitGlyph kind="tip" color={LEGEND_NEUTRAL} cx={8} cy={8} />
            </LegendItem>
          )}
          {legendHasMerge && (
            <LegendItem label="merge">
              <CommitGlyph kind="merge" color={LEGEND_NEUTRAL} cx={8} cy={8} />
            </LegendItem>
          )}
          <LegendItem label="working tree">
            <CommitGlyph kind="working" color={workingTreeAccent(fileStatus.length)} cx={8} cy={8} r={5} />
          </LegendItem>
          {legendHasPush && <LegendBadge dir="up" label="to push" />}
          {legendHasPull && <LegendBadge dir="down" label="to pull" />}
          {legendHasMain && <BranchPill label="default" color={MAIN_BRANCH_COLOR} icon="★" isDefault />}
          {legendHasCurrentBranch && <BranchPill label="checked out" color={LEGEND_NEUTRAL} icon="◉" />}
          <span style={{ opacity: 0.75 }}>colour = branch</span>
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
            <div style={{ flexShrink: 0 }}>
              <button
                onClick={toggleStash}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 7,
                  height: 34, paddingLeft: 12, paddingRight: 10,
                  background: stashOpen ? 'rgba(74,158,255,0.22)' : 'rgba(74,158,255,0.15)',
                  border: 'none', borderTop: '1px solid rgba(74,158,255,0.4)', cursor: 'pointer',
                  color: '#4a9eff', fontFamily: 'var(--lg-font-ui)', fontSize: 10.5, fontWeight: 700,
                  letterSpacing: '0.1em', textTransform: 'uppercase',
                  transition: 'background 0.12s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(74,158,255,0.3)' }}
                onMouseLeave={e => { e.currentTarget.style.background = stashOpen ? 'rgba(74,158,255,0.22)' : 'rgba(74,158,255,0.15)' }}
              >
                <svg
                  width="9" height="9" viewBox="0 0 8 8" fill="none"
                  style={{ flexShrink: 0, transition: 'transform 0.15s', transform: stashOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  <path d="M2 1.5l3 2.5-3 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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
            <CommitHeader commit={selectedCommit} repoPath={repoPath} />
            <div style={{
              display: 'flex', alignItems: 'center', height: 30, paddingLeft: 12, paddingRight: 10,
              borderBottom: '1px solid #1e2436', background: '#0d0f15', flexShrink: 0,
            }}>
              <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, fontWeight: 700, color: '#2a3040', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Files changed
                {!commitFilesLoading && commitFiles.length > 0 && (
                  <span style={{ marginLeft: 8, fontFamily: 'var(--lg-font-mono)', fontSize: 10, background: '#1a1f2e', color: '#3a4260', borderRadius: 8, padding: '1px 5px' }}>
                    {commitFiles.length}
                  </span>
                )}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {commitFilesLoading ? (
                <p style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#2a3040', padding: '12px 14px' }}>Loading…</p>
              ) : commitFiles.length === 0 ? (
                <p style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#2a3040', padding: '12px 14px' }}>No file changes</p>
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
            <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 13, color: '#2e3a50' }}>Select a commit</span>
          </div>
        )}
      </div>

      <DragHandle onMouseDown={makeDragStart('center', centerWidth)} />

      {/* ── Right column ──────────────────────────────────────────────────── */}
      <FileDetailsSidePanel
        filePath={centerFile?.file.path ?? null}
        hash={centerFile?.kind === 'commit' ? centerFile.commitHash : 'HEAD'}
        repoPath={repoPath}
        diff={diff}
        diffLoading={diffLoading}
        blame={blame}
        blameLoading={blameLoading}
        emptyMessage="Select a file to preview"
        remoteUrl={remoteUrl}
      />
    </div>
  )
}

// ── Branch filter row ─────────────────────────────────────────────────────────
