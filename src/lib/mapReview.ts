import type { UnrealAssetObject } from '../../electron/blueprintTypes'

export type MapPlane = 'XY' | 'XZ' | 'YZ'
export const mapAxes: Record<MapPlane, readonly ['X' | 'Y', 'Y' | 'Z']> = { XY: ['X', 'Y'], XZ: ['X', 'Z'], YZ: ['Y', 'Z'] }

export function mapPositions(objects: UnrealAssetObject[], plane: MapPlane = 'XY') {
  const [horizontal, vertical] = mapAxes[plane]
  return objects.flatMap(object => {
    const saved = object.properties.RelativeLocation as Record<string, unknown> | undefined
    const position = (saved?.RelativeLocation ?? saved) as { X?: unknown; Y?: unknown; Z?: unknown } | undefined
    const coordinate = (value: unknown) => typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    const x = coordinate(position?.[horizontal]), y = coordinate(position?.[vertical])
    return Number.isFinite(x) && Number.isFinite(y) ? [{ object, x, y }] : []
  })
}


/** Search the captured inventory before bounding DOM work. Selection never bypasses filters. */
export function mapVisiblePositions(points: ReturnType<typeof mapPositions>, options: {
  query: string; names?: Map<string, string>; changedOnly: boolean; changedPaths: Set<string>; selected?: string
}) {
  const query = options.query.trim().toLowerCase()
  const matching = points.filter(({ object }) => (!options.changedOnly || options.changedPaths.has(object.path)) &&
    (!query || [options.names?.get(object.path), object.name, object.path, object.classPath, object.sourcePackage, object.outer].filter(Boolean).join(' ').toLowerCase().includes(query)))
  const visible = matching.slice(0, 1000)
  const selected = matching.find(point => point.object.path === options.selected)
  if (selected && !visible.includes(selected)) visible[visible.length - 1] = selected
  return { visible, total: matching.length, omitted: matching.length - visible.length }
}
