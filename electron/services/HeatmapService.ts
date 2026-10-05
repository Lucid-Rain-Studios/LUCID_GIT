import { getDb } from '../db/database'

export interface LockEventRecord {
  lockId?: string
  repoPath: string
  filePath: string
  eventType: 'locked' | 'unlocked' | 'force-unlocked'
  actorLogin: string
  actorName: string
  timestamp: number
  durationMs: number
}

export interface ConflictEventRecord {
  repoPath: string
  filePath: string
  ourBranch: string
  theirBranch: string
  conflictType: string
  resolved?: boolean
}

export interface HeatmapNode {
  name: string
  path: string
  score: number
  value: number
  lockCount: number
  conflictCount: number
  uniqueContributors: number
  meanDurationMs: number
  children?: HeatmapNode[]
}

export interface HeatmapTimelineEntry {
  id: number
  timestamp: number
  eventType: string
  actor: string
  durationMs: number
  source: 'lock' | 'conflict'
}

// ── Write helpers ─────────────────────────────────────────────────────────────

class HeatmapService {

  recordLockEvent(e: LockEventRecord): void {
    try {
      getDb().prepare(
        'INSERT OR IGNORE INTO lock_events (repo_path, file_path, event_type, actor_login, actor_name, timestamp, duration_ms, lock_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(e.repoPath, e.filePath, e.eventType, e.actorLogin, e.actorName, e.timestamp, e.durationMs, e.lockId ?? '')
    } catch { /* ignore DB errors — non-critical */ }
  }

  recordConflictEvent(e: ConflictEventRecord): void {
    try {
      getDb().prepare(
        "INSERT INTO conflict_events (repo_path, file_path, our_branch, their_branch, conflict_type, timestamp, source) VALUES (?, ?, ?, ?, ?, ?, 'observed')"
      ).run(e.repoPath, e.filePath, e.ourBranch, e.theirBranch, e.conflictType, Date.now())
    } catch { /* ignore */ }
  }

  markConflictsResolved(repoPath: string, ourBranch: string, theirBranch: string): void {
    try {
      getDb().prepare(
        'UPDATE conflict_events SET resolved = 1 WHERE repo_path = ? AND our_branch = ? AND their_branch = ? AND resolved = 0'
      ).run(repoPath, ourBranch, theirBranch)
    } catch { /* ignore */ }
  }

  // ── Query helpers ───────────────────────────────────────────────────────────

  private cutoff(timeWindowDays: number): number {
    if (timeWindowDays <= 0) return 0
    return Date.now() - timeWindowDays * 86_400_000
  }

  computeHeatmap(repoPath: string, timeWindowDays: number, groupBy: 'folder' | 'type'): HeatmapNode {
    const db = getDb()
    const since = this.cutoff(timeWindowDays)

    type LockRow = { file_path: string; lock_count: number; contributors: string; total_duration: number; duration_count: number }
    const lockRows = db.prepare(`
      SELECT e.file_path,
             SUM(CASE WHEN e.event_type = 'locked' THEN 1 ELSE 0 END) as lock_count,
             GROUP_CONCAT(DISTINCT CASE WHEN e.event_type = 'locked' THEN e.actor_login WHEN start.timestamp <= e.timestamp THEN start.actor_login END) as contributors,
             SUM(CASE WHEN e.event_type <> 'locked' AND start.timestamp <= e.timestamp THEN e.timestamp - start.timestamp ELSE 0 END) as total_duration,
             SUM(CASE WHEN e.event_type <> 'locked' AND start.timestamp <= e.timestamp THEN 1 ELSE 0 END) as duration_count
      FROM lock_events e
      LEFT JOIN lock_events start ON start.repo_path = e.repo_path AND start.file_path = e.file_path
        AND start.lock_id = e.lock_id AND start.lock_id <> '' AND start.event_type = 'locked'
      WHERE e.repo_path = ? AND e.timestamp >= ? AND e.lock_id <> ''
      GROUP BY e.file_path
      HAVING lock_count > 0 OR duration_count > 0
    `).all(repoPath, since) as LockRow[]

    type ConflictRow = { file_path: string; conflict_count: number }
    const conflictRows = db.prepare(`
      SELECT file_path, COUNT(*) as conflict_count
      FROM conflict_events
      WHERE repo_path = ? AND timestamp >= ? AND source = 'observed'
      GROUP BY file_path
    `).all(repoPath, since) as ConflictRow[]

    const conflictMap = new Map(conflictRows.map(r => [r.file_path, r.conflict_count]))

    if (lockRows.length === 0 && conflictRows.length === 0) {
      return { name: 'root', path: '', score: 0, value: 1, lockCount: 0, conflictCount: 0, uniqueContributors: 0, meanDurationMs: 0, children: [] }
    }

    // Collect all file paths
    const allPaths = new Set([...lockRows.map(r => r.file_path), ...conflictRows.map(r => r.file_path)])

    // Build raw stats per file
    const fileStats = new Map<string, { lockCount: number; totalDuration: number; durationCount: number; contributors: Set<string>; conflictCount: number }>()
    for (const r of lockRows) {
      fileStats.set(r.file_path, {
        lockCount: r.lock_count,
        totalDuration: r.total_duration ?? 0,
        durationCount: r.duration_count,
        contributors: new Set((r.contributors ?? '').split(',').filter(Boolean)),
        conflictCount: conflictMap.get(r.file_path) ?? 0,
      })
    }
    for (const path of allPaths) {
      if (!fileStats.has(path)) {
        fileStats.set(path, {
          lockCount: 0, totalDuration: 0, durationCount: 0, contributors: new Set(),
          conflictCount: conflictMap.get(path) ?? 0,
        })
      }
    }

    // Normalize components across all files
    const stats = [...fileStats.entries()]
    const maxLock     = Math.max(1, ...stats.map(([, s]) => s.lockCount))
    const maxDuration = Math.max(1, ...stats.map(([, s]) => s.durationCount > 0 ? s.totalDuration / s.durationCount : 0))
    const maxContrib  = Math.max(1, ...stats.map(([, s]) => s.contributors.size))
    const maxConflict = Math.max(1, ...stats.map(([, s]) => s.conflictCount))

    const nodes: HeatmapNode[] = stats.map(([filePath, s]) => {
      const meanDuration = s.durationCount > 0 ? s.totalDuration / s.durationCount : 0
      const score = Math.round(
        (s.lockCount / maxLock) * 35 +
        (meanDuration / maxDuration) * 25 +
        (s.contributors.size / maxContrib) * 25 +
        (s.conflictCount / maxConflict) * 15
      )
      return {
        name: filePath.replace(/\\/g, '/').split('/').pop() ?? filePath,
        path: filePath,
        score,
        value: Math.max(1, score),
        lockCount: s.lockCount,
        conflictCount: s.conflictCount,
        uniqueContributors: s.contributors.size,
        meanDurationMs: Math.round(meanDuration),
      }
    })

    // Group
    const durationCounts = new Map(stats.map(([file, s]) => [file, s.durationCount]))
    if (groupBy === 'type') {
      return this.groupByType(nodes, durationCounts)
    }
    return this.groupByFolder(nodes, durationCounts)
  }

  private groupByFolder(nodes: HeatmapNode[], durationCounts: Map<string, number>): HeatmapNode {
    const groups = new Map<string, HeatmapNode[]>()
    for (const node of nodes) {
      const parts = node.path.replace(/\\/g, '/').split('/')
      const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)'
      const group = groups.get(folder) ?? []
      group.push(node)
      groups.set(folder, group)
    }
    const children: HeatmapNode[] = [...groups.entries()].map(([folder, items]) => ({
      name: folder.split('/').pop() ?? folder,
      path: folder,
      score: Math.round(items.reduce((a, b) => a + b.score, 0) / items.length),
      value: items.reduce((a, b) => a + b.value, 0),
      lockCount: items.reduce((a, b) => a + b.lockCount, 0),
      conflictCount: items.reduce((a, b) => a + b.conflictCount, 0),
      uniqueContributors: Math.max(...items.map(i => i.uniqueContributors)),
      meanDurationMs: this.groupMeanDuration(items, durationCounts),
      children: items,
    }))
    return { name: 'root', path: '', score: 0, value: children.reduce((a, b) => a + b.value, 0), lockCount: 0, conflictCount: 0, uniqueContributors: 0, meanDurationMs: 0, children }
  }

  private groupByType(nodes: HeatmapNode[], durationCounts: Map<string, number>): HeatmapNode {
    const groups = new Map<string, HeatmapNode[]>()
    for (const node of nodes) {
      const ext = node.path.split('.').pop()?.toLowerCase() ?? 'other'
      const group = groups.get(ext) ?? []
      group.push(node)
      groups.set(ext, group)
    }
    const children: HeatmapNode[] = [...groups.entries()].map(([ext, items]) => ({
      name: `.${ext}`,
      path: ext,
      score: Math.round(items.reduce((a, b) => a + b.score, 0) / items.length),
      value: items.reduce((a, b) => a + b.value, 0),
      lockCount: items.reduce((a, b) => a + b.lockCount, 0),
      conflictCount: items.reduce((a, b) => a + b.conflictCount, 0),
      uniqueContributors: Math.max(...items.map(i => i.uniqueContributors)),
      meanDurationMs: this.groupMeanDuration(items, durationCounts),
      children: items,
    }))
    return { name: 'root', path: '', score: 0, value: children.reduce((a, b) => a + b.value, 0), lockCount: 0, conflictCount: 0, uniqueContributors: 0, meanDurationMs: 0, children }
  }

  topContended(repoPath: string, timeWindowDays: number, limit = 10): HeatmapNode[] {
    const root = this.computeHeatmap(repoPath, timeWindowDays, 'folder')
    const flat: HeatmapNode[] = []
    const collect = (node: HeatmapNode) => {
      if (!node.children) flat.push(node)
      else node.children.forEach(c => collect(c))
    }
    collect(root)
    return flat.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  private groupMeanDuration(items: HeatmapNode[], counts: Map<string, number>): number {
    const completed = items.reduce((sum, item) => sum + (counts.get(item.path) ?? 0), 0)
    return completed ? Math.round(items.reduce((sum, item) => sum + item.meanDurationMs * (counts.get(item.path) ?? 0), 0) / completed) : 0
  }

  getTimeline(repoPath: string, filePath: string, timeWindowDays: number): HeatmapTimelineEntry[] {
    const db = getDb()
    const since = this.cutoff(timeWindowDays)

    type LockTimelineRow = { id: number; timestamp: number; event_type: string; actor_login: string; actor_name: string; duration_ms: number }
    const lockRows = db.prepare(
      `SELECT e.id, e.timestamp, e.event_type, e.actor_login, e.actor_name,
        CASE WHEN e.event_type <> 'locked' AND start.timestamp <= e.timestamp THEN e.timestamp - start.timestamp ELSE 0 END as duration_ms
       FROM lock_events e
       LEFT JOIN lock_events start ON start.repo_path = e.repo_path AND start.file_path = e.file_path
         AND start.lock_id = e.lock_id AND start.lock_id <> '' AND start.event_type = 'locked'
       WHERE e.repo_path = ? AND e.file_path = ? AND e.timestamp >= ? AND e.lock_id <> '' ORDER BY e.timestamp DESC LIMIT 100`
    ).all(repoPath, filePath, since) as LockTimelineRow[]

    type ConflictTimelineRow = { id: number; timestamp: number; their_branch: string; our_branch: string }
    const conflictRows = db.prepare(
      "SELECT id, timestamp, their_branch, our_branch FROM conflict_events WHERE repo_path = ? AND file_path = ? AND timestamp >= ? AND source = 'observed' ORDER BY timestamp DESC LIMIT 50"
    ).all(repoPath, filePath, since) as ConflictTimelineRow[]

    const entries: HeatmapTimelineEntry[] = [
      ...lockRows.map(r => ({
        id: r.id, timestamp: r.timestamp, eventType: r.event_type,
        actor: r.actor_name || r.actor_login, durationMs: r.duration_ms, source: 'lock' as const,
      })),
      ...conflictRows.map(r => ({
        id: r.id, timestamp: r.timestamp, eventType: 'conflict',
        actor: r.their_branch, durationMs: 0, source: 'conflict' as const,
      })),
    ]
    return entries.sort((a, b) => b.timestamp - a.timestamp)
  }
}

export const heatmapService = new HeatmapService()
