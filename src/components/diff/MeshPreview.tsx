import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { NativeMeshGeometry, UnrealAssetObject } from '../../../electron/blueprintTypes'
import { collisionBounds, collisionHulls, sourceMeshHulls, initialMeshCamera, type MeshCamera, type Vertex } from '../../lib/meshReview'

const SourceMeshCanvas = lazy(() => import('./SourceMeshCanvas').then(module => ({ default: module.SourceMeshCanvas })))

/** CPU/SVG captured geometry; bounded, read-only, no dependency reads or GPU resources. */
export function MeshPreview({ objects, allObjects, camera, onCamera, selected, onSelect, labels = { left: 'Base', right: 'Selected' }, single = false, boneLocal = false, nativeSides, lod = 0, showWireframeControl = true, loading = false }: {
  objects: UnrealAssetObject[]; allObjects: UnrealAssetObject[][]; camera: MeshCamera; onCamera(camera: MeshCamera): void
  selected?: string; onSelect(object: UnrealAssetObject): void
  labels?: { left: string; right: string }; single?: boolean; boneLocal?: boolean
  nativeSides?: Array<NativeMeshGeometry | undefined>; lod?: number; showWireframeControl?: boolean; loading?: boolean
}) {
  const sides = useMemo(() => allObjects.map((objects, index) => nativeSides ? sourceMeshHulls(objects, nativeSides[index], lod) : collisionHulls(objects, boneLocal)), [allObjects, boneLocal, nativeSides, lod])
  const decoded = useMemo(() => sides[allObjects.indexOf(objects)] ?? (nativeSides ? sourceMeshHulls(objects, undefined, lod) : collisionHulls(objects, boneLocal)), [objects, allObjects, sides, boneLocal, nativeSides, lod])
  const savedBounds = useMemo(() => collisionBounds(decoded.hulls), [decoded])
  const bounds = useMemo(() => collisionBounds(sides.flatMap(side => side.hulls)), [sides])
  const gpu = !!nativeSides && (decoded.vertices > 20000 || decoded.triangles > 10000)
  const topology = useMemo(() => nativeSides && !gpu ? decoded.hulls.map(hull => {
    const edges = new Map<string, [number, number]>()
    for (let i = 0; i < hull.indices.length; i += 3) {
      const triangle = hull.indices.slice(i, i + 3)
      for (let j = 0; j < 3; j++) {
        const a = triangle[j], b = triangle[(j + 1) % 3]
        edges.set(`${Math.min(a, b)}:${Math.max(a, b)}`, [a, b])
      }
    }
    return { hull, edges: [...edges.values()] }
  }) : [], [decoded, nativeSides, gpu])
  const field = useRef<SVGSVGElement>(null)
  const drag = useRef<{ id: number; x: number; y: number; camera: MeshCamera } | null>(null)
  const project = (vertex: Vertex) => {
    const [x, y, z] = vertex.map((value, axis) => (value - bounds.center[axis]) / bounds.radius)
    const horizontal = Math.cos(camera.yaw) * x - Math.sin(camera.yaw) * y
    const depth = Math.sin(camera.yaw) * x + Math.cos(camera.yaw) * y
    return { x: 200 + horizontal * 145 * camera.zoom, y: 180 - (Math.cos(camera.pitch) * z - Math.sin(camera.pitch) * depth) * 145 * camera.zoom, depth: Math.cos(camera.pitch) * depth + Math.sin(camera.pitch) * z }
  }
  const faces = gpu || nativeSides && camera.wireframe ? [] : decoded.hulls.flatMap(hull => {
    const projected = hull.vertices.map(project)
    return Array.from({ length: hull.indices.length / 3 }, (_, index) => {
      const points = hull.indices.slice(index * 3, index * 3 + 3).map(i => projected[i])
      return { hull, index, depth: points.reduce((sum, point) => sum + point.depth, 0) / 3, points: points.map(point => `${point.x},${point.y}`).join(' ') }
    })
  }).sort((a, b) => a.depth - b.depth)
  const zoom = (factor: number) => onCamera({ ...camera, zoom: Math.max(.2, Math.min(10, camera.zoom * factor)) })
  useEffect(() => {
    const element = field.current
    if (!element) return
    const wheel = (event: WheelEvent) => { event.preventDefault(); zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .008)) }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  })
  if (loading && nativeSides && !decoded.hulls.length) return <section className="uar-mesh uar-mesh-loading" role="status" aria-label="Loading source geometry"><Loader2 className="uar-preview-spinner" size={22} aria-hidden="true"/><span>Loading source geometry…</span></section>
  return <section className="uar-mesh">
    <p className="uar-caption">{nativeSides ? `Unreal source model LOD ${lod}` : "Saved box/sphere/capsule/convex collision geometry"} · centimeters · Z up. {boneLocal && 'Selected body local coordinates; bone placement and the assembled skeleton are not reconstructed.'} {nativeSides ? "Materials and textures are not rendered. Source geometry is not generated render topology or Nanite." : "Render mesh, materials and LODs are not reconstructed."}</p>
    <details className="uar-collision-summary"><summary>{nativeSides ? "Source geometry by revision" : "Collision geometry by revision"}</summary><table><thead><tr><th>Revision</th><th>{nativeSides ? "Source LOD" : "Decoded shapes"}</th><th>{nativeSides ? "Unavailable LODs" : "Omitted shapes"}</th><th>{nativeSides ? "Source vertices / triangles" : "Preview vertices / triangles"}</th><th>Decoded extent XYZ (cm)</th></tr></thead><tbody>{sides.map((side, index) => {
      if (single && index === 0) return null
      const extent = collisionBounds(side.hulls)
      return <tr key={index}><th>{index === 0 ? labels.left : labels.right}</th><td>{nativeSides ? lod : side.hulls.length}</td><td>{side.omitted}</td><td>{side.hulls.length ? `${side.vertices} / ${side.triangles}` : 'Unavailable'}</td><td>{side.hulls.length ? extent.max.map((value, axis) => (value - extent.min[axis]).toFixed(2)).join(' × ') : 'Unavailable'}</td></tr>
    })}</tbody></table><small>Extents cover displayed geometry only. Empty or unavailable geometry does not establish absence; equal counts do not establish equal geometry.</small></details>
    <div className="uar-map-tools"><button className="lg-toolbar-control" onClick={() => onCamera({ ...initialMeshCamera, wireframe: camera.wireframe })}>{nativeSides ? "Fit source mesh" : "Fit collision"}</button><button className="lg-toolbar-control" aria-label="Zoom collision in" onClick={() => zoom(1.5)}>+</button><button className="lg-toolbar-control" aria-label="Zoom collision out" onClick={() => zoom(1 / 1.5)}>−</button>{showWireframeControl && <button className="lg-toolbar-control" aria-pressed={camera.wireframe} onClick={() => onCamera({ ...camera, wireframe: !camera.wireframe })}>Wireframe</button>}<small>{Math.round(camera.zoom * 100)}%</small></div>
    {decoded.hulls.length ? <svg ref={field} className="uar-mesh-field" viewBox="0 0 400 360" role="region" tabIndex={0} aria-label={nativeSides ? "Unreal source mesh preview" : "Saved collision preview"}
      onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, camera } }}
      onPointerMove={event => { const start = drag.current; if (start?.id === event.pointerId) onCamera({ ...start.camera, yaw: start.camera.yaw + (event.clientX - start.x) * .01, pitch: Math.max(-1.5, Math.min(1.5, start.camera.pitch + (event.clientY - start.y) * .01)) }) }}
      onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId) } }} onLostPointerCapture={() => { drag.current = null }}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) { event.preventDefault(); if (event.key === 'Home') onCamera({ ...initialMeshCamera, wireframe: camera.wireframe }); else if (['+', '=', '-'].includes(event.key)) zoom(event.key === '-' ? 1 / 1.5 : 1.5); else onCamera({ ...camera, yaw: camera.yaw + (event.key === 'ArrowLeft' ? -.15 : event.key === 'ArrowRight' ? .15 : 0), pitch: Math.max(-1.5, Math.min(1.5, camera.pitch + (event.key === 'ArrowUp' ? .15 : event.key === 'ArrowDown' ? -.15 : 0))) }) } }}>
      {!(nativeSides && camera.wireframe) && faces.map(face => <polygon key={`${face.hull.object.path}:${face.hull.kind}:${face.hull.index}:${face.index}`} points={face.points} fill={camera.wireframe ? 'none' : selected === face.hull.object.path ? 'var(--lg-warning)' : 'var(--lg-accent)'} fillOpacity=".25" stroke={selected === face.hull.object.path ? 'var(--lg-warning)' : 'var(--lg-text-secondary)'} strokeWidth=".7"><title>{face.hull.object.name} · {face.hull.kind} {face.hull.kind === "source LOD" ? face.hull.index : face.hull.index + 1}</title></polygon>)}
      {gpu && <Suspense fallback={<text x="20" y="180">Loading source viewer…</text>}><SourceMeshCanvas hulls={decoded.hulls} center={bounds.center} radius={bounds.radius} camera={camera} selected={selected}/></Suspense>}
      {nativeSides && camera.wireframe && topology.map(({ hull, edges }) => {
        const points = hull.vertices.map(project)
        const color = selected === hull.object.path ? 'var(--lg-warning)' : 'var(--lg-text-secondary)'
        return <g key={hull.object.path + ':' + hull.index}>
          {edges.map(([a, b]) => <line key={a + ':' + b} x1={points[a].x} y1={points[a].y} x2={points[b].x} y2={points[b].y} stroke={color} strokeWidth=".7"/>)}
          {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="1.6" fill={color}><title>{hull.object.name} · vertex {index}</title></circle>)}
        </g>
      })}
    </svg> : <div className="uar-empty">{nativeSides ? "No source geometry available for this LOD and revision." : "No supported saved box/sphere/convex collision geometry. Contents still exposes available metadata and native-payload changes."}</div>}
    <p className="uar-caption">{decoded.hulls.length ? nativeSides ? `${decoded.vertices} source vertices · ${decoded.triangles} source triangles.` : `${decoded.hulls.length} shapes · ${decoded.vertices} preview vertices · ${decoded.triangles} preview triangles · ${decoded.omitted} omitted shapes.` : nativeSides ? 'Source geometry unavailable.' : `Collision vertex/triangle counts unavailable · ${decoded.omitted} saved shapes omitted.`} Drag to orbit · scroll or +/− to zoom · arrows rotate · Home fits.</p>
    {decoded.hulls.length > 0 && <p className="uar-caption">Displayed extent XYZ: {savedBounds.max.map((value, axis) => (value - savedBounds.min[axis]).toFixed(2)).join(' × ')} cm. Fit uses both revisions; equal counts do not establish equal geometry.</p>}
    {!nativeSides && <p className="uar-caption">Box and faceted sphere/capsule faces are generated for this collision preview; these counts describe the preview geometry, not render-mesh topology.</p>}
    {decoded.hulls.map(hull => <button className="uar-row" key={`${hull.object.path}:${hull.kind}:${hull.index}`} aria-pressed={selected === hull.object.path} onClick={() => onSelect(hull.object)}><span>{hull.object.name} · {hull.kind} {hull.kind === "source LOD" ? hull.index : hull.index + 1}<small>{hull.vertices.length} vertices · {hull.indices.length / 3} triangles</small></span></button>)}
    {decoded.diagnostics.map(message => <p className="uar-warning" key={message}>{message}</p>)}
  </section>
}
