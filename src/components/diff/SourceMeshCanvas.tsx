import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import type { CollisionHull, MeshCamera, Vertex } from '../../lib/meshReview'

/** Large source meshes use bounded GPU buffers instead of one DOM node per face. */
export function SourceMeshCanvas({ hulls, center, radius, camera, selected }: {
  hulls: CollisionHull[]; center: Vertex; radius: number; camera: MeshCamera; selected?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const draw = useRef<(() => void) | null>(null)
  const current = useRef({ camera, selected })
  current.current = { camera, selected }
  const [error, setError] = useState('')
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ canvas: element, antialias: true, alpha: true, preserveDrawingBuffer: true }) }
    catch { setError('GPU source preview unavailable. Enable WebGL and reopen the preview.'); return }
    setError('')
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(400, 360, false)
    const scene = new THREE.Scene(), view = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 10)
    view.up.set(0, 0, 1)
    const light = new THREE.DirectionalLight(0xffffff, 2)
    light.position.set(2, -1, 3)
    scene.add(new THREE.AmbientLight(0xffffff, 1), light)
    const resources: Array<{ dispose(): void }> = []
    const entries = hulls.map(hull => {
      const geometry = new THREE.BufferGeometry()
      // Reflect Y and winding together when converting Unreal's handedness.
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(hull.vertices.flatMap(vertex => vertex.map((value, axis) => (value - center[axis]) / radius * (axis === 1 ? -1 : 1))), 3))
      const indices = hull.indices.slice()
      for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]]
      geometry.setIndex(indices)
      geometry.computeVertexNormals()
      const solid = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, flatShading: true })
      const mesh = new THREE.Mesh(geometry, solid)
      // Construct wireframe buffers only if requested, and retain them for mode changes.
      const lineMaterial = new THREE.LineBasicMaterial(), pointMaterial = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false })
      const points = new THREE.Points(geometry, pointMaterial)
      let lines: THREE.LineSegments | undefined
      scene.add(mesh, points)
      resources.push(geometry, solid, lineMaterial, pointMaterial)
      return { hull, mesh, points, solid, lineMaterial, pointMaterial, wireframe() {
        if (!lines) {
          const edges = new THREE.WireframeGeometry(geometry)
          lines = new THREE.LineSegments(edges, lineMaterial)
          resources.push(edges)
          scene.add(lines)
        }
        return lines
      }, hideLines() { if (lines) lines.visible = false } }
    })
    draw.current = () => {
      const { camera: state, selected: active } = current.current
      const styles = getComputedStyle(element)
      const accent = styles.getPropertyValue('--lg-accent').trim() || '#268bff'
      const edge = styles.getPropertyValue('--lg-text-secondary').trim() || '#90a4bb'
      const warning = styles.getPropertyValue('--lg-warning').trim() || '#ffb000'
      view.left = -200 / (145 * state.zoom); view.right = -view.left
      view.top = 180 / (145 * state.zoom); view.bottom = -view.top
      view.position.set(3 * Math.sin(state.yaw) * Math.cos(state.pitch), -3 * Math.cos(state.yaw) * Math.cos(state.pitch), 3 * Math.sin(state.pitch))
      view.lookAt(0, 0, 0); view.updateProjectionMatrix()
      for (const entry of entries) {
        const highlighted = active === entry.hull.object.path
        entry.solid.color.set(highlighted ? warning : accent)
        entry.lineMaterial.color.set(highlighted ? warning : edge)
        entry.pointMaterial.color.copy(entry.lineMaterial.color)
        entry.mesh.visible = !state.wireframe
        entry.points.visible = state.wireframe
        if (state.wireframe) entry.wireframe().visible = true
        else entry.hideLines()
      }
      renderer.render(scene, view)
    }
    draw.current()
    const lost = (event: Event) => { event.preventDefault(); setError('GPU source preview interrupted. Reopen the preview to retry.') }
    element.addEventListener('webglcontextlost', lost)
    return () => {
      draw.current = null
      element.removeEventListener('webglcontextlost', lost)
      for (const resource of resources) resource.dispose()
      renderer.dispose(); renderer.forceContextLoss()
    }
  }, [hulls, center, radius])
  useEffect(() => { draw.current?.() }, [camera, selected])
  return <foreignObject x="0" y="0" width="400" height="360" pointerEvents="none">
    <canvas ref={canvas} aria-label="GPU source geometry" style={{ width: '100%', height: '100%', display: error ? 'none' : 'block' }}/>
    {error && <div role="alert">{error}</div>}
  </foreignObject>
}
