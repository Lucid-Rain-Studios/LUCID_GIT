import { useMemo } from 'react'
import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import { initialMeshCamera, type MeshCamera } from '../../lib/meshReview'
import { BlueprintChoice } from './BlueprintChoice'
import { MeshPreview } from './MeshPreview'

/** One captured body at a time: no implicit bone transforms or skeleton assembly. */
export function PhysicsAssetPreview({ objects, allObjects, camera, onCamera, selected, onSelect, labels, single }: {
  objects: UnrealAssetObject[]; allObjects: UnrealAssetObject[][]; camera: MeshCamera; onCamera(camera: MeshCamera): void
  selected: string; onSelect(object: UnrealAssetObject): void; labels: { left: string; right: string }; single: boolean
}) {
  const bodies = useMemo(() => [...new Map(allObjects.flatMap(objects => objects.filter(object => /\.(BodySetup|SkeletalBodySetup)$/.test(object.classPath))).map(object => [object.path, object])).values()], [allObjects])
  const body = bodies.find(object => object.path === selected) ?? bodies.find(body => objects.includes(body)) ?? bodies[0]
  const sides = useMemo(() => allObjects.map(objects => {
    const matches = objects.filter(object => object.path === body?.path && /\.(BodySetup|SkeletalBodySetup)$/.test(object.classPath))
    return matches.length === 1 ? matches : []
  }), [allObjects, body?.path])
  const choices = bodies.slice(0, 1000)
  if (body && !choices.includes(body)) choices[999] = body
  const current = sides[allObjects.indexOf(objects)] ?? []
  return <section aria-label="Saved physics bodies">
    <p className="uar-caption">Inspect saved collision for one body. Constraints and simulation settings remain saved fields in Contents; this preview does not simulate physics.</p>
    {body ? <>
      <BlueprintChoice id="uar-physics-body" label="Physics body" value={body.path} items={choices.map(object => ({ value: object.path, name: object.name, detail: typeof object.properties.BoneName === 'string' ? object.properties.BoneName : 'Bone unknown', title: object.path }))} onChange={path => {
        const target = bodies.find(object => object.path === path)
        if (target) { onSelect(target); onCamera(initialMeshCamera) }
      }}/>
      {bodies.length > 1000 && <p className="uar-warning">Body selector limited to 1,000 entries. All objects retains the remaining saved inventory.</p>}
      <MeshPreview objects={current} allObjects={sides} camera={camera} onCamera={onCamera} selected={selected} onSelect={onSelect} labels={labels} single={single} boneLocal/>
    </> : <p className="uar-empty">No saved body setup is available in this revision.</p>}
  </section>
}
