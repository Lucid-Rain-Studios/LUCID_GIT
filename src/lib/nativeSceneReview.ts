import type { NativeSceneReview } from '../../electron/blueprintTypes'

export type NativeActor = NonNullable<NativeSceneReview['actors']>[number]
export type NativeActorChange = {
  kind: 'unchanged' | 'moved' | 'renamed' | 'modified' | 'added' | 'removed' | 'unknown'
  before?: NativeActor
  after?: NativeActor
  delta?: [number, number, number]
  reason?: string
}

/** Compare captured outputs only; labels and filenames never establish actor identity. */
export function nativeActorChanges(scenes: Array<NativeSceneReview | undefined>, paths?: readonly string[]) {
  const [left, right] = scenes
  const comparable = left?.status === 'ready' && right?.status === 'ready' && Array.isArray(left.actors) && Array.isArray(right.actors) && left.engineVersion === right.engineVersion
  // A complete dependency closure does not prove that Unreal loaded every actor.
  const presenceComplete = comparable && left.actorInventoryComplete === true && right.actorInventoryComplete === true && !!paths?.[0] && paths[0] === paths[1]
  const index = (actors: NativeActor[] = []) => {
    const result = new Map<string, NativeActor[]>()
    for (const actor of actors) if (actor.saved === true) {
      const matches = result.get(actor.path)
      if (matches) matches.push(actor)
      else result.set(actor.path, [actor])
    }
    return result
  }
  const before = index(left?.actors), after = index(right?.actors), changes = new Map<string, NativeActorChange>()
  const valid = (actor: NativeActor) => actor.path.startsWith('/Game/') && actor.path.includes(':PersistentLevel.') && actor.location.length === 3 && actor.location.every(Number.isFinite)
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path) ?? [], b = after.get(path) ?? []
    if (!comparable || a.length > 1 || b.length > 1 || [...a,...b].some(actor => !valid(actor))) {
      changes.set(path, { kind: 'unknown', reason: !comparable ? 'Both captures with the same engine version are required.' : 'Actor identity or location is ambiguous.' })
    } else if (!a.length || !b.length) {
      changes.set(path, { kind: presenceComplete ? a.length ? 'removed' : 'added' : 'unknown', before: a[0], after: b[0], reason: presenceComplete ? undefined : 'Presence is unconfirmed: actor inventory completeness or package identity is unverified.' })
    } else {
      const delta = b[0].location.map((value,i) => value - a[0].location[i]) as [number, number, number]
      if (!delta.every(Number.isFinite)) { changes.set(path, {kind:'unknown',reason:'Location comparison exceeds numeric range.'}); continue }
      const moved = delta.some(value => Math.abs(value) > .0001), renamed = a[0].name !== b[0].name
      changes.set(path, { kind: moved && renamed ? 'modified' : moved ? 'moved' : renamed ? 'renamed' : 'unchanged', before: a[0], after: b[0], delta: moved ? delta : undefined })
    }
  }
  return { changes, comparable, presenceComplete }
}
