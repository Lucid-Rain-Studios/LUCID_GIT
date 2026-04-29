import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { execSafe } from '../util/dugite-exec'
import { ueHeadlessService } from './UEHeadlessService'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AssetType =
  | 'texture' | 'audio' | 'video'
  | 'level' | 'generic-ue'
  | 'binary'

export interface PreviewData {
  previewPath: string | null   // absolute path to cached PNG, or null
  sizeBytes: number
  width?: number
  height?: number
  format?: string
}

export type AssetDelta =
  | { kind: 'texture'
      sizeDelta: number
      widthBefore: number; heightBefore: number
      widthAfter: number;  heightAfter: number
      formatBefore: string; formatAfter: string }
  | { kind: 'metadata'
      before: Record<string, string>
      after:  Record<string, string> }
  | { kind: 'unavailable'; reason: string }

export interface AssetDiffResult {
  assetType: AssetType
  left:  PreviewData
  right: PreviewData
  delta: AssetDelta
  cacheKey: string
  ueAvailable: boolean
  fallbackReason: string | null
}

export interface AssetDiffRequest {
  repoPath:  string
  filePath:  string
  leftRef:   string   // commit SHA, 'HEAD', 'INDEX', or 'WORKING'
  rightRef:  string
  editorBinaryOverride?: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEXTURE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.tga', '.bmp', '.gif', '.tiff', '.tif', '.exr', '.hdr', '.psd', '.dds', '.webp'])
const AUDIO_EXTS   = new Set(['.wav', '.mp3', '.ogg', '.flac', '.aif', '.aiff', '.wem'])
const VIDEO_EXTS   = new Set(['.mp4', '.avi', '.mov', '.wmv', '.mkv', '.bk2'])
const LFS_POINTER  = 'version https://git-lfs.github.com/spec/v1'
const CACHE_BASE   = path.join(os.homedir(), '.lucid-git', 'cache', 'asset-diffs')
const CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB

// ── Sharp (optional native dep) ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpLib: any = null
try { sharpLib = require('sharp') } catch { /* not installed */ }

// ── Helpers ───────────────────────────────────────────────────────────────────

function hash8(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8)
}

function cacheDir(req: AssetDiffRequest): string {
  return path.join(
    CACHE_BASE,
    hash8(req.repoPath),
    `${hash8(req.filePath)}-${hash8(req.leftRef)}-${hash8(req.rightRef)}`,
  )
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0
  try {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) total += await dirSizeBytes(full)
      else try { total += (await fs.promises.stat(full)).size } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total
}

// ── Service ───────────────────────────────────────────────────────────────────

class AssetDiffService {
  classify(filePath: string): AssetType {
    const ext = path.extname(filePath).toLowerCase()
    if (TEXTURE_EXTS.has(ext)) return 'texture'
    if (AUDIO_EXTS.has(ext))   return 'audio'
    if (VIDEO_EXTS.has(ext))   return 'video'
    if (ext === '.umap')       return 'level'
    if (ext === '.uasset' || ext === '.upk' || ext === '.udk') return 'generic-ue'
    return 'binary'
  }

  /**
   * Extract one side of a diff to the cache directory.
   * Returns the path to the extracted file, or null if unavailable.
   */
  async extractBlob(
    repoPath: string,
    filePath: string,
    ref: string,
    destDir: string,
    side: 'left' | 'right',
  ): Promise<{ blobPath: string | null; sizeBytes: number }> {
    const ext      = path.extname(filePath)
    const destFile = path.join(destDir, `${side}${ext}`)

    // Working-tree file — copy directly
    if (ref === 'WORKING') {
      const src = path.join(repoPath, filePath)
      try {
        const stat = await fs.promises.stat(src)
        await fs.promises.copyFile(src, destFile)
        return { blobPath: destFile, sizeBytes: stat.size }
      } catch {
        return { blobPath: null, sizeBytes: 0 }
      }
    }

    // Git blob extraction
    const gitRef = ref === 'INDEX' ? `:${filePath}` : `${ref}:${filePath}`
    const { exitCode, stdout } = await execSafe(['cat-file', '-p', gitRef], repoPath)

    if (exitCode !== 0) return { blobPath: null, sizeBytes: 0 }

    // LFS pointer? Attempt smudge.
    if (stdout.startsWith(LFS_POINTER)) {
      const smudge = await execSafe(
        ['lfs', 'smudge', '--', filePath],
        repoPath,
        // pass pointer on stdin — not supported by execSafe, use pointer file instead
      )
      // Write pointer to a temp file, smudge it
      const ptrFile = path.join(destDir, `${side}.lfsptr`)
      try {
        await fs.promises.writeFile(ptrFile, stdout, 'utf8')
        // git lfs smudge reads from stdin; use execSafe to pipe
        const { execSync } = require('child_process')
        const binary = execSync(
          `git lfs smudge -- "${filePath}"`,
          { cwd: repoPath, input: stdout, maxBuffer: 256 * 1024 * 1024 }
        ) as Buffer
        await fs.promises.writeFile(destFile, binary)
        await fs.promises.unlink(ptrFile).catch(() => {})
        return { blobPath: destFile, sizeBytes: binary.length }
      } catch {
        // LFS server unavailable — return null but extract size from pointer
        const sizeMatch = stdout.match(/size (\d+)/)
        await fs.promises.unlink(ptrFile).catch(() => {})
        return { blobPath: null, sizeBytes: sizeMatch ? parseInt(sizeMatch[1]) : 0 }
      }
    }

    // Plain binary blob
    try {
      const { execSync } = require('child_process')
      const binary = execSync(
        `git cat-file -p ${gitRef}`,
        { cwd: repoPath, maxBuffer: 256 * 1024 * 1024 }
      ) as Buffer
      await fs.promises.writeFile(destFile, binary)
      return { blobPath: destFile, sizeBytes: binary.length }
    } catch {
      return { blobPath: null, sizeBytes: 0 }
    }
  }

  /**
   * Scan a buffer for embedded PNG streams (UE assets embed thumbnails as raw PNG).
   * Returns all valid PNG buffers found, largest first.
   */
  private extractPNGsFromBuffer(buf: Buffer): Buffer[] {
    const PNG_SIG  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const IEND_TYPE = Buffer.from([0x49, 0x45, 0x4E, 0x44]) // 'IEND'
    const results: Buffer[] = []
    let searchFrom = 0

    while (searchFrom < buf.length) {
      const start = buf.indexOf(PNG_SIG, searchFrom)
      if (start === -1) break

      let pos = start + 8  // skip 8-byte signature
      let found = false

      while (pos + 12 <= buf.length) {
        const dataLen = buf.readUInt32BE(pos)
        if (dataLen > 64 * 1024 * 1024) break  // sanity: no chunk > 64 MB
        const chunkEnd = pos + 4 + 4 + dataLen + 4  // len(4) + type(4) + data + crc(4)
        if (chunkEnd > buf.length) break
        if (buf.slice(pos + 4, pos + 8).equals(IEND_TYPE)) {
          results.push(buf.slice(start, chunkEnd))
          searchFrom = chunkEnd
          found = true
          break
        }
        pos = chunkEnd
      }

      if (!found) searchFrom = start + 1
    }

    // Largest PNG first (highest resolution thumbnail)
    return results.sort((a, b) => b.length - a.length)
  }

  /** Extract the best embedded PNG thumbnail from a UE asset binary file. */
  private async extractUEThumbnail(blobPath: string, outPng: string): Promise<boolean> {
    try {
      const buf  = await fs.promises.readFile(blobPath)
      const pngs = this.extractPNGsFromBuffer(buf)
      if (pngs.length === 0 || pngs[0].length < 67) return false  // min valid PNG ~67 bytes
      await fs.promises.writeFile(outPng, pngs[0])
      return true
    } catch {
      return false
    }
  }

  /** Build a PreviewData (PNG thumbnail) for an image blob using sharp. */
  private async renderTexturePreview(
    blobPath: string,
    outPng: string,
  ): Promise<{ width: number; height: number; format: string } | null> {
    if (!sharpLib || !blobPath) return null
    try {
      const img = sharpLib(blobPath)
      const meta = await img.metadata()
      // Write a capped-size preview PNG (max 800px wide)
      await img
        .resize({ width: 800, withoutEnlargement: true })
        .png()
        .toFile(outPng)
      return {
        width:  meta.width  ?? 0,
        height: meta.height ?? 0,
        format: meta.format ?? 'unknown',
      }
    } catch {
      return null
    }
  }

  /** Evict cache entries (oldest-first) until total size is under CACHE_MAX_BYTES. */
  private async evictCache(): Promise<void> {
    const total = await dirSizeBytes(CACHE_BASE)
    if (total <= CACHE_MAX_BYTES) return

    // Collect all entry dirs with their mtimes
    const entries: { dir: string; mtime: number }[] = []
    try {
      for (const repo of await fs.promises.readdir(CACHE_BASE)) {
        const repoDir = path.join(CACHE_BASE, repo)
        for (const entry of await fs.promises.readdir(repoDir)) {
          const entryDir = path.join(repoDir, entry)
          try {
            const stat = await fs.promises.stat(entryDir)
            entries.push({ dir: entryDir, mtime: stat.mtimeMs })
          } catch { /* skip */ }
        }
      }
    } catch { return }

    entries.sort((a, b) => a.mtime - b.mtime)
    let remaining = total

    for (const { dir } of entries) {
      if (remaining <= CACHE_MAX_BYTES * 0.8) break
      const size = await dirSizeBytes(dir)
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {})
      remaining -= size
    }
  }

  /** Main entry point: diff two refs of one file. Results are cached. */
  async diff(req: AssetDiffRequest): Promise<AssetDiffResult> {
    const assetType = this.classify(req.filePath)
    const dir = cacheDir(req)
    const resultFile = path.join(dir, 'result.json')
    const key = `${hash8(req.repoPath)}-${hash8(req.filePath)}-${hash8(req.leftRef)}-${hash8(req.rightRef)}`

    // Cache hit
    if (fs.existsSync(resultFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as AssetDiffResult
        // Touch to update mtime for LRU eviction
        fs.utimesSync(dir, new Date(), new Date())
        return cached
      } catch { /* corrupt cache — re-render */ }
    }

    fs.mkdirSync(dir, { recursive: true })

    // Extract both blobs
    const [leftBlob, rightBlob] = await Promise.all([
      this.extractBlob(req.repoPath, req.filePath, req.leftRef,  dir, 'left'),
      this.extractBlob(req.repoPath, req.filePath, req.rightRef, dir, 'right'),
    ])

    let left:  PreviewData = { previewPath: null, sizeBytes: leftBlob.sizeBytes }
    let right: PreviewData = { previewPath: null, sizeBytes: rightBlob.sizeBytes }
    let delta: AssetDelta  = { kind: 'unavailable', reason: 'No preview available' }
    let ueAvailable        = false
    let fallbackReason: string | null = null

    // ── Texture / image ────────────────────────────────────────────────────────
    if (assetType === 'texture') {
      if (!sharpLib) {
        fallbackReason = 'Image processing library (sharp) not available'
      } else {
        const leftOut  = path.join(dir, 'left.preview.png')
        const rightOut = path.join(dir, 'right.preview.png')

        const [leftMeta, rightMeta] = await Promise.all([
          leftBlob.blobPath  ? this.renderTexturePreview(leftBlob.blobPath, leftOut)   : Promise.resolve(null),
          rightBlob.blobPath ? this.renderTexturePreview(rightBlob.blobPath, rightOut) : Promise.resolve(null),
        ])

        if (leftMeta)  left  = { previewPath: leftOut,  sizeBytes: leftBlob.sizeBytes,  ...leftMeta }
        if (rightMeta) right = { previewPath: rightOut, sizeBytes: rightBlob.sizeBytes, ...rightMeta }

        delta = {
          kind: 'texture',
          sizeDelta:    rightBlob.sizeBytes - leftBlob.sizeBytes,
          widthBefore:  leftMeta?.width  ?? 0,
          heightBefore: leftMeta?.height ?? 0,
          widthAfter:   rightMeta?.width  ?? 0,
          heightAfter:  rightMeta?.height ?? 0,
          formatBefore: leftMeta?.format  ?? 'unknown',
          formatAfter:  rightMeta?.format ?? 'unknown',
        }
      }
    }

    // ── UE assets / levels — extract embedded thumbnails, then try commandlet ───
    if (assetType === 'generic-ue' || assetType === 'level') {
      const project = req.repoPath
      let editorBin: string | null = null
      try {
        const entries = fs.readdirSync(req.repoPath)
        const uproject = entries.find(f => f.endsWith('.uproject'))
        if (uproject) {
          const raw = JSON.parse(fs.readFileSync(path.join(req.repoPath, uproject), 'utf8'))
          editorBin = await ueHeadlessService.findEditorBinary(
            raw['EngineAssociation'] ?? '',
            req.editorBinaryOverride,
          )
        }
      } catch { /* no uproject */ }

      if (!editorBin) {
        fallbackReason = 'Unreal Editor not found — showing metadata only'
      } else if (ueHeadlessService.isEditorRunning(project)) {
        fallbackReason = 'Unreal Editor is open — cannot spawn commandlet while editor is running'
      } else {
        ueAvailable = true
        fallbackReason = 'UE commandlet diff not yet available in this build'
      }

      // Try to extract embedded PNG thumbnails from each side's binary
      const leftThumbOut  = path.join(dir, 'left.preview.png')
      const rightThumbOut = path.join(dir, 'right.preview.png')
      const [leftHasThumb, rightHasThumb] = await Promise.all([
        leftBlob.blobPath  ? this.extractUEThumbnail(leftBlob.blobPath,  leftThumbOut)  : Promise.resolve(false),
        rightBlob.blobPath ? this.extractUEThumbnail(rightBlob.blobPath, rightThumbOut) : Promise.resolve(false),
      ])

      if (leftHasThumb)  left  = { ...left,  previewPath: leftThumbOut }
      if (rightHasThumb) right = { ...right, previewPath: rightThumbOut }

      if (leftHasThumb || rightHasThumb) {
        // Use texture-kind delta so AssetDiffViewer renders image panes
        delta = {
          kind:         'texture',
          sizeDelta:    rightBlob.sizeBytes - leftBlob.sizeBytes,
          widthBefore:  0, heightBefore: 0,
          widthAfter:   0, heightAfter:  0,
          formatBefore: assetType === 'level' ? 'Level (.umap)'    : 'UE Asset (.uasset)',
          formatAfter:  assetType === 'level' ? 'Level (.umap)'    : 'UE Asset (.uasset)',
        }
        if (leftHasThumb && rightHasThumb) fallbackReason = null
      } else {
        // No embedded thumbnail — metadata fallback
        delta = {
          kind: 'metadata',
          before: {
            'File size': formatBytes(leftBlob.sizeBytes),
            'Type':      assetType === 'level' ? 'Level (.umap)' : 'UE Asset (.uasset)',
            'Ref':       req.leftRef,
          },
          after: {
            'File size': formatBytes(rightBlob.sizeBytes),
            'Type':      assetType === 'level' ? 'Level (.umap)' : 'UE Asset (.uasset)',
            'Ref':       req.rightRef,
          },
        }
      }
    }

    // ── Audio / video / other binary — metadata only ───────────────────────────
    if (assetType === 'audio' || assetType === 'video' || assetType === 'binary') {
      delta = {
        kind: 'metadata',
        before: { 'File size': formatBytes(leftBlob.sizeBytes),  'Ref': req.leftRef },
        after:  { 'File size': formatBytes(rightBlob.sizeBytes), 'Ref': req.rightRef },
      }
    }

    const result: AssetDiffResult = {
      assetType, left, right, delta, cacheKey: key, ueAvailable, fallbackReason,
    }

    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf8')
    this.evictCache().catch(() => {})

    return result
  }

  /** Single-ref thumbnail — used by file row, BinaryDiff, and history panel. */
  async renderThumbnail(repoPath: string, filePath: string, ref: string): Promise<string | null> {
    const dir = path.join(CACHE_BASE, hash8(repoPath), `thumb-${hash8(filePath)}-${hash8(ref)}`)
    fs.mkdirSync(dir, { recursive: true })

    const outPng = path.join(dir, 'thumb.png')
    if (fs.existsSync(outPng)) return outPng

    const blob = await this.extractBlob(repoPath, filePath, ref, dir, 'left')
    if (!blob.blobPath) return null

    // UE assets: try to extract the embedded PNG thumbnail first
    const ext = path.extname(filePath).toLowerCase()
    if (ext === '.uasset' || ext === '.umap' || ext === '.upk' || ext === '.udk') {
      if (await this.extractUEThumbnail(blob.blobPath, outPng)) return outPng
    }

    // Image files: use sharp
    if (!sharpLib) return null
    const meta = await this.renderTexturePreview(blob.blobPath, outPng)
    return meta ? outPng : null
  }

  /** Lightweight metadata — no rendering. */
  async extractMetadata(repoPath: string, filePath: string, ref: string): Promise<Record<string, string>> {
    const assetType = this.classify(filePath)
    const dir = path.join(CACHE_BASE, hash8(repoPath), `meta-${hash8(filePath)}-${hash8(ref)}`)
    fs.mkdirSync(dir, { recursive: true })

    const blob = await this.extractBlob(repoPath, filePath, ref, dir, 'left')
    const meta: Record<string, string> = {
      'File size': formatBytes(blob.sizeBytes),
      'Type':      assetType,
      'Ref':       ref,
    }

    if (assetType === 'texture' && blob.blobPath && sharpLib) {
      try {
        const info = await sharpLib(blob.blobPath).metadata()
        meta['Width']  = `${info.width ?? '?'}px`
        meta['Height'] = `${info.height ?? '?'}px`
        meta['Format'] = info.format ?? 'unknown'
      } catch { /* ignore */ }
    }

    return meta
  }
}

function formatBytes(b: number): string {
  if (b <= 0)             return '0 B'
  if (b < 1_024)          return `${b} B`
  if (b < 1_048_576)      return `${(b / 1_024).toFixed(1)} KB`
  if (b < 1_073_741_824)  return `${(b / 1_048_576).toFixed(1)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
}

export const assetDiffService = new AssetDiffService()
