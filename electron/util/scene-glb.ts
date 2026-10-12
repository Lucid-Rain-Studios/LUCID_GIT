import type { NativeSceneReview } from '../blueprintTypes'

/** Self-contained engine output only. Reject network URIs and unreasonable GPU allocations. */
export function inspectSceneGlb(bytes: Buffer): NonNullable<NativeSceneReview['stats']> {
  if (bytes.length > 64 * 1024 * 1024 || bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('Invalid or oversized glTF scene.')
  let json: Record<string, any> | undefined, binaryLength = 0, binaryOffset = 0
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('Truncated scene chunk.')
    const size = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4)
    if (size % 4 || offset + 8 + size > bytes.length) throw new Error('Invalid scene chunk bounds.')
    if (type === 0x4e4f534a) {
      if (json || offset !== 12 || size > 4 * 1024 * 1024) throw new Error('Invalid scene metadata chunk.')
      json = JSON.parse(bytes.subarray(offset + 8, offset + 8 + size).toString('utf8'))
    } else if (type === 0x004e4942) {
      if (binaryLength) throw new Error('Duplicate scene binary chunk.')
      binaryLength = size
      binaryOffset = offset + 8
    } else throw new Error('Unsupported scene chunk.')
    offset += 8 + size
  }
  if (!json || json.asset?.version !== '2.0') throw new Error('Unsupported scene schema.')
  const list = (name: string, max: number): any[] => {
    const value = json![name] ?? []
    if (!Array.isArray(value) || value.length > max || value.some(v => !v || typeof v !== 'object')) throw new Error('Invalid scene ' + name)
    return value
  }
  const nodes = list('nodes', 10000), meshes = list('meshes', 2048), materials = list('materials', 1024), skins = list('skins', 128), animations = list('animations', 128), accessors = list('accessors', 30000), views = list('bufferViews', 30000), images = list('images', 128)
  const buffers = list('buffers', 1)
  if (buffers.some(b => b.uri !== undefined || !Number.isInteger(b.byteLength) || b.byteLength < 0 || b.byteLength > binaryLength)) throw new Error('Scene buffers must be embedded.')
  const validIndex = (v: unknown, size: number) => Number.isInteger(v) && Number(v) >= 0 && Number(v) < size
  for (const view of views) if (view.buffer !== 0 || !Number.isInteger(view.byteLength) || view.byteLength < 0 || !Number.isInteger(view.byteOffset ?? 0) || (view.byteOffset ?? 0) < 0 || (view.byteOffset ?? 0) + view.byteLength > binaryLength) throw new Error('Invalid scene buffer view.')
  for (const accessor of accessors) if (!Number.isInteger(accessor.count) || accessor.count < 0 || accessor.count > 2_000_000 || !['SCALAR','VEC2','VEC3','VEC4','MAT2','MAT3','MAT4'].includes(accessor.type) || ![5120,5121,5122,5123,5125,5126].includes(accessor.componentType) || accessor.sparse || !validIndex(accessor.bufferView, views.length)) throw new Error('Unsupported scene accessor.')
  const componentSize: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
  const componentCount: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
  for (const accessor of accessors) {
    const view = views[accessor.bufferView], unit = componentSize[accessor.componentType], element = unit * componentCount[accessor.type]
    const offset = accessor.byteOffset ?? 0, stride = view.byteStride ?? element
    // Engine skin matrices use float MAT4; reject unsupported packed small-component matrices.
    if (accessor.type.startsWith('MAT') && unit !== 4 || !Number.isInteger(offset) || offset < 0 || offset % unit || !Number.isInteger(stride) || stride < element || stride > 252 || stride % unit || offset + (accessor.count ? (accessor.count - 1) * stride + element : 0) > view.byteLength) throw new Error('Invalid scene accessor bounds.')
  }
  for (const image of images) if (image.uri !== undefined || !validIndex(image.bufferView, views.length) || !['image/png','image/jpeg'].includes(image.mimeType)) throw new Error('Scene textures must be embedded PNG/JPEG images.')
  let pixels = 0
  for (const image of images) {
    const view = views[image.bufferView], start = binaryOffset + (view.byteOffset ?? 0), end = start + view.byteLength
    let width = 0, height = 0
    if (image.mimeType === 'image/png') {
      if (end - start < 24 || bytes.readUInt32BE(start) !== 0x89504e47 || bytes.readUInt32BE(start + 12) !== 0x49484452) throw new Error('Invalid scene PNG.')
      width = bytes.readUInt32BE(start + 16); height = bytes.readUInt32BE(start + 20)
    } else {
      if (end - start < 4 || bytes.readUInt16BE(start) !== 0xffd8) throw new Error('Invalid scene JPEG.')
      for (let p = start + 2; p + 8 < Math.min(end,start + 65536);) {
        if (bytes[p] !== 0xff) throw new Error('Invalid JPEG header.')
        const marker = bytes[p + 1], size = bytes.readUInt16BE(p + 2)
        if (size < 2 || p + 2 + size > end) throw new Error('Invalid JPEG bounds.')
        if ([0xc0,0xc1,0xc2].includes(marker)) { height = bytes.readUInt16BE(p + 5); width = bytes.readUInt16BE(p + 7); break }
        p += 2 + size
      }
    }
    pixels += width * height
    if (!width || !height || width > 4096 || height > 4096 || pixels > 32 * 1024 * 1024) throw new Error('Scene textures exceed the decoded pixel budget.')
  }
  let vertices = 0, triangles = 0
  const meshTriangles: number[] = []
  for (const mesh of meshes) {
    let meshCount = 0
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length > 256) throw new Error('Invalid scene sections.')
    for (const primitive of mesh.primitives) {
      if ((primitive.mode ?? 4) !== 4 || !validIndex(primitive.attributes?.POSITION, accessors.length)) throw new Error('Unsupported scene primitive.')
      const count = accessors[primitive.attributes.POSITION].count
      const sectionTriangles = (primitive.indices === undefined ? count : accessors[primitive.indices]?.count) / 3
      if (vertices + count > 500000 || !Number.isInteger(sectionTriangles) || triangles + sectionTriangles > 500000) throw new Error('Scene exceeds the 500000 vertex/triangle budget.')
      const position = accessors[primitive.attributes.POSITION]
      if (position.type !== 'VEC3' || position.componentType !== 5126) throw new Error('Unsupported scene positions.')
      for (const attribute of Object.values(primitive.attributes)) if (!validIndex(attribute, accessors.length) || accessors[Number(attribute)].count !== count) throw new Error('Invalid scene attribute.')
      if (primitive.material !== undefined && !validIndex(primitive.material, materials.length)) throw new Error('Invalid scene material.')
      const positionView = views[position.bufferView], positionStart = binaryOffset + (positionView.byteOffset ?? 0) + (position.byteOffset ?? 0), positionStride = positionView.byteStride ?? 12
      for (let i = 0; i < count; i++) for (let axis = 0; axis < 3; axis++) if (!Number.isFinite(bytes.readFloatLE(positionStart + i * positionStride + axis * 4))) throw new Error('Nonfinite scene position.')
      vertices += count
      if (primitive.indices !== undefined && !validIndex(primitive.indices, accessors.length)) throw new Error('Invalid scene triangle accessor.')
      if (primitive.indices !== undefined) {
        const indices = accessors[primitive.indices], view = views[indices.bufferView], unit = componentSize[indices.componentType]
        if (indices.type !== 'SCALAR' || ![5121,5123,5125].includes(indices.componentType)) throw new Error('Invalid scene indices.')
        const start = binaryOffset + (view.byteOffset ?? 0) + (indices.byteOffset ?? 0), stride = view.byteStride ?? unit
        for (let i = 0; i < indices.count; i++) if (bytes.readUIntLE(start + i * stride, unit) >= count) throw new Error('Scene index exceeds vertex count.')
      }
      triangles += sectionTriangles; meshCount += sectionTriangles
    }
    meshTriangles.push(meshCount)
  }
  if (vertices > 500000 || triangles > 500000 || !Number.isInteger(triangles)) throw new Error('Scene exceeds the 500000 vertex/triangle budget.')
  for (const skin of skins) if (!Array.isArray(skin.joints) || skin.joints.length > 1024 || skin.joints.some((i: unknown) => !validIndex(i, nodes.length))) throw new Error('Invalid scene skeleton.')
  let instancedTriangles = 0
  for (const node of nodes) {
    if (node.mesh !== undefined) { if (!validIndex(node.mesh, meshes.length)) throw new Error('Invalid scene mesh reference.'); instancedTriangles += meshTriangles[node.mesh] }
    if (node.skin !== undefined && !validIndex(node.skin, skins.length)) throw new Error('Invalid scene skin reference.')
  }
  if (instancedTriangles > 2_000_000) throw new Error('Scene exceeds the instanced triangle budget.')
  const visiting = new Set<number>(), visited = new Set<number>(), parents = new Set<number>()
  for (const node of nodes) for (const child of node.children ?? []) { if (parents.has(child)) throw new Error('Scene nodes must have unique parents.'); parents.add(child) }
  for (const scene of list('scenes', 32)) if (!Array.isArray(scene.nodes) || scene.nodes.length > 10000 || scene.nodes.some((index: unknown) => !validIndex(index,nodes.length))) throw new Error('Invalid scene roots.')
  const visit = (index: number, depth: number) => {
    if (!validIndex(index, nodes.length) || depth > 128 || visiting.has(index)) throw new Error('Invalid scene hierarchy.')
    if (visited.has(index)) return
    visiting.add(index)
    const node = nodes[index]
    for (const key of ['translation','rotation','scale','matrix']) if (node[key] && (!Array.isArray(node[key]) || node[key].some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n)))) throw new Error('Invalid scene transform.')
    if (node.children && (!Array.isArray(node.children) || node.children.length > 10000)) throw new Error('Invalid scene children.')
    for (const child of node.children ?? []) visit(child, depth + 1)
    visiting.delete(index); visited.add(index)
  }
  for (let i = 0; i < nodes.length; i++) visit(i, 0)
  return { nodes: nodes.length, meshes: meshes.length, materials: materials.length, textures: images.length, skins: skins.length, animations: animations.length, vertices, triangles }
}
