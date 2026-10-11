import type { UnrealAssetObject } from '../../electron/blueprintTypes'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const finite = (value: unknown) => { const number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN; return Number.isFinite(number) ? number : undefined }
export const blendSpaceClass = (classPath: string) => /^\/Script\/Engine\.(BlendSpace|BlendSpace1D|AimOffsetBlendSpace|AimOffsetBlendSpace1D)$/.test(classPath)

/** Authored samples only. Array positions are field locations, not stable identities. */
export function blendSpaceModel(objects: UnrealAssetObject[]) {
  const roots = objects.filter(object => blendSpaceClass(object.classPath))
  const object = roots.length === 1 ? roots[0] : undefined
  const dimensions = object?.classPath.endsWith('1D') ? 1 : 2
  const saved = (key: string) => object?.opaqueProperties?.includes(key) ? undefined : object?.properties[key]
  const axis = (index: number) => {
    const key = index === 0 && Object.hasOwn(object?.properties ?? {}, 'BlendParameters') ? 'BlendParameters' : `BlendParameters[${index}]`
    const fields = record(saved(key))
    return { label: typeof fields.DisplayName === 'string' ? fields.DisplayName : `Axis ${index + 1}`, min: finite(fields.Min), max: finite(fields.Max), fields }
  }
  const values = saved('SampleData'), samples = Array.isArray(values) ? values : []
  const entries = samples.slice(0,1000).map((value,index) => {
    const fields = record(value), wrapper = record(fields.SampleValue), point = record(wrapper.SampleValue ?? fields.SampleValue)
    const x = finite(point.X), y = dimensions === 1 ? undefined : finite(point.Y)
    return { index, key: `SampleData[${index}]`, fields, x, y, positioned: x !== undefined && (dimensions === 1 || y !== undefined), label: typeof fields.Animation === 'string' ? fields.Animation : 'Animation reference unavailable' }
  })
  return { object, dimensions, axes: [axis(0), axis(1)], entries, total: samples.length, omitted: Math.max(0,samples.length-entries.length) }
}

/** Shared observed extent, including only explicit axis endpoints. No omitted defaults. */
export function blendSpaceBounds(models: ReturnType<typeof blendSpaceModel>[]) {
  return [0,1].map(index => {
    const values = models.flatMap(model => [...(index === 1 && model.dimensions === 1 ? [] : model.entries.filter(entry => entry.positioned).map(entry => index === 0 ? entry.x! : entry.y!)), model.axes[index].min, model.axes[index].max]).filter((value): value is number => value !== undefined)
    if (!values.length) return { min: 0, max: 1, available: false }
    const min = Math.min(...values), max = Math.max(...values)
    // Bounded percentage arithmetic avoids overflow from extreme finite values.
    return { min, max, available: true }
  })
}
