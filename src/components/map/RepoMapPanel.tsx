import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ipc, Lock, CommitFileChange, PresenceFile } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useAuthStore } from '@/stores/authStore'

interface RepoMapPanelProps {
  repoPath: string
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface FileNode {
  name:           string
  path:           string
  isDir:          boolean
  children:       FileNode[]
  score:          number        // raw activity score (files only)
  totalScore:     number        // propagated aggregate
  fileCount:      number
  lockList:       Lock[]
  presenceLogins: string[]
  myStatus:       'staged' | 'modified' | null
}

interface Rect        { x: number; y: number; w: number; h: number }
interface LayoutItem  { node: FileNode; rect: Rect }
interface HoverInfo   { node: FileNode; x: number; y: number }

// ── Color / display utils ─────────────────────────────────────────────────────

function heatFill(ratio: number): string {
  // Cool (dark blue) → Hot (accent orange)
  const h = (225 - ratio * 205).toFixed(1)
  const s = (18  + ratio * 67).toFixed(1)
  const l = (12  + ratio * 45).toFixed(1)
  return `hsl(${h},${s}%,${l}%)`
}

function heatStroke(ratio: number, hovered: boolean): string {
  if (hovered) return 'rgba(255,255,255,0.28)'
  if (ratio > 0.75) return 'rgba(232,98,47,0.55)'
  if (ratio > 0.4)  return 'rgba(245,168,50,0.25)'
  return '#1a1f2e'
}

function labelCol(ratio: number): string {
  return ratio > 0.55 ? '#ffffff' : ratio > 0.28 ? '#dde1f0' : '#8b94b0'
}

function authorColor(name: string): string {
  const p = ['#4d9dff','#a27ef0','#2ec573','#f5a832','#e8622f','#1abc9c','#e91e63']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return p[h % p.length]
}

function avatarInitials(login: string): string {
  const parts = login.split(/[_\-.]/).filter(p => p.length > 0)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return login.slice(0, 2).toUpperCase()
}

function truncate(s: string, maxCh: number): string {
  if (maxCh < 2) return ''
  return s.length <= maxCh ? s : s.slice(0, maxCh - 1) + '…'
}

function timeAgoStr(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60)    return 'just now'
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Tree building ─────────────────────────────────────────────────────────────

function buildTree(
  freqMap:   Map<string, number>,
  lockMap:   Map<string, Lock>,
  presMap:   Map<string, string[]>,
  statusMap: Map<string, 'staged' | 'modified'>,
): FileNode {
  const nodes = new Map<string, FileNode>()

  function ensure(path: string): FileNode {
    if (!nodes.has(path)) {
      nodes.set(path, {
        name: path.split('/').pop() || path,
        path, isDir: false, children: [],
        score: 0, totalScore: 0, fileCount: 0,
        lockList: [], presenceLogins: [], myStatus: null,
      })
    }
    return nodes.get(path)!
  }

  for (const [filePath, score] of freqMap) {
    const norm = filePath.replace(/\\/g, '/')
    const node = ensure(norm)
    node.score        = score
    node.fileCount    = 1
    node.lockList     = lockMap.has(norm) ? [lockMap.get(norm)!] : []
    node.presenceLogins = presMap.get(norm) ?? []
    node.myStatus     = statusMap.get(norm) ?? null

    // Ensure ancestor dirs exist
    const parts = norm.split('/')
    for (let d = 1; d < parts.length; d++) {
      const dirPath = parts.slice(0, d).join('/')
      ensure(dirPath).isDir = true
    }
  }

  // Wire parent → child
  for (const [path, node] of nodes) {
    if (!path.includes('/')) continue
    const parentPath = path.split('/').slice(0, -1).join('/')
    const parent = ensure(parentPath)
    parent.isDir = true
    if (!parent.children.some(c => c.path === path)) parent.children.push(node)
  }

  // Root collects top-level nodes
  const root: FileNode = {
    name: 'root', path: '', isDir: true,
    children: [...nodes.values()].filter(n => !n.path.includes('/')),
    score: 0, totalScore: 0, fileCount: 0,
    lockList: [], presenceLogins: [], myStatus: null,
  }

  function propagate(node: FileNode): void {
    for (const child of node.children) propagate(child)
    if (!node.isDir) { node.totalScore = node.score; return }
    node.totalScore = node.children.reduce((s, c) => s + c.totalScore, 0)
    node.fileCount  = node.children.reduce((s, c) => s + c.fileCount,  0)
    for (const c of node.children) {
      for (const l of c.lockList)
        if (!node.lockList.some(ll => ll.id === l.id)) node.lockList.push(l)
      for (const login of c.presenceLogins)
        if (!node.presenceLogins.includes(login)) node.presenceLogins.push(login)
    }
    node.children.sort((a, b) => b.totalScore - a.totalScore)
  }

  propagate(root)
  return root
}

// ── Binary-split treemap layout ───────────────────────────────────────────────

function layout(nodes: FileNode[], rect: Rect, gap = 2): LayoutItem[] {
  if (nodes.length === 0 || rect.w < 4 || rect.h < 4) return []
  if (nodes.length === 1) return [{ node: nodes[0], rect }]

  const scores = nodes.map(n => Math.max(n.totalScore, 0.01))
  const total  = scores.reduce((s, v) => s + v, 0)

  let leftSum = 0, split = 0
  while (split < nodes.length - 1 && leftSum + scores[split] < total * 0.5) {
    leftSum += scores[split++]
  }
  leftSum += scores[split++]
  const ratio = leftSum / total

  let lr: Rect, rr: Rect
  if (rect.w >= rect.h) {
    const lw = Math.max(4, (rect.w - gap) * ratio)
    lr = { x: rect.x,             y: rect.y, w: lw,                   h: rect.h }
    rr = { x: rect.x + lw + gap,  y: rect.y, w: rect.w - lw - gap,    h: rect.h }
  } else {
    const lh = Math.max(4, (rect.h - gap) * ratio)
    lr = { x: rect.x, y: rect.y,             w: rect.w, h: lh }
    rr = { x: rect.x, y: rect.y + lh + gap,  w: rect.w, h: rect.h - lh - gap }
  }

  return [...layout(nodes.slice(0, split), lr, gap), ...layout(nodes.slice(split), rr, gap)]
}

// ── SVG cell ──────────────────────────────────────────────────────────────────

function Cell({
  item, maxScore, currentLogin, hoveredPath,
  onEnter, onMove, onLeave, onClick,
}: {
  item:         LayoutItem
  maxScore:     number
  currentLogin: string | null
  hoveredPath:  string | null
  onEnter: (node: FileNode, x: number, y: number) => void
  onMove:  (node: FileNode, x: number, y: number) => void
  onLeave: () => void
  onClick: (node: FileNode) => void
}) {
  const { node, rect: r } = item
  const ratio   = maxScore > 0 ? Math.min(node.totalScore / maxScore, 1) : 0
  const hovered = hoveredPath === node.path
  const fill    = heatFill(ratio)
  const stroke  = heatStroke(ratio, hovered)
  const tc      = labelCol(ratio)
  const pad     = 6

  const statusStroke = node.myStatus === 'staged'   ? '#2ec573'
                     : node.myStatus === 'modified' ? '#f5a832'
                     : null

  return (
    <g
      style={{ cursor: node.isDir ? 'pointer' : 'default' }}
      onClick={() => node.isDir && onClick(node)}
      onMouseEnter={e => onEnter(node, (e.nativeEvent as MouseEvent).offsetX, (e.nativeEvent as MouseEvent).offsetY)}
      onMouseMove={e  => onMove (node, (e.nativeEvent as MouseEvent).offsetX, (e.nativeEvent as MouseEvent).offsetY)}
      onMouseLeave={onLeave}
    >
      {/* Base rect */}
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={5} ry={5}
        fill={fill} stroke={statusStroke ?? stroke}
        strokeWidth={statusStroke ? 1.75 : hovered ? 1 : 0.6}
      />

      {/* Staged/Modified left accent */}
      {statusStroke && r.h > 14 && (
        <rect x={r.x} y={r.y + 5} width={2.5} height={r.h - 10} rx={1} fill={statusStroke} />
      )}

      {/* Directory chevron */}
      {node.isDir && r.w > 22 && r.h > 16 && (
        <text x={r.x + pad} y={r.y + 13} fill={tc} fontSize={8}
          fontFamily="monospace" opacity={0.6} style={{ userSelect: 'none', pointerEvents: 'none' }}>
          ▶
        </text>
      )}

      {/* Name */}
      {r.h > 14 && r.w > 28 && (
        <text
          x={r.x + pad + (node.isDir && r.w > 22 ? 11 : 0)}
          y={r.y + 13}
          fill={tc} fontSize={Math.min(11, Math.max(8, r.w / 14))}
          fontFamily="'IBM Plex Sans', system-ui"
          fontWeight={node.isDir ? 600 : 400}
          style={{ userSelect: 'none', pointerEvents: 'none' }}
        >
          {truncate(node.name, Math.floor((r.w - pad * 2 - 14) / 6.2))}
        </text>
      )}

      {/* Stats sub-label */}
      {r.h > 30 && r.w > 48 && node.totalScore > 0 && (
        <text x={r.x + pad} y={r.y + 25}
          fill={tc} fontSize={8} opacity={0.55}
          fontFamily="'JetBrains Mono', monospace"
          style={{ userSelect: 'none', pointerEvents: 'none' }}>
          {node.isDir ? `${node.fileCount}f · ${node.totalScore}↑` : `${node.totalScore}↑`}
        </text>
      )}

      {/* Lock dot (top-right) */}
      {node.lockList.length > 0 && r.w > 16 && r.h > 16 && (() => {
        const isOwn = node.lockList.some(l => l.owner.login === currentLogin)
        return (
          <circle cx={r.x + r.w - 8} cy={r.y + 8} r={5}
            fill={isOwn ? '#2ec573' : '#f5a832'} fillOpacity={0.95} />
        )
      })()}

      {/* Presence avatars (bottom-left) */}
      {node.presenceLogins.length > 0 && r.h > 28 && r.w > 28 && (
        <g>
          {node.presenceLogins.slice(0, 4).map((login, i) => {
            const col = authorColor(login)
            const cx  = r.x + pad + i * 13
            const cy  = r.y + r.h - 9
            return (
              <g key={login}>
                <circle cx={cx} cy={cy} r={6} fill={col} fillOpacity={0.9} />
                <text x={cx} y={cy + 2.5} textAnchor="middle" fill="#fff"
                  fontSize={5.5} fontWeight="700" fontFamily="monospace"
                  style={{ userSelect: 'none', pointerEvents: 'none' }}>
                  {avatarInitials(login).slice(0, 1)}
                </text>
              </g>
            )
          })}
          {node.presenceLogins.length > 4 && (
            <text x={r.x + pad + 4 * 13} y={r.y + r.h - 6}
              fill="#8b94b0" fontSize={7} fontFamily="monospace"
              style={{ userSelect: 'none', pointerEvents: 'none' }}>
              +{node.presenceLogins.length - 4}
            </text>
          )}
        </g>
      )}
    </g>
  )
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function Tooltip({
  info, containerW, containerH, presNames,
}: {
  info: HoverInfo; containerW: number; containerH: number
  presNames: Map<string, string>
}) {
  const { node, x, y } = info
  const W = 240, H_EST = 140
  const tx = x + W + 12 > containerW ? x - W - 8 : x + 12
  const ty = y + H_EST + 8 > containerH ? y - H_EST : y + 8

  const isDir = node.isDir
  const locksByOwner = node.lockList.reduce((acc, l) => {
    const key = l.owner.login
    if (!acc.has(key)) acc.set(key, l)
    return acc
  }, new Map<string, Lock>())

  return (
    <div style={{
      position: 'absolute', left: tx, top: ty, width: W, zIndex: 50,
      background: '#1d2235', border: '1px solid #2f3a54',
      borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      padding: '12px 14px', pointerEvents: 'none',
    }}>
      {/* Path */}
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870', marginBottom: 4, wordBreak: 'break-all' }}>
        {node.path || '/'}
      </div>
      {/* Name */}
      <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 14, fontWeight: 700, color: '#dde1f0', marginBottom: 8 }}>
        {node.name}
        {isDir && <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4e5870', marginLeft: 6 }}>/</span>}
      </div>

      {/* Metrics row */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
        <div>
          <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, color: '#4e5870', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Activity</div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 700, color: node.totalScore > 8 ? '#e8622f' : node.totalScore > 3 ? '#f5a832' : '#8b94b0' }}>
            ↑{node.totalScore}
          </div>
        </div>
        {isDir && (
          <div>
            <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, color: '#4e5870', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Files</div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 700, color: '#dde1f0' }}>{node.fileCount}</div>
          </div>
        )}
        {node.lockList.length > 0 && (
          <div>
            <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, color: '#4e5870', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Locks</div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 700, color: '#f5a832' }}>{locksByOwner.size}</div>
          </div>
        )}
      </div>

      {/* Current status */}
      {node.myStatus && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
          padding: '4px 8px', borderRadius: 5,
          background: node.myStatus === 'staged' ? 'rgba(46,197,115,0.12)' : 'rgba(245,168,50,0.12)',
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: node.myStatus === 'staged' ? '#2ec573' : '#f5a832' }} />
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: node.myStatus === 'staged' ? '#2ec573' : '#f5a832' }}>
            {node.myStatus === 'staged' ? 'Staged in your workspace' : 'Modified in your workspace'}
          </span>
        </div>
      )}

      {/* Locks */}
      {locksByOwner.size > 0 && (
        <div style={{ marginBottom: 6 }}>
          {[...locksByOwner.values()].slice(0, 3).map(l => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 20 }}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <rect x="2" y="4.5" width="6" height="4" rx="1" stroke="#f5a832" strokeWidth="1" />
                <path d="M3.5 4.5V3a1.5 1.5 0 0 1 3 0v1.5" stroke="#f5a832" strokeWidth="1" strokeLinecap="round" />
              </svg>
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#f5a832' }}>
                {l.owner.name || l.owner.login}
              </span>
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#4e5870' }}>
                {timeAgoStr(l.lockedAt)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Presence */}
      {node.presenceLogins.length > 0 && (
        <div>
          <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, color: '#4e5870', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
            Working here
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {node.presenceLogins.map(login => {
              const col = authorColor(login)
              return (
                <div key={login} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: col, opacity: 0.85, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 7, fontWeight: 700, color: '#fff' }}>
                      {avatarInitials(login)}
                    </span>
                  </div>
                  <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: '#8b94b0' }}>
                    {presNames.get(login) ?? login}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {isDir && node.children.length > 0 && (
        <div style={{ marginTop: 8, fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#4e5870' }}>
          Click to zoom in
        </div>
      )}
    </div>
  )
}

// ── Breadcrumb ────────────────────────────────────────────────────────────────

function Breadcrumb({
  stack, onPop,
}: { stack: FileNode[]; onPop: (idx: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', flex: 1, minWidth: 0 }}>
      <button
        onClick={() => onPop(-1)}
        style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: stack.length === 0 ? '#dde1f0' : '#4d9dff', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', flexShrink: 0 }}
      >Root</button>
      {stack.map((node, i) => (
        <React.Fragment key={node.path}>
          <span style={{ color: '#4e5870', fontSize: 12 }}>›</span>
          <button
            onClick={() => onPop(i)}
            style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              color: i === stack.length - 1 ? '#dde1f0' : '#4d9dff',
              background: 'none', border: 'none', cursor: i < stack.length - 1 ? 'pointer' : 'default',
              padding: '0 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140,
            }}
          >{node.name}</button>
        </React.Fragment>
      ))}
    </div>
  )
}

// ── Side panel ────────────────────────────────────────────────────────────────

function SidePanel({
  freqMap, locks, presence, presNames,
}: {
  freqMap:   Map<string, number>
  locks:     Lock[]
  presence:  PresenceFile | null
  presNames: Map<string, string>
}) {
  const hotFiles = useMemo(() => {
    return [...freqMap.entries()]
      .filter(([p]) => !p.endsWith('/'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
  }, [freqMap])

  const presEntries = useMemo(() => {
    if (!presence) return []
    const cutoff = Date.now() - 30 * 60 * 1000
    return Object.values(presence.entries)
      .filter(e => new Date(e.lastSeen).getTime() > cutoff)
      .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
  }, [presence])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', overflowY: 'auto', flex: 1 }}>

      {/* ── Legend ──────────────────────────────────────────────────────────── */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #252d42' }}>
        <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 600, color: '#4e5870', letterSpacing: '0.09em', textTransform: 'uppercase', marginBottom: 6 }}>Activity Heat</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, color: '#4e5870' }}>none</span>
          <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'linear-gradient(to right, hsl(225,18%,12%), hsl(115,45%,30%), hsl(40,70%,40%), hsl(20,83%,57%))', opacity: 0.85 }} />
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, color: '#e8622f' }}>hot</span>
        </div>
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          {[
            { col: '#2ec573', label: 'My locks' },
            { col: '#f5a832', label: 'Team locks' },
            { col: '#f5a832', label: 'Modified', border: true },
            { col: '#2ec573', label: 'Staged', border: true },
          ].map((item, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              {item.border
                ? <div style={{ width: 10, height: 10, borderRadius: 2, border: `2px solid ${item.col}`, background: 'transparent' }} />
                : <div style={{ width: 8, height: 8, borderRadius: '50%', background: item.col }} />
              }
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, color: '#4e5870' }}>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Active teammates ─────────────────────────────────────────────────── */}
      {presEntries.length > 0 && (
        <div style={{ borderBottom: '1px solid #252d42' }}>
          <div style={{ padding: '8px 14px 4px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 600, color: '#4e5870', letterSpacing: '0.09em', textTransform: 'uppercase' }}>
            Active Now · {presEntries.length}
          </div>
          {presEntries.map(e => {
            const col = authorColor(e.login)
            const ini = avatarInitials(e.login)
            const isStale = Date.now() - new Date(e.lastSeen).getTime() > 10 * 60 * 1000
            return (
              <div key={e.login} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 14px', borderBottom: '1px solid #1a1f30' }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', flexShrink: 0, background: col, opacity: isStale ? 0.4 : 0.85, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, fontWeight: 700, color: '#fff' }}>{ini}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: 600, color: isStale ? '#4e5870' : '#dde1f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.name || e.login}
                    </span>
                    <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, color: '#4e5870', flexShrink: 0 }}>
                      {timeAgoStr(e.lastSeen)}
                    </span>
                  </div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#4d9dff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                    {e.branch}
                  </div>
                  {e.modifiedCount > 0 && (
                    <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#f5a832', marginTop: 1 }}>
                      {e.modifiedCount} file{e.modifiedCount !== 1 ? 's' : ''} modified
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Hot spots ────────────────────────────────────────────────────────── */}
      {hotFiles.length > 0 && (
        <div style={{ borderBottom: '1px solid #252d42' }}>
          <div style={{ padding: '8px 14px 4px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 600, color: '#4e5870', letterSpacing: '0.09em', textTransform: 'uppercase' }}>
            Most Active Files
          </div>
          {hotFiles.map(([path, score], i) => {
            const name = path.split('/').pop()!
            const ratio = hotFiles[0][1] > 0 ? score / hotFiles[0][1] : 0
            return (
              <div key={path} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, paddingLeft: 14, paddingRight: 14, borderBottom: '1px solid #1a1f30' }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#4e5870', width: 14, flexShrink: 0 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ height: 3, background: '#1d2235', borderRadius: 2, marginBottom: 3 }}>
                    <div style={{ height: 3, borderRadius: 2, background: heatFill(ratio), width: `${ratio * 100}%` }} />
                  </div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#8b94b0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={path}>
                    {name}
                  </div>
                </div>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: ratio > 0.6 ? '#e8622f' : '#4e5870', flexShrink: 0 }}>↑{score}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Current locks ────────────────────────────────────────────────────── */}
      {locks.length > 0 && (
        <div>
          <div style={{ padding: '8px 14px 4px', fontFamily: "'IBM Plex Sans', system-ui", fontSize: 9, fontWeight: 600, color: '#4e5870', letterSpacing: '0.09em', textTransform: 'uppercase' }}>
            Active Locks · {locks.length}
          </div>
          {locks.map(l => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 14px', borderBottom: '1px solid #1a1f30' }}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ marginTop: 2, flexShrink: 0 }}>
                <rect x="2" y="5.5" width="8" height="5" rx="1.5" stroke="#f5a832" strokeWidth="1.1" />
                <path d="M3.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5" stroke="#f5a832" strokeWidth="1.1" strokeLinecap="round" />
              </svg>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#dde1f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.path}>
                  {l.path.split('/').pop()}
                </div>
                <div style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 10, color: '#4e5870', marginTop: 1 }}>
                  {l.owner.name || l.owner.login} · {timeAgoStr(l.lockedAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {presEntries.length === 0 && hotFiles.length === 0 && locks.length === 0 && (
        <div style={{ padding: 20, fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#4e5870', textAlign: 'center' }}>
          No activity data yet
        </div>
      )}
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

const COMMIT_LIMIT   = 20
const SCORE_MODIFIED = 6
const SCORE_LOCKED   = 4
const SCORE_PRESENCE = 2

export function RepoMapPanel({ repoPath }: RepoMapPanelProps) {
  const { fileStatus } = useRepoStore()
  const { accounts, currentAccountId } = useAuthStore()
  const currentLogin = accounts.find(a => a.userId === currentAccountId)?.login ?? null

  // ── Data state ────────────────────────────────────────────────────────────
  const [freqMap,   setFreqMap]   = useState<Map<string, number>>(new Map())
  const [locks,     setLocks]     = useState<Lock[]>([])
  const [presence,  setPresence]  = useState<PresenceFile | null>(null)
  const [presNames, setPresNames] = useState<Map<string, string>>(new Map())
  const [loading,   setLoading]   = useState(true)
  const [commitCount, setCommitCount] = useState(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  // ── SVG container size ────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null)
  const [svgSize, setSvgSize] = useState({ w: 800, h: 500 })
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width > 10 && height > 10) setSvgSize({ w: width, h: height })
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // ── Zoom navigation ───────────────────────────────────────────────────────
  const [zoomStack, setZoomStack] = useState<FileNode[]>([])
  const [fading,    setFading]    = useState(false)

  const zoomTo = useCallback((node: FileNode) => {
    setFading(true)
    setTimeout(() => {
      setZoomStack(s => [...s, node])
      setFading(false)
    }, 130)
  }, [])

  const popTo = useCallback((idx: number) => {
    setFading(true)
    setTimeout(() => {
      if (idx === -1) setZoomStack([])
      else setZoomStack(s => s.slice(0, idx + 1))
      setFading(false)
    }, 130)
  }, [])

  // ── Hover state ───────────────────────────────────────────────────────────
  const [hovered, setHovered] = useState<HoverInfo | null>(null)

  const handleEnter = useCallback((node: FileNode, x: number, y: number) => setHovered({ node, x, y }), [])
  const handleMove  = useCallback((node: FileNode, x: number, y: number) => setHovered(h => h?.node === node ? { node, x, y } : h), [])
  const handleLeave = useCallback(() => setHovered(null), [])

  // ── Data loading ──────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [commits, locksResult, presResult] = await Promise.all([
        ipc.log(repoPath, { limit: COMMIT_LIMIT }),
        ipc.listLocks(repoPath),
        ipc.presenceRead(repoPath),
      ])
      if (!mounted.current) return

      setCommitCount(commits.length)
      setLocks(locksResult)
      setPresence(presResult)

      // Build login → display name map
      const nameMap = new Map<string, string>()
      for (const entry of Object.values(presResult?.entries ?? {})) {
        if (entry.name) nameMap.set(entry.login, entry.name)
      }
      setPresNames(nameMap)

      // Fetch changed files in batches to avoid flooding the IPC channel
      const BATCH = 4
      const fileChangeSets: PromiseSettledResult<CommitFileChange[]>[] = []
      for (let i = 0; i < commits.length; i += BATCH) {
        if (!mounted.current) return
        const slice = await Promise.allSettled(
          commits.slice(i, i + BATCH).map(c => ipc.commitFiles(repoPath, c.hash))
        )
        fileChangeSets.push(...slice)
      }

      const freq = new Map<string, number>()

      const add = (path: string, delta: number) => {
        const norm = path.replace(/\\/g, '/')
        freq.set(norm, (freq.get(norm) ?? 0) + delta)
      }

      // Commit frequency (1 per commit)
      for (const result of fileChangeSets) {
        if (result.status === 'fulfilled') {
          for (const f of result.value) add(f.path, 1)
        }
      }

      // Boost: currently modified files
      for (const f of fileStatus) add(f.path, SCORE_MODIFIED)

      // Boost: locked files
      for (const l of locksResult) add(l.path, SCORE_LOCKED)

      // Boost: presence files
      for (const entry of Object.values(presResult?.entries ?? {})) {
        const cutoff = Date.now() - 30 * 60 * 1000
        if (new Date(entry.lastSeen).getTime() < cutoff) continue
        for (const file of entry.modifiedFiles) add(file, SCORE_PRESENCE)
      }

      if (mounted.current) setFreqMap(freq)
    } catch { /* ignore */ }
    finally { if (mounted.current) setLoading(false) }
  }, [repoPath, fileStatus])

  useEffect(() => { loadData() }, [repoPath])

  // ── Derived: tree + layout ────────────────────────────────────────────────
  const lockMap = useMemo(() => {
    const m = new Map<string, Lock>()
    for (const l of locks) m.set(l.path.replace(/\\/g, '/'), l)
    return m
  }, [locks])

  const presMap = useMemo(() => {
    const m = new Map<string, string[]>()
    if (!presence) return m
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const entry of Object.values(presence?.entries ?? {})) {
      if (new Date(entry.lastSeen).getTime() < cutoff) continue
      for (const file of entry.modifiedFiles) {
        const norm = file.replace(/\\/g, '/')
        if (!m.has(norm)) m.set(norm, [])
        m.get(norm)!.push(entry.login)
      }
    }
    return m
  }, [presence])

  const statusMap = useMemo(() => {
    const m = new Map<string, 'staged' | 'modified'>()
    for (const f of fileStatus) m.set(f.path.replace(/\\/g, '/'), f.staged ? 'staged' : 'modified')
    return m
  }, [fileStatus])

  const tree = useMemo(() =>
    freqMap.size > 0 ? buildTree(freqMap, lockMap, presMap, statusMap) : null,
    [freqMap, lockMap, presMap, statusMap]
  )

  const currentNode = useMemo(() =>
    zoomStack.length > 0 ? zoomStack[zoomStack.length - 1] : tree,
    [zoomStack, tree]
  )

  const layoutItems = useMemo(() => {
    if (!currentNode) return []
    const children = currentNode.isDir ? currentNode.children : [currentNode]
    if (children.length === 0) return []
    const pad = 4
    return layout(children, { x: pad, y: pad, w: svgSize.w - pad * 2, h: svgSize.h - pad * 2 })
  }, [currentNode, svgSize])

  const maxScore = useMemo(() =>
    layoutItems.reduce((m, item) => Math.max(m, item.node.totalScore), 1),
    [layoutItems]
  )

  const stats = useMemo(() => ({
    totalFiles: tree?.fileCount ?? 0,
    activePaths: freqMap.size,
    totalLocks: locks.length,
    presenceCount: presence ? Object.keys(presence.entries).length : 0,
  }), [tree, freqMap, locks, presence])

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', background: '#0b0d13' }}>

      {/* ── Main map area ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

        {/* Top bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          height: 40, paddingLeft: 14, paddingRight: 12, flexShrink: 0,
          borderBottom: '1px solid #252d42', background: '#10131c',
        }}>
          <Breadcrumb stack={zoomStack} onPop={popTo} />

          {/* Stats */}
          <div style={{ display: 'flex', gap: 14, flexShrink: 0 }}>
            {[
              { label: `${stats.activePaths} tracked`, color: '#4e5870' },
              { label: `${commitCount} commits`, color: '#4e5870' },
              ...(stats.totalLocks > 0 ? [{ label: `${stats.totalLocks} locked`, color: '#f5a832' }] : []),
              ...(stats.presenceCount > 0 ? [{ label: `${stats.presenceCount} online`, color: '#2ec573' }] : []),
            ].map((s, i) => (
              <span key={i} style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, color: s.color }}>
                {s.label}
              </span>
            ))}
          </div>

          <button
            onClick={loadData}
            disabled={loading}
            style={{
              background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer',
              color: loading ? '#4e5870' : '#8b94b0', fontSize: 15,
              opacity: loading ? 0.5 : 1, padding: '0 4px', flexShrink: 0,
            }}
            onMouseEnter={e => { if (!loading) e.currentTarget.style.color = '#e8622f' }}
            onMouseLeave={e => { if (!loading) e.currentTarget.style.color = '#8b94b0' }}
            title="Refresh"
          >↺</button>
        </div>

        {/* SVG treemap */}
        <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {loading && layoutItems.length === 0 ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ animation: 'spin 1.5s linear infinite' }}>
                <circle cx="20" cy="20" r="15" stroke="#252d42" strokeWidth="2" />
                <path d="M20 5 A15 15 0 0 1 35 20" stroke="#e8622f" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#4e5870' }}>
                Analysing repository…
              </span>
            </div>
          ) : freqMap.size === 0 && !loading ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 13, color: '#4e5870' }}>
                No commit history found
              </span>
            </div>
          ) : (
            <svg
              width={svgSize.w} height={svgSize.h}
              style={{ display: 'block', opacity: fading ? 0 : 1, transition: 'opacity 0.13s ease' }}
            >
              {layoutItems.map(item => (
                <Cell
                  key={item.node.path}
                  item={item}
                  maxScore={maxScore}
                  currentLogin={currentLogin}
                  hoveredPath={hovered?.node.path ?? null}
                  onEnter={handleEnter}
                  onMove={handleMove}
                  onLeave={handleLeave}
                  onClick={zoomTo}
                />
              ))}
            </svg>
          )}

          {/* Hover tooltip */}
          {hovered && (
            <Tooltip
              info={hovered}
              containerW={svgSize.w}
              containerH={svgSize.h}
              presNames={presNames}
            />
          )}
        </div>
      </div>

      {/* ── Side panel ────────────────────────────────────────────────────── */}
      <div style={{
        width: 260, flexShrink: 0,
        borderLeft: '1px solid #252d42', background: '#10131c',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          height: 40, display: 'flex', alignItems: 'center', paddingLeft: 14,
          borderBottom: '1px solid #252d42', flexShrink: 0,
        }}>
          <span style={{ fontFamily: "'IBM Plex Sans', system-ui", fontSize: 11, fontWeight: 600, color: '#8b94b0', letterSpacing: '0.07em', textTransform: 'uppercase' }}>
            Activity
          </span>
        </div>
        <SidePanel freqMap={freqMap} locks={locks} presence={presence} presNames={presNames} />
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
