import fs from 'fs'
import path from 'path'
import { execSafe } from '../util/dugite-exec'
import { getDb } from '../db/database'
import type { OperationStep } from '../types'

const MAX_SCAN_BYTES = 4 * 1024 * 1024
const ASSET_REF_RE = /\/Game\/[A-Za-z0-9_\-/.]+/g

export interface DepNodeInfo {
  packageName: string
  filePath: string
  assetClass: string
  hardRefs: string[]
  softRefs: string[]
}

export interface DepCommit {
  hash: string
  author: string
  email: string
  timestamp: number
  message: string
  churnCount: number
}

export interface DepBlameEntry {
  filePath: string
  packageName: string
  assetClass: string
  hopDistance: number
  recentCommits: DepCommit[]
}

export interface SuspectEntry {
  hash: string
  author: string
  email: string
  timestamp: number
  message: string
  score: number
  reasons: string[]
  filePath: string
}

export interface DepBlameResult {
  target: DepBlameEntry
  dependencies: DepBlameEntry[]
  suspects: SuspectEntry[]
}

export interface DepGraphStatus {
  cacheKey: string
  nodeCount: number
  edgeCount: number
  builtAt: number
}

export interface DepRefResult {
  packageName: string
  referencedBy: DepNodeInfo[]
}

type ProgressCallback = (step: OperationStep) => void

// ── Utilities ─────────────────────────────────────────────────────────────────

function simpleHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

async function headSha(repoPath: string): Promise<string> {
  const r = await execSafe(['rev-parse', 'HEAD'], repoPath)
  return r.exitCode === 0 ? r.stdout.trim() : 'none'
}

function makeCacheKey(repoPath: string, sha: string): string {
  return `${simpleHash(repoPath)}-${sha.slice(0, 12)}`
}

function scanBuffer(buf: Buffer): string[] {
  const text = buf.toString('latin1')
  const matches = text.match(ASSET_REF_RE) ?? []
  return [...new Set(matches.map(r => r.replace(/[./\s]+$/, '')))]
}

function extractAssetClass(buf: Buffer): string {
  // Scan the first 2KB for a recognizable UE class name
  const text = buf.slice(0, 2048).toString('latin1')
  const classes = ['StaticMesh', 'SkeletalMesh', 'Texture2D', 'TextureCube', 'Material',
    'MaterialInstance', 'SoundWave', 'SoundCue', 'Blueprint', 'AnimSequence',
    'AnimBlueprint', 'World', 'DataTable', 'CurveFloat', 'Particle']
  for (const cls of classes) {
    if (text.includes(cls)) return cls
  }
  return 'Unknown'
}

function filePathToPackageName(filePath: string): string {
  const rel = filePath.replace(/\\/g, '/')
  const lower = rel.toLowerCase()
  const idx = lower.indexOf('/content/')
  if (idx >= 0) {
    const after = rel.slice(idx + 9)
    const withoutExt = after.replace(/\.(uasset|umap|udk|upk)$/i, '')
    return `/Game/${withoutExt}`
  }
  // Check if it starts with Content/ at root
  if (lower.startsWith('content/')) {
    const after = rel.slice(8)
    const withoutExt = after.replace(/\.(uasset|umap|udk|upk)$/i, '')
    return `/Game/${withoutExt}`
  }
  const withoutExt = rel.replace(/\.(uasset|umap|udk|upk)$/i, '').replace(/.*\//, '')
  return `/Game/${withoutExt}`
}

// ── Service ───────────────────────────────────────────────────────────────────

type DbRow = {
  package_name: string
  file_path: string
  asset_class: string
  hard_refs: string
  soft_refs: string
}

const LOG_FMT = '%H%x00%an%x00%ae%x00%at%x00%s'

class DependencyService {

  async buildGraph(repoPath: string, onProgress: ProgressCallback): Promise<DepGraphStatus> {
    const sha = await headSha(repoPath)
    const key = makeCacheKey(repoPath, sha)
    const db = getDb()

    const existing = db.prepare('SELECT COUNT(*) as cnt FROM dep_nodes WHERE cache_key = ?').get(key) as { cnt: number }
    if (existing.cnt > 0) {
      return { cacheKey: key, nodeCount: existing.cnt, edgeCount: this.countEdges(key), builtAt: Date.now() }
    }

    onProgress({ id: 'dep-ls', label: 'Listing asset files', status: 'running' })

    const lsRes = await execSafe(
      ['ls-files', '--cached', '--', '*.uasset', '*.umap', '*.udk'],
      repoPath
    )
    if (lsRes.exitCode !== 0 || !lsRes.stdout.trim()) {
      onProgress({ id: 'dep-ls', label: 'Listing asset files', status: 'done', detail: 'No assets found' })
      return { cacheKey: key, nodeCount: 0, edgeCount: 0, builtAt: Date.now() }
    }

    const files = lsRes.stdout.trim().split('\n').filter(Boolean)
    const total = files.length
    onProgress({ id: 'dep-ls', label: 'Listing asset files', status: 'done', detail: `${total} assets found` })

    const insert = db.prepare(
      'INSERT OR REPLACE INTO dep_nodes (cache_key, package_name, file_path, asset_class, hard_refs, soft_refs) VALUES (?, ?, ?, ?, ?, ?)'
    )

    const insertBatch = db.transaction((batch: DepNodeInfo[]) => {
      for (const n of batch) {
        insert.run(key, n.packageName, n.filePath, n.assetClass, JSON.stringify(n.hardRefs), JSON.stringify(n.softRefs))
      }
    })

    const BATCH = 50
    let processed = 0

    for (let i = 0; i < files.length; i += BATCH) {
      const chunk = files.slice(i, i + BATCH)
      const nodes: DepNodeInfo[] = []

      for (const relPath of chunk) {
        // Yield before each file. Everything below — statSync, readSync of up
        // to 4 MB, and a latin1 decode plus global regex over that whole
        // buffer — is synchronous, and so is the SQLite transaction that ends
        // each batch, so without this the loop holds the main process from the
        // first asset to the last. On an Unreal project that is tens of
        // thousands of files and minutes of dead app: no IPC reply is
        // delivered, no git process exit is observed, and every armed read
        // deadline expires unheard and then fires in a burst on recovery. One
        // yield per file bounds the block to a single asset.
        await new Promise(resolve => setImmediate(resolve))

        const absPath = path.join(repoPath, relPath)
        try {
          const stat = fs.statSync(absPath)
          const readSize = Math.min(stat.size, MAX_SCAN_BYTES)
          const buf = Buffer.allocUnsafe(readSize)
          const fd = fs.openSync(absPath, 'r')
          fs.readSync(fd, buf, 0, readSize, 0)
          fs.closeSync(fd)
          nodes.push({
            packageName: filePathToPackageName(relPath),
            filePath: relPath,
            assetClass: extractAssetClass(buf),
            hardRefs: scanBuffer(buf),
            softRefs: [],
          })
        } catch {
          nodes.push({
            packageName: filePathToPackageName(relPath),
            filePath: relPath,
            assetClass: 'Unknown',
            hardRefs: [],
            softRefs: [],
          })
        }
      }

      insertBatch(nodes)
      processed += chunk.length
      onProgress({
        id: 'dep-scan',
        label: 'Scanning assets',
        status: processed >= total ? 'done' : 'running',
        progress: Math.round((processed / total) * 100),
        current: processed,
        total,
      })
    }

    const nodeCount = files.length
    return { cacheKey: key, nodeCount, edgeCount: this.countEdges(key), builtAt: Date.now() }
  }

  private countEdges(key: string): number {
    const db = getDb()
    const rows = db.prepare('SELECT hard_refs, soft_refs FROM dep_nodes WHERE cache_key = ?').all(key) as Array<{ hard_refs: string; soft_refs: string }>
    let count = 0
    for (const r of rows) {
      count += (JSON.parse(r.hard_refs) as string[]).length
      count += (JSON.parse(r.soft_refs) as string[]).length
    }
    return count
  }

  async graphStatus(repoPath: string): Promise<DepGraphStatus | null> {
    const sha = await headSha(repoPath)
    const key = makeCacheKey(repoPath, sha)
    const db = getDb()
    const row = db.prepare('SELECT COUNT(*) as cnt FROM dep_nodes WHERE cache_key = ?').get(key) as { cnt: number }
    if (row.cnt === 0) return null
    return { cacheKey: key, nodeCount: row.cnt, edgeCount: this.countEdges(key), builtAt: 0 }
  }

  async refreshCache(repoPath: string): Promise<void> {
    const db = getDb()
    const prefix = simpleHash(repoPath)
    db.prepare("DELETE FROM dep_nodes WHERE cache_key LIKE ?").run(`${prefix}-%`)
  }

  private getNodeByPath(key: string, filePath: string): DepNodeInfo | null {
    const db = getDb()
    const row = db.prepare(
      'SELECT package_name, file_path, asset_class, hard_refs, soft_refs FROM dep_nodes WHERE cache_key = ? AND file_path = ?'
    ).get(key, filePath) as DbRow | undefined
    return row ? this.rowToNode(row) : null
  }

  private getNodeByPackage(key: string, packageName: string): DepNodeInfo | null {
    const db = getDb()
    const row = db.prepare(
      'SELECT package_name, file_path, asset_class, hard_refs, soft_refs FROM dep_nodes WHERE cache_key = ? AND package_name = ?'
    ).get(key, packageName) as DbRow | undefined
    return row ? this.rowToNode(row) : null
  }

  private rowToNode(row: DbRow): DepNodeInfo {
    return {
      packageName: row.package_name,
      filePath: row.file_path,
      assetClass: row.asset_class,
      hardRefs: JSON.parse(row.hard_refs),
      softRefs: JSON.parse(row.soft_refs),
    }
  }

  private async getFileCommits(repoPath: string, filePath: string, limit: number): Promise<DepCommit[]> {
    const [logRes, churnRes] = await Promise.all([
      execSafe(['log', '--follow', `--format=${LOG_FMT}`, `-${limit}`, '--', filePath], repoPath),
      execSafe(['log', '--follow', '--format=%H', '--', filePath], repoPath),
    ])
    const churnCount = churnRes.exitCode === 0
      ? churnRes.stdout.trim().split('\n').filter(Boolean).length
      : 0
    if (logRes.exitCode !== 0 || !logRes.stdout.trim()) return []
    return logRes.stdout.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\x00')
      return {
        hash: parts[0] ?? '',
        author: parts[1] ?? '',
        email: parts[2] ?? '',
        timestamp: parseInt(parts[3] ?? '0', 10) * 1000,
        message: parts[4] ?? '',
        churnCount,
      }
    })
  }

  async blameWithDependencies(repoPath: string, filePath: string): Promise<DepBlameResult> {
    const sha = await headSha(repoPath)
    const key = makeCacheKey(repoPath, sha)

    const node = this.getNodeByPath(key, filePath)
    const packageName = node?.packageName ?? filePathToPackageName(filePath)

    const targetCommits = await this.getFileCommits(repoPath, filePath, 20)
    const target: DepBlameEntry = {
      filePath,
      packageName,
      assetClass: node?.assetClass ?? 'Unknown',
      hopDistance: 0,
      recentCommits: targetCommits,
    }

    if (!node) {
      return { target, dependencies: [], suspects: this.rankSuspects([{ entry: target, hopDistance: 0 }]) }
    }

    // BFS: collect dependencies up to depth 2, max 15 total
    const allEntries: Array<{ entry: DepBlameEntry; hopDistance: number }> = [{ entry: target, hopDistance: 0 }]
    const visited = new Set<string>([packageName])
    const queue: Array<{ refs: string[]; hopDistance: number }> = [{ refs: node.hardRefs.slice(0, 15), hopDistance: 1 }]

    while (queue.length > 0 && allEntries.length < 16) {
      const item = queue.shift()!
      if (item.hopDistance > 2) continue

      for (const ref of item.refs) {
        if (visited.has(ref) || allEntries.length >= 16) break
        visited.add(ref)

        const depNode = this.getNodeByPackage(key, ref)
        if (!depNode) continue

        const depCommits = await this.getFileCommits(repoPath, depNode.filePath, 10)
        allEntries.push({
          entry: { filePath: depNode.filePath, packageName: depNode.packageName, assetClass: depNode.assetClass, hopDistance: item.hopDistance, recentCommits: depCommits },
          hopDistance: item.hopDistance,
        })

        if (item.hopDistance < 2) {
          queue.push({ refs: depNode.hardRefs.slice(0, 8), hopDistance: item.hopDistance + 1 })
        }
      }
    }

    return {
      target,
      dependencies: allEntries.slice(1).map(e => e.entry),
      suspects: this.rankSuspects(allEntries),
    }
  }

  private rankSuspects(entries: Array<{ entry: DepBlameEntry; hopDistance: number }>): SuspectEntry[] {
    const now = Date.now()
    const best = new Map<string, SuspectEntry>()

    for (const { entry, hopDistance } of entries) {
      const hopFactor = 1 / (1 + hopDistance * 0.5)

      for (const commit of entry.recentCommits) {
        const ageDays = (now - commit.timestamp) / 86_400_000
        const recency = Math.max(0, 1 - ageDays / 365)
        const churn   = Math.min(commit.churnCount / 50, 1)
        const hard    = hopDistance === 0 ? 1.0 : 0.3
        const score   = recency * 0.4 + hopFactor * 0.3 + churn * 0.2 + hard * 0.1

        const existing = best.get(commit.hash)
        if (!existing || existing.score < score) {
          const reasons: string[] = []
          if (recency > 0.7)    reasons.push('recent change')
          if (hopDistance === 0) reasons.push('direct edit')
          if (churn > 0.5)      reasons.push('high churn')
          best.set(commit.hash, {
            hash: commit.hash, author: commit.author, email: commit.email,
            timestamp: commit.timestamp, message: commit.message,
            score, reasons, filePath: entry.filePath,
          })
        }
      }
    }

    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, 10)
  }

  async findReferences(repoPath: string, packageName: string): Promise<DepRefResult> {
    const sha = await headSha(repoPath)
    const key = makeCacheKey(repoPath, sha)
    const db = getDb()

    const rows = db.prepare(
      "SELECT package_name, file_path, asset_class, hard_refs, soft_refs FROM dep_nodes WHERE cache_key = ? AND (hard_refs LIKE ? OR soft_refs LIKE ?)"
    ).all(key, `%${packageName}%`, `%${packageName}%`) as DbRow[]

    const referencedBy: DepNodeInfo[] = []
    for (const row of rows) {
      const n = this.rowToNode(row)
      if (n.hardRefs.includes(packageName) || n.softRefs.includes(packageName)) {
        referencedBy.push(n)
      }
    }
    return { packageName, referencedBy }
  }
}

export const dependencyService = new DependencyService()
