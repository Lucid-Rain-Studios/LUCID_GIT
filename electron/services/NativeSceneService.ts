import { app } from 'electron'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { ueHeadlessService } from './UEHeadlessService'
import { SCENE_SCRIPT } from './SceneExportScript'
import { verifySceneInputs } from './SceneSnapshot'
import { inspectSceneGlb } from '../util/scene-glb'
import { savedSceneAttachments, type SavedSceneAttachment } from '../util/saved-attachments'
import type { BlueprintSide, NativeSceneReview } from '../blueprintTypes'

export class NativeSceneService {
  private entries = new Map<string, NativeSceneReview>()
  private active = false
  private waiting: Array<() => void> = []
  private shutdown = new AbortController()
  private directory: string
  constructor(directory = path.join(app.getPath('userData'), 'cache', 'native-scenes')) { this.directory = directory }

  async extract(root: BlueprintSide, directory: string, snapshot: { renderOnly?: boolean; packages: NativeSceneReview['packages']; diagnostics: string[]; complete: boolean; identity: string; exportEngineVersion?: string; minimumEngineVersion?: string; actorNames?: string[]; actorCandidates?: Array<{path:string;classPath:string;package:string}>; actorManifestComplete?: boolean; components?: SavedSceneAttachment[]; componentsComplete?: boolean }, signal?: AbortSignal, bakeMaterials = false, force = false, lod = 0): Promise<NativeSceneReview> {
    const unavailable = (reason: string): NativeSceneReview => ({ status: 'unavailable', reason, engineVersion: root.document?.engineVersion ?? '', packages: snapshot.packages, diagnostics: snapshot.diagnostics, complete: false })
    if (!Number.isInteger(lod) || lod < 0 || lod > 7) return unavailable('Render LOD must be an integer from 0 to 7.')
    const cancellation = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal
    const version = /^(5\.\d+)(?:\.|$)/.exec(snapshot.exportEngineVersion ?? snapshot.minimumEngineVersion ?? root.document?.engineVersion ?? '')?.[1]
    if (!version || root.document?.assetReview?.cooked) return unavailable('Scene export requires an uncooked UE5 package.')
    if (snapshot.minimumEngineVersion && Number(version.split('.')[1]) < Number(snapshot.minimumEngineVersion.split('.')[1])) return unavailable('A dependency is newer than the captured project engine. Update the project association before exporting this scene.')
    const editor = await ueHeadlessService.findEditorBinary(version)
    if (!editor) return unavailable(`Install Unreal Engine ${version} for scene export.`)
    const identity = await fs.stat(editor)
    const bridgeRoot=path.join(app.isPackaged ? path.join(process.resourcesPath,'unreal-preview-bridge') : path.join(__dirname,'../../tools/UnrealPreviewBridge/bin'),version)
    const bridgeFiles=['UnrealPreviewBridge.uplugin','Binaries/Win64/UnrealEditor.modules','Binaries/Win64/UnrealEditor-UnrealPreviewBridge.dll']
    let bridge:Buffer[]|undefined
    if(process.platform==='win32')try {
      const candidate=await Promise.all(bridgeFiles.map(async file=>{const target=path.join(bridgeRoot,file);if((await fs.stat(target)).size>32*1024*1024)throw new Error('Bridge binary limit');return fs.readFile(target)}))
      const engineModules=JSON.parse(await fs.readFile(path.join(path.dirname(editor),'UnrealEditor.modules'),'utf8'))
      if(JSON.parse(candidate[1].toString()).BuildId===engineModules.BuildId)bridge=candidate
    }catch { /* Missing/mismatched native bridge keeps the explicit fallback. */ }
    const key = crypto.createHash('sha256').update(SCENE_SCRIPT).update(bridge ? crypto.createHash('sha256').update(Buffer.concat(bridge)).digest('hex') : 'no-bridge').update(JSON.stringify([bakeMaterials,lod])).update(snapshot.identity).update(root.path).update(editor).update(`${identity.size}:${identity.mtimeMs}`).digest('hex')
    const cached = this.entries.get(key)
    if (!force && cached && (!cached.key || await fs.access(path.join(this.directory, cached.key + '.glb')).then(() => true, () => false))) return cached
    if (cancellation.aborted) return unavailable('Scene export cancelled.')
    if (this.active) {
      if (this.waiting.length >= 4) return unavailable('Scene exporter is busy. Retry after active exports finish.')
      const acquired = await new Promise<boolean>(resolve => {
        const wake = () => { cancellation.removeEventListener('abort', cancel); resolve(true) }
        const cancel = () => { const index = this.waiting.indexOf(wake); if (index >= 0) this.waiting.splice(index, 1); resolve(false) }
        this.waiting.push(wake); cancellation.addEventListener('abort', cancel, { once: true }); if (cancellation.aborted) cancel()
      })
      if (!acquired) return unavailable('Scene export cancelled.')
    } else this.active = true
    try {
      if (cancellation.aborted) throw new Error('Scene export cancelled.')
      // Another identical capture may have completed while this caller waited.
      const completed = this.entries.get(key)
      if (!force && completed && (!completed.key || await fs.access(path.join(this.directory, completed.key + '.glb')).then(() => true, () => false))) return completed
      const verify = await verifySceneInputs(directory)
      const assetClass = root.document!.assetClass!
      const roots = root.document!.assetReview!.objects.filter(obj => obj.classPath === assetClass)
      if (roots.length !== 1) throw new Error('Captured scene root is ambiguous.')
      const gamePath = root.path.slice(root.path.indexOf('Content/') + 8).replace(/\.(umap|uasset)$/i, '')
      const asset = '/Game/' + gamePath + '.' + roots[0].name
      if(bridge)for(const [index,file] of bridgeFiles.entries()){const target=path.join(directory,'Plugins/UnrealPreviewBridge',file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bridge[index])}
      await fs.writeFile(path.join(directory, 'Preview.uproject'), JSON.stringify({ FileVersion: 3, Plugins: [{ Name: 'PythonScriptPlugin', Enabled: true }, { Name: 'GLTFExporter', Enabled: true }, { Name: 'StateTree', Enabled: true }, { Name: 'GameplayStateTree', Enabled: true },{Name:'UnrealPreviewBridge',Enabled:!!bridge}] }))
      const external = snapshot.packages.filter(p => p.path.includes('/__ExternalActors__/') || p.path.includes('/__ExternalObjects__/')).map(p => '/Game/' + p.path.slice(p.path.indexOf('Content/') + 8).replace(/\.uasset$/i, ''))
      const editorObjects = root.document!.assetReview!.objects.filter(object => object.classPath.endsWith('.StateTreeEditorData')).map(object => object.name)
      const visualActors = [...new Set(root.document!.assetReview!.objects.filter(object => /\.(StaticMeshComponent|SkeletalMeshComponent|InstancedStaticMeshComponent|HierarchicalInstancedStaticMeshComponent)$/.test(object.classPath)).map(object => '/Game/' + gamePath + '.' + object.outer.replace('.PersistentLevel.', ':PersistentLevel.')))].slice(0,10000)
      const attachments = snapshot.components ? {components:snapshot.components,complete:snapshot.componentsComplete === true} : savedSceneAttachments(root)
      await fs.writeFile(path.join(directory, 'request.json'), JSON.stringify({ asset, class: assetClass, renderOnly: snapshot.renderOnly === true, visualActors, external, editorObjects, bakeMaterials, lod, components:attachments.components.slice(0,10000), componentsComplete:attachments.complete && attachments.components.length <= 10000, actorNames: snapshot.actorNames ?? [], actorCandidates: snapshot.actorCandidates ?? [], actorManifestComplete: snapshot.actorManifestComplete === true }))
      await fs.writeFile(path.join(directory, 'export.py'), SCENE_SCRIPT)
      for (const file of ['scene.json', 'scene.glb']) await fs.rm(path.join(directory, file), { force: true })
      const run = await ueHeadlessService.runCommandlet({ editorBin: editor, projectPath: path.join(directory, 'Preview.uproject'), commandlet: 'pythonscript', params: [`-script=${path.join(directory, 'export.py')}`, '-stdout', '-FullStdOutLogOutput', '-nosound'], timeoutMs: 360000, signal: cancellation, rendering: bakeMaterials && assetClass !== '/Script/StateTreeModule.StateTree' })
      const artifactWritten = await fs.access(path.join(directory,'scene.json')).then(() => true, () => false)
      // Unreal reports unrelated dependency compile errors in the commandlet exit code.
      // A fresh script-end artifact may still be inspected, with those errors retained.
      const partialExit = !run.success && /^Exited with code/.test(run.error ?? '') && artifactWritten
      if (!run.success && !partialExit) {
        const lines = run.output.split('\n').filter(line => /Error:|Fatal error|Assertion failed/.test(line))
        const headline = lines.find(line => /Fatal error:|Assertion failed:|Unhandled Exception:/.test(line))
        const failure = [...(headline ? [headline] : []),...lines.slice(-14)]
        snapshot.diagnostics.push(...failure.map(line => line.slice(0, 2048)))
        const detail = (headline ?? failure.at(-1))?.trim().slice(0, 500)
        throw new Error([run.error, detail].filter(Boolean).join(' ') || 'Engine scene export failed.')
      }
      await verify()
      const infoFile = path.join(directory, 'scene.json')
      if ((await fs.stat(infoFile)).size > 4 * 1024 * 1024) throw new Error('Scene details exceed 4 MB.')
      const info = JSON.parse(await fs.readFile(infoFile, 'utf8'))
      if (typeof info.engineVersion !== 'string' || !info.engineVersion.startsWith(version + '.') || !Array.isArray(info.diagnostics) || info.diagnostics.length > 100 || info.diagnostics.some((v: unknown) => typeof v !== 'string' || v.length > 8192)) throw new Error('Invalid scene details.')
      const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      if (!Array.isArray(info.actors) || info.actors.length > 10000 || info.actors.some((value: unknown) => { const v = record(value); return typeof v.name !== 'string' || typeof v.path !== 'string' || !Array.isArray(v.location) || v.location.length !== 3 || v.location.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n)) || v.saved !== undefined && typeof v.saved !== 'boolean' })) throw new Error('Invalid reconstructed actors.')
      if (info.actors.some((value: unknown) => { const v = record(value); return v.guid !== undefined && (v.saved !== true || typeof v.guid !== 'string' || !/^[a-f0-9]{32}$/.test(v.guid) || v.guid === '0'.repeat(32)) })) throw new Error('Invalid native actor GUID.')
      const tuple = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length && value.every(n => typeof n === 'number' && Number.isFinite(n))
      if (info.actors.some((value: unknown) => { const v = record(value); return v.scale !== undefined && !tuple(v.scale,3) || v.rotation !== undefined && (!tuple(v.rotation,4) || Math.abs(v.rotation.reduce((sum,n) => sum+n*n,0)-1) > .001) })) throw new Error('Invalid native actor rotation or scale.')
      if (!Array.isArray(info.bags) || info.bags.length > 1002 || info.bags.some((value: unknown) => { const v = record(value); return typeof v.object !== 'string' || typeof v.property !== 'string' || typeof v.text !== 'string' || v.text.length > 65536 })) throw new Error('Invalid native StateTree bags.')
      const errors = run.output.split('\n').filter(line => /LogLinker: Warning:|LogUObjectGlobals: Warning: Failed to load|LogBlueprint: Error:|LogPython: Error:/.test(line)).slice(0, 25).map(line => line.slice(0, 1024))
      if (partialExit) errors.unshift('Engine reported dependency errors; the completed export is partial.')
      const diagnostics = [...snapshot.diagnostics, ...info.diagnostics, ...errors].slice(0, 100)
      const result: NativeSceneReview = { status: 'ready', engineVersion: info.engineVersion, packages: snapshot.packages, diagnostics, complete: snapshot.complete && diagnostics.length === 0, actors: info.actors, bags: info.bags }
      if (info.playback !== undefined) {
        if (!Array.isArray(info.playback) || info.playback.length>10000 || info.playback.some((value:unknown) => {const v=record(value);return typeof v.actor!=='string' || v.actor.length>2048 || typeof v.clip!=='string' || v.clip.length>1024 || typeof v.position!=='number' || !Number.isFinite(v.position) || v.position<0 || typeof v.rate!=='number' || !Number.isFinite(v.rate) || Math.abs(v.rate)>16 || typeof v.looping!=='boolean' || typeof v.playing!=='boolean'})) throw new Error('Invalid saved animation playback.')
        result.playback=info.playback
      }
      const sourcePaths = new Set(snapshot.actorCandidates?.map(actor => actor.path) ?? [])
      const sourceWorlds = new Set([...sourcePaths].map(path => path.split(':')[0]))
      const actorsByPath = new Map<string,Array<{path:string;saved?:boolean;guid?:string}>>()
      for (const actor of info.actors) { const matches = actorsByPath.get(actor.path); if (matches) matches.push(actor); else actorsByPath.set(actor.path,[actor]) }
      const instanceWorlds = new Map<string,{world:string;source:string;identity:string;owner:string}>()
      if (info.instances !== undefined) {
        if (assetClass !== '/Script/Engine.World' || !Array.isArray(info.instances) || info.instances.length > 256) throw new Error('Invalid level instance inventory.')
        const identities = new Set<string>()
        for (const value of info.instances) {
          const v = record(value)
          if (typeof v.world !== 'string' || !(v.world.startsWith('/Game/') || bridge && v.world.startsWith('/Temp/Game/')) || v.world.length > 2048 || typeof v.source !== 'string' || !v.source.startsWith('/Game/') || v.source.length > 2048 || !sourceWorlds.has(v.source) || typeof v.identity !== 'string' || !/^[a-f0-9]{32}(\/[a-f0-9]{32}){0,31}$/.test(v.identity) || typeof v.owner !== 'string' || !sourcePaths.has(v.owner) || instanceWorlds.has(v.world) || identities.has(v.identity)) throw new Error('Invalid level instance provenance.')
          const owner = (actorsByPath.get(v.owner) ?? []).filter(actor => actor.saved === true)
          if (owner.length !== 1 || owner[0].guid !== v.identity.split('/')[0]) throw new Error('Invalid saved instance owner.')
          instanceWorlds.set(v.world,value); identities.add(v.identity)
        }
        result.instances = info.instances
      }
      for (const actor of info.actors) {
        if (actor.instanceLabel !== undefined && (typeof actor.instanceLabel !== 'string' || actor.instanceLabel.length > 512 || actor.instancePath === undefined)) throw new Error('Invalid instance display label.')
        if (actor.instancePath === undefined && actor.sourcePath === undefined && actor.inspectPath === undefined && actor.renderName === undefined) {
          if (actor.saved === true && !sourcePaths.has(actor.path)) throw new Error('Saved actor is outside the captured source manifest.')
          continue
        }
        const world = actor.path.split(':')[0], instance = instanceWorlds.get(world)
        if (!instance || actor.instancePath !== instance.identity || actor.inspectPath !== instance.owner || typeof actor.sourcePath !== 'string' || actor.sourcePath !== instance.source + actor.path.slice(world.length) || actor.saved === true && !sourcePaths.has(actor.sourcePath) || typeof actor.renderName !== 'string' || actor.renderName.length > 2048) throw new Error('Invalid instanced actor provenance.')
      }
      for (const instance of instanceWorlds.values()) {
        const chain = instance.identity.split('/')
        if (chain.length < 2) continue
        const parent = chain.slice(0,-1).join('/'), matches = info.actors.filter((actor: {saved?:boolean;instancePath?:string;guid?:string}) => actor.saved === true && actor.instancePath === parent && actor.guid === chain.at(-1))
        if (matches.length !== 1 || ![...instanceWorlds.values()].some(value => value.identity === parent && value.owner === instance.owner)) throw new Error('Invalid nested instance owner chain.')
      }
      if (info.actorInventory !== undefined) {
        const inventory = info.actorInventory
        if (inventory.expected > Math.min(10000,(snapshot.actorCandidates?.length ?? 0)*(instanceWorlds.size+1))) throw new Error('Native actor proof exceeds the captured manifest.')
        if (assetClass !== '/Script/Engine.World' || !Number.isInteger(inventory.expected) || inventory.expected < 0 || inventory.expected > 10000 || !Number.isInteger(inventory.matched) || inventory.matched < 0 || inventory.matched > inventory.expected || !Array.isArray(inventory.missing) || inventory.missing.length !== Math.min(100,inventory.expected - inventory.matched) || inventory.missing.some((value: unknown) => typeof value !== 'string' || value.length > 2048) || !Array.isArray(inventory.diagnostics) || inventory.diagnostics.length > 100 || inventory.diagnostics.some((value: unknown) => typeof value !== 'string' || value.length > 2048) || typeof info.actorInventoryComplete !== 'boolean' || info.actors.filter((actor: {saved?:boolean}) => actor.saved).length !== inventory.matched) throw new Error('Invalid native actor inventory proof.')
        result.actorInventory = inventory
        result.actorInventoryComplete = info.actorInventoryComplete && snapshot.actorManifestComplete === true && snapshot.complete && errors.length === 0 && inventory.matched === inventory.expected && inventory.diagnostics.length === 0
      }
      if (info.renderLod !== undefined) {
        if (!Number.isInteger(info.renderLod.count) || info.renderLod.count < 1 || info.renderLod.count > 64 || info.renderLod.requested !== lod || lod >= info.renderLod.count) throw new Error('Invalid render LOD details.')
        result.renderLod = info.renderLod
      }
      if (assetClass !== '/Script/StateTreeModule.StateTree') {
        const file = path.join(directory, 'scene.glb')
        if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error('Scene payload exceeds 64 MB.')
        const bytes = await fs.readFile(file)
        result.stats = inspectSceneGlb(bytes)
        const payloadKey = crypto.createHash('sha256').update(bytes).digest('hex')
        result.key = payloadKey
        await fs.mkdir(this.directory, { recursive: true })
        if (cancellation.aborted) throw new Error('Scene export cancelled.')
        const temporary = path.join(this.directory, payloadKey + '.' + crypto.randomUUID() + '.tmp')
        try {
          await fs.writeFile(temporary, bytes, { flag: 'wx' })
          await fs.rename(temporary, path.join(this.directory, payloadKey + '.glb'))
        } finally { await fs.unlink(temporary).catch(() => {}) }
      }
      if (cancellation.aborted) throw new Error('Scene export cancelled.')
      this.entries.set(key, result)
      await this.prune()
      return result
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)) }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active = false }
  }

  async read(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key) || ![...this.entries.values()].some(entry => entry.key === key)) throw new Error('Scene preview expired. Retry the capture.')
    const file = path.join(this.directory, key + '.glb')
    if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error('Scene payload exceeds its limit.')
    const bytes = await fs.readFile(file)
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== key) throw new Error('Cached scene changed. Retry the export.')
    inspectSceneGlb(bytes)
    return new Uint8Array(bytes)
  }
  private async prune() {
    while (this.entries.size > 8) {
      const key = this.entries.keys().next().value!, payload = this.entries.get(key)?.key
      this.entries.delete(key)
      if (payload && ![...this.entries.values()].some(entry => entry.key === payload)) {
        await fs.unlink(path.join(this.directory, payload + '.glb')).catch(() => {})
      }
    }
    const files = await fs.readdir(this.directory).catch(() => [])
    const entries = await Promise.all(files.filter(file => /^[a-f0-9]{64}\.glb$/.test(file)).map(async file => ({ file, stat: await fs.stat(path.join(this.directory, file)) })))
    let bytes = entries.reduce((sum, e) => sum + e.stat.size, 0)
    for (const entry of entries.sort((a,b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
      if (bytes <= 256 * 1024 * 1024) break
      await fs.unlink(path.join(this.directory, entry.file))
      const payload = entry.file.slice(0,-4)
      for (const [key, result] of this.entries) if (result.key === payload) this.entries.delete(key)
      bytes -= entry.stat.size
    }
  }
  stop() { this.shutdown.abort(); this.entries.clear() }
}
export const nativeSceneService = new NativeSceneService()
