import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { execSafe, exec, gitAuthArgs } from '../util/dugite-exec'
import { authService } from './AuthService'
import { CHANNELS } from '../ipc/channels'
import type { Lock } from '../types'
import { notificationService } from './NotificationService'
import { webhookService } from './WebhookService'
import { heatmapService } from './HeatmapService'

class LockService {
  private pollTimers  = new Map<string, ReturnType<typeof setInterval>>()
  private prevLocks   = new Map<string, Lock[]>()
  private watchedFiles: Array<{ repoPath: string; filePath: string }> = []
  // Track when each file was locked so we can compute duration on unlock
  private lockTimestamps = new Map<string, number>()  // `${repoPath}::${filePath}` → timestamp

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
    const normalized = filePath.replace(/\\/g, '/')
    const fullPath = path.join(repoPath, normalized)
    const token = await authService.getCurrentToken()
    // Prefer --id when available: works even when the file no longer exists on disk (ghost file).
    // If the caller did not provide a lockId, resolve one from current LFS locks.
    let resolvedLockId = lockId
    if (!resolvedLockId) {
      const locks = await this.listLocks(repoPath)
      resolvedLockId = locks.find(l => l.path === normalized)?.id
    }
    const pathArgs = resolvedLockId ? ['--id', resolvedLockId] : [normalized]
    const args = [...gitAuthArgs(token), 'lfs', 'unlock', ...pathArgs]
    // Deleted (ghost) files can still be locked in LFS; force-unlock avoids local path checks.
    if (force || !fs.existsSync(fullPath)) args.push('--force')
    await exec(args, repoPath)
    const now = Date.now()
    const lockedAt = this.lockTimestamps.get(`${repoPath}::${normalized}`) ?? now
    this.lockTimestamps.delete(`${repoPath}::${normalized}`)
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

  // ── Private ─────────────────────────────────────────────────────────────────

  private async poll(repoPath: string): Promise<void> {
    const current  = await this.listLocks(repoPath)
    const previous = this.prevLocks.get(repoPath) ?? []

    // New locks since last poll
    for (const lock of current) {
      if (!previous.find(l => l.path === lock.path)) {
        const title = `${lock.owner.name} locked a file`
        const body  = lock.path
        const n = notificationService.push(repoPath, 'lock', title, body)
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

        // High-priority notification if this file was being watched
        const watchIdx = this.watchedFiles.findIndex(
          w => w.repoPath === repoPath && w.filePath === lock.path
        )
        if (watchIdx >= 0) {
          this.watchedFiles.splice(watchIdx, 1)
        }
      }
    }

    this.prevLocks.set(repoPath, current)
    this.broadcastLocks(repoPath, current)
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
