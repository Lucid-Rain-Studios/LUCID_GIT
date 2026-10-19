import * as THREE from 'three'
import type { NativeSceneReview } from '../../electron/blueprintTypes'

type Actor = NonNullable<NativeSceneReview['actors']>[number]

/** Keep every captured instance at its first sampled pose between clip selections. */
export function primeNativeAnimationPose(group:THREE.Object3D,clips:readonly THREE.AnimationClip[],profiles:ReadonlyArray<NonNullable<NativeSceneReview['playback']>[number]|undefined>=[]) {
  if(!clips.length)return
  const mixer=new THREE.AnimationMixer(group)
  clips.forEach((clip,index)=>{const action=mixer.clipAction(clip).play();action.time=profiles[index]?.position ?? 0})
  mixer.update(0)
  const poses:Array<{object:THREE.Object3D;position:THREE.Vector3;rotation:THREE.Quaternion;scale:THREE.Vector3}>=[]
  group.traverse(object=>poses.push({object,position:object.position.clone(),rotation:object.quaternion.clone(),scale:object.scale.clone()}))
  mixer.stopAllAction();mixer.uncacheRoot(group)
  for(const pose of poses){pose.object.position.copy(pose.position);pose.object.quaternion.copy(pose.rotation);pose.object.scale.copy(pose.scale)}
  group.updateMatrixWorld(true)
}

export function nativeClipPlayback(clips:readonly THREE.AnimationClip[],group:THREE.Object3D,actors:readonly Actor[],profiles:NonNullable<NativeSceneReview['playback']>=[]) {
  return nativeClipOwners(clips,group,actors).map((owner,index)=>{
    const matches=profiles.filter(profile=>owner && profile.actor===(owner.renderName ?? owner.name) && (clips[index].name===profile.clip || clips[index].name.startsWith(profile.clip+'_')))
    return matches.length===1 ? matches[0] : undefined
  })
}

/** Resolve clip targets once per immutable payload; duplicate names remain selectable. */
export function nativeClipOwners(clips: readonly THREE.AnimationClip[], group: THREE.Object3D, actors: readonly Actor[]) {
  const nodes = new Map<string,THREE.Object3D | null>()
  group.traverse(object => { for (const key of new Set([object.name,object.uuid])) if (key) nodes.set(key,nodes.has(key) ? null : object) })
  return clips.map(clip => {
    const owners = new Set<Actor>()
    let complete = clip.tracks.length > 0
    for (const track of clip.tracks) {
      try {
        const object = nodes.get(THREE.PropertyBinding.parseTrackName(track.name).nodeName)
        const actor = object && nativeActorForObject(object,actors)
        if (actor) owners.add(actor)
        else complete = false
      } catch { complete = false }
    }
    return complete && owners.size === 1 ? [...owners][0] : undefined
  })
}

export function nativeClipLabels(clips: readonly THREE.AnimationClip[], group: THREE.Object3D, actors: readonly Actor[]) {
  const labels = nativeClipOwners(clips,group,actors).map((owner,index) => {
    const name=clips[index].name || 'Animation'
    return owner ? name+' · '+owner.name+(owner.instanceLabel ? ' · '+owner.instanceLabel : '') : name
  })
  const counts = new Map<string,number>()
  for (const label of labels) counts.set(label,(counts.get(label) ?? 0)+1)
  return labels.map((label,index) => label + ((counts.get(label) ?? 0)>1 ? ' · clip '+(index+1) : ''))
}

/** Unreal glTF skins can be separate scene roots; joint ancestry owns the mesh. */
export function nativeActorForObject(object: THREE.Object3D, actors: readonly Actor[]): Actor | undefined {
  const ancestor = (node: THREE.Object3D | null) => {
    for (; node; node = node.parent) {
      if (node instanceof THREE.Bone) continue
      const name = node.userData.name ?? node.name
      if (typeof name !== 'string') continue
      const matches = actors.filter(actor => (actor.renderName ?? actor.name) === name || actor.renderName && name.startsWith(actor.renderName + '__part_') || !actor.renderName && actor.path.split('.').pop() === name)
      if (matches.length > 1) return null
      if (matches.length === 1) return matches[0]
    }
    return undefined
  }
  if (object instanceof THREE.SkinnedMesh) {
    const owners = new Set<Actor>()
    let unresolved = false
    for (const bone of object.skeleton.bones) {
      const owner = ancestor(bone)
      if (owner === null) return
      if (owner) owners.add(owner)
      else unresolved = true
    }
    if (owners.size > 1) return
    if (owners.size === 1) return unresolved ? undefined : [...owners][0]
  }
  return ancestor(object) ?? undefined
}
