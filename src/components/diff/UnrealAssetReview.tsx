import { mapAttachmentPositions } from '../../lib/mapTransforms'
import { BlendSpacePreview } from './BlendSpaceReview'
import { blendSpaceClass } from '../../lib/blendSpaceReview'
import { AnimationSequenceContents, AnimationSequencePreview } from './AnimationSequenceReview'
import { PhysicsAssetPreview } from './PhysicsAssetPreview'
import { MapContents } from './MapContents'
import { MeshContents } from './MeshContents'
import { mapInventory } from '../../lib/mapInventory'
import { referencePackage, savedObjectIndex } from '../../lib/assetReferences'
import { MeshPreview } from './MeshPreview'
import { initialMeshCamera } from '../../lib/meshReview'
import { MapPreview } from './MapPreview'
import { mapPositions, type MapPlane } from '../../lib/mapReview'
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

type LinkSide = { object: UnrealAssetObject; objects: UnrealAssetObject[]; side: 'left' | 'right'; label: string; ref: string; packagePath: string }
function ObjectInspector({ object, change, objects, linkSides, onOpen, onSelect }: { object?: UnrealAssetObject; change?: AssetObjectChange; objects: UnrealAssetObject[]; linkSides: LinkSide[]; onOpen(path: string, ref: string): void; onSelect(object: UnrealAssetObject, side?: 'left' | 'right'): void }) {
  const referenceLinks = useMemo(() => linkSides.flatMap(captured => {
    const resolve = savedObjectIndex(captured.objects)
    return (captured.object.references ?? []).slice(0, 128).map(reference => ({ ...captured, reference, target: resolve(captured.object, reference.target), path: referencePackage(reference, captured.packagePath) }))
  }), [linkSides])
  if (!object) return <div className="uar-empty">Select an object or change to inspect its saved values.</div>
  return <section className="uar-inspector" aria-label="Saved object details">
    <strong>{object.name}</strong><small>{object.classPath}</small><small>{object.serializedPath ?? object.path}</small>
    {object.sourcePackage && <small>Source package: {object.sourcePackage}</small>}
    {stateTreeLinks(object, objects).map(link => <div className="uar-object-link" key={link.label}><small>{link.label}: {link.description}</small>{link.object && <button className="lg-toolbar-control" onClick={() => onSelect(link.object!)}>Inspect {link.label.toLowerCase()}</button>}</div>)}
    {referenceLinks.length > 0 && <details className="uar-reference-links" open><summary>Saved object references</summary>{referenceLinks.map((link, index) => <div className="uar-object-link" key={index}><small>{link.label} · {link.reference.propertyPath}: {link.reference.target}</small>{link.target ? <button className="lg-toolbar-control" onClick={() => onSelect(link.target!, link.side)}>Inspect {link.label.toLowerCase()} {link.reference.propertyPath}</button> : link.path && /^(WORKING|INDEX|[a-f0-9]{40})$/i.test(link.ref) ? <button className="lg-toolbar-control" onClick={() => onOpen(link.path!, link.ref)}>Open {link.label.toLowerCase()} {link.reference.propertyPath}</button> : <small>Unresolved reference, ambiguous object, custom mount or unavailable captured revision.</small>}</div>)}</details>}
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
  const [contentsMode, setContentsMode] = useState<'focused' | 'all'>('focused')
  const [side, setSide] = useState<'left' | 'right'>('right')
  const [selected, setSelected] = useState(''), [filter, setFilter] = useState('')
  const [blendSample, setBlendSample] = useState('')
  const [sequenceEntry, setSequenceEntry] = useState('')
  const [physicsBody, setPhysicsBody] = useState('')
  const [meshCamera, setMeshCamera] = useState(initialMeshCamera)
  const captureKey = JSON.stringify([repoPath, filePath, oldPath, leftRef, rightRef])
  const [nativeKey, setNativeKey] = useState(''), [meshSource, setMeshSource] = useState(false), [sourceLod, setSourceLod] = useState(0)
  const nativeRequested = nativeKey === captureKey
  const [mapScope, setMapScope] = useState<'roots' | 'all'>('roots')
  const [mapQuery, setMapQuery] = useState('')
  const [mapChangedOnly, setMapChangedOnly] = useState(false)
  const [mapAttachments, setMapAttachments] = useState(false)
  const [mapPlane, setMapPlane] = useState<MapPlane>('XY')
  const [mapCamera, setMapCamera] = useState({ zoom: 1, x: 0, y: 0 })
  const [visible, setVisible] = useState(250), [expanded, setExpanded] = useState(false)
  useEffect(() => setVisible(250), [filePath, view, side, filter])
  const fullButton = useRef<HTMLButtonElement>(null), wasExpanded = useRef(false)
  useEffect(() => { if (wasExpanded.current && !expanded) fullButton.current?.focus(); wasExpanded.current = expanded }, [expanded])
  useEffect(() => {
    let cancelled = false
    const requestId = crypto.randomUUID()
    setResult(null); setError(''); setPhysicsBody(''); setSequenceEntry(''); setBlendSample(''); setSelected(''); setFilter(''); setContentsMode('focused'); setMapScope('roots'); setMapQuery(''); setMapChangedOnly(false); setMapAttachments(false); setMapPlane('XY'); setMapCamera({ zoom: 1, x: 0, y: 0 }); setMeshCamera(initialMeshCamera)
    ipc.blueprintCompare(repoPath, { filePath, oldPath, leftRef, rightRef, requestId, externalActors: includeActors, nativeGeometry: nativeRequested, force: retry > 0 }).then(data => {
      if (cancelled) return
      setResult(data)
      const present = [data.left, data.right].filter(item => item.status !== 'absent')
      if (present.length && present.every(item => item.status === 'ready' && !item.document?.assetReview && !item.document?.graphs.length)) {
        unsupportedCallback.current?.('Asset class: ' + [...new Set(present.map(item => item.document?.assetClass ?? 'Unknown'))].join(' / ') + '. No inventory was returned by the reader. Showing binary details.')
      }
      setSide(data.right.status === 'absent' ? 'left' : 'right')
      const hasGraphs = [data.left, data.right].some(item => !!item.document?.graphs.length)
      if (nativeRequested) setSourceLod(data.right.geometry?.lods.find(lod => lod.vertices.length)?.index ?? data.left.geometry?.lods.find(lod => lod.vertices.length)?.index ?? 0)
      setView(hasGraphs || nativeRequested ? 'preview' : single ? 'contents' : 'changes')
    }).catch(reason => { if (!cancelled) setError(String(reason.message ?? reason)) })
    return () => { cancelled = true; void ipc.blueprintCancel(requestId).catch(() => {}) }
  }, [repoPath, filePath, oldPath, leftRef, rightRef, single, retry, includeActors, nativeRequested])
  const changes = useMemo(() => result && !single ? assetChanges(result) : [], [result, single])
  const selectedSide = result?.[side], assetDocument = selectedSide?.document
  const reviewSides = useMemo(() => result ? (['left', 'right'] as const).map(key => reviewObjects(result, key)) : [[], []], [result])
  const blendSpace = blendSpaceClass(assetDocument?.assetClass ?? '')
  const sequenceFamily = blendSpace || assetDocument?.assetReview?.family === 'animation-sequence'
  const physicsAsset = assetDocument?.assetClass === '/Script/Engine.PhysicsAsset'
  const meshFamily = physicsAsset || assetDocument?.assetReview?.family === 'mesh'
  const objects = reviewSides[side === 'left' ? 0 : 1]
  const nativeSides = useMemo(() => result ? [result.left.geometry, result.right.geometry] : [], [result])
  const sourceLods = useMemo(() => [...new Set(nativeSides.flatMap(geometry => geometry?.lods.map(lod => lod.index) ?? []))].sort((a, b) => a - b), [nativeSides])
  const mapInventories = useMemo(() => reviewSides.map((objects,index) => mapInventory((index === 0 ? result?.left : result?.right)?.document?.assetReview?.family === 'map' ? objects : [])), [reviewSides,result])
  const inventory = assetDocument?.assetReview?.family === 'map' ? mapInventories[side === 'left' ? 0 : 1] : null
  const hasMapActors = mapInventories.some(inventory => inventory.actors.length > 0)
  const effectiveMapScope = hasMapActors ? mapScope : 'all'
  const mapNames = useMemo(() => new Map(inventory?.actors.flatMap(actor => [[actor.object.path, actor.name] as [string, string], ...actor.owned.map(object => [object.path, effectiveMapScope === 'roots' && object === actor.root ? actor.name : actor.name + ' / ' + object.name] as [string, string])]) ?? []), [inventory, effectiveMapScope])
  const attachmentModels = useMemo(() => mapAttachments ? reviewSides.map((objects, index) => mapAttachmentPositions(objects, mapInventories[index].roots, mapPlane)) : undefined, [mapAttachments, reviewSides, mapInventories, mapPlane])
  const attachmentBounds = useMemo(() => attachmentModels?.flatMap((model, index) => model.points.filter(point => effectiveMapScope !== 'roots' || mapInventories[index].roots.includes(point.object)).slice(0, 1000)), [attachmentModels, effectiveMapScope, mapInventories])
  const allMapObjects = useMemo(() => reviewSides.flatMap((objects,index) => mapPositions(effectiveMapScope === 'roots' ? mapInventories[index].roots : objects, mapPlane).slice(0,1000).map(point => point.object)), [reviewSides,mapInventories,effectiveMapScope,mapPlane])
  const change = changes.find(item => item.key === selected)
  const object = view === 'changes' ? change?.right ?? change?.left : objects.find(item => item.path === selected)
  const matching = (text: string) => text.toLowerCase().includes(filter.toLowerCase())
  const canCompare = !!result && [result.left, result.right].every(item => item.status === 'absent' || item.status === 'ready' && !!item.document?.assetReview)
  const labels = useMemo(() => ({ left: revisionLabels?.left ?? 'Base', right: revisionLabels?.right ?? 'Selected' }), [revisionLabels?.left, revisionLabels?.right])
  const selectObject = (item: UnrealAssetObject) => { setSelected(item.path); if (/\.(BodySetup|SkeletalBodySetup)$/.test(item.classPath)) setPhysicsBody(item.path) }
  const rows = objects.filter(item => matching(item.name + ' ' + item.path + ' ' + item.classPath))
  const filteredChanges = changes.filter(item => matching((item.right ?? item.left)!.name + ' ' + (item.right ?? item.left)!.path + ' ' + (item.right ?? item.left)!.classPath))
  const hasGraphs = !!result && [result.left, result.right].some(item => item.document?.graphs.length)
  const inspectorSide = view === 'changes' ? change?.right ? 'right' : 'left' : side
  const inspectorObjects = reviewSides[inspectorSide === 'left' ? 0 : 1]
  const linkSides = useMemo<LinkSide[]>(() => result ? (view === 'changes' ? (['left', 'right'] as const).flatMap(key => change?.[key] ? [{ object: change[key]!, objects: reviewSides[key === 'left' ? 0 : 1], side: key, label: labels[key], ref: result[key].resolvedRef ?? result[key].ref, packagePath: change[key]!.sourcePackage ?? result[key].path ?? filePath }] : []) : object ? [{ object, objects, side, label: labels[side], ref: selectedSide!.resolvedRef ?? selectedSide!.ref, packagePath: object.sourcePackage ?? selectedSide!.path ?? filePath }] : []) : [], [result, view, change, reviewSides, labels, object, objects, side, selectedSide, filePath])
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
        {view === 'contents' && (inventory?.actors.length || meshFamily || sequenceFamily) ? <div className="uar-map-tools"><button className="lg-toolbar-control" aria-pressed={contentsMode === 'focused'} onClick={() => setContentsMode('focused')}>{inventory ? 'Actors and owned exports' : sequenceFamily ? 'Animation metadata' : 'Mesh metadata'}</button><button className="lg-toolbar-control" aria-pressed={contentsMode === 'all'} onClick={() => setContentsMode('all')}>All objects</button></div> : null}
        {view === 'contents' && contentsMode === 'focused' && inventory && inventory.actors.length > 0 && <MapContents objects={objects} selected={selected} filter={filter} visible={visible} onSelect={selectObject}/>}
        {view === 'contents' && contentsMode === 'focused' && meshFamily && <MeshContents objects={objects} selected={selected} filter={filter} visible={visible} onSelect={selectObject}/>}
        {view === 'contents' && contentsMode === 'focused' && sequenceFamily && <AnimationSequenceContents objects={objects} selected={selected} filter={filter} onSelect={selectObject}/>}
        {view === 'changes' && <><div className="uar-counts">{(['added', 'removed', 'modified', 'unknown'] as const).map(kind => <span className={'uar-' + kind} key={kind}>{markers[kind]} {counts(kind)} {kind}</span>)}</div>{!canCompare ? <div className="uar-empty">Comparison unavailable. {result.left.reason ?? result.right.reason ?? 'One side has no decoded inventory.'} Unknown content is not treated as absent.</div> : changes.length === 0 ? <div className="uar-empty">No differences in decoded objects/properties. Other package data may still differ.</div> : filteredChanges.slice(0, visible).map(item => <button className={'uar-row uar-' + item.kind} key={item.key} aria-pressed={selected === item.key} onClick={() => setSelected(item.key)}><span>{markers[item.kind]}</span><span>{(item.right ?? item.left)!.name}<small>{className((item.right ?? item.left)!)}{(item.right ?? item.left)!.sourcePackage && ' · ' + (item.right ?? item.left)!.sourcePackage}</small></span><small>{item.kind}{item.opaqueChanged ? ' · native data' : ''}</small></button>)}</>}
        {view === 'contents' && (contentsMode === 'all' || !inventory?.actors.length && !meshFamily && !sequenceFamily) && (selectedSide?.status !== 'ready' ? <div className="uar-empty">{selectedSide?.status === 'absent' ? 'File absent in this revision.' : selectedSide?.reason}</div> : rows.slice(0, visible).map(item => <button className="uar-row" key={item.path} aria-pressed={selected === item.path} onClick={() => selectObject(item)}><span>{item.name}<small>{className(item)} · {item.sourcePackage ?? item.outer}</small></span><small>{Object.keys(item.properties).length} fields{!item.decoded ? ' · incomplete' : ''}</small></button>))}
        {view === 'preview' && ['/Script/Engine.StaticMesh', '/Script/Engine.SkeletalMesh'].includes(assetDocument?.assetClass ?? '') && <div className="uar-map-tools"><button className="lg-toolbar-control" aria-pressed={nativeRequested && meshSource} onClick={() => { setNativeKey(captureKey); setMeshSource(true); setSourceLod(0); setMeshCamera(initialMeshCamera) }}>Preview source mesh with Unreal</button><button className="lg-toolbar-control" aria-pressed={!nativeRequested || !meshSource} onClick={() => { setMeshSource(false); setMeshCamera(initialMeshCamera) }}>Saved collision</button>{nativeRequested && meshSource && sourceLods.length > 0 && <BlueprintChoice id="uar-source-lod" label="Source LOD" value={String(sourceLod)} items={sourceLods.map(index => ({ value: String(index), name: `LOD ${index}`, detail: '', color: 'var(--lg-text-secondary)' }))} onChange={value => { setSourceLod(Number(value)); setMeshCamera(initialMeshCamera) }}/>}<small>Requires the matching installed UE version · captured package only</small></div>}
        {view === 'preview' && (selectedSide?.status !== 'ready' ? <div className="uar-empty">{selectedSide?.status === 'absent' ? 'File absent in this revision.' : selectedSide?.reason}</div> : assetDocument?.assetReview?.family === 'statetree' ? <StateTreePreview objects={objects} changes={changes} side={side} onSelect={selectObject}/> : assetDocument?.assetReview?.family === 'map' ? <MapPreview attachment={attachmentModels ? { ...attachmentModels[side === 'left' ? 0 : 1], allPoints: attachmentBounds! } : undefined} onAttachment={value => { if (value === mapAttachments) return; setMapAttachments(value); setMapCamera({ zoom: 1, x: 0, y: 0 }) }} query={mapQuery} onQuery={setMapQuery} changedOnly={mapChangedOnly} onChangedOnly={setMapChangedOnly} canCompare={!single && canCompare} scope={effectiveMapScope} roots={inventory?.roots} actorCount={inventory?.actors.length ?? 0} onScope={hasMapActors ? value => { if (value === effectiveMapScope) return; setMapScope(value); setMapCamera({ zoom: 1, x: 0, y: 0 }) } : undefined} plane={mapPlane} onPlane={value => { if (value === mapPlane) return; setMapPlane(value); setMapCamera({ zoom: 1, x: 0, y: 0 }) }} names={mapNames} objects={objects} allObjects={allMapObjects} changes={changes} side={side} selected={selected} camera={mapCamera} onCamera={setMapCamera} onSelect={selectObject}/> : blendSpace ? <BlendSpacePreview objects={objects} allObjects={reviewSides} selected={blendSample} onSelected={setBlendSample} onSelect={selectObject}/> : sequenceFamily ? <AnimationSequencePreview objects={objects} allObjects={reviewSides} selected={sequenceEntry} onSelected={setSequenceEntry} onSelect={selectObject}/> : physicsAsset ? <PhysicsAssetPreview labels={labels} single={single} objects={objects} allObjects={reviewSides} camera={meshCamera} onCamera={setMeshCamera} selected={physicsBody || selected} onSelect={selectObject}/> : meshFamily ? <MeshPreview nativeSides={nativeRequested && meshSource ? nativeSides : undefined} lod={sourceLod} labels={labels} single={single} objects={objects} allObjects={reviewSides} camera={meshCamera} onCamera={setMeshCamera} selected={selected} onSelect={selectObject}/> : <div className="uar-empty">No visual decoder is available for this asset class. Saved objects and properties are available in Contents.</div>)}
        {(view === 'contents' ? rows.length : view === 'changes' ? filteredChanges.length : 0) > visible && <button className="lg-toolbar-control" onClick={() => setVisible(value => value + 250)}>Show 250 more objects</button>}
      </section><ObjectInspector object={object} objects={inspectorObjects} linkSides={linkSides} onOpen={(path, ref) => openPackage(repoPath, path, ref)} onSelect={(item, targetSide) => { setView('contents'); setContentsMode('all'); setSide(targetSide ?? inspectorSide); selectObject(item) }} change={view === 'changes' ? change : changes.find(item => item[side]?.path === object?.path)}/></div>}
      <footer className="uar-coverage"><strong>Coverage</strong>{result.externalActors && <span>Actor additions/removals refer to the selected map scope. Data layers and asset references are saved fields only; inherited values and world transforms remain unresolved.</span>}{[...new Set([...(result.left.document?.assetReview?.coverage ?? []), ...(result.right.document?.assetReview?.coverage ?? [])])].map(message => <span key={message}>{message}</span>)}{result.left.status === 'unavailable' && <span>{labels.left}: {result.left.reason}</span>}{result.right.status === 'unavailable' && <span>{labels.right}: {result.right.reason}</span>}</footer>
    </>}
  </div>
  return expanded ? createPortal(<ExpandedAssetReview onClose={() => setExpanded(false)}>{body}</ExpandedAssetReview>, document.body) : body
}

function ExpandedAssetReview({ children, onClose }: { children: React.ReactNode; onClose(): void }) {
  const overlay = useDialogOverlayDismiss(onClose, true, 'Unreal asset review')
  return <div {...overlay} className="bp-expanded uar-expanded">{children}</div>
}
