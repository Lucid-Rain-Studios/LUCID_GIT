import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ueHeadlessService } from './UEHeadlessService'
import { NativeMeshWorker } from './NativeMeshWorker'
import type { BlueprintDocument, NativeMeshGeometry } from '../blueprintTypes'

const PROVIDER = 'unreal-source-mesh-v1' as const
const MAX_INPUT_BYTES = 64 * 1024 * 1024
// Only generated script/configuration and captured package bytes enter this project.
// No repository project, plugins, Python startup scripts or mutable dependencies are loaded.
export const MESH_SCRIPT = 'import unreal, json, os\ndef extract(base):\n' + String.raw`
with open(os.path.join(base, 'request.json'), encoding='utf-8') as stream:
    request = json.load(stream)
mesh = unreal.load_asset(request['asset'])
skeletal = request['class'] == '/Script/Engine.SkeletalMesh'
if not isinstance(mesh, unreal.SkeletalMesh if skeletal else unreal.StaticMesh):
    raise RuntimeError('Captured asset did not load with the expected mesh class.')
api = unreal.GeometryScript_AssetUtils
query = unreal.GeometryScript_MeshQueries
lists = unreal.GeometryScript_List
count = unreal.SkeletalMeshEditorSubsystem.get_lod_count(mesh) if skeletal else api.get_num_static_mesh_lods_of_type(mesh, unreal.GeometryScriptLODType.SOURCE_MODEL)
result = {'status': 'ready', 'provider': 'unreal-source-mesh-v1', 'engineVersion': unreal.SystemLibrary.get_engine_version(),
          'totalLods': count, 'lods': [], 'diagnostics': ['Isolated captured package only. Materials, textures and repository dependencies are not loaded.', 'Source-model geometry, not generated render LODs, Nanite, skinning or playback.']}
vertices_left, triangles_left = 20000, 10000
for index in range(min(count, 8)):
    dynamic = unreal.DynamicMesh()
    lod = unreal.GeometryScriptMeshReadLOD(lod_type=unreal.GeometryScriptLODType.SOURCE_MODEL, lod_index=index)
    copy = api.copy_mesh_from_skeletal_mesh if skeletal else api.copy_mesh_from_static_mesh
    dynamic, outcome = copy(mesh, dynamic, unreal.GeometryScriptCopyMeshFromAssetOptions(), lod)
    if outcome != unreal.GeometryScriptOutcomePins.SUCCESS:
        result['lods'].append({'index': index, 'vertexCount': 0, 'triangleCount': 0, 'vertices': [], 'indices': [], 'reason': 'No readable source model for this LOD.'})
        continue
    nv, nt = query.get_vertex_count(dynamic), dynamic.get_triangle_count()
    item = {'index': index, 'vertexCount': nv, 'triangleCount': nt, 'vertices': [], 'indices': []}
    if nv > vertices_left or nt > triangles_left:
        item['reason'] = 'Source geometry exceeds the shared 20000 vertex / 10000 triangle preview budget.'
    else:
        dynamic, positions, vertex_gaps = query.get_all_vertex_positions(dynamic, False)
        dynamic, triangles, triangle_gaps = query.get_all_triangle_indices(dynamic, False)
        if vertex_gaps or triangle_gaps:
            item['reason'] = 'Source mesh has sparse IDs; no implicit remapping was applied.'
        else:
            item['vertices'] = [[p.x, p.y, p.z] for p in lists.convert_vector_list_to_array(positions)]
            item['indices'] = [v for t in lists.convert_triangle_list_to_array(triangles) for v in (t.x, t.y, t.z)]
            vertices_left -= nv
            triangles_left -= nt
    result['lods'].append(item)
if count > 8:
    result['diagnostics'].append('Only the first eight source LODs were inspected.')
with open(os.path.join(base, 'geometry.json'), 'w', encoding='utf-8') as stream:
    json.dump(result, stream, allow_nan=False, separators=(',', ':'))
`.split('\n').map(line => '    ' + line).join('\n')

/** Validate the process boundary before geometry can reach the renderer. */
export function validateNativeGeometry(value: unknown): NativeMeshGeometry {
  const data = value as NativeMeshGeometry
  if (!data || data.status !== 'ready' || data.provider !== PROVIDER || typeof data.engineVersion !== 'string' || data.engineVersion.length > 256 || !Number.isInteger(data.totalLods) || data.totalLods < 0 || data.totalLods > 1024 || !Array.isArray(data.lods) || data.lods.length > 8 || !Array.isArray(data.diagnostics) || data.diagnostics.length > 16 || data.diagnostics.some(item => typeof item !== 'string' || item.length > 1024)) throw new Error('Invalid native mesh response.')
  let vertices = 0, triangles = 0
  const indexes = new Set<number>()
  for (const lod of data.lods) {
    if (!lod || !Number.isInteger(lod.index) || lod.index < 0 || lod.index >= data.totalLods || indexes.has(lod.index) || !Number.isInteger(lod.vertexCount) || lod.vertexCount < 0 || !Number.isInteger(lod.triangleCount) || lod.triangleCount < 0 || !Array.isArray(lod.vertices) || !Array.isArray(lod.indices) || lod.indices.length % 3 || (lod.reason !== undefined && (typeof lod.reason !== 'string' || lod.reason.length > 1024))) throw new Error('Invalid source LOD response.')
    indexes.add(lod.index)
    vertices += lod.vertices.length; triangles += lod.indices.length / 3
    if (vertices > 20000 || triangles > 10000 || lod.vertices.some(p => !Array.isArray(p) || p.length !== 3 || p.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 1e12)) || lod.indices.some(i => !Number.isInteger(i) || i < 0 || i >= lod.vertices.length) || (!lod.reason && (lod.vertices.length !== lod.vertexCount || lod.indices.length / 3 !== lod.triangleCount)) || (lod.reason && (lod.vertices.length || lod.indices.length))) throw new Error('Invalid or oversized source geometry.')
  }
  return data
}

export class NativeMeshService {
  private cache = new Map<string, NativeMeshGeometry>()
  private active = false
  private waiting: Array<() => void> = []
  private shutdown = new AbortController()
  private worker = new NativeMeshWorker()

  async extract(blobPath: string, repositoryFile: string, document: BlueprintDocument, signal?: AbortSignal): Promise<NativeMeshGeometry> {
    try { return await this.extractMesh(blobPath, repositoryFile, document, signal) }
    catch (error) { return { status: 'unavailable', provider: PROVIDER, engineVersion: document.engineVersion, reason: error instanceof Error ? error.message : String(error), diagnostics: [], totalLods: 0, lods: [] } }
  }

  private async extractMesh(blobPath: string, repositoryFile: string, document: BlueprintDocument, signal?: AbortSignal): Promise<NativeMeshGeometry> {
    const unavailable = (reason: string): NativeMeshGeometry => ({ status: 'unavailable', provider: PROVIDER, engineVersion: document.engineVersion, reason, diagnostics: [], totalLods: 0, lods: [] })
    const cancellation = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal
    if (cancellation.aborted) return unavailable('Asset preview cancelled.')
    const version = /^(5\.\d+)\./.exec(document.engineVersion)?.[1]
    if (!version || !['/Script/Engine.StaticMesh', '/Script/Engine.SkeletalMesh'].includes(document.assetClass ?? '') || document.assetReview?.cooked) return unavailable('Native preview currently supports uncooked UE5 static and skeletal mesh packages.')
    const roots = document.assetReview?.objects.filter(object => object.classPath === document.assetClass) ?? []
    if (roots.length !== 1 || !/^[A-Za-z0-9_ -]+$/.test(roots[0].name)) return unavailable('The captured mesh root is missing or ambiguous.')
    // Content paths only: custom plugin mounts require a separate proven snapshot provider.
    const file = repositoryFile.replace(/\\/g, '/')
    if (/(?:^|\/)Plugins\//i.test(file)) return unavailable('Plugin content mounts require a separate captured dependency provider.')
    const match = /(?:^|\/)Content\/(.+)\.uasset$/i.exec(file)
    if (!match || !match[1].split('/').every(part => /^[A-Za-z0-9_ -]+$/.test(part))) return unavailable('Native preview requires a package under a Content directory.')
    const editor = await ueHeadlessService.findEditorBinary(version)
    if (!editor) return unavailable(`Lucid Git could not locate Unreal Engine ${version} (UnrealEditor-Cmd.exe) required to preview this saved source mesh. If it is already installed, its installation path may not have been detected.`)
    const binary = await fs.stat(editor)
    const companion = blobPath.replace(/\.uasset$/i, '.uexp')
    const extraStat = await fs.stat(companion).catch(() => null)
    const size = (await fs.stat(blobPath)).size + (extraStat?.size ?? 0)
    if (size > MAX_INPUT_BYTES) return unavailable('Captured mesh and exports exceed the 64 MB native preview limit.')
    // Hash queued inputs as streams: waiting jobs retain paths, not whole package buffers.
    const content = crypto.createHash('sha256')
    let seen = 0
    for (const input of extraStat ? [blobPath, companion] : [blobPath]) {
      content.update(String((await fs.stat(input)).size) + ':')
      for await (const chunk of createReadStream(input)) {
        if (cancellation.aborted) return unavailable('Asset preview cancelled.')
        seen += chunk.length
        if (seen > MAX_INPUT_BYTES) return unavailable('Captured mesh changed or exceeds the native preview limit.')
        content.update(chunk)
      }
    }
    const contentKey = content.digest('hex')
    const key = crypto.createHash('sha256').update(PROVIDER).update(editor).update(`${binary.size}:${binary.mtimeMs}`).update(file).update(contentKey).digest('hex')
    const cached = this.cache.get(key)
    if (cached) return cached
    if (this.active) {
      if (this.waiting.length >= 4) return unavailable('Native preview is busy. Retry after the current exports finish.')
      const acquired = await new Promise<boolean>(resolve => {
        const wake = () => { cancellation.removeEventListener('abort', cancel); resolve(true) }
        const cancel = () => { const index = this.waiting.indexOf(wake); if (index >= 0) this.waiting.splice(index, 1); resolve(false) }
        this.waiting.push(wake)
        cancellation.addEventListener('abort', cancel, { once: true })
        if (cancellation.aborted) cancel()
      })
      if (!acquired) return unavailable('Asset preview cancelled.')
    } else this.active = true
    let directory = ''
    try {
      if (signal?.aborted || this.shutdown.signal.aborted) throw new Error('Asset preview cancelled.')
      const existing = this.cache.get(key)
      if (existing) return existing
      const bytes = await fs.readFile(blobPath), extra = extraStat ? await fs.readFile(companion) : null
      const captured = crypto.createHash('sha256').update(String(bytes.length) + ':').update(bytes)
      if (extra) captured.update(String(extra.length) + ':').update(extra)
      if (captured.digest('hex') !== contentKey) throw new Error('Captured mesh bytes changed while waiting for native export.')
      let target = ''
      // Unique package paths prevent Unreal from returning a previously loaded revision.
      const engineKey = `${editor}:${binary.size}:${binary.mtimeMs}`
      await this.worker.run(editor, engineKey, MESH_SCRIPT, cancellation, async (root, id) => {
        directory = path.join(root, 'Content', id)
        target = path.join(directory, match[1] + '.uasset')
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, bytes)
        if (extra) await fs.writeFile(target.replace(/\.uasset$/i, '.uexp'), extra)
        await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({ asset: '/Game/' + id + '/' + match[1] + '.' + roots[0].name, class: document.assetClass }))
        return directory
      }, bytes.length + (extra?.length ?? 0))
      const output = path.join(directory, 'geometry.json')
      if ((await fs.stat(output)).size > 4 * 1024 * 1024) throw new Error('Native geometry exceeds the 4 MB response limit.')
      // Verify copies after the job; no repository source is ever opened by Unreal.
      if (!(await fs.readFile(target)).equals(bytes) || extra && !(await fs.readFile(target.replace(/\.uasset$/i, '.uexp'))).equals(extra)) throw new Error('The isolated engine changed captured package bytes; export discarded.')
      const result = validateNativeGeometry(JSON.parse(await fs.readFile(output, 'utf8')))
      if (!result.engineVersion.startsWith(version + '.')) throw new Error('Installed engine version does not match this saved package.')
      if (cancellation.aborted) throw new Error('Asset preview cancelled.')
      this.cache.set(key, result)
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
      return result
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)) }
    finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {})
      const next = this.waiting.shift(); if (next) next(); else this.active = false
    }
  }

  stop() { this.shutdown.abort(); this.cache.clear(); void this.worker.stop() }
}
export const nativeMeshService = new NativeMeshService()
