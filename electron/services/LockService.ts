import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { execSafe, exec, gitAuthArgs } from '../util/dugite-exec'
import { authService } from './AuthService'
import { CHANNELS } from '../ipc/channels'
import type { Lock } from '../types'
import { notificationService } from './NotificationService'
import { desktopNotificationService } from './DesktopNotificationService'
import { webhookService } from './WebhookService'
import { heatmapService } from './HeatmapService'
import { gitService } from './GitService'

// Window after a self-unlock during which a poll-detected lock removal is
// attributed to that unlock rather than to an external force-unlock. Generous
// because `git lfs unlock` + the next poll cycle can be slow.
const SELF_UNLOCK_GRACE_MS = 60_000
const BULK_UNLOCK_CONCURRENCY = 8

export interface UnlockTarget {
  filePath: string
  force?: boolean
  lockId?: string
}

export interface BulkUnlockResult {
  unlocked: string[]
  failed: Array<{ filePath: string; error: string }>
}

class LockService {
  private pollTimers  = new Map<string, ReturnType<typeof setInterval>>()
  private prevLocks   = new Map<string, Lock[]>()
  private watchedFiles: Array<{ repoPath: string; filePath: string }> = []
  // Track when each file was locked so we can compute duration on unlock
  private lockTimestamps = new Map<string, number>()  // `${repoPath}::${filePath}` → timestamp
  // Track recent self-initiated unlocks so the poller can tell external
  // unlocks (force-unlocks by an admin / teammate) apart from your own.
  private recentSelfUnlocks = new Map<string, number>()  // key → unlock timestamp

  // ── Core LFS commands ───────────────────────────────────────────────────────

  async listLocks(repoPath: string): Promise<Lock[]> {
    const token = await authService.getCurrentToken()
    const { exitCode, stdout } = await execSafe([...gitAuthArgs(token), 'lfs', 'locks', '--json'], repoPath)
    if (exitCode !== 0 || !stdout.trim()) return []
    try {
      const raw = JSON.parse(stdout) as Array<{
        id: string
        path: string
        owner: { name: string }
        locked_at: string
      }>
      return raw.map(l => {
        const normalizedPath = l.path.replace(/\\/g, '/')
        const fullPath = path.join(repoPath, normalizedPath)
        return {
          id:       l.id,
          path:     normalizedPath,
          owner:    { name: l.owner.name, login: l.owner.name },
          lockedAt: l.locked_at,
          isGhost:  !fs.existsSync(fullPath),
        }
      })
    } catch {
      return []
    }
  }

  async lockFile(repoPath: string, filePath: string, actorLogin = '', actorName = ''): Promise<Lock> {
    const normalized = filePath.replace(/\\/g, '/')
    const token = await authService.getCurrentToken()
    await exec([...gitAuthArgs(token), 'lfs', 'lock', normalized], repoPath)
    const locks = await this.listLocks(repoPath)
    const lock  = locks.find(l => l.path === normalized)
    if (!lock) throw new Error(`Lock not found for "${normalized}" after locking`)
    const now = Date.now()
    this.lockTimestamps.set(`${repoPath}::${normalized}`, now)
    heatmapService.recordLockEvent({
      repoPath, filePath: normalized, eventType: 'locked',
      actorLogin: actorLogin || lock.owner.login,
      actorName:  actorName  || lock.owner.name,
      timestamp: now, durationMs: 0,
    })
    return lock
  }

  async unlockFile(repoPath: string, filePath: string, force = false, lockId?: string, actorLogin = '', actorName = ''): Promise<void> {
    const token = await authService.getCurrentToken()
    await this.unlockFileWithToken(repoPath, filePath, force, lockId, token, actorLogin, actorName)
  }

  async unlockFiles(repoPath: string, targets: UnlockTarget[]): Promise<BulkUnlockResult> {
    if (targets.length === 0) return { unlocked: [], failed: [] }

    // Keychain access and Git authentication setup happen once for the entire batch.
    // A small worker pool avoids both the serial path and spawning thousands of
    // competing git-lfs processes at once.
    const token = await authService.getCurrentToken()
    const unlocked: string[] = []
    const failed: BulkUnlockResult['failed'] = []
    let nextIndex = 0

    const worker = async () => {
      while (true) {
        const index = nextIndex++
        if (index >= targets.length) return
        const target = targets[index]
        try {
          await this.unlockFileWithToken(repoPath, target.filePath, target.force ?? false, target.lockId, token)
          unlocked.push(target.filePath.replace(/\\/g, '/'))
        } catch (error) {
          failed.push({ filePath: target.filePath, error: String(error) })
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(BULK_UNLOCK_CONCURRENCY, targets.length) }, () => worker()),
    )
    return { unlocked, failed }
  }

  private async unlockFileWithToken(repoPath: string, filePath: string, force: boolean, lockId: string | undefined, token: string | null, actorLogin = '', actorName = ''): Promise<void> {
    const normalized = filePath.replace(/\\/g, '/')
    const fullPath = path.join(repoPath, normalized)
    // Prefer --id when available: works even when the file no longer exists on disk (ghost file).
    // If the caller did not provide a lockId, resolve one from current LFS locks.
    let resolvedLockId = lockId
    if (!resolvedLockId) {
      const locks = await this.listLocks(repoPath)
      resolvedLockId = locks.find(l => l.path === normalized)?.id
    }
    const fileExists = fs.existsSync(fullPath)
    if (!resolvedLockId && !fileExists) {
      await gitService.lfsLocksMaintenance(repoPath, true)
      const refreshedLocks = await this.listLocks(repoPath)
      resolvedLockId = refreshedLocks.find(l => l.path === normalized)?.id
      if (!resolvedLockId) {
        throw new Error(`Unable to unlock deleted file "${normalized}": lock id could not be resolved after refreshing the Git LFS lock cache`)
      }
    }
    // Use --id=<id> form for maximum CLI compatibility across Git LFS versions.
    // This also allows owners to unlock deleted files without using admin-only force unlock.
    const unlockOpts: string[] = []
    if (force) unlockOpts.push('--force')
    const makeArgs = (id?: string) => [
      ...gitAuthArgs(token),
      'lfs',
      'unlock',
      ...unlockOpts,
      ...(id ? [`--id=${id}`] : [normalized]),
    ]
    try {
      await exec(makeArgs(resolvedLockId), repoPath)
    } catch (error) {
      const msg = String(error)
      // Treat stale lock records as already unlocked; Git LFS can return
      // "Lock not found" when another client has already released it.
      if (/Lock not found/i.test(msg)) {
        // already unlocked
      } else if (this.isMissingFileUnlockCacheError(msg)) {
        await gitService.lfsLocksMaintenance(repoPath, true)
        const refreshedLocks = await this.listLocks(repoPath)
        const refreshedLockId = refreshedLocks.find(l => l.path === normalized)?.id ?? resolvedLockId
        await exec(makeArgs(refreshedLockId), repoPath)
      } else {
        throw error
      }
    }
    const now = Date.now()
    const lockedAt = this.lockTimestamps.get(`${repoPath}::${normalized}`) ?? now
    this.lockTimestamps.delete(`${repoPath}::${normalized}`)
    this.recentSelfUnlocks.set(`${repoPath}::${normalized}`, now)
    heatmapService.recordLockEvent({
      repoPath, filePath: normalized, eventType: force ? 'force-unlocked' : 'unlocked',
      actorLogin, actorName, timestamp: now, durationMs: now - lockedAt,
    })
  }

  async watchFile(repoPath: string, filePath: string): Promise<void> {
    const already = this.watchedFiles.some(
      w => w.repoPath === repoPath && w.filePath === filePath
    )
    if (!already) this.watchedFiles.push({ repoPath, filePath })
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  startPolling(repoPath: string, intervalMs = 30_000): void {
    if (this.pollTimers.has(repoPath)) return
    // Seed the previous-lock snapshot immediately so the first real poll
    // doesn't fire spurious "new lock" events for existing locks
    this.listLocks(repoPath).then(locks => {
      this.prevLocks.set(repoPath, locks)
    })
    const id = setInterval(() => this.poll(repoPath), intervalMs)
    this.pollTimers.set(repoPath, id)
  }

  stopPolling(repoPath: string): void {
    const id = this.pollTimers.get(repoPath)
    if (id !== undefined) {
      clearInterval(id)
      this.pollTimers.delete(repoPath)
    }
  }

  async refresh(repoPath: string): Promise<Lock[]> {
    const locks = await this.listLocks(repoPath)
    this.prevLocks.set(repoPath, locks)
    this.broadcastLocks(repoPath, locks)
    return locks
  }

  // "Clear Lock Cache" toolbar action: drop the local Git LFS lock cache, then
  // re-list straight from the server (which rebuilds the cache) and broadcast
  // the fresh locks. Lean by design — no SQLite integrity inspection.
  async clearCacheAndRefresh(repoPath: string): Promise<Lock[]> {
    await gitService.clearLfsLockCache(repoPath)
    return this.refresh(repoPath)
  }

  // ── Folder-level locking ──────────────────────────────────────────────────────

  private filesUnderFolder(files: string[], folderPath: string): string[] {
    const prefix = folderPath.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    return files.filter(f => f.replace(/\\/g, '/').startsWith(prefix))
  }

  // Lock every LFS-tracked file under a folder that isn't already locked by anyone.
  async lockFolder(repoPath: string, folderPath: string): Promise<{ locked: number; skipped: number; failed: number }> {
    const [lfsFiles, currentLocks] = await Promise.all([
      gitService.lfsTrackedFiles(repoPath),
      this.listLocks(repoPath),
    ])
    const lockedPaths = new Set(currentLocks.map(l => l.path.replace(/\\/g, '/')))
    const candidates = this.filesUnderFolder(lfsFiles, folderPath)

    let locked = 0, skipped = 0, failed = 0
    for (const filePath of candidates) {
      if (lockedPaths.has(filePath)) { skipped++; continue }
      try {
        await this.lockFile(repoPath, filePath)
        locked++
      } catch {
        failed++
      }
    }
    // One broadcast after the batch keeps the UI snappy and avoids per-file churn.
    await this.refresh(repoPath)
    return { locked, skipped, failed }
  }

  // Unlock only the files under a folder that the current user owns.
  async unlockFolderMine(repoPath: string, folderPath: string): Promise<{ unlocked: number; failed: number }> {
    const login = this.currentUserLogin()
    const currentLocks = await this.listLocks(repoPath)
    const mine = currentLocks.filter(l =>
      login && l.owner.login === login && this.filesUnderFolder([l.path], folderPath).length > 0,
    )
    const result = await this.unlockFiles(
      repoPath,
      mine.map(lock => ({ filePath: lock.path, lockId: lock.id })),
    )
    await this.refresh(repoPath)
    return { unlocked: result.unlocked.length, failed: result.failed.length }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private isMissingFileUnlockCacheError(message: string): boolean {
    return /Unable to unlock/i.test(message)
      && /(CreateFile|open)\s+/i.test(message)
      && /(cannot find the (file|path)|no such file or directory)/i.test(message)
  }

  private async poll(repoPath: string): Promise<void> {
    const current  = await this.listLocks(repoPath)
    const previous = this.prevLocks.get(repoPath) ?? []

    // New locks since last poll
    for (const lock of current) {
      if (!previous.find(l => l.path === lock.path)) {
        const title = `${lock.owner.name} locked a file`
        const body  = lock.path
        const n = notificationService.push(repoPath, 'lock', title, body, { ownerLogin: lock.owner.login })
        this.emitNotification(n)
        webhookService.send(repoPath, 'fileLocked', title, body).catch(() => {})
        const now = Date.now()
        this.lockTimestamps.set(`${repoPath}::${lock.path}`, now)
        heatmapService.recordLockEvent({
          repoPath, filePath: lock.path, eventType: 'locked',
          actorLogin: lock.owner.login, actorName: lock.owner.name,
          timestamp: now, durationMs: 0,
        })
      }
    }

    // Released locks since last poll
    const currentUserLogin = this.currentUserLogin()
    const externalUnlocksOfMine: string[] = []
    for (const lock of previous) {
      if (!current.find(l => l.path === lock.path)) {
        const title = 'File unlocked'
        const body  = `${lock.path} released by ${lock.owner.name}`
        const n = notificationService.push(repoPath, 'unlock', title, body)
        this.emitNotification(n)
        webhookService.send(repoPath, 'fileUnlocked', title, body).catch(() => {})
        const now = Date.now()
        const lockedAt = this.lockTimestamps.get(`${repoPath}::${lock.path}`) ?? now
        this.lockTimestamps.delete(`${repoPath}::${lock.path}`)
        heatmapService.recordLockEvent({
          repoPath, filePath: lock.path, eventType: 'unlocked',
          actorLogin: lock.owner.login, actorName: lock.owner.name,
          timestamp: now, durationMs: now - lockedAt,
        })

        // External-unlock-of-your-lock detection: if a lock you owned just
        // disappeared and you didn't initiate the unlock yourself within the
        // grace window, collect it for a single bundled toast below so a
        // batch force-unlock doesn't spam the OS notification center.
        if (currentUserLogin && lock.owner.login === currentUserLogin) {
          const key = `${repoPath}::${lock.path}`
          const selfUnlockedAt = this.recentSelfUnlocks.get(key)
          if (selfUnlockedAt !== undefined && now - selfUnlockedAt < SELF_UNLOCK_GRACE_MS) {
            this.recentSelfUnlocks.delete(key)
          } else {
            externalUnlocksOfMine.push(lock.path)
          }
        }

        // High-priority notification if this file was being watched
        const watchIdx = this.watchedFiles.findIndex(
          w => w.repoPath === repoPath && w.filePath === lock.path
        )
        if (watchIdx >= 0) {
          this.watchedFiles.splice(watchIdx, 1)
        }
      }
    }

    if (externalUnlocksOfMine.length === 1) {
      desktopNotificationService.notify({
        event:  'forceUnlock',
        title:  'Your lock was released',
        body:   `${externalUnlocksOfMine[0]} was unlocked by another user`,
        urgent: true,
      })
    } else if (externalUnlocksOfMine.length > 1) {
      desktopNotificationService.notify({
        event:  'forceUnlock',
        title:  'Your locks were released',
        body:   `${externalUnlocksOfMine.length} of your files were unlocked`,
        urgent: true,
      })
    }

    // Garbage-collect stale self-unlock entries so the map doesn't grow
    // unbounded across long-running sessions.
    const cutoff = Date.now() - SELF_UNLOCK_GRACE_MS
    for (const [key, ts] of this.recentSelfUnlocks) {
      if (ts < cutoff) this.recentSelfUnlocks.delete(key)
    }

    this.prevLocks.set(repoPath, current)
    this.broadcastLocks(repoPath, current)
  }

  private currentUserLogin(): string | null {
    try {
      const { accounts, currentAccountId } = authService.listAccounts()
      return accounts.find(a => a.userId === currentAccountId)?.login ?? null
    } catch {
      return null
    }
  }

  private emitNotification(notification: import('../types').AppNotification): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.EVT_NOTIFICATION, notification)
      }
    })
  }

  private broadcastLocks(repoPath: string, locks: Lock[]): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.EVT_LOCK_CHANGED, locks)
      }
    })
  }


}

export const lockService = new LockService()
