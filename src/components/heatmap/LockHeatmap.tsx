import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Treemap, ResponsiveContainer, Tooltip } from 'recharts'
import { ipc, HeatmapNode, HeatmapTimelineEntry } from '@/ipc'
import { ActionBtn } from '@/components/ui/ActionBtn'

interface Props {
  repoPath: string
}

const WINDOWS = [
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
]

function scoreToColor(score: number): string {
  // 0 = cool blue → 50 = amber → 100 = hot red
  if (score <= 0)   return '#1a2a3a'
  if (score < 20)   return '#1e3a5f'
  if (score < 40)   return '#1e5f4a'
  if (score < 60)   return '#5f5a1e'
  if (score < 75)   return '#7a3a10'
  if (score < 90)   return '#9a2015'
  return '#c0150c'
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return '—'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.floor(ms / 1000)}s`
}

function timeAgo(ts: number): string {
  const d = (Date.now() - ts) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return `${Math.floor(d / 86400)}d ago`
}

// Custom Treemap cell renderer
function HeatCell(props: {
  x?: number; y?: number; width?: number; height?: number;
  name?: string; score?: number; lockCount?: number; root?: HeatmapNode
}) {
  const { x = 0, y = 0, width = 0, height = 0, name = '', score = 0 } = props
  if (width < 4 || height < 4) return null
  const bg    = scoreToColor(score)
  const text  = score > 50 ? '#fff' : '#8b94b0'
  const label = name.length > 20 ? name.slice(0, 18) + '…' : name
  return (
    <g>
      <rect x={x + 1} y={y + 1} width={width - 2} height={height - 2} fill={bg} rx={3} />
      {height > 20 && width > 40 && (
        <text
          x={x + width / 2} y={y + height / 2}
          textAnchor="middle" dominantBaseline="middle"
          style={{ fontFamily: 'var(--lg-font-mono)', fontSize: Math.min(11, width / 8), fill: text, pointerEvents: 'none' }}
        >
          {label}
        </text>
      )}
    </g>
  )
}

export function LockHeatmap({ repoPath }: Props) {
  const [windowDays, setWindowDays] = useState(30)
  const [groupBy, setGroupBy]       = useState<'folder' | 'type'>('folder')
  const [data, setData]             = useState<HeatmapNode | null>(null)
  const [top10, setTop10]           = useState<HeatmapNode[]>([])
  const [loading, setLoading]       = useState(false)
  const [drillPath, setDrillPath]   = useState<string | null>(null)
  const [timeline, setTimeline]     = useState<HeatmapTimelineEntry[] | null>(null)
  const [timelineFile, setTimelineFile] = useState<string | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!repoPath) return
    setLoading(true)
    try {
      const [root, top] = await Promise.all([
        ipc.heatmapCompute(repoPath, windowDays, groupBy),
        ipc.heatmapTop(repoPath, windowDays, 10),
      ])
      setData(root)
      setTop10(top)
      setDrillPath(null)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [repoPath, windowDays, groupBy])

  useEffect(() => { load() }, [load])

  const openTimeline = async (filePath: string) => {
    setTimelineFile(filePath)
    try {
      const tl = await ipc.heatmapTimeline(repoPath, filePath, windowDays)
      setTimeline(tl)
    } catch { setTimeline([]) }
  }

  const exportSVG = () => {
    const svgEl = chartRef.current?.querySelector('svg')
    if (!svgEl) return
    const serialized = new XMLSerializer().serializeToString(svgEl)
    const blob = new Blob([serialized], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'lock-heatmap.svg'; a.click()
    URL.revokeObjectURL(url)
  }

  // Determine what to show in the treemap
  let treemapData: HeatmapNode[] = []
  if (data) {
    if (drillPath) {
      const drilled = data.children?.find(c => c.path === drillPath)
      treemapData = drilled?.children ?? []
    } else {
      treemapData = data.children ?? []
    }
  }

  const hasData = treemapData.length > 0

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 16 }}>

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexShrink: 0 }}>
          <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#e8622f', fontWeight: 700, letterSpacing: '0.05em' }}>
            LOCK HEATMAP
          </span>
          <div style={{ flex: 1 }} />

          {/* Time window */}
          <div style={{ display: 'flex', gap: 4 }}>
            {WINDOWS.map(w => (
              <ActionBtn
                key={w.label}
                onClick={() => setWindowDays(w.days)}
                size="sm"
                ghost={windowDays !== w.days}
                style={{ height: 24, paddingLeft: 10, paddingRight: 10, fontSize: 11 }}
              >{w.label}</ActionBtn>
            ))}
          </div>

          {/* Group by */}
          <div style={{ display: 'flex', gap: 4 }}>
            {(['folder', 'type'] as const).map(g => (
              <ActionBtn
                key={g}
                onClick={() => setGroupBy(g)}
                size="sm"
                ghost={groupBy !== g}
                style={{ height: 24, paddingLeft: 10, paddingRight: 10, fontSize: 11 }}
              >{g.charAt(0).toUpperCase() + g.slice(1)}</ActionBtn>
            ))}
          </div>

          <ActionBtn onClick={exportSVG} size="sm" style={{ height: 24, paddingLeft: 10, paddingRight: 10, fontSize: 11 }}>
            Export SVG
          </ActionBtn>
          <ActionBtn onClick={load} size="sm" style={{ height: 24, paddingLeft: 10, paddingRight: 10, fontSize: 11 }}>
            Refresh
          </ActionBtn>
        </div>

        <p style={{ margin: '0 0 10px', color: '#8b94b0', fontFamily: 'var(--lg-font-ui)', fontSize: 11 }}>
          Observed activity only. Previews and legacy records are excluded; averages use completed lock intervals.
        </p>

        {/* Drill breadcrumb */}
        {drillPath && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexShrink: 0 }}>
            <button onClick={() => setDrillPath(null)} style={{ background: 'none', border: 'none', color: '#4d9dff', cursor: 'pointer', fontFamily: 'var(--lg-font-ui)', fontSize: 12, padding: 0 }}>
              ← All
            </button>
            <span style={{ color: '#4e5870', fontFamily: 'var(--lg-font-mono)', fontSize: 11 }}>/ {drillPath}</span>
          </div>
        )}

        {/* Treemap */}
        <div ref={chartRef} style={{ flex: 1, overflow: 'hidden', borderRadius: 8, border: '1px solid #1e2436' }}>
          {loading && (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#4e5870' }}>Loading heatmap…</span>
            </div>
          )}
          {!loading && !hasData && (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 14, color: '#4e5870' }}>No lock or conflict data for this time window.</span>
              <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#2f3a54' }}>Lock and unlock files to see heatmap data.</span>
            </div>
          )}
          {!loading && hasData && (
            <ResponsiveContainer width="100%" height="100%">
              <Treemap
                data={treemapData}
                dataKey="value"
                aspectRatio={4 / 3}
                content={<HeatCell />}
                onClick={(node) => {
                  const n = node as unknown as HeatmapNode
                  if (n.children && n.children.length > 0 && !drillPath) {
                    setDrillPath(n.path)
                  } else if (n.path) {
                    openTimeline(n.path)
                  }
                }}
              >
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null
                    const n = payload[0].payload as HeatmapNode
                    return (
                      <div style={{
                        background: '#1d2235', border: '1px solid #2f3a54', borderRadius: 6,
                        padding: '8px 12px', fontFamily: 'var(--lg-font-ui)', fontSize: 12,
                      }}>
                        <div style={{ color: '#dde1f0', fontWeight: 600, marginBottom: 4 }}>{n.name}</div>
                        <div style={{ color: '#8b94b0' }}>Score: <span style={{ color: scoreToColor(n.score) === '#1a2a3a' ? '#4e5870' : '#f5a832' }}>{n.score}</span></div>
                        <div style={{ color: '#8b94b0' }}>Lock acquisitions: {n.lockCount}</div>
                        <div style={{ color: '#8b94b0' }}>Conflicts: {n.conflictCount}</div>
                        <div style={{ color: '#8b94b0' }}>Contributors: {n.uniqueContributors}</div>
                        <div style={{ color: '#8b94b0' }}>Avg completed lock: {fmtDuration(n.meanDurationMs)}</div>
                      </div>
                    )
                  }}
                />
              </Treemap>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Right sidebar: Top 10 + optional timeline */}
      <div style={{ width: 260, flexShrink: 0, borderLeft: '1px solid #1e2436', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {timelineFile ? (
          /* Timeline drawer */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #1e2436', display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => { setTimeline(null); setTimelineFile(null) }} style={{ background: 'none', border: 'none', color: '#4e5870', cursor: 'pointer', fontSize: 14, padding: 0 }}>←</button>
              <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#8b94b0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {timelineFile.split('/').pop()}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {!timeline && <div style={{ padding: 16, color: '#4e5870', fontFamily: 'var(--lg-font-ui)', fontSize: 12 }}>Loading…</div>}
              {timeline?.length === 0 && <div style={{ padding: 16, color: '#4e5870', fontFamily: 'var(--lg-font-ui)', fontSize: 12 }}>No events in this window.</div>}
              {timeline?.map((e, i) => (
                <div key={i} style={{ padding: '6px 12px', borderBottom: '1px solid #1a1e2e' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 8, flexShrink: 0,
                      background: e.source === 'conflict' ? 'rgba(232,69,69,0.15)' : e.eventType === 'locked' ? 'rgba(46,197,115,0.15)' : 'rgba(139,148,176,0.1)',
                      color: e.source === 'conflict' ? '#e84545' : e.eventType === 'locked' ? '#2ec573' : '#4e5870',
                    }}>{e.eventType}</span>
                    <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#8b94b0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.actor}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                    <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870' }}>{timeAgo(e.timestamp)}</span>
                    {e.durationMs > 0 && <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870' }}>{fmtDuration(e.durationMs)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Top 10 contended */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid #1e2436', fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#8b94b0', fontWeight: 600, letterSpacing: '0.05em', flexShrink: 0 }}>
              TOP CONTENDED
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {top10.length === 0 && (
                <div style={{ padding: 16, color: '#4e5870', fontFamily: 'var(--lg-font-ui)', fontSize: 12 }}>No data yet.</div>
              )}
              {top10.map((node, i) => (
                <div
                  key={node.path}
                  onClick={() => openTimeline(node.path)}
                  style={{ padding: '8px 12px', borderBottom: '1px solid #1a1e2e', cursor: 'pointer' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#131726' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870', width: 16, textAlign: 'right', flexShrink: 0 }}>{i + 1}.</span>
                    <div style={{ width: 32, height: 4, borderRadius: 2, background: '#1e2436', flexShrink: 0, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${node.score}%`, background: node.score > 75 ? '#e84545' : node.score > 50 ? '#f5a832' : '#4d9dff', borderRadius: 2 }} />
                    </div>
                    <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#dde1f0', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {node.name}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, paddingLeft: 24, marginTop: 2 }}>
                    <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870' }}>🔒 {node.lockCount}</span>
                    {node.conflictCount > 0 && <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#e84545' }}>⚡ {node.conflictCount}</span>}
                    <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870' }}>👤 {node.uniqueContributors}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
