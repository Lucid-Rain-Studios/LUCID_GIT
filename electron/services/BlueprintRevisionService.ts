import { app } from 'electron'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, type ChildProcess } from 'node:child_process'
import { assetDiffService } from './AssetDiffService'
import { nativeMeshService } from './NativeMeshService'
import { nativeSceneService } from './NativeSceneService'
import { captureSceneSnapshot } from './SceneSnapshot'
import { externalActorPrefix } from '../util/external-actors'
import { execSafe, withGitTimeout } from '../util/dugite-exec'
import { owningMapCandidate } from '../util/external-actors'
import { confirmsMapOwnership, discoverExternalActors, emptyExternalReview, estimatedCaptureBytes, mutableActorStamp } from './ExternalActorReview'
import { withRepoSlot } from '../util/repo-gate'
import type { BlueprintComparison, BlueprintDocument, BlueprintRequest, BlueprintSide } from '../blueprintTypes'

const EXTRACTOR_VERSION = '16-actor-manifest-uassetapi-3228c1e8'
const READER_VERSION = 16
const MAX_BYTES = 256 * 1024 * 1024
const MAX_CACHE_BYTES = 256 * 1024 * 1024
const sha = (b: string | Buffer) => crypto.createHash('sha256').update(b).digest('hex')

function validatePath(file: string) {
  if (typeof file !== 'string' || !file || file.includes('\0') || path.isAbsolute(file) || file.split(/[\\/]/).some(p => p === '..' || p.toLowerCase() === '.git') || !/\.(uasset|umap)$/i.test(file))
    throw new Error('Select a repository-relative .uasset or .umap path.')
}
function validateRef(ref: string) {
  if (!['HEAD', 'INDEX', 'WORKING', 'ABSENT'].includes(ref) && !/^[a-f0-9]{40}(?:\^1)?$/i.test(ref)) throw new Error('Invalid Blueprint revision.')
}

export class BlueprintRevisionService {
  private cache = new Map<string, BlueprintDocument>()
  private inFlight = new Map<string, Promise<BlueprintDocument>>()
  private identities = new Map<string, Promise<BlueprintSide>>()
  private active = 0
  private waiting: Array<{ wake(): void; reject(error: Error): void }> = []
  private processes = new Set<ChildProcess>()
  private stopping = false
  private pruneAt = 0
  private readonly helperDirectory: string
  private readonly cacheDirectory: string

  constructor(helperDirectory?: string, cacheDirectory?: string) {
    this.helperDirectory = helperDirectory ?? (app.isPackaged
      ? path.join(process.resourcesPath, 'blueprint-extractor', `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux'}-${process.arch}`)
      : path.join(__dirname, '../../tools/BlueprintExtractor/bin/Release/net10.0'))
    this.cacheDirectory = cacheDirectory ?? path.join(app.getPath('userData'), 'cache', 'blueprints')
  }

  async compare(repoPath: string, req: BlueprintRequest, signal?: AbortSignal): Promise<BlueprintComparison> {
    if (this.stopping) throw new Error('Blueprint reader is shutting down.')
    if (!req || typeof repoPath !== 'string') throw new Error('Invalid Blueprint request.')
    if (req.externalActors !== undefined && typeof req.externalActors !== 'boolean') throw new Error('Invalid external actor review scope.')
    if (req.nativeGeometry !== undefined && typeof req.nativeGeometry !== 'boolean') throw new Error('Invalid native geometry review scope.')
    if (req.nativeScene !== undefined && typeof req.nativeScene !== 'boolean') throw new Error('Invalid native scene review scope.')
    if (req.sceneBakeMaterials !== undefined && typeof req.sceneBakeMaterials !== 'boolean') throw new Error('Invalid scene material profile.')
    if (req.sceneLod !== undefined && (!Number.isInteger(req.sceneLod) || req.sceneLod < 0 || req.sceneLod > 7)) throw new Error('Render LOD must be an integer from 0 to 7.')
    validatePath(req.filePath); validatePath(req.oldPath ?? req.filePath)
    validateRef(req.leftRef); validateRef(req.rightRef)
    if (req.knownDocuments !== undefined && (!Array.isArray(req.knownDocuments) || req.knownDocuments.length > 8 || req.knownDocuments.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)))) throw new Error('Invalid Blueprint document cache keys.')
    const repo = await fs.realpath(repoPath)
    const refreshKeys = req.force === true ? new Set<string>() : undefined
    return withGitTimeout(async () => {
      if (signal?.aborted) throw new Error('Blueprint review cancelled.')
      const maps = [req.oldPath ?? req.filePath, req.filePath]
      const refs = [req.leftRef, req.rightRef]
      if (req.externalActors || req.nativeScene) for (let i = 0; i < refs.length; i++) {
        if (refs[i] === 'HEAD' || refs[i].endsWith('^1')) {
          const frozen = await execSafe(['rev-parse', '--verify', refs[i] + '^{commit}'], repo)
          if (frozen.exitCode === 0) refs[i] = frozen.stdout.trim()
        }
      }
      let manifest: Awaited<ReturnType<typeof discoverExternalActors>> | undefined, stamp = '', discoveryError = ''
      if (req.externalActors) try {
        await withRepoSlot(repo, 'read', async () => {
          manifest = await discoverExternalActors(repo, maps[0], maps[1], refs[0], refs[1], signal)
          stamp = await mutableActorStamp(repo, maps, manifest.packages.flatMap(p => [p.leftPath, p.rightPath]), refs)
        })
      } catch (error) { discoveryError = error instanceof Error ? error.message : String(error) }
      const left = await this.side(repo, maps[0], refs[0], signal, refreshKeys, MAX_BYTES, req.nativeGeometry)
      if (signal?.aborted) throw new Error('Blueprint review cancelled.')
      const right = await this.side(repo, maps[1], refs[1], signal, refreshKeys, MAX_BYTES, req.nativeGeometry)
      if (signal?.aborted) throw new Error('Blueprint review cancelled.')
      if (req.nativeScene) for (const side of [left, right]) {
        if (side.status === 'ready') side.scene = await this.scene(repo, side, signal, refreshKeys, req.sceneBakeMaterials, req.sceneLod)
        if (signal?.aborted) throw new Error('Scene review cancelled.')
      }
      const owningMaps: BlueprintComparison['owningMaps'] = {}
      for (const [index, side] of [left, right].entries()) {
        const owner = owningMapCandidate(maps[index])
        if (owner && confirmsMapOwnership(side, owner)) {
          const snapshot = await withRepoSlot(repo, 'read', () => this.resolveSide(repo, owner, refs[index], signal))
          if (!('status' in snapshot)) owningMaps[index === 0 ? 'left' : 'right'] = owner
        }
      }
      let externalActors: BlueprintComparison['externalActors']
      if (req.externalActors) {
        externalActors = emptyExternalReview(discoveryError || 'Changed external actor packages only; unchanged actors and full-world dependencies are not loaded.')
        if (manifest && !discoveryError) {
          externalActors.total = manifest.total; externalActors.omitted = manifest.omitted
          let remaining = 64 * 1024 * 1024, output = 0
          for (const [index, entry] of manifest.packages.entries()) {
            if (signal?.aborted) throw new Error('Asset review cancelled.')
            validatePath(entry.leftPath); validatePath(entry.rightPath)
            if (remaining <= 0 || output >= 16 * 1024 * 1024) {
              externalActors.omitted += manifest.packages.length - index
              externalActors.diagnostics.push('External actor byte/output budget reached. Review remaining packages individually.'); break
            }
            const captured = []
            for (let i = 0; i < 2; i++) {
              const root = i === 0 ? left : right, file = i === 0 ? entry.leftPath : entry.rightPath
              let actor: BlueprintSide
              if (root.status === 'unavailable' || root.status === 'ready' && root.document?.assetClass !== '/Script/Engine.World') {
                actor = { ref: refs[i], path: file, status: 'unavailable', reason: 'The owning map is not a decoded World package.' }
              } else {
                actor = await this.side(repo, file, refs[i], signal, refreshKeys, remaining)
                remaining -= actor.sourceBytes ?? 0
                if (actor.status === 'ready' && (root.status === 'absent' || !confirmsMapOwnership(actor, maps[i]))) actor = { ...actor, status: 'unavailable', document: undefined, reason: 'Map ownership is unresolved or the owning map is absent in this revision.' }
              }
              captured.push(actor)
            }
            const bytes = Buffer.byteLength(JSON.stringify(captured))
            if (output + bytes > 16 * 1024 * 1024) {
              externalActors.omitted += manifest.packages.length - index
              externalActors.diagnostics.push('External actor output exceeds the 16 MB aggregate budget. Review remaining packages individually.'); break
            }
            output += bytes; externalActors.packages.push({ left: captured[0], right: captured[1] })
          }
          const current = await withRepoSlot(repo, 'read', () => mutableActorStamp(repo, maps, manifest!.packages.flatMap(p => [p.leftPath, p.rightPath]), refs))
          if (stamp !== current) externalActors = { ...externalActors, packages: [], omitted: manifest.total, diagnostics: ['The index or selected package files changed during capture. Retry; actor changes have been discarded.'] }
          else {
            const after = await withRepoSlot(repo, 'read', () => discoverExternalActors(repo, maps[0], maps[1], refs[0], refs[1], signal))
            if (JSON.stringify(after) !== JSON.stringify(manifest)) externalActors = { ...externalActors, packages: [], omitted: after.total, total: after.total, diagnostics: ['External actor membership changed during capture. Retry; actor changes have been discarded.'] }
          }
        }
      }
      const known = req.knownDocuments ? new Set(req.force ? [] : req.knownDocuments) : undefined
      const transfer = (side: BlueprintSide): BlueprintSide => {
        if (!known || !side.documentKey || !side.document) return side
        if (known.has(side.documentKey)) return { ...side, document: undefined }
        known.add(side.documentKey)
        return side
      }
      return { left: transfer(left), right: transfer(right), ...(Object.keys(owningMaps).length ? { owningMaps } : {}), ...(externalActors ? { externalActors: { ...externalActors, packages: externalActors.packages.map(p => ({ left: transfer(p.left), right: transfer(p.right) })) } } : {}) }
    }, req.nativeScene ? 1500_000 : req.nativeGeometry ? 300_000 : 120_000, 'Blueprint revision read')
  }

  private async side(repo: string, file: string, ref: string, signal?: AbortSignal, refreshKeys?: Set<string>, byteLimit = MAX_BYTES, nativeGeometry = false): Promise<BlueprintSide> {
    const snapshot = await withRepoSlot(repo, 'read', () => this.resolveSide(repo, file, ref, signal))
    if ('status' in snapshot) return snapshot
    const { identity, resolved, companionIdentity, companionResolved, revisionRef } = snapshot
    if (byteLimit < MAX_BYTES) {
      const estimate = await withRepoSlot(repo, 'read', async () => await estimatedCaptureBytes(repo, file, resolved) + await estimatedCaptureBytes(repo, file.replace(/\.(uasset|umap)$/i, '.uexp'), companionResolved))
      if (estimate > byteLimit) return { ref, path: file, status: 'unavailable', reason: 'External actor package exceeds the remaining 64 MB capture budget.' }
    }
    const key = sha([repo, file, ref, identity, companionIdentity, EXTRACTOR_VERSION].join('\0'))
    // Native exports are cancellable per request; never share an abort signal between viewers.
    if (nativeGeometry) return { ...await this.loadSide(repo, file, resolved, ref, companionResolved, companionIdentity, refreshKeys, byteLimit, signal, true), resolvedRef: revisionRef }
    if (refreshKeys) this.identities.delete(key)
    let promise = this.identities.get(key)
    if (!promise) {
      promise = this.loadSide(repo, file, resolved, ref, companionResolved, companionIdentity, refreshKeys, byteLimit)
      this.identities.set(key, promise)
      void promise.then(side => {
        if (side.status === 'unavailable') this.identities.delete(key)
        while (this.identities.size > 8) this.identities.delete(this.identities.keys().next().value!)
      }, () => { this.identities.delete(key) })
    }
    const result = await promise
    return (result.sourceBytes ?? 0) > byteLimit ? { ref, path: file, status: 'unavailable', reason: 'External actor package exceeds the remaining 64 MB capture budget.' } : { ...result, resolvedRef: revisionRef }
  }

  private async resolveSide(repo: string, file: string, ref: string, signal?: AbortSignal): Promise<BlueprintSide | { identity: string; resolved: string; companionIdentity: string; companionResolved: string; revisionRef: string }> {
    if (signal?.aborted) throw new Error('Blueprint review cancelled.')
    if (ref === 'ABSENT') return { ref, path: file, status: 'absent' }
    let identity: string, resolved = ref, companionRef = ref
    if (ref === 'WORKING') {
      const absolute = await fs.realpath(path.join(repo, file)).catch(() => null)
      if (!absolute) return { ref, path: file, status: 'absent' }
      const relative = path.relative(repo, absolute)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Blueprint path leaves the repository.')
      const stat = await fs.stat(absolute, { bigint: true })
      if (stat.size > BigInt(MAX_BYTES)) return { ref, path: file, status: 'unavailable', reason: 'Asset exceeds the 256 MB review limit.' }
      identity = `working:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    } else {
      // Separate an absent path from an invalid or unavailable commit.
      if (ref !== 'INDEX') {
        const commit = await execSafe(['rev-parse', '--verify', ref + '^{commit}'], repo)
        if (commit.exitCode !== 0) return { ref, path: file, status: 'unavailable', reason: 'The selected revision is unavailable.' }
        resolved = commit.stdout.trim()
        companionRef = resolved
      }
      const blob = await execSafe(['rev-parse', '--verify', ref === 'INDEX' ? ':' + file : resolved + ':' + file], repo)
      if (blob.exitCode !== 0) return { ref, path: file, status: 'absent' }
      identity = blob.stdout.trim(); resolved = 'BLOB:' + identity
      const size = await execSafe(['cat-file', '-s', identity], repo)
      if (size.exitCode !== 0 || Number(size.stdout) > MAX_BYTES) return { ref, path: file, status: 'unavailable', reason: 'Revision content is unavailable or exceeds the 256 MB review limit.' }
    }
    if (signal?.aborted) throw new Error('Blueprint review cancelled.')
    const companion = file.replace(/\.(uasset|umap)$/i, '.uexp')
    let companionIdentity = '', companionResolved = 'ABSENT'
    if (ref === 'WORKING') {
      const extraPath = await fs.realpath(path.join(repo, companion)).catch(() => null)
      if (extraPath) {
        const relative = path.relative(repo, extraPath)
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Companion path leaves the repository.')
        const stat = await fs.stat(extraPath, { bigint: true })
        if (stat.size > BigInt(MAX_BYTES)) return { ref, path: file, status: 'unavailable', reason: 'Companion exports exceed the 256 MB review limit.' }
        companionIdentity = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
        companionResolved = 'WORKING'
      }
    } else {
      const extra = await execSafe(['rev-parse', '--verify', companionRef === 'INDEX' ? ':' + companion : companionRef + ':' + companion], repo)
      if (extra.exitCode === 0) {
        companionIdentity = extra.stdout.trim()
        const size = await execSafe(['cat-file', '-s', companionIdentity], repo)
        if (size.exitCode !== 0 || Number(size.stdout) > MAX_BYTES) return { ref, path: file, status: 'unavailable', reason: 'Companion exports are unavailable or exceed the 256 MB review limit.' }
        companionResolved = 'BLOB:' + companionIdentity
      }
    }
    return { identity, resolved, companionIdentity, companionResolved, revisionRef: companionRef }
  }

  private async loadSide(repo: string, file: string, resolved: string, ref: string, companionRef: string, companionIdentity: string, refreshKeys?: Set<string>, byteLimit = MAX_BYTES, signal?: AbortSignal, nativeGeometry = false, copyTo?: string, packagesOnly = false): Promise<BlueprintSide> {
    await fs.mkdir(this.cacheDirectory, { recursive: true })
    const temporary = await fs.mkdtemp(path.join(this.cacheDirectory, 'read-'))
    try {
      // Only byte capture holds a repository read slot. CPU extraction runs
      // after release, so a graph reader cannot delay staging or checkout.
      const snapshot = await withRepoSlot(repo, 'read', async (): Promise<BlueprintSide | { contentHash: string; key: string; blobPath: string; sourceBytes: number }> => {
      const before = ref === 'WORKING' ? await fs.stat(path.join(repo, file), { bigint: true }) : null
      const blob = await assetDiffService.extractBlob(repo, file, resolved, temporary, 'left', refreshKeys)
      if (!blob.blobPath) return { ref, path: file, status: 'unavailable', reason: blob.reason ?? 'Revision content is unavailable.' }
      if ((await fs.stat(blob.blobPath)).size > byteLimit) throw new Error('External actor package exceeds the remaining capture budget.')
      let bytes: Buffer = await fs.readFile(blob.blobPath)
      if (bytes.subarray(0, 42).toString().startsWith('version https://git-lfs.github.com/spec/v1')) {
        if (Number(/^size (\d+)$/m.exec(bytes.toString())?.[1] ?? 0) > byteLimit) throw new Error('External actor LFS object exceeds the remaining capture budget.')
        bytes = await assetDiffService.resolveLfsPointer(repo, file, bytes, refreshKeys)
        await fs.writeFile(blob.blobPath, bytes)
      }
      // Resolve companion exports from exactly the same revision/path.
      const companion = file.replace(/\.(uasset|umap)$/i, '.uexp')
      let companionHash = '', sourceBytes = bytes.length
      if (companionRef !== 'ABSENT') {
        const extra = await assetDiffService.extractBlob(repo, companion, companionRef, temporary, 'left', refreshKeys)
        if (!extra.blobPath) return { ref, path: file, status: 'unavailable', reason: extra.reason ?? 'Companion exports are unavailable.' }
        if ((await fs.stat(extra.blobPath)).size + sourceBytes > byteLimit) throw new Error('External actor exports exceed the remaining capture budget.')
        let extraBytes: Buffer = await fs.readFile(extra.blobPath)
        if (extraBytes.subarray(0, 42).toString().startsWith('version https://git-lfs.github.com/spec/v1')) {
          if (Number(/^size (\d+)$/m.exec(extraBytes.toString())?.[1] ?? 0) + sourceBytes > byteLimit) throw new Error('External actor LFS exports exceed the remaining capture budget.')
          extraBytes = await assetDiffService.resolveLfsPointer(repo, companion, extraBytes, refreshKeys)
          await fs.writeFile(extra.blobPath, extraBytes)
        }
        companionHash = sha(extraBytes); sourceBytes += extraBytes.length
        if (companionRef === 'WORKING') {
          const stat = await fs.stat(path.join(repo, companion), { bigint: true })
          if (`${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` !== companionIdentity) return { ref, path: file, status: 'unavailable', reason: 'Companion exports changed while being read. Retry the comparison.' }
        }
      }
      if (before) {
        const after = await fs.stat(path.join(repo, file), { bigint: true })
        if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size) return { ref, path: file, status: 'unavailable', reason: 'The file changed while being read. Retry the comparison.' }
      }
      const contentHash = sha(bytes)
      const key = sha(contentHash + companionHash + EXTRACTOR_VERSION)
      return { contentHash, key, blobPath: blob.blobPath, sourceBytes }
      })
      if ('status' in snapshot) return snapshot
      const force = refreshKeys !== undefined && !refreshKeys.has(snapshot.key)
      refreshKeys?.add(snapshot.key)
      const document = await this.extract(packagesOnly ? sha(snapshot.key + ':packages') : snapshot.key, snapshot.blobPath, force, packagesOnly)
      if (copyTo) {
        await fs.mkdir(path.dirname(copyTo), { recursive: true })
        await fs.copyFile(snapshot.blobPath, copyTo)
        if (companionRef !== 'ABSENT') await fs.copyFile(snapshot.blobPath.replace(/\.(uasset|umap)$/i, '.uexp'), copyTo.replace(/\.(uasset|umap)$/i, '.uexp'))
      }
      const geometry = nativeGeometry ? await nativeMeshService.extract(snapshot.blobPath, file, document, signal) : undefined
      return { ref, path: file, status: 'ready', sourceBytes: snapshot.sourceBytes, contentHash: snapshot.contentHash, documentKey: snapshot.key, document, ...(geometry ? { geometry } : {}) }
    } catch (error) {
      return { ref, path: file, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    } finally { await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}) }
  }

  private async extract(key: string, file: string, force = false, packagesOnly = false): Promise<BlueprintDocument> {
    if (this.stopping) throw new Error('Blueprint reader is shutting down.')
    if (force) this.cache.delete(key)
    const cached = this.cache.get(key)
    if (cached) return cached
    const running = this.inFlight.get(key)
    if (running) return running
    const run = async () => {
      const disk = path.join(this.cacheDirectory, key + '.json')
      const saved = force ? null : await fs.stat(disk).then(stat => stat.size <= 32 * 1024 * 1024 ? fs.readFile(disk, 'utf8') : null).then(text => text ? JSON.parse(text) as BlueprintDocument : null).catch(() => null)
      if (saved?.schemaVersion === 1 && saved.readerVersion === READER_VERSION && Array.isArray(saved.graphs)) return saved
      if (this.active >= 2) {
        if (this.waiting.length >= 8) throw new Error('Blueprint reader is busy. Retry after the current reads finish.')
        await new Promise<void>((wake, reject) => this.waiting.push({ wake, reject }))
      } else this.active++
      try {
        const exe = path.join(this.helperDirectory, process.platform === 'win32' ? 'BlueprintExtractor.exe' : 'BlueprintExtractor')
        const dll = path.join(this.helperDirectory, 'BlueprintExtractor.dll')
        const bundled = await fs.access(exe).then(() => true, () => false)
        if (!bundled && !await fs.access(dll).then(() => true, () => false)) throw new Error('Blueprint reader is not installed. Build the Blueprint tools and restart the app.')
        const text = await new Promise<string>((resolve, reject) => {
          if (this.stopping) { reject(new Error('Blueprint reader is shutting down.')); return }
          const child = execFile(bundled ? exe : 'dotnet', [...(bundled ? [file] : [dll, file]), ...(packagesOnly ? ['--packages'] : [])], { timeout: 25_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          this.processes.delete(child)
          if (error) reject(new Error(stderr.trim() || 'Blueprint extraction failed or exceeded the 25 second limit.'))
          else resolve(stdout)
          })
          this.processes.add(child)
        })
        const document = JSON.parse(text) as BlueprintDocument
        if (document.readerVersion !== READER_VERSION) throw new Error('The installed Blueprint reader is outdated. Update or rebuild the Blueprint tools, then restart the app.')
        if (document.schemaVersion !== 1 || !Array.isArray(document.graphs)) throw new Error('Unexpected Blueprint reader response.')
        await fs.writeFile(disk, text)
        await this.prune()
        return document
      } finally { const next = this.waiting.shift(); if (next) next.wake(); else this.active-- }
    }
    const promise = run().then(document => {
      this.cache.set(key, document)
      while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!)
      return document
    }).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, promise)
    return promise
  }

  private async scene(repo: string, root: BlueprintSide, signal?: AbortSignal, refreshKeys?: Set<string>, bakeMaterials = false, lod = 0) {
    root = { ...root, path: root.path.replace(/\\/g,'/') }
    const directory = await fs.mkdtemp(path.join(this.cacheDirectory, 'scene-read-'))
    const ref = root.resolvedRef ?? root.ref
    try {
      const content = root.path.slice(0, root.path.indexOf('Content/') + 8)
      if (!content.endsWith('Content/') || /(?:^|\/)Plugins\//i.test(content)) throw new Error('Scene snapshots require a conventional Content mount.')
      const frozenIndex = new Map<string, string>()
      const projectSpec = ':(glob)' + content.slice(0,-8).replace(/[[\]*?\\]/g,'\\$&') + '*.uproject'
      if (ref !== 'WORKING') await withRepoSlot(repo, 'read', async () => {
        const index = await execSafe(ref === 'INDEX' ? ['ls-files', '--stage', '-z', '--', ':(literal)' + content,projectSpec] : ['ls-tree','-r','-z',ref,'--',':(literal)' + content], repo)
        if (index.exitCode !== 0 || Buffer.byteLength(index.stdout) > 4 * 1024 * 1024) throw new Error('Index scene manifest is unavailable or too large.')
        for (const entry of index.stdout.split('\0').filter(Boolean)) {
          const match = (ref === 'INDEX' ? /^\d+ ([a-f0-9]{40}) (\d)\t(.+)$/ : /^\d+ (blob) ([a-f0-9]{40})\t(.+)$/).exec(entry)
          if (!match || ref === 'INDEX' && match[2] !== '0') throw new Error('Resolve index conflicts before reconstructing this scene.')
          frozenIndex.set(match[3], ref === 'INDEX' ? match[1] : match[2])
        }
        if (ref !== 'INDEX') {
          const folder = content.slice(0,-8)
          const top = await execSafe(['ls-tree','-z',ref + (folder ? ':' + folder.replace(/\/$/,'') : '')],repo)
          if (top.exitCode !== 0 || Buffer.byteLength(top.stdout) > 1024 * 1024) throw new Error('Captured project folder is unavailable.')
          for (const entry of top.stdout.split('\0').filter(Boolean)) {
            const match = /^\d+ blob ([a-f0-9]{40})\t(.+\.uproject)$/i.exec(entry)
            if (match) frozenIndex.set(folder + match[2],match[1])
          }
        }
      })
      const locate = async (file: string): Promise<string | null> => {
        if (ref !== 'WORKING') return frozenIndex.has(file) ? 'BLOB:' + frozenIndex.get(file) : null
        if (ref === 'WORKING') {
          const absolute = await fs.realpath(path.join(repo, file)).catch(() => null)
          if (!absolute) return null
          const relative = path.relative(repo, absolute)
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Scene dependency leaves the repository.')
          return 'WORKING'
        }
        return null
      }
      let projectStamp: { file: string; identity: string } | undefined
      const projectIdentity = async (file: string) => {
        const stat = await fs.stat(path.join(repo, file), { bigint: true })
        return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      }
      const exportEngineVersion = await withRepoSlot(repo, 'read', async () => {
        const folder = content.slice(0,-8)
        const spec = ':(glob)' + folder.replace(/[[\]*?\\]/g,'\\$&') + '*.uproject'
        const manifest = ref === 'WORKING' ? await execSafe(['ls-files','-z','--cached','--others','--exclude-standard','--',spec],repo) : { exitCode: 0, stdout: [...frozenIndex.keys()].filter(file => /\.uproject$/i.test(file)).join('\0') }
        if (manifest.exitCode !== 0 || Buffer.byteLength(manifest.stdout) > 4 * 1024 * 1024) return undefined
        const candidates = [...new Set(manifest.stdout.split('\0').filter(file => file.startsWith(folder) && !file.slice(folder.length).includes('/') && /\.uproject$/i.test(file)))]
        if (candidates.length !== 1) return undefined
        const source = await locate(candidates[0])
        if (!source) return undefined
        if (ref === 'WORKING') projectStamp = { file: candidates[0], identity: await projectIdentity(candidates[0]) }
        const size = await estimatedCaptureBytes(repo,candidates[0],source)
        if (size > 1024 * 1024) throw new Error('Project association metadata exceeds 1 MB.')
        const project = await assetDiffService.extractBlob(repo,candidates[0],source,directory,'left',refreshKeys)
        if (!project.blobPath) throw new Error('Captured project association is unavailable.')
        const config = JSON.parse(await fs.readFile(project.blobPath,'utf8'))
        const association = config.EngineAssociation
        return typeof association === 'string' && /^5\.\d+(?:\.\d+)?$/.test(association) ? association : undefined
      })
      const snapshot = await captureSceneSnapshot({ root, directory, signal,
        stamp: async files => {
          if (ref === 'INDEX') return '' // OIDs and paths are already frozen as one index manifest.
          if (ref !== 'WORKING') return ''
          const variants = files.flatMap(file => ['.uasset','.umap','.uexp','.ubulk','.uptnl'].map(ext => file.replace(/\.(uasset|umap)$/i, ext)))
          const values = []
          for (const file of variants) {
            await locate(file)
            const stat = await fs.stat(path.join(repo, file), { bigint: true }).catch(() => null)
            values.push(file + ':' + (stat ? `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'absent'))
          }
          return values.join('\0')
        },
        external: map => withRepoSlot(repo, 'read', async () => {
          const actors = externalActorPrefix(map)
          if (!actors) return []
          const prefixes = [actors, actors.replace('/__ExternalActors__/', '/__ExternalObjects__/')]
          if (ref !== 'WORKING') return [...frozenIndex.keys()].filter(file => prefixes.some(prefix => file.startsWith(prefix)) && /\.uasset$/i.test(file)).sort()
          const result = await execSafe(ref === 'WORKING' ? ['ls-files','-z','--cached','--others','--exclude-standard','--',...prefixes.map(p => ':(literal)' + p)] : ['ls-tree','-r','--name-only','-z',ref,'--',...prefixes.map(p => ':(literal)' + p)], repo)
          if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 2 * 1024 * 1024) throw new Error('World external-package manifest is unavailable or too large.')
          return [...new Set(result.stdout.split('\0').filter(file => /\.uasset$/i.test(file)))].sort()
        }),
        capture: async (requested, destination, remaining) => {
          let file = requested
          const version = await withRepoSlot(repo, 'read', async () => {
            let source = await locate(file)
            if (file !== root.path && /\.uasset$/i.test(file) && source && await locate(file.replace(/\.uasset$/i,'.umap'))) throw new Error('Dependency has competing asset and map packages in this revision.')
            if (!source && /\.uasset$/i.test(file)) { file = file.replace(/\.uasset$/i,'.umap'); source = await locate(file) }
            if (!source) return null
            const companion = await locate(file.replace(/\.(umap|uasset)$/i,'.uexp'))
            const companionStat = companion === 'WORKING' ? await fs.stat(path.join(repo,file.replace(/\.(umap|uasset)$/i,'.uexp')), {bigint:true}) : null
            return { source, companion: companion ?? 'ABSENT', companionIdentity: companionStat ? `${companionStat.size}:${companionStat.mtimeNs}:${companionStat.ctimeNs}` : '' }
          })
          if (!version) return { status: 'unavailable' as const, ref, path: requested, reason: 'Dependency is absent in the selected revision.' }
          destination = destination.replace(/\.(uasset|umap)$/i, path.extname(file))
          const captured = await this.loadSide(repo,file,version.source,ref,version.companion,version.companionIdentity,refreshKeys,Math.min(MAX_BYTES,remaining),signal,false,destination,file !== root.path)
          if (captured.status !== 'ready') return captured
          let bytes = captured.sourceBytes ?? 0
          const hashes = [captured.documentKey!]
          for (const ext of ['.ubulk','.uptnl']) await withRepoSlot(repo, 'read', async () => {
            const bulkFile = file.replace(/\.(uasset|umap)$/i,ext), source = await locate(bulkFile)
            if (!source) return
            const estimate = await estimatedCaptureBytes(repo, bulkFile, source)
            if (estimate > Math.min(MAX_BYTES, remaining - bytes)) throw new Error('Scene bulk data exceeds the capture byte budget.')
            const temporary = await fs.mkdtemp(path.join(directory,'bulk-'))
            try {
              const blob = await assetDiffService.extractBlob(repo,bulkFile,source,temporary,'left',refreshKeys)
              if (!blob.blobPath) throw new Error(blob.reason ?? 'Bulk revision is unavailable.')
              let data: Buffer = await fs.readFile(blob.blobPath)
              if (data.subarray(0,42).toString().startsWith('version https://git-lfs.github.com/spec/v1')) data = await assetDiffService.resolveLfsPointer(repo,bulkFile,data,refreshKeys)
              if (data.length > Math.min(MAX_BYTES,remaining-bytes)) throw new Error('Scene bulk data exceeds the capture byte budget.')
              await fs.writeFile(destination.replace(/\.(uasset|umap)$/i,ext),data)
              hashes.push(sha(data)); bytes += data.length
            } finally { await fs.rm(temporary,{recursive:true,force:true}) }
          })
          return { ...captured, sourceBytes: bytes, snapshotHash: sha(hashes.join('\0')) }
        }
      })
      if (projectStamp && await projectIdentity(projectStamp.file) !== projectStamp.identity) throw new Error('Working project association changed during scene capture. Retry.')
      return await nativeSceneService.extract(root,directory,{...snapshot,exportEngineVersion},signal,bakeMaterials,refreshKeys !== undefined,lod)
    } catch (error) {
      return { status: 'unavailable' as const, engineVersion: root.document?.engineVersion ?? '', packages: [], complete: false, diagnostics: [], reason: error instanceof Error ? error.message : String(error) }
    } finally { await fs.rm(directory,{recursive:true,force:true}).catch(() => {}) }
  }

  private async prune() {
    if (Date.now() - this.pruneAt < 60_000) return
    this.pruneAt = Date.now()
    const files = await fs.readdir(this.cacheDirectory)
    const entries = await Promise.all(files.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(async f => ({ file: path.join(this.cacheDirectory, f), stat: await fs.stat(path.join(this.cacheDirectory, f)) })))
    let total = entries.reduce((sum, e) => sum + e.stat.size, 0)
    for (const entry of entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
      if (total <= MAX_CACHE_BYTES) break
      await fs.unlink(entry.file); total -= entry.stat.size
    }
  }

  stop() {
    nativeMeshService.stop()
    nativeSceneService.stop()
    this.stopping = true
    for (const child of this.processes) child.kill()
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error('Blueprint reader is shutting down.'))
    this.cache.clear(); this.identities.clear()
  }
}
export const blueprintRevisionService = new BlueprintRevisionService()
