import { mapPositions } from '../../lib/mapReview'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import type { AssetObjectChange } from '../../lib/unrealAssetReview'

type Camera = { zoom: number; x: number; y: number }
const fit: Camera = { zoom: 1, x: 0, y: 0 }

/** Bounded component-relative schematic. Camera changes never request asset data. */
export function MapPreview({ objects, allObjects, changes, side, selected, camera, onCamera, onSelect }: {
  objects: UnrealAssetObject[]; allObjects: UnrealAssetObject[]; changes: AssetObjectChange[]; side: 'left' | 'right'; selected?: string
  camera: Camera; onCamera(camera: Camera): void; onSelect(object: UnrealAssetObject): void
}) {
  const field = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 400, height: 360 })
  const [hover, setHover] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const drag = useRef<{ id: number; x: number; y: number; camera: Camera } | null>(null)
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const decoded = useMemo(() => mapPositions(objects), [objects])
  const positions = decoded.slice(0, 1000)
  const bounds = useMemo(() => {
    const points = mapPositions(allObjects).slice(0, 2000)
    const xs = points.map(point => point.x), ys = points.map(point => point.y)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    return points.length ? { x: minX / 2 + maxX / 2, y: minY / 2 + maxY / 2, width: Math.max(100, maxX - minX), height: Math.max(100, maxY - minY) } : { x: 0, y: 0, width: 100, height: 100 }
  }, [allObjects])
  const scale = Math.max(.000000001, Math.min((size.width - 40) / bounds.width, (size.height - 40) / bounds.height))
  const changed = useMemo(() => new Map(changes.filter(item => item[side]).map(item => [item[side]!.path, item.kind])), [changes, side])
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
  const point = positions.find(point => point.object.path === selected)
  const active = positions.find(point => point.object.path === hover)
  const visible = positions.filter(point => point.object.name.toLowerCase().includes(filter.toLowerCase()))
  if (!decoded.length) return <div className="uar-empty">No serialized component positions are decoded. Inherited transforms are not resolved.</div>
  return <section className="uar-map">
    <p className="uar-caption">Schematic · saved component-relative XY in cm (+Y up). This is not a reconstructed world.</p>
    <div className="uar-map-tools"><button className="lg-toolbar-control" onClick={() => onCamera(fit)}>Fit map</button><button className="lg-toolbar-control" aria-label="Zoom map in" onClick={() => zoomAt(1.5, size.width / 2, size.height / 2)}>+</button><button className="lg-toolbar-control" aria-label="Zoom map out" onClick={() => zoomAt(1 / 1.5, size.width / 2, size.height / 2)}>−</button><button className="lg-toolbar-control" disabled={!point} onClick={() => { if (point) onCamera({ ...camera, x: -(point.x - bounds.x) * scale * camera.zoom, y: (point.y - bounds.y) * scale * camera.zoom }) }}>Focus selected</button><small>{Math.round(camera.zoom * 100)}%</small></div>
    <div ref={field} className="uar-map-field" role="region" tabIndex={0} aria-label="Serialized component-relative positions" aria-describedby="uar-map-help"
      onPointerDown={event => { if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, camera }; setHover(null) }}
      onPointerMove={event => { const start = drag.current; if (start && start.id === event.pointerId) onCamera({ ...start.camera, x: start.camera.x + event.clientX - start.x, y: start.camera.y + event.clientY - start.y }) }}
      onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) } }}
      onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; const moves: Record<string, [number, number]> = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }; if (moves[event.key]) { event.preventDefault(); const [x, y] = moves[event.key]; onCamera({ ...camera, x: camera.x + x, y: camera.y + y }) } else if (['+', '=', '-', 'Home'].includes(event.key)) { event.preventDefault(); if (event.key === 'Home') onCamera(fit); else zoomAt(event.key === '-' ? 1 / 1.5 : 1.5, size.width / 2, size.height / 2) } }}>
      {visible.map(point => { const pixel = screen(point), kind = changed.get(point.object.path) ?? 'unchanged'; return <button className={'uar-map-dot uar-' + kind} key={point.object.path} aria-label={`${point.object.name}: X ${point.x}, Y ${point.y} cm`} aria-pressed={selected === point.object.path} title={`${point.object.name}: (${point.x}, ${point.y}) cm · ${kind}`} style={{ left: pixel.x, top: pixel.y }} onMouseEnter={() => setHover(point.object.path)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(point.object.path)} onBlur={() => setHover(null)} onClick={() => onSelect(point.object)} /> })}
      {active && <div className="uar-map-tooltip" role="tooltip"><strong>{active.object.name}</strong><span>{active.object.sourcePackage ?? active.object.outer}</span><span>X {active.x}, Y {active.y} cm · {changed.get(active.object.path) ?? 'unchanged'}</span></div>}
      <span className="uar-map-axis" aria-hidden="true">↑ Y · X →</span>
    </div>
    <p id="uar-map-help" className="uar-caption">Drag to pan · scroll to zoom · Shift + scroll pans · arrow keys pan · +/− zoom · Home fits. Hover or focus a dot for its name; click to inspect.</p>
    <div className="uar-map-legend"><span className="uar-added">○ Added</span><span className="uar-removed">○ Removed</span><span className="uar-modified">○ Modified</span><span className="uar-unknown">○ Unknown</span><span>○ Unchanged</span></div>
    <details className="uar-map-list"><summary>{positions.length} of {decoded.length} saved positions · select overlapping objects{decoded.length > positions.length ? ` · ${decoded.length - positions.length} omitted` : ''}</summary><input className="uar-filter" aria-label="Filter map positions" placeholder="Filter object names…" value={filter} onChange={event => setFilter(event.target.value)} /><div>{visible.map(point => <button className="uar-row" key={point.object.path} onClick={() => { onSelect(point.object); onCamera({ ...camera, x: -(point.x - bounds.x) * scale * camera.zoom, y: (point.y - bounds.y) * scale * camera.zoom }) }}><span>{point.object.name}<small>{point.x}, {point.y} cm · {point.object.sourcePackage ?? point.object.outer}</small></span></button>)}</div></details>
  </section>
}
