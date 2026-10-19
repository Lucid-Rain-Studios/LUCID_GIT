import type { BlueprintSide } from '../blueprintTypes'
import { savedVector } from './saved-vector'

export type SavedSceneAttachment = {
  path: string; parent: string; socket: string
  location?: [number,number,number]; rotation?: [number,number,number]; scale?: [number,number,number]
}

/** Only explicit fields from the captured package; no inferred attachment defaults. */
export function savedSceneAttachments(side: BlueprintSide, limit = 10000) {
  const packageName = '/Game/' + side.path.slice(side.path.indexOf('Content/') + 8).replace(/\.(umap|uasset)$/i,'')
  const canonical = (value: string) => (value.startsWith('/Game/') ? value : packageName + '.' + value).replace('.PersistentLevel.',':PersistentLevel.')
  const components: SavedSceneAttachment[] = []
  for (const object of side.document?.assetReview?.objects ?? []) {
    const p = object.properties ?? {}
    if (typeof p.AttachParent !== 'string' || p.AttachParent === 'None' || typeof p.AttachSocketName !== 'string') continue
    const location = savedVector(p.RelativeLocation,'RelativeLocation',['X','Y','Z']), rotation = savedVector(p.RelativeRotation,'RelativeRotation',['Pitch','Yaw','Roll']), scale = savedVector(p.RelativeScale3D,'RelativeScale3D',['X','Y','Z'])
    if (!location && !rotation && !scale) continue
    if (components.length >= limit) return { components, complete:false }
    components.push({path:canonical(object.serializedPath ?? object.path),parent:canonical(p.AttachParent),socket:p.AttachSocketName,location,rotation,scale})
  }
  return { components, complete:true }
}
