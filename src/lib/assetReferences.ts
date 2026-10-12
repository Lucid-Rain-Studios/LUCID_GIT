import type { UnrealAssetObject } from '../../electron/blueprintTypes'

/** Match engine actor paths to captured exports, never actor labels or bare names. */
export function nativeSceneObject(actorPath: string, objects: UnrealAssetObject[], reviewedPackage: string) {
  if (!actorPath.startsWith('/Game/') || !actorPath.includes(':PersistentLevel.')) return undefined
  const target = actorPath.replace(':', '.')
  const matches = objects.filter(object => {
    const serialized = object.serializedPath ?? object.path
    if (serialized.startsWith('/Game/')) return serialized.replace(':', '.') === target
    const file = object.sourcePackage ?? reviewedPackage
    if (!file.startsWith('Content/')) return false
    return '/Game/' + file.slice(8).replace(/\.(uasset|umap)$/i, '') + '.' + serialized === target
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function savedObjectIndex(objects: UnrealAssetObject[]) {
  const index = new Map<string, UnrealAssetObject[]>()
  for (const object of objects) {
    const key = (object.sourcePackage ?? '') + '\0' + (object.serializedPath ?? object.path)
    index.set(key, [...(index.get(key) ?? []), object])
  }
  return (source: UnrealAssetObject, target: string) => {
    const matches = index.get((source.sourcePackage ?? '') + '\0' + target) ?? []
    return matches.length === 1 ? matches[0] : undefined
  }
}

const assetClasses = new Set(['World', 'StateTree', 'StaticMesh', 'SkeletalMesh', 'Skeleton', 'PhysicsAsset', 'AnimBlueprint', 'Blueprint', 'WidgetBlueprint', 'AnimSequence', 'AnimMontage', 'BlendSpace', 'BlendSpace1D', 'AimOffsetBlendSpace', 'AimOffsetBlendSpace1D', 'Material', 'MaterialInstance', 'MaterialInstanceConstant', 'Texture2D', 'TextureCube'])

/** Conventional root Content only. Do not guess plugin/custom mounts or subobject ownership. */
export function referencePackage(reference: NonNullable<UnrealAssetObject['references']>[number], reviewedPackage: string) {
  if (!reviewedPackage.startsWith('Content/') || !reference.target.startsWith('/Game/')) return undefined
  const className = reference.className.split('.').pop() ?? ''
  if (!assetClasses.has(className)) return undefined
  const parts = reference.target.slice(6).split('.')
  if (parts.length !== 2 || !parts[1] || parts[1].includes(':')) return undefined
  const segments = parts[0].split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\:*?"<>|]/.test(segment) || [...segment].some(character => character.charCodeAt(0) < 32))) return undefined
  return 'Content/' + parts[0] + (className === 'World' ? '.umap' : '.uasset')
}
