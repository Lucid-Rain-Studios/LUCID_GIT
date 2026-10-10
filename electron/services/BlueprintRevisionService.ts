import { app } from 'electron'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, type ChildProcess } from 'node:child_process'
import { assetDiffService } from './AssetDiffService'
import { execSafe, withGitTimeout } from '../util/dugite-exec'
import { owningMapCandidate } from '../util/external-actors'
import { confirmsMapOwnership, discoverExternalActors, emptyExternalReview, estimatedCaptureBytes, mutableActorStamp } from './ExternalActorReview'
import { withRepoSlot } from '../util/repo-gate'
import type { BlueprintComparison, BlueprintDocument, BlueprintRequest, BlueprintSide } from '../blueprintTypes'

const EXTRACTOR_VERSION = '9-uassetapi-3228c1e8'
const READER_VERSION = 9
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
    validatePath(req.filePath); validatePath(req.oldPath ?? req.filePath)
    validateRef(req.leftRef); validateRef(req.rightRef)
    if (req.knownDocuments !== undefined && (!Array.isArray(req.knownDocuments) || req.knownDocuments.length > 8 || req.knownDocuments.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)))) throw new Error('Invalid Blueprint document cache keys.')
    const repo = await fs.realpath(repoPath)
    const refreshKeys = req.force === true ? new Set<string>() : undefined
    return withGitTimeout(async () => {
      if (signal?.aborted) throw new Error('Blueprint review cancelled.')
      const maps = [req.oldPath ?? req.filePath, req.filePath]
      const refs = [req.leftRef, req.rightRef]
      if (req.externalActors) for (let i = 0; i < refs.length; i++) {
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
      const left = await this.side(repo, maps[0], refs[0], signal, refreshKeys)
      if (signal?.aborted) throw new Error('Blueprint review cancelled.')
      const right = await this.side(repo, maps[1], refs[1], signal, refreshKeys)
      if (signal?.aborted) throw new Error('Blueprint review cancelled.')
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
    }, 120_000, 'Blueprint revision read')
  }

  private async side(repo: string, file: string, ref: string, signal?: AbortSignal, refreshKeys?: Set<string>, byteLimit = MAX_BYTES): Promise<BlueprintSide> {
    const snapshot = await withRepoSlot(repo, 'read', () => this.resolveSide(repo, file, ref, signal))
    if ('status' in snapshot) return snapshot
    const { identity, resolved, companionIdentity, companionResolved } = snapshot
    if (byteLimit < MAX_BYTES) {
      const estimate = await withRepoSlot(repo, 'read', async () => await estimatedCaptureBytes(repo, file, resolved) + await estimatedCaptureBytes(repo, file.replace(/\.(uasset|umap)$/i, '.uexp'), companionResolved))
      if (estimate > byteLimit) return { ref, path: file, status: 'unavailable', reason: 'External actor package exceeds the remaining 64 MB capture budget.' }
    }
    const key = sha([repo, file, ref, identity, companionIdentity, EXTRACTOR_VERSION].join('\0'))
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
    return (result.sourceBytes ?? 0) > byteLimit ? { ref, path: file, status: 'unavailable', reason: 'External actor package exceeds the remaining 64 MB capture budget.' } : result
  }

  private async resolveSide(repo: string, file: string, ref: string, signal?: AbortSignal): Promise<BlueprintSide | { identity: string; resolved: string; companionIdentity: string; companionResolved: string }> {
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
    return { identity, resolved, companionIdentity, companionResolved }
  }

  private async loadSide(repo: string, file: string, resolved: string, ref: string, companionRef: string, companionIdentity: string, refreshKeys?: Set<string>, byteLimit = MAX_BYTES): Promise<BlueprintSide> {
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
      const document = await this.extract(snapshot.key, snapshot.blobPath, force)
      return { ref, path: file, status: 'ready', sourceBytes: snapshot.sourceBytes, contentHash: snapshot.contentHash, documentKey: snapshot.key, document }
    } catch (error) {
      return { ref, path: file, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    } finally { await fs.rm(temporary, { recursive: true, force: true }).catch(() => {}) }
  }

  private async extract(key: string, file: string, force = false): Promise<BlueprintDocument> {
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
          const child = execFile(bundled ? exe : 'dotnet', bundled ? [file] : [dll, file], { timeout: 25_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
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
    this.stopping = true
    for (const child of this.processes) child.kill()
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error('Blueprint reader is shutting down.'))
    this.cache.clear(); this.identities.clear()
  }
}
export const blueprintRevisionService = new BlueprintRevisionService()
