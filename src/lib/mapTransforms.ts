import type { UnrealAssetObject } from '../../electron/blueprintTypes'
import { savedObjectIndex } from './assetReferences'
import { rotate, type Vertex } from './meshReview'
import { mapAxes, type MapPlane } from './mapReview'
import { savedVector as vector } from '../../electron/util/saved-vector'

/** Strict saved attachment chains only. Missing defaults, sockets and cross-package
 * references are unresolved. Positive uniform scale avoids FTransform shear ambiguity. */
export function mapAttachmentPositions(objects: UnrealAssetObject[], roots: UnrealAssetObject[], plane: MapPlane) {
  const resolve = savedObjectIndex(objects), verifiedRoots = new Set(roots)
  const cache = new Map<UnrealAssetObject, { location?: Vertex; reason?: string }>()
  const chain = (object: UnrealAssetObject) => {
    const result: UnrealAssetObject[] = [], visited = new Set<UnrealAssetObject>()
    let cursor: UnrealAssetObject | undefined = object
    while (cursor && result.length < 32 && !visited.has(cursor)) {
      visited.add(cursor); result.push(cursor)
      const p = cursor.properties
      if (p.AttachParent === 'None') return verifiedRoots.has(cursor) ? { result } : { reason: 'No verified actor-root anchor' }
      if (typeof p.AttachParent !== 'string') return { reason: 'Attachment parent omitted' }
      cursor = resolve(cursor, p.AttachParent)
      if (!cursor) return { reason: 'Attachment parent missing, ambiguous or outside this package' }
    }
    return { reason: 'Attachment cycle or depth limit' }
  }
  const locate = (object: UnrealAssetObject) => {
    const cached = cache.get(object)
    if (cached) return cached
    const saved = chain(object)
    let location: Vertex = [0, 0, 0], reason = saved.reason
    if (saved.result) for (const component of saved.result) {
      const p = component.properties
      const translation = vector(p.RelativeLocation, 'RelativeLocation', ['X', 'Y', 'Z'])
      const rotation = vector(p.RelativeRotation, 'RelativeRotation', ['Pitch', 'Yaw', 'Roll'])
      const scale = vector(p.RelativeScale3D, 'RelativeScale3D', ['X', 'Y', 'Z'])
      if (!translation || !rotation || !scale) { reason = 'Transform fields omitted or invalid'; break }
      if (scale[0] <= 0 || scale[0] !== scale[1] || scale[0] !== scale[2]) { reason = 'Nonuniform or negative scale unsupported'; break }
      if (p.bAbsoluteLocation !== false || p.bAbsoluteRotation !== false || p.bAbsoluteScale !== false || p.AttachSocketName !== 'None') { reason = 'Absolute-transform flags or socket unresolved'; break }
      const rotated = rotate(location.map(value => value * scale[0]) as Vertex, rotation)
      location = rotated.map((value, axis) => value + translation[axis]) as Vertex
      if (!location.every(Number.isFinite)) { reason = 'Composed transform exceeds finite coordinates'; break }
    }
    const result = reason ? { reason } : { location }
    cache.set(object, result)
    return result
  }
  const [h, v] = mapAxes[plane], axes = { X: 0, Y: 1, Z: 2 }
  const points: Array<{ object: UnrealAssetObject; x: number; y: number }> = []
  const unresolved = new Map<string, number>()
  for (const object of objects) {
    if (!('RelativeLocation' in object.properties)) continue
    const result = locate(object)
    if (result.location) points.push({ object, x: result.location[axes[h]], y: result.location[axes[v]] })
    else unresolved.set(result.reason!, (unresolved.get(result.reason!) ?? 0) + 1)
  }
  return { points, unresolved }
}
