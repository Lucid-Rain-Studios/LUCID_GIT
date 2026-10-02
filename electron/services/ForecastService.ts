import { gitService } from './GitService'
import { withRepoSlot, repoSlotState } from '../util/repo-gate'
import { BrowserWindow } from 'electron'
import { execSafe } from '../util/dugite-exec'
import { CHANNELS } from '../ipc/channels'
import { desktopNotificationService } from './DesktopNotificationService'

export interface ForecastConflict {
  filePath: string
  remoteBranch: string
  remoteLastCommit: string
  remoteLastAuthor: string
  remoteLastMessage: string
  severity: 'high' | 'medium' | 'low'
}

export interface ForecastStatus {
  repoPath: string
  enabled: boolean
  lastPolledAt: number | null
  error?: string | null
  intervalMinutes: number
  conflicts: ForecastConflict[]
}

class ForecastService {
  private timers    = new Map<string, ReturnType<typeof setInterval>>()
  private status    = new Map<string, ForecastStatus>()
  private conflicts = new Map<string, ForecastConflict[]>()
  // Refcounted pause: callers (op start/finish) increment/decrement; while
  // >0, scheduled polls become no-ops so we don't compete with user-driven
  // pushes/pulls/merges/etc.
  private pauseCount = 0
  private polling = new Set<string>()

  pause(): void { this.pauseCount += 1 }

  resume(): void {
    if (this.pauseCount > 0) this.pauseCount -= 1
  }

  isPaused(): boolean { return this.pauseCount > 0 }

  start(repoPath: string, intervalMinutes = 5): ForecastStatus {
    for (const previous of this.timers.keys()) this.stop(previous)

    const st: ForecastStatus = {
      repoPath,
      enabled: true,
      lastPolledAt: null,
      intervalMinutes,
      conflicts: [],
    }
    this.status.set(repoPath, st)

    // First poll immediately (async, don't block)
    this.poll(repoPath).catch(() => {})

    const id = setInterval(() => this.poll(repoPath).catch(() => {}), intervalMinutes * 60_000)
    this.timers.set(repoPath, id)
    return st
  }

  stop(repoPath: string): void {
    const id = this.timers.get(repoPath)
    if (id !== undefined) {
      clearInterval(id)
      this.timers.delete(repoPath)
    }
    this.status.delete(repoPath)
    this.conflicts.delete(repoPath)
  }

  getStatus(repoPath: string): ForecastStatus | null {
    const st = this.status.get(repoPath)
    if (!st) return null
    return { ...st, conflicts: this.conflicts.get(repoPath) ?? [] }
  }

  private async poll(repoPath: string): Promise<void> {
    if (this.pauseCount > 0 || this.polling.has(repoPath)) return
    const slot = repoSlotState(repoPath)
    if (slot.activeWrite || slot.activeReads || slot.waiting) return
    const status = this.status.get(repoPath)
    if (!status) return
    this.polling.add(repoPath)
    try {
      await withRepoSlot(repoPath, 'write', () => this.pollCurrent(repoPath, status))
    } catch (error) {
      if (this.status.get(repoPath) === status) {
        status.error = String(error)
        this.emitStatus(status)
      }
    } finally { this.polling.delete(repoPath) }
  }

  private emitStatus(status: ForecastStatus): void {
    for (const win of BrowserWindow.getAllWindows()) if (!win.webContents.isDestroyed()) win.webContents.send(CHANNELS.EVT_FORECAST_CONFLICT, { ...status })
  }

  private async pollCurrent(repoPath: string, expected: ForecastStatus): Promise<void> {
    // Shared authentication and gate; a failed fetch never updates freshness.
    await gitService.fetch(repoPath)
    if (this.status.get(repoPath) !== expected) return

    // 2. Get locally modified files (staged + unstaged)
    const modifiedFiles = new Set((await gitService.status(repoPath)).map(file => file.path))

    // 3. Get current branch
    const branchRes = await execSafe(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
    const currentBranch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : 'HEAD'

    // 4. List remote tracking branches
    const refRes = await execSafe(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'], repoPath)
    if (refRes.exitCode !== 0) throw new Error('Unable to list branches for forecast')

    const remoteBranches = refRes.stdout.trim().split('\n')
      .filter(Boolean)
      .filter(b => !b.includes('/HEAD') && !b.endsWith(`/${currentBranch}`))

    // 5. For each remote branch, find files that differ from HEAD
    const newConflicts: ForecastConflict[] = []

    for (const remoteBranch of remoteBranches.slice(0, 10)) {
      const diffRes = await execSafe(
        ['diff', '--name-only', '-z', `HEAD...${remoteBranch}`],
        repoPath
      )
      if (diffRes.exitCode !== 0) throw new Error('Unable to compare forecast branch ' + remoteBranch)
      if (!diffRes.stdout) continue

      const remoteChanged = new Set(
        diffRes.stdout.split('\0').filter(Boolean)
      )

      // Intersect with locally modified
      const overlapping = [...modifiedFiles].filter(f => remoteChanged.has(f))
      if (overlapping.length === 0) continue

      // Get info about the remote branch tip commit
      const logRes = await execSafe(
        ['log', '-1', '--format=%H%x00%an%x00%s', remoteBranch],
        repoPath
      )
      let remoteLastCommit = ''
      let remoteLastAuthor = ''
      let remoteLastMessage = ''
      if (logRes.exitCode === 0) {
        const parts = logRes.stdout.trim().split('\x00')
        remoteLastCommit  = parts[0]?.slice(0, 7) ?? ''
        remoteLastAuthor  = parts[1] ?? ''
        remoteLastMessage = parts[2] ?? ''
      }

      for (const filePath of overlapping) {
        newConflicts.push({
          filePath,
          remoteBranch,
          remoteLastCommit,
          remoteLastAuthor,
          remoteLastMessage,
          severity: overlapping.length > 3 ? 'high' : overlapping.length > 1 ? 'medium' : 'low',
        })
      }
    }

    if (this.status.get(repoPath) !== expected) return
    // 6. Update status and emit events
    const previousConflicts = this.conflicts.get(repoPath) ?? []
    this.conflicts.set(repoPath, newConflicts)
    const st = this.status.get(repoPath)
    if (st) {
      st.error = null
      st.lastPolledAt = Date.now()
      st.conflicts = newConflicts
    }

    if (st) this.emitStatus(st)
    if (newConflicts.length > 0) {
      // Only toast on NEWLY-detected conflicts so the user isn't pinged every
      // poll cycle for the same overlap. Compare by file+remoteBranch tuple.
      const wasKnown = new Set(previousConflicts.map(c => `${c.filePath}::${c.remoteBranch}`))
      const fresh = newConflicts.filter(c => !wasKnown.has(`${c.filePath}::${c.remoteBranch}`))
      if (fresh.length > 0) {
        const first = fresh[0]
        const extra = fresh.length - 1
        const summary = extra > 0
          ? `${first.filePath} on ${first.remoteBranch} (+${extra} more)`
          : `${first.filePath} on ${first.remoteBranch}`
        desktopNotificationService.notify({
          event:  'conflictForecast',
          title:  fresh.length === 1 ? 'Potential merge conflict' : `${fresh.length} potential merge conflicts`,
          body:   summary,
          urgent: fresh.some(c => c.severity === 'high'),
        })
      }
    }
  }
}

export const forecastService = new ForecastService()
