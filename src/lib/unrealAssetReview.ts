import type { BlueprintComparison, UnrealAssetObject } from '../../electron/blueprintTypes'

export const isUnrealPackage = (path: string) => /\.(uasset|umap)$/i.test(path)
export const revisionName = (ref: string) => ({ WORKING: 'Working tree', INDEX: 'Index', HEAD: 'HEAD', ABSENT: 'Absent' }[ref] ?? ref.slice(0, 7) + (ref.endsWith('^1') ? ' parent' : ''))
export type AssetChangeKind = 'added' | 'removed' | 'modified' | 'unknown'
export interface AssetPropertyChange { path: string; before?: unknown; after?: unknown; beforePresent: boolean; afterPresent: boolean }
export interface AssetObjectChange { key: string; kind: AssetChangeKind; left?: UnrealAssetObject; right?: UnrealAssetObject; properties: AssetPropertyChange[]; opaqueChanged: boolean; ambiguous: boolean }

// Sort object keys, but retain serialized array order. Unknown native data is
// kept out of semantic property claims and is reported independently.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value) ?? 'undefined'
}
export function propertyChanges(left: Record<string, unknown>, right: Record<string, unknown>): AssetPropertyChange[] {
  const changes: AssetPropertyChange[] = []
  const walk = (a: Record<string, unknown>, b: Record<string, unknown>, prefix: string, depth: number) => {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const before = a[key], after = b[key], field = prefix ? prefix + '.' + key : key
      const beforePresent = Object.hasOwn(a, key), afterPresent = Object.hasOwn(b, key)
      if (canonical(before) === canonical(after) && beforePresent === afterPresent) continue
      if (depth < 12 && before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) walk(before as Record<string, unknown>, after as Record<string, unknown>, field, depth + 1)
      else changes.push({ path: field, before, after, beforePresent, afterPresent })
    }
  }
  walk(left, right, '', 0)
  return changes
}
export function reviewObjects(comparison: BlueprintComparison, side: 'left' | 'right'): UnrealAssetObject[] {
  const base = comparison[side].document?.assetReview?.objects ?? []
  const external = comparison.externalActors?.packages.flatMap(pair => packageObjects(pair[side])) ?? []
  return [...base, ...external]
}
function packageObjects(side: BlueprintComparison['left']): UnrealAssetObject[] {
  return side.status === 'ready' ? (side.document?.assetReview?.objects ?? []).map(object => ({ ...object, serializedPath: object.path, sourcePackage: side.path, path: side.path + ' :: ' + object.path })) : []
}
export function assetChanges(comparison: BlueprintComparison): AssetObjectChange[] {
  const changes = packageChanges(comparison)
  for (const pair of comparison.externalActors?.packages ?? []) {
    const wrap = (side: BlueprintComparison['left']) => side.document?.assetReview ? { ...side, document: { ...side.document, assetReview: { ...side.document.assetReview, objects: packageObjects(side) } } } : side
    const partial = packageChanges({ left: wrap(pair.left), right: wrap(pair.right) })
    changes.push(...partial)
  }
  return changes
}
function packageChanges(comparison: BlueprintComparison): AssetObjectChange[] {
  if (![comparison.left, comparison.right].every(side => side.status === 'absent' || side.status === 'ready' && side.document?.assetReview)) return []
  const left = comparison.left.document?.assetReview?.objects ?? [], right = comparison.right.document?.assetReview?.objects ?? []
  const counts = (objects: UnrealAssetObject[], key: 'id' | 'path') => { const map = new Map<string, number>(); for (const object of objects) if (object[key]) map.set(object[key], (map.get(object[key]) ?? 0) + 1); return map }
  const li = counts(left, 'id'), ri = counts(right, 'id'), lp = counts(left, 'path'), rp = counts(right, 'path')
  const rightIds = new Map(right.filter(o => o.id && ri.get(o.id) === 1).map(o => [o.id, o]))
  const rightPaths = new Map(right.filter(o => rp.get(o.path) === 1).map(o => [o.path, o]))
  const used = new Set<UnrealAssetObject>(), result: AssetObjectChange[] = []
  for (const a of left) {
    const byGuid = a.id && li.get(a.id) === 1 ? rightIds.get(a.id) : undefined
    const byPath = lp.get(a.path) === 1 ? rightPaths.get(a.path) : undefined
    const b = byGuid ?? (byPath && (!a.id || !byPath.id || a.id === byPath.id) ? byPath : undefined)
    if (b && used.has(b)) continue
    if (b) used.add(b)
    const ambiguous = (a.id && (li.get(a.id)! > 1 || (ri.get(a.id) ?? 0) > 1)) || lp.get(a.path)! > 1 || (rp.get(a.path) ?? 0) > 1
    const opaqueFields = new Set([...(a.opaqueProperties ?? []), ...(b?.opaqueProperties ?? [])])
    const tagged = (value: UnrealAssetObject) => Object.fromEntries(Object.entries(value.properties).filter(([key]) => !opaqueFields.has(key)))
    const properties = b && a.decoded && b.decoded ? propertyChanges(tagged(a), tagged(b)) : []
    if (b && a.path !== b.path) properties.unshift({ path: 'Object path', before: a.path, after: b.path, beforePresent: true, afterPresent: true })
    if (b && a.classPath !== b.classPath) properties.unshift({ path: 'Object class', before: a.classPath, after: b.classPath, beforePresent: true, afterPresent: true })
    const opaqueChanged = !!b && (a.opaqueHash !== b.opaqueHash || [...opaqueFields].some(key => canonical(a.properties[key]) !== canonical(b.properties[key])))
    if (!b || properties.length || opaqueChanged || !a.decoded || !b.decoded || ambiguous) result.push({ key: a.path, kind: ambiguous || !a.decoded || b && !b.decoded ? 'unknown' : !b ? 'removed' : 'modified', left: a, right: b, properties, opaqueChanged, ambiguous: !!ambiguous })
  }
  for (const b of right) if (!used.has(b)) result.push({ key: '+' + b.path, kind: !b.decoded || (rp.get(b.path) ?? 0) > 1 || b.id && ((ri.get(b.id) ?? 0) > 1 || (li.get(b.id) ?? 0) > 1) ? 'unknown' : 'added', right: b, properties: [], opaqueChanged: false, ambiguous: (rp.get(b.path) ?? 0) > 1 || !!b.id && ((ri.get(b.id) ?? 0) > 1 || (li.get(b.id) ?? 0) > 1) })
  return result
}

export function displayValue(value: unknown, present = true): string {
  if (!present) return 'Not serialized / unresolved default'
  if (typeof value === 'string') return value || '(empty string)'
  return JSON.stringify(value, null, 2) ?? 'Unknown'
}
