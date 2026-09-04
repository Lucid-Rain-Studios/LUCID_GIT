import React, { useState, useEffect, useCallback } from 'react'
import { ipc, DepBlameResult, DepBlameEntry, SuspectEntry, DepGraphStatus, DepRefResult } from '@/ipc'
import { ReferenceViewer, GraphNode, GraphLink } from './ReferenceViewer'

interface Props {
  repoPath: string
  filePath: string
  onClose: () => void
}

type Phase = 'idle' | 'building' | 'blaming' | 'done' | 'error'

const ASSET_CLASS_COLORS: Record<string, string> = {
  StaticMesh: '#4d9dff', SkeletalMesh: '#a27ef0',
  Texture2D: '#2ec573', Material: '#f5a832',
  SoundWave: '#e84545', Blueprint: '#e8622f',
  AnimSequence: '#4dd9c5', World: '#4dd9c5',
}
function classColor(cls: string): string {
  for (const [k, v] of Object.entries(ASSET_CLASS_COLORS)) if (cls.includes(k)) return v
  return '#4e5870'
}

function timeAgo(ts: number): string {
  const d = (Date.now() - ts) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

export function DependencyBlamePanel({ repoPath, filePath, onClose }: Props) {
  const [phase, setPhase]       = useState<Phase>('idle')
  const [graphStatus, setGraphStatus] = useState<DepGraphStatus | null>(null)
  const [result, setResult]     = useState<DepBlameResult | null>(null)
  const [refResult, setRefResult] = useState<DepRefResult | null>(null)
  const [error, setError]       = useState<string | null>(null)
  const [expandedDeps, setExpandedDeps] = useState(true)
  const [showGraph, setShowGraph]       = useState(false)
  const [selectedSuspect, setSelectedSuspect] = useState<SuspectEntry | null>(null)

  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath

  const load = useCallback(async () => {
    setError(null)
    try {
      const gs = await ipc.depGraphStatus(repoPath)
      setGraphStatus(gs)
      if (!gs) { setPhase('idle'); return }

      setPhase('blaming')
      const res = await ipc.depBlameAsset(repoPath, filePath)
      setResult(res)
      setPhase('done')
    } catch (e) {
      setError(String(e))
      setPhase('error')
    }
  }, [repoPath, filePath])

  useEffect(() => { load() }, [load])

  const buildGraph = async () => {
    setPhase('building')
    setError(null)
    try {
      const gs = await ipc.depBuildGraph(repoPath)
      setGraphStatus(gs)
      setPhase('blaming')
      const res = await ipc.depBlameAsset(repoPath, filePath)
      setResult(res)
      setPhase('done')
    } catch (e) {
      setError(String(e))
      setPhase('error')
    }
  }

  const refreshGraph = async () => {
    await ipc.depRefreshCache(repoPath)
    await buildGraph()
  }

  const loadRefs = async (packageName: string) => {
    try {
      const r = await ipc.depLookupReferences(repoPath, packageName)
      setRefResult(r)
      setShowGraph(true)
    } catch { /* ignore */ }
  }

  // ── Graph data ───────────────────────────────────────────────────────────────

  const graphNodes: GraphNode[] = []
  const graphLinks: GraphLink[] = []

  if (result && showGraph) {
    const target = result.target
    graphNodes.push({
      id: target.packageName, label: fileName,
      assetClass: target.assetClass, isTarget: true, hopDistance: 0,
    })
    for (const dep of result.dependencies) {
      const lbl = dep.filePath.replace(/\\/g, '/').split('/').pop() ?? dep.filePath
      graphNodes.push({
        id: dep.packageName, label: lbl,
        assetClass: dep.assetClass, isTarget: false, hopDistance: dep.hopDistance,
      })
      graphLinks.push({ sourceId: target.packageName, targetId: dep.packageName, isHard: true })
    }
    if (refResult) {
      for (const ref of refResult.referencedBy) {
        if (!graphNodes.find(n => n.id === ref.packageName)) {
          const lbl = ref.filePath.replace(/\\/g, '/').split('/').pop() ?? ref.filePath
          graphNodes.push({ id: ref.packageName, label: lbl, assetClass: ref.assetClass, isTarget: false, hopDistance: 1 })
        }
        graphLinks.push({ sourceId: ref.packageName, targetId: target.packageName, isHard: false })
      }
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0b0d13', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
        borderBottom: '1px solid #252d42', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: '#e8622f', fontFamily: 'var(--lg-font-mono)', fontWeight: 700, letterSpacing: '0.05em' }}>
            DEP BLAME
          </span>
          <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#dde1f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {fileName}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#4e5870', cursor: 'pointer', padding: '2px 4px', fontSize: 16, lineHeight: 1 }}
          title="Close"
        >×</button>
      </div>

      {/* Graph status bar */}
      {graphStatus && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 14px',
          borderBottom: '1px solid #252d42', background: '#0e1120', flexShrink: 0,
        }}>
          <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870' }}>
            Graph: {graphStatus.nodeCount.toLocaleString()} nodes · {graphStatus.edgeCount.toLocaleString()} edges
          </span>
          <div style={{ flex: 1 }} />
          <Btn label="Rebuild" onClick={buildGraph} secondary small />
          <Btn label="Refresh" onClick={refreshGraph} secondary small />
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── No graph yet ── */}
        {phase === 'idle' && !graphStatus && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 14, color: '#8b94b0', marginBottom: 6 }}>
                No dependency graph cached for this HEAD.
              </div>
              <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870', marginBottom: 20 }}>
                Build the graph by scanning all tracked .uasset files.
              </div>
              <Btn label="Build Dependency Graph" onClick={buildGraph} />
            </div>
          </div>
        )}

        {/* ── Building/loading ── */}
        {(phase === 'building' || phase === 'blaming') && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 12, color: '#4e5870' }}>
              {phase === 'building' ? 'Building dependency graph…' : 'Analyzing blame…'}
            </span>
          </div>
        )}

        {/* ── Error ── */}
        {phase === 'error' && error && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <div style={{
              background: 'rgba(232,69,69,0.1)', border: '1px solid rgba(232,69,69,0.3)',
              borderRadius: 6, padding: '8px 16px', maxWidth: 420,
              fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: '#e84545', whiteSpace: 'pre-wrap',
            }}>{error}</div>
            <Btn label="Retry" onClick={load} secondary />
          </div>
        )}

        {/* ── Results ── */}
        {phase === 'done' && result && (
          <>
            {/* Left: dependency tree */}
            <div style={{ width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #252d42', overflow: 'hidden' }}>
              <div style={{ flex: 1, overflowY: 'auto' }}>

                {/* Direct blame section */}
                <BlameSection
                  entry={result.target}
                  label="Target"
                  isTarget
                  onViewRefs={() => loadRefs(result.target.packageName)}
                />

                {/* Dependencies */}
                {result.dependencies.length > 0 && (
                  <>
                    <div
                      onClick={() => setExpandedDeps(e => !e)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                        borderBottom: '1px solid #252d42', cursor: 'pointer',
                        background: '#0e1120', flexShrink: 0,
                      }}
                    >
                      <span style={{ fontSize: 9, color: '#4e5870', transition: 'transform 0.15s', display: 'inline-block', transform: expandedDeps ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
                      <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#8b94b0', fontWeight: 600 }}>
                        DEPENDENCIES ({result.dependencies.length})
                      </span>
                    </div>
                    {expandedDeps && result.dependencies.map((dep, i) => (
                      <BlameSection
                        key={i}
                        entry={dep}
                        label={`Hop ${dep.hopDistance}`}
                        isTarget={false}
                        onViewRefs={() => loadRefs(dep.packageName)}
                        indent
                      />
                    ))}
                  </>
                )}
              </div>

              {/* Graph toggle button */}
              <div style={{ padding: '8px 14px', borderTop: '1px solid #252d42', flexShrink: 0 }}>
                <Btn
                  label={showGraph ? 'Hide Reference Graph' : 'View Reference Graph'}
                  onClick={() => {
                    if (!showGraph && result) loadRefs(result.target.packageName)
                    else setShowGraph(false)
                  }}
                  secondary
                  full
                />
              </div>
            </div>

            {/* Right: suspects + optional graph */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {showGraph && graphNodes.length > 0 ? (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, overflow: 'hidden' }}>
                  <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#8b94b0', fontWeight: 600, marginBottom: 10 }}>
                    REFERENCE GRAPH
                  </div>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <ReferenceViewer
                      nodes={graphNodes}
                      links={graphLinks}
                      width={500}
                      height={400}
                      onNodeClick={(id) => {
                        const node = result.dependencies.find(d => d.packageName === id)
                        if (node) loadRefs(node.packageName)
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 12px 0' }}>
                  <SuspectList
                    suspects={result.suspects}
                    selected={selectedSuspect?.hash ?? null}
                    onSelect={setSelectedSuspect}
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BlameSection({ entry, isTarget, onViewRefs, indent }: {
  entry: DepBlameEntry
  label: string
  isTarget: boolean
  onViewRefs: () => void
  indent?: boolean
}) {
  const [expanded, setExpanded] = useState(isTarget)
  const fileName = entry.filePath.replace(/\\/g, '/').split('/').pop() ?? entry.filePath
  const color = classColor(entry.assetClass)

  return (
    <div style={{ borderBottom: '1px solid #1e2436' }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: `6px 14px 6px ${indent ? 24 : 14}px`,
          cursor: 'pointer', background: isTarget ? '#0e1120' : 'transparent',
        }}
        onMouseEnter={e => { if (!isTarget) e.currentTarget.style.background = '#131726' }}
        onMouseLeave={e => { if (!isTarget) e.currentTarget.style.background = 'transparent' }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ flex: 1, fontFamily: 'var(--lg-font-mono)', fontSize: 11, color: isTarget ? '#dde1f0' : '#8b94b0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fileName}
        </span>
        <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870', flexShrink: 0 }}>
          {entry.recentCommits.length} commits
        </span>
        <span style={{ fontSize: 9, color: '#4e5870', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>▶</span>
      </div>

      {expanded && (
        <div style={{ paddingLeft: indent ? 32 : 22, paddingRight: 14, paddingBottom: 8 }}>
          <div style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 9, color: '#4e5870', marginBottom: 6 }}>
            {entry.packageName}
          </div>
          {entry.recentCommits.slice(0, 5).map((c, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4d9dff', flexShrink: 0 }}>
                {shortHash(c.hash)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#8b94b0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.message}
                </div>
                <div style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870' }}>
                  {c.author} · {timeAgo(c.timestamp)}
                  {c.churnCount > 10 && <span style={{ color: '#e84545', marginLeft: 6 }}>churn: {c.churnCount}</span>}
                </div>
              </div>
            </div>
          ))}
          <button
            onClick={e => { e.stopPropagation(); onViewRefs() }}
            style={{
              marginTop: 4, padding: '3px 8px', borderRadius: 4, border: '1px solid #2f3a54',
              background: 'transparent', color: '#4e5870',
              fontFamily: 'var(--lg-font-ui)', fontSize: 10, cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = '#dde1f0'; e.currentTarget.style.borderColor = '#4e5870' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#4e5870'; e.currentTarget.style.borderColor = '#2f3a54' }}
          >
            View references →
          </button>
        </div>
      )}
    </div>
  )
}

function SuspectList({ suspects, selected, onSelect }: {
  suspects: SuspectEntry[]
  selected: string | null
  onSelect: (s: SuspectEntry) => void
}) {
  if (suspects.length === 0) return (
    <div style={{ padding: 24, fontFamily: 'var(--lg-font-ui)', fontSize: 12, color: '#4e5870', textAlign: 'center' }}>
      No commits to analyze.
    </div>
  )

  return (
    <>
      <div style={{ padding: '10px 16px 6px', fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#8b94b0', fontWeight: 600, letterSpacing: '0.05em' }}>
        SUSPECTS
      </div>
      {suspects.map((s, i) => {
        const pct = Math.round(s.score * 100)
        const isSelected = s.hash === selected
        return (
          <div
            key={s.hash}
            onClick={() => onSelect(s)}
            style={{
              padding: '8px 16px', borderBottom: '1px solid #1e2436',
              background: isSelected ? '#1a2035' : 'transparent',
              cursor: 'pointer', transition: 'background 0.1s',
            }}
            onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = '#131726' }}
            onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                fontFamily: 'var(--lg-font-mono)', fontSize: 10,
                color: '#4e5870', width: 16, textAlign: 'right', flexShrink: 0,
              }}>{i + 1}.</span>

              {/* Score bar */}
              <div style={{ width: 40, height: 4, borderRadius: 2, background: '#1e2436', flexShrink: 0, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: pct > 70 ? '#e84545' : pct > 40 ? '#f5a832' : '#4d9dff', borderRadius: 2 }} />
              </div>
              <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: pct > 70 ? '#e84545' : pct > 40 ? '#f5a832' : '#8b94b0', flexShrink: 0 }}>
                {pct}%
              </span>

              <span style={{ fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4d9dff', flexShrink: 0 }}>
                {shortHash(s.hash)}
              </span>

              <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 11, color: '#dde1f0', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.message}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, paddingLeft: 76 }}>
              <span style={{ fontFamily: 'var(--lg-font-ui)', fontSize: 10, color: '#4e5870' }}>
                {s.author} · {timeAgo(s.timestamp)}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                {s.reasons.map(r => (
                  <span key={r} style={{
                    fontFamily: 'var(--lg-font-ui)', fontSize: 9,
                    padding: '1px 5px', borderRadius: 8,
                    background: 'rgba(232,98,47,0.12)', color: '#e8622f',
                    border: '1px solid rgba(232,98,47,0.25)',
                  }}>{r}</span>
                ))}
              </div>
            </div>

            {isSelected && (
              <div style={{ marginTop: 6, paddingLeft: 76, fontFamily: 'var(--lg-font-mono)', fontSize: 10, color: '#4e5870' }}>
                via {s.filePath.replace(/\\/g, '/').split('/').pop()}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

function Btn({ label, onClick, secondary, small, full }: {
  label: string; onClick: () => void; secondary?: boolean; small?: boolean; full?: boolean
}) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: small ? 24 : 30,
        paddingLeft: small ? 8 : 14,
        paddingRight: small ? 8 : 14,
        borderRadius: 5,
        width: full ? '100%' : undefined,
        background: secondary
          ? hover ? '#1e2436' : 'transparent'
          : hover ? '#d4531f' : '#e8622f',
        border: secondary ? '1px solid #2f3a54' : '1px solid transparent',
        color: secondary ? '#8b94b0' : '#fff',
        fontFamily: 'var(--lg-font-ui)',
        fontSize: small ? 11 : 13,
        fontWeight: secondary ? 400 : 600,
        cursor: 'pointer',
        transition: 'background 0.12s',
      }}
    >{label}</button>
  )
}
