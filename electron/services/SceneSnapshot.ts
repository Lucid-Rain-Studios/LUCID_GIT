import * as fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { BlueprintSide, NativeSceneReview } from '../blueprintTypes'

export function gamePackageFile(packageName: string, root: string) {
  const content = /^(.*(?:^|\/)Content)\//.exec(root)?.[1]
  if (!content || /(?:^|\/)Plugins\//i.test(content) || !packageName.startsWith('/Game/')) return null
  const suffix = packageName.slice(6)
  if (!suffix.split('/').every(part => part.length > 0 && part.length < 256 && /^[\p{L}\p{N}_ -]+$/u.test(part))) return null
  return content + '/' + suffix
}

/** Exact-revision closure; dependencies are discovered from package tables, not names in text. */
export async function captureSceneSnapshot(args: {
  root: BlueprintSide; directory: string; signal?: AbortSignal
  capture(file: string, destination: string, remaining: number): Promise<BlueprintSide>
  external(map: string): Promise<string[]>
  stamp(files: string[]): Promise<string>
}) {
  const packages: NativeSceneReview['packages'] = [], diagnostics: string[] = []
  const documents = new Map<string, string>()
  const actorNames = new Set<string>()
  const actorCandidates: Array<{ path: string; classPath: string; package: string }> = []
  let actorManifestComplete = true
  const initial = await args.stamp([])
  let remaining = 512 * 1024 * 1024
  const queue = [args.root.path], seen = new Set<string>(), scheduled = new Set(queue), stamps = new Map<string, string>()
  const enqueue = (file: string) => {
    if (scheduled.has(file)) return
    if (scheduled.size >= 256) { if (!diagnostics.includes('Dependency package limit reached (256).')) diagnostics.push('Dependency package limit reached (256).'); return }
    scheduled.add(file); queue.push(file)
  }
  while (queue.length) {
    if (args.signal?.aborted) throw new Error('Scene capture cancelled.')
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    if (seen.size > 256) { diagnostics.push('Dependency package limit reached (256).'); break }
    if (remaining <= 0) { diagnostics.push('Dependency byte limit reached (512 MB).'); break }
    stamps.set(file, await args.stamp([file]))
    const destination = path.join(args.directory, file.slice(file.indexOf('Content/')))
    const captured = await args.capture(file, destination, remaining)
    if (captured.status !== 'ready') { diagnostics.push(`${file}: ${captured.reason ?? captured.status}`); continue }
    if (file === args.root.path && captured.documentKey !== args.root.documentKey) throw new Error('Root asset changed before dependency capture. Retry.')
    if (!captured.document?.assetReview?.packages || captured.document.assetReview.packageReferencesComplete !== true) throw new Error('Update the package reader: dependency tables are unavailable or incomplete.')
    documents.set(file, captured.document.engineVersion)
    for (const name of captured.document.assetReview.actorNames ?? []) actorNames.add(name)
    const candidates = captured.document.assetReview.actorCandidates
    if (!Array.isArray(candidates) || captured.document.assetReview.actorCandidatesComplete !== true) actorManifestComplete = false
    const packageName = '/Game/' + captured.path.slice(captured.path.indexOf('Content/') + 8).replace(/\.(uasset|umap)$/i,'')
    for (const candidate of candidates ?? []) {
      if (actorCandidates.length >= 10000) { actorManifestComplete = false; break }
      if (typeof candidate.path !== 'string' || typeof candidate.classPath !== 'string' || candidate.path.length > 2048 || candidate.classPath.length > 2048) { actorManifestComplete = false; continue }
      const serialized = candidate.path.startsWith('/Game/') ? candidate.path : packageName + '.' + candidate.path
      if (!serialized.includes('.PersistentLevel.') || candidate.classPath === 'None') { actorManifestComplete = false; continue }
      actorCandidates.push({ path: serialized.replace('.PersistentLevel.', ':PersistentLevel.'), classPath: candidate.classPath, package: packageName })
    }
    const bytes = captured.sourceBytes ?? 0
    remaining -= bytes
    packages.push({ path: captured.path, hash: captured.snapshotHash ?? captured.documentKey!, bytes })
    for (const name of captured.document.assetReview.packages) {
      if (name.startsWith('/Engine/') || name.startsWith('/Script/')) continue
      const candidate = gamePackageFile(name, args.root.path)
      if (!candidate) { diagnostics.push(`Unsupported dependency mount: ${name}`); continue }
      // capture callback resolves the extension uniquely at the same frozen revision.
      if (!seen.has(candidate + '.uasset') && !seen.has(candidate + '.umap')) enqueue(candidate + '.uasset')
    }
    if (captured.document.assetClass === '/Script/Engine.World') for (const file of await args.external(captured.path)) enqueue(file)
  }
  if (await args.stamp([]) !== initial) throw new Error('Index changed during scene capture. Retry.')
  for (const [file, stamp] of stamps) if (await args.stamp([file]) !== stamp) throw new Error('Working dependency changed during scene capture. Retry.')
  if (!documents.has(args.root.path)) throw new Error('Root package is unavailable for scene capture.')
  const identity = crypto.createHash('sha256').update(JSON.stringify(packages)).digest('hex')
  const versions = [...documents.values()].filter(v => /^5\.\d+\./.test(v)).sort((a,b) => Number(b.split('.')[1]) - Number(a.split('.')[1]))
  return { packages, diagnostics: [...new Set(diagnostics)].slice(0, 100), complete: diagnostics.length === 0, identity, documents, minimumEngineVersion: versions[0], actorNames: [...actorNames], actorCandidates, actorManifestComplete }
}

export async function verifySceneInputs(directory: string) {
  const hashes = new Map<string, string>()
  async function visit(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) hashes.set(file, crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex'))
      else throw new Error('Unexpected linked file in captured scene.')
    }
  }
  await visit(path.join(directory, 'Content'))
  return async () => {
    for (const [file, hash] of hashes) if (crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex') !== hash) throw new Error('Engine changed captured scene input; result discarded.')
  }
}
