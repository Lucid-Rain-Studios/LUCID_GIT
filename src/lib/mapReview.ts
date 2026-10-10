import type { UnrealAssetObject } from '../../electron/blueprintTypes'

export function mapPositions(objects: UnrealAssetObject[]) {
  return objects.flatMap(object => {
    const saved = object.properties.RelativeLocation as Record<string, unknown> | undefined
    const position = (saved?.RelativeLocation ?? saved) as { X?: unknown; Y?: unknown } | undefined
    const coordinate = (value: unknown) => typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
    const x = coordinate(position?.X), y = coordinate(position?.Y)
    return Number.isFinite(x) && Number.isFinite(y) ? [{ object, x, y }] : []
  })
}
