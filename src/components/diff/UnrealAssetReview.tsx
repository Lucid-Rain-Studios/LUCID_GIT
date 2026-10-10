import { MapPreview } from './MapPreview'
import { mapPositions } from '../../lib/mapReview'
import { stateTreeLinks } from '../../lib/stateTreeReview'
import { StateTreePreview } from './StateTreePreview'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react'
import { ipc } from '@/ipc'
import type { BlueprintComparison, UnrealAssetObject } from '../../../electron/blueprintTypes'
import { assetChanges, displayValue, revisionName, reviewObjects, type AssetObjectChange } from '@/lib/unrealAssetReview'
import { useDialogOverlayDismiss } from '@/lib/useDialogOverlayDismiss'
import { BlueprintDiff, type BlueprintDiffProps } from './BlueprintDiff'
import { BlueprintChoice } from './BlueprintChoice'
import { useAssetViewerStore } from '@/stores/assetViewerStore'
import './UnrealAssetReview.css'

const markers = { added: '+', removed: '−', modified: '~', unknown: '?' }
const className = (object: UnrealAssetObject) => object.classPath.split('.').pop() ?? object.classPath

function ObjectInspector({ object, change, objects, onSelect }: { object?: UnrealAssetObject; change?: AssetObjectChange; objects: UnrealAssetObject[]; onSelect(object: UnrealAssetObject): void }) {
  if (!object) return <div className="uar-empty">Select an object or change to inspect its saved values.</div>
  return <section className="uar-inspector" aria-label="Saved object details">
    <strong>{object.name}</strong><small>{object.classPath}</small><small>{object.serializedPath ?? object.path}</small>
    {object.sourcePackage && <small>Source package: {object.sourcePackage}</small>}
    {stateTreeLinks(object, objects).map(link => <div className="uar-object-link" key={link.label}><small>{link.label}: {link.description}</small>{link.object && <button className="lg-toolbar-control" onClick={() => onSelect(link.object!)}>Inspect {link.label.toLowerCase()}</button>}</div>)}
    {change?.ambiguous && <p role="status">Identity is ambiguous. This is not a confirmed addition or removal.</p>}
    {change?.properties.map(property => <div className="uar-property" key={property.path}><small>{property.path}</small><div className="uar-values"><pre className="uar-before">{displayValue(property.before, property.beforePresent)}</pre><span>→</span><pre className="uar-after">{displayValue(property.after, property.afterPresent)}</pre></div></div>)}
    {change?.opaqueChanged && <p className="uar-warning">Native payload changed. Its meaning has not been decoded.</p>}
    <div className="uar-object-properties">{Object.entries(object.properties).map(([name, value]) => <details key={name}><summary>{name}{object.opaqueProperties?.includes(name) ? ' · raw serialized value' : ''}</summary><pre>{displayValue(value)}</pre></details>)}</div>
    {object.opaqueBytes > 0 && <small>{object.opaqueBytes.toLocaleString()} native bytes · not interpreted</small>}
    {object.diagnostics.map(message => <p className="uar-warning" key={message}>{message}</p>)}
  </section>
}

/** Shared package review using existing immutable revision/LFS documents. */
export function UnrealAssetReview(props: BlueprintDiffProps) {
  const { repoPath, request, files, single = false, revisionLabels } = props
  const openPackage = useAssetViewerStore(state => state.openBlueprint)
  const [mapTarget, setMapTarget] = useState<{ left?: string; right?: string } | null>(null)
  const [externalActors, setExternalActors] = useState(request.externalActors === true)
  const { filePath, oldPath, leftRef, rightRef } = mapTarget ? { ...request, filePath: mapTarget.right ?? mapTarget.left!, oldPath: mapTarget.left } : request
  const includeActors = externalActors || !!mapTarget
  const unsupportedCallback = useRef(props.onUnsupported)
  unsupportedCallback.current = props.onUnsupported
  const [result, setResult] = useState<BlueprintComparison | null>(null)
  const [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const [view, setView] = useState<'changes' | 'contents' | 'preview'>('changes')
  const [side, setSide] = useState<'left' | 'right'>('right')
  const [selected, setSelected] = useState(''), [filter, setFilter] = useState('')
  const [mapCamera, setMapCamera] = useState({ zoom: 1, x: 0, y: 0 })
  const [visible, setVisible] = useState(250), [expanded, setExpanded] = useState(false)
  useEffect(() => setVisible(250), [filePath, view, side, filter])
  const fullButton = useRef<HTMLButtonElement>(null), wasExpanded = useRef(false)
  useEffect(() => { if (wasExpanded.current && !expanded) fullButton.current?.focus(); wasExpanded.current = expanded }, [expanded])
  useEffect(() => {
    let cancelled = false
    const requestId = crypto.randomUUID()
    setResult(null); setError(''); setSelected(''); setFilter(''); setMapCamera({ zoom: 1, x: 0, y: 0 })
    ipc.blueprintCompare(repoPath, { filePath, oldPath, leftRef, rightRef, requestId, externalActors: includeActors, force: retry > 0 }).then(data => {
      if (cancelled) return
      setResult(data)
      const present = [data.left, data.right].filter(item => item.status !== 'absent')
      if (present.length && present.every(item => item.status === 'ready' && !item.document?.assetReview && !item.document?.graphs.length)) {
        unsupportedCallback.current?.('Asset class: ' + [...new Set(present.map(item => item.document?.assetClass ?? 'Unknown'))].join(' / ') + '. No inventory was returned by the reader. Showing binary details.')
      }
      setSide(data.right.status === 'absent' ? 'left' : 'right')
      const hasGraphs = [data.left, data.right].some(item => !!item.document?.graphs.length)
      setView(hasGraphs ? 'preview' : single ? 'contents' : 'changes')
    }).catch(reason => { if (!cancelled) setError(String(reason.message ?? reason)) })
    return () => { cancelled = true; void ipc.blueprintCancel(requestId).catch(() => {}) }
  }, [repoPath, filePath, oldPath, leftRef, rightRef, single, retry, includeActors])
  const changes = useMemo(() => result && !single ? assetChanges(result) : [], [result, single])
  const selectedSide = result?.[side], assetDocument = selectedSide?.document
  const objects = useMemo(() => result ? reviewObjects(result, side) : [], [result, side])
  const allMapObjects = useMemo(() => result ? (['left', 'right'] as const).flatMap(key => mapPositions(reviewObjects(result, key)).slice(0, 1000).map(point => point.object)) : [], [result])
  const change = changes.find(item => item.key === selected)
  const object = view === 'changes' ? change?.right ?? change?.left : objects.find(item => item.path === selected)
  const matching = (text: string) => text.toLowerCase().includes(filter.toLowerCase())
  const canCompare = !!result && [result.left, result.right].every(item => item.status === 'absent' || item.status === 'ready' && !!item.document?.assetReview)
  const labels = { left: revisionLabels?.left ?? 'Base', right: revisionLabels?.right ?? 'Selected' }
  const selectObject = (item: UnrealAssetObject) => setSelected(item.path)
  const rows = objects.filter(item => matching(item.name + ' ' + item.path + ' ' + item.classPath))
  const filteredChanges = changes.filter(item => matching((item.right ?? item.left)!.name + ' ' + (item.right ?? item.left)!.path + ' ' + (item.right ?? item.left)!.classPath))
  const hasGraphs = !!result && [result.left, result.right].some(item => item.document?.graphs.length)
  const counts = (kind: AssetObjectChange['kind']) => changes.filter(item => item.kind === kind).length
  const body = <div className="uar" aria-label="Unreal asset review">
    <header className="uar-heading"><div><strong>{filePath.replace(/\\/g, '/').split('/').pop()}</strong><small>{filePath}</small><small>{assetDocument?.assetClass ?? 'Unreal package'}{assetDocument?.engineVersion ? ` · saved UE ${assetDocument.engineVersion}` : ''}</small></div><div className="uar-actions"><button className="lg-toolbar-control" onClick={() => setRetry(value => value + 1)} title="Refresh this asset"><RotateCcw size={14}/> Retry</button><button ref={fullButton} className="lg-toolbar-control" aria-label={expanded ? 'Exit expanded asset review' : 'Expand asset review'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={14}/> : <Maximize2 size={14}/>}</button><button className="lg-toolbar-control" onClick={() => mapTarget ? setMapTarget(null) : props.onFallback()}>{mapTarget ? 'Back to actor package' : 'Binary details'}</button></div></header>
    {files && files.length > 1 && <div className="uar-files"><BlueprintChoice id="uar-file-choice" label="Unreal asset" value={String(Math.max(0, files.findIndex(file => file.selected ?? file.path === filePath)))} items={files.map((file, index) => ({ value: String(index), name: file.label ?? file.path.split('/').pop() ?? file.path, detail: file.stage ?? '', color: 'var(--lg-text-secondary)' }))} onChange={value => files[Number(value)]?.onSelect()}/></div>}
    {result?.owningMaps && !mapTarget && <div className="uar-scope"><span>Verified owning map: {result.owningMaps.right ?? result.owningMaps.left}</span><button className="lg-toolbar-control" onClick={() => setMapTarget(result.owningMaps!)}>Review owning map</button></div>}
    {/\.umap$/i.test(filePath) && <div className="uar-scope"><button className="lg-toolbar-control" aria-pressed={includeActors} onClick={() => { if (mapTarget) { setMapTarget(null); setExternalActors(false) } else setExternalActors(value => !value) }}>{includeActors ? 'Map + changed external actors' : 'Review changed external actors'}</button><small>Changed packages only · full-world inventory is not loaded</small></div>}
    {result?.externalActors && <div className="uar-external" aria-label="Changed external actor packages"><strong>{result.externalActors.packages.length} of {result.externalActors.total} changed actor packages reviewed{result.externalActors.omitted ? ` · ${result.externalActors.omitted} omitted` : ''}</strong>{result.externalActors.packages.map((pair, index) => <details key={index}><summary>{pair.right.path === pair.left.path ? pair.right.path : pair.left.path + ' → ' + pair.right.path}</summary>{(['left', 'right'] as const).map(key => <div key={key}><small>{labels[key]}: {pair[key].status}{pair[key].reason ? ' · ' + pair[key].reason : ''}</small>{pair[key].status !== 'absent' && <button className="lg-toolbar-control" onClick={() => openPackage(repoPath, pair[key].path, pair[key].ref)}>Inspect {labels[key].toLowerCase()} package</button>}</div>)}</details>)}{result.externalActors.diagnostics.map(message => <small key={message}>{message}</small>)}</div>}
    <div className="uar-revisions">{(['left', 'right'] as const).filter(key => !single || key === 'right').map(key => <span key={key}>{labels[key]} <code>{revisionName(key === 'left' ? leftRef : rightRef)}</code></span>)}<small>Read-only</small></div>
    <nav className="uar-tabs" aria-label="Unreal asset view">{(['changes', 'contents', 'preview'] as const).map(tab => <button key={tab} className="lg-toolbar-control" aria-pressed={view === tab} onClick={() => { setView(tab); setSelected(tab === 'changes' ? changes.find(item => item.left?.path === object?.path || item.right?.path === object?.path)?.key ?? '' : object?.path ?? '') }} disabled={single && tab === 'changes'}>{tab[0].toUpperCase() + tab.slice(1)}</button>)}</nav>
    {error ? <div className="uar-empty" role="alert">{error}</div> : !result ? <div className="uar-empty" role="status">Reading saved asset revisions…</div> : <>
      {view !== 'changes' && <div className="uar-view-tools"><div>{(['left', 'right'] as const).filter(key => !single || key === 'right').map(key => <button key={key} className="lg-toolbar-control" aria-pressed={side === key} onClick={() => { const next = reviewObjects(result, key); const matches = object ? next.filter(candidate => object.id ? candidate.id === object.id : candidate.path === object.path && !candidate.id) : []; setSide(key); setSelected(matches.length === 1 ? matches[0].path : '') }}>{labels[key]}</button>)}</div><small>{objects.length.toLocaleString()} package objects</small></div>}
      {hasGraphs && <div className="uar-graph" style={{ display: view === 'preview' ? 'flex' : 'none' }}><BlueprintDiff {...props} files={undefined} comparison={result} onRetry={() => setRetry(value => value + 1)}/></div>}
      {!(view === 'preview' && hasGraphs) && <div className="uar-workspace"><section className="uar-content">
        {(view === 'contents' || view === 'changes') && <input className="uar-filter" aria-label="Filter asset objects" placeholder="Filter names, classes or paths…" value={filter} onChange={event => setFilter(event.target.value)}/>}
        {view === 'changes' && <><div className="uar-counts">{(['added', 'removed', 'modified', 'unknown'] as const).map(kind => <span className={'uar-' + kind} key={kind}>{markers[kind]} {counts(kind)} {kind}</span>)}</div>{!canCompare ? <div className="uar-empty">Comparison unavailable. {result.left.reason ?? result.right.reason ?? 'One side has no decoded inventory.'} Unknown content is not treated as absent.</div> : changes.length === 0 ? <div className="uar-empty">No differences in decoded objects/properties. Other package data may still differ.</div> : filteredChanges.slice(0, visible).map(item => <button className={'uar-row uar-' + item.kind} key={item.key} aria-pressed={selected === item.key} onClick={() => setSelected(item.key)}><span>{markers[item.kind]}</span><span>{(item.right ?? item.left)!.name}<small>{className((item.right ?? item.left)!)}{(item.right ?? item.left)!.sourcePackage && ' · ' + (item.right ?? item.left)!.sourcePackage}</small></span><small>{item.kind}{item.opaqueChanged ? ' · native data' : ''}</small></button>)}</>}
        {view === 'contents' && (selectedSide?.status !== 'ready' ? <div className="uar-empty">{selectedSide?.status === 'absent' ? 'File absent in this revision.' : selectedSide?.reason}</div> : rows.slice(0, visible).map(item => <button className="uar-row" key={item.path} aria-pressed={selected === item.path} onClick={() => selectObject(item)}><span>{item.name}<small>{className(item)} · {item.sourcePackage ?? item.outer}</small></span><small>{Object.keys(item.properties).length} fields{!item.decoded ? ' · incomplete' : ''}</small></button>))}
        {view === 'preview' && (selectedSide?.status !== 'ready' ? <div className="uar-empty">{selectedSide?.status === 'absent' ? 'File absent in this revision.' : selectedSide?.reason}</div> : assetDocument?.assetReview?.family === 'statetree' ? <StateTreePreview objects={objects} changes={changes} side={side} onSelect={selectObject}/> : assetDocument?.assetReview?.family === 'map' ? <MapPreview objects={objects} allObjects={allMapObjects} changes={changes} side={side} selected={selected} camera={mapCamera} onCamera={setMapCamera} onSelect={selectObject}/> : <div className="uar-empty">{assetDocument?.assetReview?.family === 'mesh' ? 'Mesh geometry is not decoded by the installed reader.' : 'No visual decoder is available for this asset class.'} Saved objects and properties are available in Contents.</div>)}
        {(view === 'contents' ? rows.length : view === 'changes' ? filteredChanges.length : 0) > visible && <button className="lg-toolbar-control" onClick={() => setVisible(value => value + 250)}>Show 250 more objects</button>}
      </section><ObjectInspector object={object} objects={objects} onSelect={item => { setView('contents'); selectObject(item) }} change={view === 'changes' ? change : changes.find(item => item[side]?.path === object?.path)}/></div>}
      <footer className="uar-coverage"><strong>Coverage</strong>{result.externalActors && <span>Actor additions/removals refer to the selected map scope. Data layers and asset references are saved fields only; inherited values and world transforms remain unresolved.</span>}{[...new Set([...(result.left.document?.assetReview?.coverage ?? []), ...(result.right.document?.assetReview?.coverage ?? [])])].map(message => <span key={message}>{message}</span>)}{result.left.status === 'unavailable' && <span>{labels.left}: {result.left.reason}</span>}{result.right.status === 'unavailable' && <span>{labels.right}: {result.right.reason}</span>}</footer>
    </>}
  </div>
  return expanded ? createPortal(<ExpandedAssetReview onClose={() => setExpanded(false)}>{body}</ExpandedAssetReview>, document.body) : body
}

function ExpandedAssetReview({ children, onClose }: { children: React.ReactNode; onClose(): void }) {
  const overlay = useDialogOverlayDismiss(onClose, true, 'Unreal asset review')
  return <div {...overlay} className="bp-expanded uar-expanded">{children}</div>
}
