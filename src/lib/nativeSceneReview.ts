import type { NativeSceneReview } from '../../electron/blueprintTypes'

export type NativeActor = NonNullable<NativeSceneReview['actors']>[number]
export type NativeActorChange = {
  kind: 'unchanged' | 'moved' | 'rotated' | 'scaled' | 'renamed' | 'repathed' | 'modified' | 'replaced' | 'added' | 'removed' | 'unknown'
  before?: NativeActor
  after?: NativeActor
  delta?: [number, number, number]
  reason?: string
  identity?: 'guid' | 'path'
  pathChanged?: boolean
  scaleChanged?: boolean
  rotationDegrees?: number
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
  const tuple = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every(n=>typeof n === 'number' && Number.isFinite(n))
  const valid = (actor: NativeActor) => actor.path.startsWith('/Game/') && actor.path.includes(':PersistentLevel.') && (actor.instancePath === undefined || /^[a-f0-9]{32}(\/[a-f0-9]{32}){0,31}$/.test(actor.instancePath) && !!actor.sourcePath?.startsWith('/Game/') && actor.sourcePath.includes(':PersistentLevel.')) && tuple(actor.location,3) && (actor.scale === undefined || tuple(actor.scale,3)) && (actor.rotation === undefined || tuple(actor.rotation,4) && Math.abs(actor.rotation.reduce((sum,n)=>sum+n*n,0)-1) <= .001)
  const guid = (actor: NativeActor) => actor.guid && /^[a-f0-9]{32}$/.test(actor.guid) && actor.guid !== '0'.repeat(32) ? (actor.instancePath ?? '') + ':' + actor.guid : undefined
  const guids = (actors: NativeActor[] = []) => {
    const result = new Map<string, NativeActor[]>()
    for (const actor of actors) if (actor.saved === true && guid(actor)) {
      const key = guid(actor)!, matches = result.get(key)
      if (matches) matches.push(actor); else result.set(key,[actor])
    }
    return result
  }
  const beforeGuids = guids(left?.actors), afterGuids = guids(right?.actors)
  const compare = (a: NativeActor, b: NativeActor, identity: 'guid' | 'path'): NativeActorChange => {
    const delta = b.location.map((value,i) => value - a.location[i]) as [number, number, number]
    if (!delta.every(Number.isFinite)) return {kind:'unknown',reason:'Location comparison exceeds numeric range.'}
    const moved = delta.some(value => Math.abs(value) > .0001), renamed = a.name !== b.name, pathChanged = a.path !== b.path
    const scaleDelta = a.scale && b.scale ? b.scale.map((n,i)=>n-a.scale![i]) : undefined
    if (scaleDelta && !scaleDelta.every(Number.isFinite)) return {kind:'unknown',reason:'Scale comparison exceeds numeric range.'}
    const scaleChanged = scaleDelta?.some(n=>Math.abs(n) > .0001) ?? false
    let angle = 0
    if (a.rotation && b.rotation) {
      const dot = a.rotation.reduce((sum,n,i)=>sum+n*b.rotation![i],0), norm = Math.hypot(...a.rotation)*Math.hypot(...b.rotation)
      angle = 2*Math.acos(Math.min(1,Math.abs(dot/norm)))*180/Math.PI
    }
    const rotated = angle > .0001
    return {kind: Number(moved) + Number(renamed) + Number(pathChanged) + Number(scaleChanged) + Number(rotated) > 1 ? 'modified' : moved ? 'moved' : rotated ? 'rotated' : scaleChanged ? 'scaled' : renamed ? 'renamed' : pathChanged ? 'repathed' : 'unchanged', before:a, after:b, delta:moved ? delta : undefined, identity, pathChanged, scaleChanged, rotationDegrees:rotated ? angle : undefined}
  }
  // Publish the same pair under both paths so side-local selection/inspection
  // remains tied to the actual saved export on that side.
  if (comparable) for (const [key, a] of beforeGuids) {
    const b = afterGuids.get(key)
    if (a.length !== 1 || b?.length !== 1 || before.get(a[0].path)?.length !== 1 || after.get(b[0].path)?.length !== 1 || !valid(a[0]) || !valid(b[0])) continue
    if (a[0].path !== b[0].path && (before.has(b[0].path) || after.has(a[0].path))) {
      const change: NativeActorChange = {kind:'unknown',reason:'Actor paths are reused by different identities across revisions.'}
      changes.set(a[0].path,change); changes.set(b[0].path,change); continue
    }
    const change = compare(a[0],b[0],'guid')
    changes.set(a[0].path,change); changes.set(b[0].path,change)
  }
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (changes.has(path)) continue
    const a = before.get(path) ?? [], b = after.get(path) ?? []
    const ambiguousGuid = [...a,...b].some(actor => actor.guid !== undefined && (!guid(actor) || (beforeGuids.get(guid(actor)!)?.length ?? 0) > 1 || (afterGuids.get(guid(actor)!)?.length ?? 0) > 1 || [...(beforeGuids.get(guid(actor)!) ?? []),...(afterGuids.get(guid(actor)!) ?? [])].some(candidate => !valid(candidate))))
    if (!comparable || a.length > 1 || b.length > 1 || ambiguousGuid || [...a,...b].some(actor => !valid(actor))) {
      changes.set(path, { kind: 'unknown', reason: !comparable ? 'Both captures with the same engine version are required.' : 'Actor identity or location is ambiguous.' })
    } else if (!a.length || !b.length) {
      changes.set(path, { kind: presenceComplete ? a.length ? 'removed' : 'added' : 'unknown', before: a[0], after: b[0], reason: presenceComplete ? undefined : 'Presence is unconfirmed: actor inventory completeness or package identity is unverified.' })
    } else if (guid(a[0]) && guid(b[0]) && guid(a[0]) !== guid(b[0])) {
      changes.set(path,{kind:presenceComplete ? 'replaced' : 'unknown',before:a[0],after:b[0],reason:'Different saved actor GUIDs occupy this object path.'})
    } else changes.set(path,compare(a[0],b[0],'path'))
  }
  return { changes, comparable, presenceComplete }
}
