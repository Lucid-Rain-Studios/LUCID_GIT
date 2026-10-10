import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, Link2, Focus, PanelRightClose, PanelRightOpen, Minus, Plus, RotateCcw, ChevronLeft, ChevronRight, Menu } from 'lucide-react'
import { ipc, type UEProject, type BlueprintComparison, type BlueprintGraph, type BlueprintNode, type BlueprintRequest, type BlueprintSide } from '@/ipc'
import { graphChanges, graphText, pairGraphs, wireChanges, type GraphChange, type NodeChange } from '@/lib/blueprintGraph'
import { loadKlee, type BlueprintCamera, type KleeCanvas } from '@/lib/blueprintKlee'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'
import { BlueprintChoice } from './BlueprintChoice'
import './BlueprintDiff.css'

export interface BlueprintFileChoice { path: string; label?: string; stage?: 'Staged' | 'Unstaged'; selected?: boolean; onSelect(): void }
interface Props { files?: BlueprintFileChoice[]; project?: UEProject | null; repoPath: string; request: Omit<BlueprintRequest, 'requestId'>; onFallback(): void; onUnsupported?(reason: string): void }
const tone: Record<NodeChange, string> = { added: 'var(--lg-success)', removed: 'var(--lg-error)', modified: 'var(--lg-warning)', moved: '#9c8de3', commented: 'var(--lg-warning)' }
const mark: Record<NodeChange, string> = { added: '+', removed: '−', modified: '~', moved: '↔', commented: '✎' }
const label = (ref: string) => ref === 'WORKING' ? 'Working tree' : ref === 'INDEX' ? 'Index' : ref === 'ABSENT' ? 'Absent revision' : ref === 'HEAD' ? 'HEAD' : ref.replace(/\^1$/, '').slice(0, 7) + (ref.endsWith('^1') ? ' parent' : '')

function GraphPane({ side, graph, changes, wires, selected, canvasRef, saved, onCamera, onSelect }: {
  side: BlueprintSide; graph?: BlueprintGraph; changes: Record<string, NodeChange>; wires: Record<string, 'added' | 'removed' | 'modified'>; selected: string; canvasRef: React.MutableRefObject<KleeCanvas | null>; saved: React.MutableRefObject<BlueprintCamera | undefined>; onCamera(camera: BlueprintCamera): void; onSelect(id: string): void
}) {
  const element = useRef<HTMLCanvasElement>(null), callbacks = useRef({ onCamera, onSelect })
  callbacks.current = { onCamera, onSelect }
  const wireDecorations = useRef(wires)
  wireDecorations.current = wires
  const decorations = useRef(changes)
  decorations.current = changes
  const selection = useRef(selected)
  selection.current = selected
  const [error, setError] = useState<string | null>(null)
  const text = useMemo(() => graph ? graphText(graph) : '', [graph])
  useEffect(() => {
    let cancelled = false; setError(null)
    if (!graph?.nodes.length || !element.current) return
    loadKlee().then(klee => {
      if (cancelled || !element.current) return
      canvasRef.current = klee.createKleeCanvas(element.current, text, { changes: decorations.current, wireChanges: wireDecorations.current, camera: saved.current, onCamera: camera => { saved.current = camera; callbacks.current.onCamera(camera) }, onSelect: id => callbacks.current.onSelect(id) })
      canvasRef.current.select(selection.current)
    }).catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true; if (canvasRef.current) { saved.current = canvasRef.current.getCamera(); canvasRef.current.destroy(); canvasRef.current = null } }
  }, [graph, text, canvasRef, saved]) // Decorations update independently of graph loading.
  useEffect(() => { canvasRef.current?.setChanges(changes) }, [changes, canvasRef])
  useEffect(() => { canvasRef.current?.setWireChanges(wires) }, [wires, canvasRef])
  useEffect(() => { canvasRef.current?.select(selected) }, [selected, canvasRef])
  const message = error ?? (side.status === 'unavailable' ? side.reason : side.status === 'absent' ? 'File is absent in this revision.' : !graph ? side.document?.diagnostics.join(' ') || 'This graph is absent in this revision.' : !graph.nodes.length ? 'This graph has no serialized nodes.' : null)
  return <section className="bp-pane" aria-label={label(side.ref)}>
    <header><strong>{label(side.ref)}</strong><span className="bp-readonly">Read-only</span><small title={side.path}>{side.path}</small></header>
    <div className="bp-canvas-wrap">
      <canvas ref={element} tabIndex={0} aria-label={`${label(side.ref)} Blueprint graph. Drag to pan, scroll to zoom. Arrow keys pan; Home fits the graph.`} />
      {message && <div className="bp-empty" role={error || side.status === 'unavailable' ? 'alert' : undefined}>{message}</div>}
      {graph?.nodes.length ? <span className="bp-canvas-hint">{graph.nodes.length} nodes · Drag to pan · Scroll to zoom</span> : null}
    </div>
  </section>
}

function Inspector({ change, node }: { change?: GraphChange; node?: BlueprintNode }) {
  if (!node) return <div className="bp-inspector-empty">Select a node or change to inspect its saved values.</div>
  return <div className="bp-inspector"><strong>{node.title}</strong><small>{node.classPath}</small>
    {change && <div className="bp-change-kind" style={{ color: tone[change.kind] }}>{mark[change.kind]} {change.kind === 'moved' ? 'Layout changed' : change.kind === 'commented' ? 'Comment changed' : change.kind[0].toUpperCase() + change.kind.slice(1)}</div>}
    {change?.left && change.right && <div className="bp-value-pair"><span>Base</span><span>Selected revision</span></div>}
    {(node.pins.length > 0 || (change?.left?.pins.length ?? 0) > 0) && <div className="bp-pin-values">{Array.from(new Set([...(change?.left?.pins ?? []).map(p => p.id), ...node.pins.map(p => p.id)])).map(id => {
      const pin = node.pins.find(p => p.id === id), old = change?.left?.pins.find(p => p.id === id)
      const value = (p: typeof pin) => p ? p.defaultValue || p.defaultText || (p.defaultObject !== 'None' ? p.defaultObject : '') || '—' : 'Absent'
      return <div key={id}><span title={pin?.type.category ?? old?.type.category}>{pin?.name ?? old?.name} · {pin?.type.category ?? old?.type.category}</span>{change?.left && change.right && <span className="bp-old-value">{value(old)}</span>}<code>{value(pin)}</code>{(pin?.links.length || old?.links.length) ? <small>Connections: {change?.left && change.right ? `${(old?.links ?? []).map(l => `${l.nodeName ?? 'Unknown'}:${l.pin.slice(0,8)}`).join(', ') || 'None'} → ` : ''}{(pin?.links ?? []).map(l => `${l.nodeName ?? 'Unknown'}:${l.pin.slice(0,8)}`).join(', ') || 'None'}</small> : null}</div>
    })}</div>}
    {change?.commentChanged && <div className="bp-comment-diff"><strong>Comment</strong><span>Base</span><pre>{change.left?.comment || '(empty)'}</pre><span>Selected revision</span><pre>{change.right?.comment || '(empty)'}</pre></div>}
    <details><summary>Saved properties</summary><pre>{JSON.stringify(node.properties, null, 2)}</pre></details>
    <small>{node.complete ? 'Serialized node data decoded.' : 'This node contains unsupported data. Its connections may be incomplete.'}</small>
  </div>
}

export function BlueprintDiff({ files, project, repoPath, request, onFallback, onUnsupported }: Props) {
  const [result, setResult] = useState<BlueprintComparison | null>(null), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0)
  const [expanded, setExpanded] = useState(false), [graphKey, setGraphKey] = useState(''), [selected, setSelected] = useState(''), [sync, setSync] = useState(true), [highlight, setHighlight] = useState(true), [inspector, setInspector] = useState(false)
  const navigation = useRef<HTMLDetailsElement>(null)
  const left = useRef<KleeCanvas | null>(null), right = useRef<KleeCanvas | null>(null), leftCamera = useRef<BlueprintCamera>(), rightCamera = useRef<BlueprintCamera>()
  const fullscreenButton = useRef<HTMLButtonElement>(null), wasExpanded = useRef(false)
  useEffect(() => { if (wasExpanded.current && !expanded) fullscreenButton.current?.focus(); wasExpanded.current = expanded }, [expanded])
  const unsupportedCallback = useRef(onUnsupported)
  unsupportedCallback.current = onUnsupported
  const { filePath, oldPath, leftRef, rightRef } = request
  useEffect(() => {
    let cancelled = false
    const requestId = crypto.randomUUID()
    setResult(null); setError(null); setSelected(''); setGraphKey(''); leftCamera.current = undefined; rightCamera.current = undefined
    ipc.blueprintCompare(repoPath, { filePath, oldPath, leftRef, rightRef, requestId, force: retry > 0 }).then(data => {
      if (cancelled) return
      setResult(data)
      const present = [data.left, data.right].filter(side => side.status !== 'absent')
      if (present.length && present.every(side => side.status === 'ready' && side.document?.status === 'unsupported')) {
        const classes = [...new Set(present.map(side => side.document?.assetClass).filter(Boolean))].join(' / ')
        const reasons = [...new Set(present.flatMap(side => side.document?.diagnostics ?? []))].join(' ')
        unsupportedCallback.current?.([classes ? 'Asset class: ' + classes + '.' : '', reasons, 'Showing binary details.'].filter(Boolean).join(' '))
      }
    }).catch(e => { if (!cancelled) setError(String(e.message ?? e)) })
    return () => { cancelled = true; void ipc.blueprintCancel(requestId).catch(() => {}) }
  }, [repoPath, filePath, oldPath, leftRef, rightRef, retry])
  const pairs = useMemo(() => pairGraphs(result?.left.document?.graphs ?? [], result?.right.document?.graphs ?? []), [result])
  const pair = pairs.find(p => p.key === graphKey) ?? pairs.find(p => p.name === 'EventGraph') ?? pairs[0]
  const comparable = !!result && [result.left, result.right].every(side => side.status === 'absent' || side.status === 'ready' && side.document?.status !== 'unsupported')
  const graphEntries = useMemo(() => pairs.map(p => {
    const changes = comparable ? graphChanges(p) : []
    const incomplete = p.left?.complete === false || p.right?.complete === false
    const status = !comparable ? 'comparison unavailable' : !p.left ? 'added' : !p.right ? 'removed' : changes.length ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : ''
    const suffix = [status, comparable && incomplete ? 'incomplete' : ''].filter(Boolean).join(', ')
    return { pair: p, changes, wires: comparable ? wireChanges(p) : [], label: p.name + (suffix ? ` (${suffix})` : ''), detail: suffix ? `(${suffix})` : '', color: !comparable ? 'var(--lg-text-secondary)' : !p.left ? 'var(--lg-success)' : !p.right ? 'var(--lg-error)' : 'var(--lg-warning)' }
  }), [pairs, comparable])
  const changes = graphEntries.find(entry => entry.pair === pair)?.changes ?? []
  const currentWires = graphEntries.find(entry => entry.pair === pair)?.wires
  const leftWires = useMemo(() => Object.fromEntries(highlight ? (currentWires ?? []).filter(c => c.kind !== 'added').map(c => [c.id, c.kind]) : []), [currentWires, highlight])
  const rightWires = useMemo(() => Object.fromEntries(highlight ? (currentWires ?? []).filter(c => c.kind !== 'removed').map(c => [c.id, c.kind]) : []), [currentWires, highlight])
  const leftChanges = useMemo(() => Object.fromEntries(highlight ? changes.filter(c => c.left).map(c => [c.id, c.kind]) : []), [changes, highlight])
  const rightChanges = useMemo(() => Object.fromEntries(highlight ? changes.filter(c => c.right).map(c => [c.id, c.kind]) : []), [changes, highlight])
  const chosen = changes.find(c => c.id === selected)
  const node = pair?.right?.nodes.find(n => n.id === selected) ?? pair?.left?.nodes.find(n => n.id === selected)
  const cameraChanged = (side: 'left' | 'right', camera: BlueprintCamera) => {
    if (!sync) return
    const other = side === 'left' ? right : left, saved = side === 'left' ? rightCamera : leftCamera
    saved.current = camera; other.current?.setCamera(camera)
  }
  const select = (id: string, focus = false) => { setSelected(id); left.current?.select(id, focus); right.current?.select(id, focus) }
  const fit = () => { left.current?.fit(); right.current?.fit() }
  const step = (direction: number) => { if (changes.length) { const index = changes.findIndex(c => c.id === selected); select(changes[(index + direction + changes.length) % changes.length].id, true); setInspector(true) } }
  const zoom = (factor: number) => { const camera = right.current?.getCamera() ?? left.current?.getCamera(); if (camera) { const next = { ...camera, zoom: Math.max(.05, Math.min(3, camera.zoom * factor)) }; if (right.current) right.current.setCamera(next, true); else left.current?.setCamera(next, true) } }
  const chooseGraph = (key: string) => {
    left.current?.destroy(); right.current?.destroy(); left.current = null; right.current = null
    leftCamera.current = undefined; rightCamera.current = undefined; setGraphKey(key); setSelected('')
    if (navigation.current) navigation.current.open = false
  }
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && navigation.current?.open) {
        if (navigation.current.querySelector('[role=listbox]')) return
        event.preventDefault(); event.stopImmediatePropagation(); navigation.current.open = false
        navigation.current.querySelector<HTMLElement>('summary')?.focus()
      }
    }
    const outside = (event: PointerEvent) => {
      if (navigation.current?.open && !navigation.current.contains(event.target as Node)) navigation.current.open = false
    }
    document.addEventListener('keydown', dismiss, true); document.addEventListener('pointerdown', outside)
    return () => { document.removeEventListener('keydown', dismiss, true); document.removeEventListener('pointerdown', outside) }
  }, [])
  const currentFile = files?.findIndex(file => file.selected ?? file.path === request.filePath) ?? -1
  const content = <div className="bp-viewer">
    <div className="bp-toolbar">
      <details className="bp-navigation" ref={navigation}>
        <summary tabIndex={0} aria-label="Choose Blueprint graph or file"><Menu size={15}/><span>Graphs &amp; files</span></summary>
        <div className="bp-navigation-panel">
          <label htmlFor="bp-file-choice">Changed Blueprint file</label>
          {files?.length ? <BlueprintChoice id="bp-file-choice" label="Blueprint file" value={String(currentFile)} items={files.map((file, i) => ({ value: String(i), name: file.path.includes('/') ? '.../' + file.path.split('/').pop() : file.path, prefix: file.stage ?? file.label?.match(/^(Unstaged|Staged)\b/)?.[1], title: file.path }))} onChange={value => { if (navigation.current) navigation.current.open = false; files[Number(value)]?.onSelect() }}/> : <div className="bp-navigation-file" title={request.filePath}>{request.filePath}</div>}
          <label htmlFor="bp-graph-choice">Graph / function</label>
          <BlueprintChoice id="bp-graph-choice" label="Blueprint graph" value={pair?.key ?? ''} items={graphEntries.map(entry => ({ value: entry.pair.key, name: entry.pair.name, detail: entry.detail, color: entry.color }))} onChange={chooseGraph}/>
          <small>{pairs.length} graph{pairs.length === 1 ? '' : 's'} in this comparison</small>
        </div>
      </details>
      <span className="bp-active-graph" title={pair?.name}>{pair?.name ?? 'Blueprint graph'}</span>
      <button className="lg-toolbar-control lg-icon-control" title="Synchronize graph views" aria-label="Synchronize graph views" aria-pressed={sync} onClick={() => { setSync(!sync); if (!sync) { const camera = right.current?.getCamera() ?? left.current?.getCamera(); if(camera){left.current?.setCamera(camera);right.current?.setCamera(camera)} } }}><Link2 size={14}/></button>
      <button className="lg-toolbar-control" aria-pressed={highlight} onClick={() => setHighlight(!highlight)}>Changes</button>
      <button className="lg-toolbar-control lg-icon-control" aria-label="Previous change" disabled={!changes.length} onClick={() => step(-1)}><ChevronLeft size={14}/></button><button className="lg-toolbar-control lg-icon-control" aria-label="Next change" disabled={!changes.length} onClick={() => step(1)}><ChevronRight size={14}/></button>
      <button className="lg-toolbar-control lg-icon-control" title="Fit graph" aria-label="Fit graph" onClick={fit}><Focus size={14}/></button>
      <button className="lg-toolbar-control lg-icon-control" aria-label="Zoom out" onClick={() => zoom(.8)}><Minus size={14}/></button><button className="lg-toolbar-control lg-icon-control" aria-label="Zoom in" onClick={() => zoom(1.25)}><Plus size={14}/></button>
      <button className="lg-toolbar-control lg-icon-control" aria-label="Toggle node inspector" aria-pressed={inspector} onClick={() => setInspector(!inspector)}>{inspector?<PanelRightClose size={14}/>:<PanelRightOpen size={14}/>}</button>
      <button ref={fullscreenButton} className="lg-toolbar-control" onClick={() => setExpanded(!expanded)}>{expanded?<Minimize2 size={14}/>:<Maximize2 size={14}/>} {expanded?'Exit full screen':'Full screen'}</button>
      <button className="lg-toolbar-control" onClick={onFallback}>Binary details</button>
    </div>
    {project && <div className="bp-info" title={`${project.uprojectPath}\nEngine association: ${project.engineAssociation || project.engineVersion}`}>{project.name} � {project.engineVersion === 'Unknown' ? 'Engine version unknown' : `UE ${project.engineVersion}`} � Read-only revision review</div>}
    {!result && <div className="bp-empty" role={error ? 'alert' : 'status'}>{error ?? 'Reading Blueprint revisions…'}{error && <button onClick={() => setRetry(v => v+1)}><RotateCcw size={14}/> Retry</button>}</div>}
    {result && <>
      {(result.left.status === 'unavailable' || result.right.status === 'unavailable' || pair?.left?.complete === false || pair?.right?.complete === false) && <div className="bp-warning" role="status">Some revision data is unavailable or incomplete. Change highlights cover decoded nodes only.<details><summary>Details</summary>{Array.from(new Set([result.left.reason, result.right.reason, ...(pair?.left?.diagnostics??[]), ...(pair?.right?.diagnostics??[])].filter(Boolean))).map((s,i)=><div key={i}>{s}</div>)}</details><button onClick={() => setRetry(v => v+1)}>Retry reading</button></div>}
      {pair?.matchedByName && <div className="bp-info">Graphs matched by name because their saved identities differ.</div>}
      <div className="bp-body"><div className="bp-revisions"><GraphPane side={result.left} graph={pair?.left} changes={leftChanges} wires={leftWires} selected={selected} canvasRef={left} saved={leftCamera} onCamera={camera => cameraChanged('left',camera)} onSelect={id=>select(id)}/><GraphPane side={result.right} graph={pair?.right} changes={rightChanges} wires={rightWires} selected={selected} canvasRef={right} saved={rightCamera} onCamera={camera=>cameraChanged('right',camera)} onSelect={id=>select(id)}/></div>
      {inspector && <aside className="bp-sidebar"><header>Graph changes <span>{changes.length}</span></header><div className="bp-change-list">{changes.length ? changes.map(c=><button key={c.id} className={selected===c.id?'selected':''} onClick={()=>select(c.id,true)}><span style={{color:tone[c.kind]}}>{mark[c.kind]}</span><div>{c.title}<small>{[c.kind === 'modified' ? 'Properties, pins or connections changed' : c.kind === 'commented' ? 'Comment changed' : c.kind === 'moved' ? 'Saved layout changed' : 'Node '+c.kind, c.commentChanged && c.kind !== 'commented' ? 'Comment changed' : '', c.layoutChanged && c.kind !== 'moved' ? 'Saved layout changed' : ''].filter(Boolean).join(' / ')}</small></div></button>) : <p>{pair && (!comparable||pair.left?.complete===false||pair.right?.complete===false) ? 'Comparison is incomplete.' : pair ? 'No decoded graph changes. Other asset data may still differ.' : 'No supported graph to compare.'}</p>}</div><Inspector change={chosen} node={node}/>
        <details className="bp-node-list"><summary>All nodes</summary>{(pair?.right?.nodes ?? pair?.left?.nodes ?? []).map(n=><button key={n.id||n.name} onClick={()=>select(n.id,true)}>{n.title}</button>)}</details>
      </aside>}</div>
      <footer className="bp-footer">{highlight && !!currentWires?.length && <small aria-label="Wire change summary">+ {currentWires.filter(w => w.kind === 'added').length} added wires / - {currentWires.filter(w => w.kind === 'removed').length} removed wires (dashed) / ~ {currentWires.filter(w => w.kind === 'modified').length} modified wires</small>}{sync?'Views synchronized':'Independent views'}<small aria-label="Graph change summary">{!comparable ? 'Comparison unavailable' : (pair?.left?.complete === false || pair?.right?.complete === false) ? `${changes.length} decoded changes - Comparison incomplete` : !changes.length ? 'No decoded changes · Other asset data may differ' : `${changes.length} graph change${changes.length === 1 ? '' : 's'}`}</small><span>Read-only · Node positions are preserved</span></footer>
    </>}
  </div>
  return expanded ? createPortal(<ExpandedReview onClose={()=>setExpanded(false)}>{content}</ExpandedReview>, document.body) : content
}

function ExpandedReview({ children, onClose }: { children: React.ReactNode; onClose(): void }) {
  const overlay = useDialogOverlayDismiss(onClose, true, 'Blueprint revision review')
  const rootRef = overlay.ref, close = useRef(onClose)
  close.current = onClose
  const fullscreen = useRef(false)
  useEffect(() => {
    const root = rootRef.current
    let disposed = false
    if (!document.fullscreenElement && root?.requestFullscreen) {
      root.requestFullscreen().then(() => { if(disposed && document.fullscreenElement===root)void document.exitFullscreen();else fullscreen.current=true }).catch(()=>{})
    }
    const changed = () => { if(fullscreen.current && !document.fullscreenElement)close.current() }
    document.addEventListener('fullscreenchange',changed)
    return () => { disposed=true;document.removeEventListener('fullscreenchange',changed);if(fullscreen.current && document.fullscreenElement===root)void document.exitFullscreen().catch(()=>{}) }
  }, [rootRef])
  return <div {...overlay} className="bp-expanded">{children}</div>
}

