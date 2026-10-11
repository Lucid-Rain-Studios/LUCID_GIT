import { mapAxes, mapPositions, mapVisiblePositions, type MapPlane } from '../../lib/mapReview'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import type { AssetObjectChange } from '../../lib/unrealAssetReview'

type Camera = { zoom: number; x: number; y: number }
const fit: Camera = { zoom: 1, x: 0, y: 0 }

/** Bounded component-relative schematic. Camera changes never request asset data. */
export function MapPreview({ query, onQuery, changedOnly, onChangedOnly, canCompare, scope = 'all', roots = [], actorCount = 0, onScope, plane = 'XY', onPlane, attachment, onAttachment, names, objects, allObjects, changes, side, selected, camera, onCamera, onSelect }: {
  query: string; onQuery(query: string): void; changedOnly: boolean; onChangedOnly(value: boolean): void; canCompare: boolean
  scope?: 'roots' | 'all'; roots?: UnrealAssetObject[]; actorCount?: number; onScope?(scope: 'roots' | 'all'): void
  plane?: MapPlane; onPlane?(plane: MapPlane): void; names?: Map<string, string>; objects: UnrealAssetObject[]; allObjects: UnrealAssetObject[]; changes: AssetObjectChange[]; side: 'left' | 'right'; selected?: string
  camera: Camera; onCamera(camera: Camera): void; onSelect(object: UnrealAssetObject): void
  attachment?: { points: ReturnType<typeof mapPositions>; allPoints: ReturnType<typeof mapPositions>; unresolved: Map<string, number> }
  onAttachment?(enabled: boolean): void
}) {
  const [horizontal, vertical] = mapAxes[plane]
  const field = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 400, height: 360 })
  const [hover, setHover] = useState<string | null>(null)
  const [movement, setMovement] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; camera: Camera } | null>(null)
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const decoded = useMemo(() => attachment ? attachment.points.filter(point => scope !== 'roots' || roots.includes(point.object)) : mapPositions(scope === 'roots' ? roots : objects, plane), [attachment, objects, roots, scope, plane])
  const name = (object: UnrealAssetObject) => names?.get(object.path) ?? object.name
  const bounds = useMemo(() => {
    const points = (attachment?.allPoints ?? mapPositions(allObjects, plane)).slice(0, 2000)
    const xs = points.map(point => point.x), ys = points.map(point => point.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    return points.length ? { x: minX / 2 + maxX / 2, y: minY / 2 + maxY / 2, width: Math.max(100, maxX - minX), height: Math.max(100, maxY - minY) } : { x: 0, y: 0, width: 100, height: 100 }
  }, [allObjects, attachment, plane])
  const scale = Math.max(.000000001, Math.min((size.width - 40) / bounds.width, (size.height - 40) / bounds.height))
  const changed = useMemo(() => new Map(changes.filter(item => item[side]).map(item => [item[side]!.path, item.kind])), [changes, side])
  const movements = useMemo(() => changes.flatMap(change => {
    if (attachment) return [] // Parent-derived edits are not direct component changes.
    if (!change.left || !change.right || change.ambiguous) return []
    const before = mapPositions([change.left], plane)[0], after = mapPositions([change.right], plane)[0]
    if (!before || !after || before.x === after.x && before.y === after.y) return []
    return [{ before, after }]
  }), [changes, plane, attachment])
  const screen = (point: { x: number; y: number }) => ({ x: size.width / 2 + (point.x - bounds.x) * scale * camera.zoom + camera.x, y: size.height / 2 - (point.y - bounds.y) * scale * camera.zoom + camera.y })
  const zoomAt = (factor: number, x: number, y: number) => {
    const current = cameraRef.current, zoom = Math.max(.2, Math.min(100, current.zoom * factor)), ratio = zoom / current.zoom
    onCamera({ zoom, x: x - size.width / 2 - (x - size.width / 2 - current.x) * ratio, y: y - size.height / 2 - (y - size.height / 2 - current.y) * ratio })
  }
  useEffect(() => {
    const element = field.current
    if (!element) return
    const observer = new ResizeObserver(entries => { const box = entries[0].contentRect; if (box.width > 0 && box.height > 0) setSize({ width: box.width, height: box.height }) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const element = field.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = element.getBoundingClientRect(), current = cameraRef.current
      if (event.shiftKey) onCamera({ ...current, x: current.x - event.deltaX - event.deltaY })
      else zoomAt(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .008), event.clientX - rect.left, event.clientY - rect.top)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  })
  const changedPaths = useMemo(() => new Set(changed.keys()), [changed])
  const results = useMemo(() => mapVisiblePositions(decoded, { query, names, changedOnly, changedPaths, selected }), [decoded, query, names, changedOnly, changedPaths, selected])
  const visible = results.visible
  const visiblePaths = new Set(visible.map(point => point.object.path))
  const visibleMovements = movements.filter(item => visiblePaths.has(item[side === 'left' ? 'before' : 'after'].object.path)).slice(0, 1000)
  const point = visible.find(point => point.object.path === selected)
  const active = visible.find(point => point.object.path === hover)
  const fitResults = () => {
    const xs = visible.map(point => point.x), ys = visible.map(point => point.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    const zoom = Math.max(.2, Math.min(100, Math.min((size.width - 40) / Math.max(100, maxX - minX), (size.height - 40) / Math.max(100, maxY - minY)) / scale))
    onCamera({ zoom, x: -((minX / 2 + maxX / 2) - bounds.x) * scale * zoom, y: ((minY / 2 + maxY / 2) - bounds.y) * scale * zoom })
  }
  return <section className="uar-map">
    <p className="uar-caption">Schematic · {attachment ? 'saved attachment-composed' : 'saved component-relative'} {plane} in cm (+{vertical} up). This is not a reconstructed world.</p>
    {onAttachment && <div className="uar-map-tools" role="group" aria-label="Map transform mode"><button className="lg-toolbar-control" aria-pressed={!attachment} onClick={() => onAttachment(false)}>Relative positions</button><button className="lg-toolbar-control" aria-pressed={!!attachment} onClick={() => onAttachment(true)}>Saved attachments</button></div>}
    {attachment && <p className="uar-caption" role="status">Explicit saved chains only; no inherited defaults, sockets, Blueprint execution or world reconstruction. Changed markers describe saved component fields, not inherited movement. {Array.from(attachment.unresolved, ([reason, count]) => `${count} unresolved: ${reason}`).join(' · ')}</p>}
    {onScope && <div className="uar-map-tools" role="group" aria-label="Map dot scope"><button className="lg-toolbar-control" aria-pressed={scope === 'roots'} onClick={() => { drag.current = null; setHover(null); onScope('roots') }}>Actor roots</button><button className="lg-toolbar-control" aria-pressed={scope === 'all'} onClick={() => { drag.current = null; setHover(null); onScope('all') }}>All positioned exports</button></div>}
    {scope === 'roots' && <p className="uar-caption">{decoded.length} positioned actor roots of {actorCount} saved actors · {actorCount - roots.length} actors have no unique owned root · {roots.length - decoded.length} roots lack {attachment ? 'a supported saved attachment chain' : `complete saved ${plane} coordinates`}. Markers describe root-component changes.</p>}
    {onPlane && <div className="uar-map-tools" role="group" aria-label="Map projection">{(['XY', 'XZ', 'YZ'] as const).map(value => <button className="lg-toolbar-control" key={value} aria-pressed={plane === value} onClick={() => { drag.current = null; setHover(null); onPlane(value) }}>{({ XY: 'Top (XY)', XZ: 'Front (XZ)', YZ: 'Side (YZ)' })[value]}</button>)}</div>}
    <div className="uar-map-tools"><button className="lg-toolbar-control" onClick={() => onCamera(fit)}>Fit map</button><button className="lg-toolbar-control" aria-label="Zoom map in" onClick={() => zoomAt(1.5, size.width / 2, size.height / 2)}>+</button><button className="lg-toolbar-control" aria-label="Zoom map out" onClick={() => zoomAt(1 / 1.5, size.width / 2, size.height / 2)}>−</button><button className="lg-toolbar-control" disabled={!point} onClick={() => { if (point) onCamera({ ...camera, x: -(point.x - bounds.x) * scale * camera.zoom, y: (point.y - bounds.y) * scale * camera.zoom }) }}>Focus selected</button><small>{Math.round(camera.zoom * 100)}%</small></div>
    {visibleMovements.length > 0 && <div className="uar-map-tools"><button className="lg-toolbar-control" aria-pressed={movement} onClick={() => setMovement(value => !value)}>Compare saved positions</button><small>{visibleMovements.length} displayed matched {plane} edits · guides compare relative values, not world movement</small></div>}
    <input className="uar-filter" aria-label="Filter map positions" placeholder="Search actor/object names, classes or paths…" value={query} onChange={event => { setHover(null); onQuery(event.target.value) }} />
    <div className="uar-map-tools"><button className="lg-toolbar-control" aria-pressed={changedOnly} disabled={!canCompare} onClick={() => { setHover(null); onChangedOnly(!changedOnly) }}>Changed dots only</button><button className="lg-toolbar-control" disabled={!visible.length} onClick={fitResults}>Fit results</button><small role="status">{visible.length} shown · {results.total} matching of {decoded.length} positions{results.omitted ? ` · ${results.omitted} omitted` : ''}</small></div>
    <div ref={field} className="uar-map-field" role="region" tabIndex={0} aria-label={attachment ? 'Serialized attachment-composed positions' : 'Serialized component-relative positions'} aria-describedby="uar-map-help"
      onPointerDown={event => { if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, camera }; setHover(null) }}
      onPointerMove={event => { const start = drag.current; if (start && start.id === event.pointerId) onCamera({ ...start.camera, x: start.camera.x + event.clientX - start.x, y: start.camera.y + event.clientY - start.y }) }}
      onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) } }}
      onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; const moves: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }; if (moves[event.key]) { event.preventDefault(); const [x, y] = moves[event.key]; onCamera({ ...camera, x: camera.x + x, y: camera.y + y }) } else if (['+', '=', '-', 'Home'].includes(event.key)) { event.preventDefault(); if (event.key === 'Home') onCamera(fit); else zoomAt(event.key === '-' ? 1 / 1.5 : 1.5, size.width / 2, size.height / 2) } }}>
      {!decoded.length && <div className="uar-empty" role="status">No complete saved {plane} positions. Missing coordinates and inherited transforms are not filled in.</div>}
      {decoded.length > 0 && !visible.length && <div className="uar-empty" role="status">No captured positions match these filters. This does not establish that the world has no matching actors.</div>}
      {movement && <svg className="uar-map-guides" width={size.width} height={size.height} aria-hidden="true">{visibleMovements.map(item => { const before = screen(item.before), after = screen(item.after); return <g key={item.after.object.path}><line x1={before.x} y1={before.y} x2={after.x} y2={after.y}/><circle cx={before.x} cy={before.y} r="5"/><circle cx={after.x} cy={after.y} r="3"/></g> })}</svg>}
      {visible.map(point => { const pixel = screen(point), kind = changed.get(point.object.path) ?? 'unchanged'; return <button className={'uar-map-dot uar-' + kind} key={point.object.path} aria-label={`${name(point.object)}: ${horizontal} ${point.x}, ${vertical} ${point.y} cm`} aria-pressed={selected === point.object.path} title={`${name(point.object)}: (${point.x}, ${point.y}) cm · ${kind}`} style={{ left: pixel.x, top: pixel.y }} onMouseEnter={() => setHover(point.object.path)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(point.object.path)} onBlur={() => setHover(null)} onClick={() => onSelect(point.object)} /> })}
      {active && <div className="uar-map-tooltip" role="tooltip"><strong>{name(active.object)}</strong><span>{active.object.sourcePackage ?? active.object.outer}</span><span>{horizontal} {active.x}, {vertical} {active.y} cm · {changed.get(active.object.path) ?? 'unchanged'}</span></div>}
      <span className="uar-map-axis" aria-hidden="true">↑ {vertical} · {horizontal} →</span>
    </div>
    {scope === 'all' && <p className="uar-caption">{objects.length - decoded.length} package objects have no {attachment ? 'supported saved attachment position' : `complete saved ${plane} coordinates`}; these may be nonspatial objects or components with omitted/inherited values.</p>}
    <p id="uar-map-help" className="uar-caption">Drag to pan · scroll to zoom · Shift + scroll pans · arrow keys pan · +/− zoom · Home fits. Hover or focus a dot for its name; click to inspect.</p>
    <div className="uar-map-legend"><span className="uar-added">○ Added</span><span className="uar-removed">○ Removed</span><span className="uar-modified">○ Modified</span><span className="uar-unknown">○ Unknown</span><span>○ Unchanged</span></div>
    <details className="uar-map-list"><summary>{visible.length} of {results.total} matching saved {plane} positions · select overlapping objects{results.omitted ? ` · ${results.omitted} omitted` : ''}</summary><div>{visible.map(point => <button className="uar-row" key={point.object.path} onClick={() => { onSelect(point.object); onCamera({ ...camera, x: -(point.x - bounds.x) * scale * camera.zoom, y: (point.y - bounds.y) * scale * camera.zoom }) }}><span>{name(point.object)}<small>{point.x}, {point.y} cm · {point.object.sourcePackage ?? point.object.outer}</small></span></button>)}</div></details>
  </section>
}
