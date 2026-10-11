import type { UnrealAssetObject } from '../../electron/blueprintTypes'
import { savedObjectIndex } from './assetReferences'

export function actorName(object: UnrealAssetObject) {
  const label = object.properties.ActorLabel
  return typeof label === 'string' && label ? label : object.name
}

/** Actor membership is saved Level.Actors or verified external-package ownership.
 * Owned exports follow explicit outer references; missing/cyclic owners remain unassigned. */
export function mapInventory(objects: UnrealAssetObject[]) {
  const resolve = savedObjectIndex(objects), actors = new Set<UnrealAssetObject>()
  let unresolvedActorReferences = 0
  for (const level of objects) if (level.classPath === '/Script/Engine.Level' && Array.isArray(level.properties.Actors)) {
    for (const path of level.properties.Actors) if (typeof path === 'string') { const actor = resolve(level, path); if (actor) actors.add(actor); else if (path !== 'None') unresolvedActorReferences++ }
  }
  for (const object of objects) if (object.sourcePackage && object.id && object.outer.endsWith('.PersistentLevel') && object.properties.ActorGuid) actors.add(object)
  const groups = new Map([...actors].map(object => [object, { object, name: actorName(object), owned: [] as UnrealAssetObject[], root: typeof object.properties.RootComponent === 'string' ? resolve(object, object.properties.RootComponent) : undefined }]))
  const unassigned: UnrealAssetObject[] = []
  for (const object of objects) {
    if (actors.has(object)) continue
    let cursor: UnrealAssetObject | undefined = object, owner: UnrealAssetObject | undefined
    const visited = new Set<UnrealAssetObject>()
    for (let depth = 0; cursor && depth < 32 && !visited.has(cursor); depth++) {
      visited.add(cursor)
      cursor = resolve(cursor, cursor.outer)
      if (cursor && actors.has(cursor)) { owner = cursor; break }
    }
    if (owner) groups.get(owner)!.owned.push(object)
    else unassigned.push(object)
  }
  const actorGroups = [...groups.values()]
  const roots = actorGroups.flatMap(actor => actor.root && actor.owned.includes(actor.root) ? [actor.root] : [])
  return { actors: actorGroups, roots, unassigned, unresolvedActorReferences }
}
