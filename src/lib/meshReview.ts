import type { NativeMeshGeometry, UnrealAssetObject } from '../../electron/blueprintTypes'

export type MeshCamera = { yaw: number; pitch: number; zoom: number; wireframe: boolean }
export const initialMeshCamera: MeshCamera = { yaw: -.7, pitch: .5, zoom: 1, wireframe: false }

export type Vertex = [number, number, number]
export interface CollisionHull { object: UnrealAssetObject; index: number; kind: 'convex' | 'box' | 'sphere' | 'capsule' | 'source LOD'; vertices: Vertex[]; indices: number[] }

/** Engine output has already passed the bounded main-process validator. */
export function sourceMeshHulls(objects: UnrealAssetObject[], geometry: NativeMeshGeometry | undefined, index: number) {
  const roots = objects.filter(object => ['/Script/Engine.StaticMesh', '/Script/Engine.SkeletalMesh'].includes(object.classPath))
  const lod = geometry?.status === 'ready' ? geometry.lods.find(lod => lod.index === index) : undefined
  const hulls: CollisionHull[] = roots.length === 1 && lod?.vertices.length && lod.indices.length ? [{ object: roots[0], index, kind: 'source LOD', vertices: lod.vertices, indices: lod.indices }] : []
  const diagnostics = geometry?.status === 'unavailable' ? [geometry.reason ?? 'Native source geometry unavailable.'] : !geometry ? ['Native source geometry has not been requested.'] : [...geometry.diagnostics, ...(roots.length !== 1 ? ['The captured mesh root is ambiguous.'] : []), ...(lod?.reason ? [lod.reason] : !lod ? ['This source LOD is unavailable in this revision.'] : [])]
  return { hulls, vertices: hulls.length ? lod!.vertices.length : 0, triangles: hulls.length ? lod!.indices.length / 3 : 0, omitted: hulls.length ? 0 : 1, diagnostics }
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const number = (value: unknown) => typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN
function vector(value: unknown, name: string, fields = ['X', 'Y', 'Z']) {
  const root = record(value), data = record(root[name] ?? value)
  const values = fields.map(field => number(data[field]))
  return values.every(Number.isFinite) ? values : null
}

/** Unreal degree rotator: negative roll X, negative pitch Y, positive yaw Z. */
export function rotate(vertex: Vertex, rotation: number[]): Vertex {
  const [pitch,yaw,roll]=rotation.map(value=>(value%360)*Math.PI/180),[x,y,z]=vertex
  const ry=Math.cos(roll)*y+Math.sin(roll)*z,rz=-Math.sin(roll)*y+Math.cos(roll)*z
  const px=Math.cos(pitch)*x-Math.sin(pitch)*rz,pz=Math.sin(pitch)*x+Math.cos(pitch)*rz
  return [Math.cos(yaw)*px-Math.sin(yaw)*ry,Math.sin(yaw)*px+Math.cos(yaw)*ry,pz]
}

function quaternion(value: unknown, name: string) {
  const components=vector(value,name,['X','Y','Z','W'])
  const norm=components?Math.hypot(...components):0
  return components && norm>=.999 && norm<=1.001 ? components.map(value=>value/norm) : null
}
function rotateQuaternion(vertex: Vertex, rotation: number[]): Vertex {
  const [x,y,z]=vertex,[qx,qy,qz,qw]=rotation
  const tx=2*(qy*z-qz*y),ty=2*(qz*x-qx*z),tz=2*(qx*y-qy*x)
  return [x+qw*tx+qy*tz-qz*ty,y+qw*ty+qz*tx-qx*tz,z+qw*tz+qx*ty-qy*tx]
}
/** Never choose between competing saved rotation profiles or substitute absent defaults. */
function savedRotation(shape: Record<string,unknown>) {
  if ('Rotation' in shape && 'Orientation' in shape) return null
  if ('Orientation' in shape) {
    const orientation=quaternion(shape.Orientation,'Orientation')
    return orientation ? (vertex: Vertex)=>rotateQuaternion(vertex,orientation) : null
  }
  const rotation=vector(shape.Rotation,'Rotation',['Pitch','Yaw','Roll'])
  return rotation ? (vertex: Vertex)=>rotate(vertex,rotation) : null
}

/** Explicit saved collision only. Primitive faces are preview tessellation, never render-mesh counts. */
export function collisionHulls(objects: UnrealAssetObject[], boneLocal = false) {
  const hulls: CollisionHull[] = [], diagnostics: string[] = []
  let verticesUsed = 0, trianglesUsed = 0, omitted = 0
  for (const object of objects) {
    if (!/\.(BodySetup|SkeletalBodySetup)$/.test(object.classPath)) continue
    if (!boneLocal && (object.classPath.endsWith('.SkeletalBodySetup') || 'BoneName' in object.properties)) continue
    const aggregate = record(object.properties.AggGeom)
    for (const key of ['TaperedCapsuleElems', 'LevelSetElems', 'SkinnedLevelSetElems']) {
      if (Array.isArray(aggregate[key]) && aggregate[key].length) {
        omitted += aggregate[key].length
        if (diagnostics.length < 16) diagnostics.push(`${object.name}: ${aggregate[key].length} saved ${key} collision shapes are not decoded.`)
      }
    }
    for (const kind of ['sphere','capsule'] as const) {
      const shapes=aggregate[kind==='sphere'?'SphereElems':'SphylElems']
      if (!Array.isArray(shapes)) continue
      for(let index=0;index<shapes.length;index++) {
        const shape=record(shapes[index]),center=vector(shape.Center,'Center'),radius=number(shape.Radius)
        const length=kind==='capsule'?number(shape.Length):0,rotation=kind==='capsule'?savedRotation(shape):(vertex: Vertex)=>vertex
        if(!center || !rotation || !Number.isFinite(radius) || radius<=0 || !Number.isFinite(length) || length<0){
          omitted++;if(diagnostics.length<16)diagnostics.push(`${object.name} ${kind} ${index+1}: incomplete or invalid saved center/radius${kind==='capsule'?'/rotation/length':''}.`);continue
        }
        // Capsule Length excludes both hemispheres; zero length uses sphere topology.
        const bands=length>0?[1,2,3,4,4,5,6,7]:[1,2,3,4,5,6,7],vertexCount=2+bands.length*16,triangleCount=bands.length*32
        if(hulls.length>=64 || verticesUsed+vertexCount>20000 || trianglesUsed+triangleCount>10000){omitted++;continue}
        const local:Vertex[]=[[0,0,length/2+radius]],indices:number[]=[]
        for(const [ring,band] of bands.entries())for(let segment=0;segment<16;segment++){
          const latitude=band*Math.PI/8,longitude=segment*Math.PI/8,offset=length>0?(ring<4?length/2:-length/2):0
          local.push([radius*Math.sin(latitude)*Math.cos(longitude),radius*Math.sin(latitude)*Math.sin(longitude),radius*Math.cos(latitude)+offset])
        }
        local.push([0,0,-length/2-radius])
        const south=vertexCount-1,last=1+(bands.length-1)*16
        for(let segment=0;segment<16;segment++){
          const next=(segment+1)%16
          indices.push(0,1+segment,1+next,south,last+next,last+segment)
          for(let ring=0;ring<bands.length-1;ring++){
            const a=1+ring*16+segment,b=1+ring*16+next
            indices.push(a,a+16,b,b,a+16,b+16)
          }
        }
        const vertices=local.map(vertex=>rotation(vertex).map((value,axis)=>value+center[axis]) as Vertex)
        if(vertices.some(vertex=>vertex.some(value=>!Number.isFinite(value)))){omitted++;continue}
        hulls.push({object,index,kind,vertices,indices});verticesUsed+=vertexCount;trianglesUsed+=triangleCount
      }
    }
    const boxes = aggregate.BoxElems
    if (Array.isArray(boxes)) for (let index = 0; index < boxes.length; index++) {
      if (hulls.length >= 64 || verticesUsed + 8 > 20000 || trianglesUsed + 12 > 10000) { omitted++; continue }
      const box = record(boxes[index]), center = vector(box.Center, 'Center')
      const rotation = savedRotation(box)
      const dimensions = ['X', 'Y', 'Z'].map(axis => number(box[axis]))
      if (!center || !rotation || dimensions.some(value => !Number.isFinite(value) || value < 0) || dimensions.every(value => value === 0)) {
        omitted++; if (diagnostics.length < 16) diagnostics.push(`${object.name} box ${index + 1}: incomplete or invalid saved center/rotation/dimensions.`); continue
      }
      const vertices: Vertex[] = []
      for (const zSign of [-1, 1]) for (const ySign of [-1, 1]) for (const xSign of [-1, 1]) {
        const local:Vertex=[xSign*dimensions[0]/2,ySign*dimensions[1]/2,zSign*dimensions[2]/2]
        vertices.push(rotation(local).map((value,axis)=>value+center[axis]) as Vertex)
      }
      if (vertices.some(vertex => vertex.some(value => !Number.isFinite(value)))) { omitted++; continue }
      hulls.push({ object, index, kind: 'box', vertices, indices: [0,2,3,0,3,1,4,5,7,4,7,6,0,1,5,0,5,4,2,6,7,2,7,3,0,4,6,0,6,2,1,3,7,1,7,5] })
      verticesUsed += 8; trianglesUsed += 12
    }
    const convex = aggregate.ConvexElems
    if (!Array.isArray(convex)) continue
    for (let index = 0; index < convex.length; index++) {
      const hull = record(convex[index]), transform = record(hull.Transform)
      if (hulls.length >= 64 || Array.isArray(hull.VertexData) && verticesUsed + hull.VertexData.length > 20000 || Array.isArray(hull.IndexData) && trianglesUsed + hull.IndexData.length / 3 > 10000) { omitted++; continue }
      const rotation = quaternion(transform.Rotation, 'Rotation')
      const translation = vector(transform.Translation, 'Translation'), scale = vector(transform.Scale3D, 'Scale3D')
      const vertices = Array.isArray(hull.VertexData) ? hull.VertexData.map(vertex => vector(vertex, 'VertexData')) : []
      const indices = Array.isArray(hull.IndexData) ? hull.IndexData.map(number) : []
      if (!rotation || !translation || !scale || vertices.length < 4 || vertices.some(vertex => !vertex) || !indices.length || indices.length % 3 || indices.some(value => !Number.isInteger(value) || value < 0 || value >= vertices.length)) {
        omitted++; if (diagnostics.length < 16) diagnostics.push(`${object.name} hull ${index + 1}: incomplete or invalid saved geometry/transform.`); continue
      }
      if (hulls.length >= 64 || verticesUsed + vertices.length > 20000 || trianglesUsed + indices.length / 3 > 10000) { omitted++; continue }
      const transformed = vertices.map(vertex => {
        const scaled=vertex!.map((value,axis)=>value*scale[axis]) as Vertex
        return rotateQuaternion(scaled,rotation).map((value,axis)=>value+translation[axis]) as Vertex
      })
      if (transformed.some(vertex => vertex.some(value => !Number.isFinite(value)))) { omitted++; continue }
      verticesUsed += vertices.length; trianglesUsed += indices.length / 3
      hulls.push({ object, index, kind: 'convex', vertices: transformed, indices })
    }
  }
  return { hulls, omitted, diagnostics: diagnostics.slice(0, 16), vertices: verticesUsed, triangles: trianglesUsed }
}

export function collisionBounds(hulls: CollisionHull[]) {
  const min: Vertex = [Infinity, Infinity, Infinity], max: Vertex = [-Infinity, -Infinity, -Infinity]
  for (const hull of hulls) for (const vertex of hull.vertices) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], vertex[axis]); max[axis] = Math.max(max[axis], vertex[axis]) }
  const center = min.map((value, axis) => value / 2 + max[axis] / 2) as Vertex
  const radius = Math.hypot(...max.map((value, axis) => value / 2 - min[axis] / 2))
  return hulls.length ? { min, max, center, radius: Math.min(Number.MAX_VALUE, Math.max(.01, radius)) } : { min: [0, 0, 0] as Vertex, max: [0, 0, 0] as Vertex, center: [0, 0, 0] as Vertex, radius: 1 }
}
