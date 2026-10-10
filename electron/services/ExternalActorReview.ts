import * as fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSafe } from '../util/dugite-exec'
import { externalActorPrefix, mapPackagePath } from '../util/external-actors'
import type { BlueprintSide, ExternalActorReview } from '../blueprintTypes'

export const MAX_EXTERNAL_PACKAGES = 16
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Asset review cancelled.') }

export function confirmsMapOwnership(side: BlueprintSide, map: string): boolean {
  const packagePath = mapPackagePath(map)
  return !!packagePath && !!side.document?.assetReview?.objects.some(object =>
    object.outer.startsWith(packagePath + '.') && /^\.[^.]+\.PersistentLevel(?:\.|$)/.test(object.outer.slice(packagePath.length)) && !!object.id && object.properties.ActorGuid !== undefined)
}

/** On-demand changed-package manifest; Git enumerates paths, never reader bytes.
 * No filesystem walk or full-world decode. Call inside the repository read gate. */
export async function discoverExternalActors(repo: string, leftMap: string, rightMap: string, leftRef: string, rightRef: string, signal?: AbortSignal) {
  const leftPrefix = externalActorPrefix(leftMap), rightPrefix = externalActorPrefix(rightMap)
  if (!leftPrefix || !rightPrefix) throw new Error('External actor review requires a map under a Content folder.')
  const prefixes = [...new Set([leftPrefix, rightPrefix])]
  const specs = prefixes.map(prefix => ':(literal)' + prefix)
  const run = async (args: string[]) => {
    check(signal)
    const result = await execSafe(args, repo, { GIT_OPTIONAL_LOCKS: '0' })
    if (result.exitCode !== 0) throw new Error('External actor manifest is unavailable. Retry after the repository operation finishes.')
    if (Buffer.byteLength(result.stdout) > MAX_MANIFEST_BYTES) throw new Error('External actor manifest exceeds the 2 MB limit. Review individual packages instead.')
    return result.stdout.split('\0').filter(Boolean)
  }
  let paths: string[]
  if (leftRef === 'ABSENT' || rightRef === 'ABSENT') {
    const ref = leftRef === 'ABSENT' ? rightRef : leftRef
    paths = ref === 'ABSENT' ? [] : await run(ref === 'WORKING'
      ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...specs]
      : ref === 'INDEX' ? ['ls-files', '-z', '--', ...specs] : ['ls-tree', '-r', '--name-only', '-z', ref, '--', ...specs])
  } else if (leftRef === rightRef) paths = []
  else {
    const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z']
    const revisions = leftRef === 'WORKING' || rightRef === 'WORKING'
      ? (leftRef === 'INDEX' || rightRef === 'INDEX' ? [] : [leftRef === 'WORKING' ? rightRef : leftRef])
      : leftRef === 'INDEX' || rightRef === 'INDEX' ? ['--cached', leftRef === 'INDEX' ? rightRef : leftRef] : [leftRef, rightRef]
    paths = await run([...base, ...revisions, '--', ...specs])
  }
  if (leftRef === 'WORKING' || rightRef === 'WORKING') paths.push(...await run(['ls-files', '-z', '--others', '--exclude-standard', '--', ...specs]))
  // A companion-only change must invalidate its owning package too.
  paths = [...new Set(paths.map(file => file.replace(/\.uexp$/i, '.uasset')).filter(file => /\.uasset$/i.test(file) && prefixes.some(prefix => file.startsWith(prefix))))].sort()
  const suffixes = [...new Set(paths.map(file => file.slice(prefixes.find(prefix => file.startsWith(prefix))!.length)))].sort()
  const packages = suffixes.slice(0, MAX_EXTERNAL_PACKAGES).map(suffix => ({ leftPath: leftPrefix + suffix, rightPath: rightPrefix + suffix }))
  return { packages, total: suffixes.length, omitted: Math.max(0, suffixes.length - MAX_EXTERNAL_PACKAGES) }
}

// Freeze mutable selection metadata before capture and compare it again afterwards.
// Stats cover only selected packages/root/companions; index bytes support worktrees.
export async function mutableActorStamp(repo: string, maps: string[], files: string[], refs: string[]) {
  const values: string[] = []
  if (refs.includes('INDEX')) {
    const result = await execSafe(['rev-parse', '--git-path', 'index'], repo)
    if (result.exitCode !== 0) throw new Error('Index snapshot is unavailable.')
    const index = path.resolve(repo, result.stdout.trim())
    if ((await fs.stat(index)).size > 32 * 1024 * 1024) throw new Error('Index metadata exceeds the 32 MB external review limit.')
    const bytes = await fs.readFile(index)
    values.push(crypto.createHash('sha256').update(bytes).digest('hex'))
  }
  if (refs.includes('WORKING')) for (const file of [...new Set([...maps, ...files].flatMap(file => [file, file.replace(/\.(uasset|umap)$/i, '.uexp')]))]) {
    const absolute = await fs.realpath(path.join(repo, file)).catch(() => null)
    if (!absolute) { values.push(file + ':absent'); continue }
    const relative = path.relative(repo, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('External actor path leaves the repository.')
    const stat = await fs.stat(absolute, { bigint: true })
    values.push(`${file}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
  }
  return values.join('\0')
}

export function emptyExternalReview(message: string): ExternalActorReview {
  return { scope: 'changed-packages', total: 0, omitted: 0, packages: [], diagnostics: [message] }
}

/** Declared LFS size is checked before the existing downloader runs. Only small
 * pointer blobs are read here; normal packages use filesystem/Git size metadata. */
export async function estimatedCaptureBytes(repo: string, file: string, resolved: string): Promise<number> {
  if (resolved === 'ABSENT') return 0
  let size: number, pointer = ''
  if (resolved === 'WORKING') {
    const absolute = await fs.realpath(path.join(repo, file))
    const relative = path.relative(repo, absolute)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('External actor path leaves the repository.')
    size = (await fs.stat(absolute)).size
    if (size <= 1024) pointer = await fs.readFile(absolute, 'utf8')
  } else {
    const oid = resolved.replace(/^BLOB:/, '')
    const result = await execSafe(['cat-file', '-s', oid], repo)
    if (result.exitCode !== 0 || !Number.isFinite(Number(result.stdout))) throw new Error('External actor size is unavailable.')
    size = Number(result.stdout)
    if (size <= 1024) {
      const blob = await execSafe(['cat-file', 'blob', oid], repo)
      if (blob.exitCode !== 0) throw new Error('External actor pointer is unavailable.')
      pointer = blob.stdout
    }
  }
  return pointer.startsWith('version https://git-lfs.github.com/spec/v1') ? Number(/^size (\d+)$/m.exec(pointer)?.[1] ?? size) : size
}
