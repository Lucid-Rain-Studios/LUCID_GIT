import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { exec, execWithStdin, gitAuthArgs, withGitTimeout } from '../util/dugite-exec'
import { authService } from './AuthService'
import { CHANNELS } from '../ipc/channels'
import type { Lock, OperationStep } from '../types'
import { notificationService } from './NotificationService'
import { desktopNotificationService } from './DesktopNotificationService'
import { webhookService } from './WebhookService'
import { heatmapService } from './HeatmapService'
import { gitService } from './GitService'

// Window after a self-unlock during which a poll-detected lock removal is
// attributed to that unlock rather than to an external force-unlock. Generous
// because `git lfs unlock` + the next poll cycle can be slow.
const SELF_UNLOCK_GRACE_MS = 60_000

// Shared across one bulk unlock so a corrupt lock cache is repaired once for
// the whole batch rather than once per file: the repair deletes every local
// cache database and re-verifies against the server, so repeating it per file
// is pure cost.
interface CacheRepairState {
  attempted: boolean
}

export interface UnlockTarget {
  filePath: string
  force?: boolean
  lockId?: string
}

export interface BulkUnlockResult {
  unlocked: string[]
  failed: Array<{ filePath: string; error: string }>
}

type ProgressCallback = (step: OperationStep) => void

class LockService {
  private pollTimers  = new Map<string, ReturnType<typeof setInterval>>()
  private prevLocks   = new Map<string, Lock[]>()
  private watchedFiles: Array<{ repoPath: string; filePath: string }> = []
  // Server IDs distinguish separate lock intervals on the same file.
  private lockTimestamps = new Map<string, number>()  // `${repoPath}::${lockId}` → timestamp
  // Track recent self-initiated unlocks so the poller can tell external
  // unlocks (force-unlocks by an admin / teammate) apart from your own.
  private recentSelfUnlocks = new Map<string, number>()  // key → unlock timestamp

  // Git LFS rewrites `.git/lfs/lockcache.db` on every lock/unlock and reads it
  // on every listing, with no inter-process locking of its own. Two git-lfs
  // processes touching one repo can interleave writes and leave the file
  // structurally invalid ("gob: encoded unsigned integer out of range"), after
  // which every lock operation in that repo fails until the cache is deleted.
  // Every git-lfs invocation for a repo therefore runs through this queue.
  private lfsQueues = new Map<string, Promise<void>>()

  /**
   * Run `fn` once every git-lfs operation already queued for this repo has
   * settled. Code already holding the queue must call the `*Unguarded`
   * variants instead — re-entering here from inside `fn` deadlocks.
   */
  private withLfsLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.lfsQueues.get(repoPath) ?? Promise.resolve()
    const run = tail.then(fn)
    // The stored tail settles either way: one failed operation must not reject
    // everything queued behind it, nor raise an unhandled rejection.
    const next = run.then(() => {}, () => {})
    this.lfsQueues.set(repoPath, next)
    next.then(() => {
      // Drop drained queues so the map doesn't grow one entry per repo forever.
      if (this.lfsQueues.get(repoPath) === next) this.lfsQueues.delete(repoPath)
    })
    return run
  }

  /** True while a git-lfs operation for this repo is queued or running. */
  private isLfsBusy(repoPath: string): boolean {
    return this.lfsQueues.has(repoPath)
  }

  // ── Core LFS commands ───────────────────────────────────────────────────────

  private authoritative = new Map<string, { locks: Lock[]; at: number; accountId: string | null }>()
  private pendingLists = new Map<string, { accountId: string | null; promise: Promise<Lock[]> }>()

  async assertStageAllowed(repoPath: string, paths: string[]): Promise<void> {
    if (!paths.length) return
    // One literal, NUL-delimited attribute check covers the entire selection.
    const attrs = await execWithStdin(['check-attr', '-z', '--stdin', 'filter'], repoPath, paths.join('\0') + '\0')
    const fields = attrs.stdout.split('\0')
    const lfsPaths = new Set<string>()
    for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i + 2] === 'lfs') lfsPaths.add(fields[i])
    if (!lfsPaths.size) return
    const accountId = authService.listAccounts().currentAccountId
    const cached = this.authoritative.get(repoPath)
    const locks = cached && cached.accountId === accountId && Date.now() - cached.at < 30_000 ? cached.locks : await this.listLocks(repoPath)
    const login = this.currentUserLogin()
    const blocked = locks.filter(lock => lfsPaths.has(lock.path) && lock.owner.login !== login)
    if (blocked.length) throw new Error('Cannot stage files locked by another owner: ' + blocked.map(lock => lock.path + ' (' + lock.owner.name + ')').join(', '))
  }

  async listLocks(repoPath: string): Promise<Lock[]> {
    const accountId = authService.listAccounts().currentAccountId
    const pending = this.pendingLists.get(repoPath)
    if (pending && pending.accountId === accountId) return pending.promise
    // The deadline belongs to the listing, not time spent waiting for an
    // existing LFS operation. Share refreshes without reusing stale results.
    const promise = this.withLfsLock(repoPath, () => withGitTimeout(
      () => this.listLocksUnguarded(repoPath), 30_000, 'lock:list',
    ))
    const entry = { accountId, promise }
    this.pendingLists.set(repoPath, entry)
    try {
      return await promise
    } finally {
      if (this.pendingLists.get(repoPath) === entry) this.pendingLists.delete(repoPath)
    }
  }

  private async listLocksUnguarded(repoPath: string): Promise<Lock[]> {
    const token = await authService.getCurrentToken()
    const remoteUrl = await gitService.getRemoteUrl(repoPath)
    const accountId = authService.listAccounts().currentAccountId
    const { stdout } = await exec([...gitAuthArgs(token, remoteUrl), 'lfs', 'locks', '--json'], repoPath)
    try {
      const raw = JSON.parse(stdout) as Array<{
        id: string
        path: string
        owner: { name: string }
        locked_at: string
      }>
      if (!Array.isArray(raw) || raw.some(l => !l || typeof l.id !== 'string' || typeof l.path !== 'string' || typeof l.owner?.name !== 'string')) throw new Error('Invalid Git LFS lock response')
      const locks = raw.map(l => {
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
      this.authoritative.set(repoPath, { locks, at: Date.now(), accountId })
      return locks
    } catch (error) {
      throw new Error('Unable to read authoritative locks: ' + String(error))
    }
  }

  async lockFile(repoPath: string, filePath: string, actorLogin = '', actorName = '', onProgress?: ProgressCallback): Promise<Lock> {
    return this.withLfsLock(repoPath, () => this.lockFileUnguarded(repoPath, filePath, actorLogin, actorName, onProgress))
  }

  private async lockFileUnguarded(repoPath: string, filePath: string, actorLogin = '', actorName = '', onProgress?: ProgressCallback): Promise<Lock> {
    const normalized = filePath.replace(/\\/g, '/')
    onProgress?.({ id: 'lock-auth', label: 'Preparing lock', status: 'running', progress: 10, detail: normalized })
    const token = await authService.getCurrentToken()
    const remoteUrl = await gitService.getRemoteUrl(repoPath)
    onProgress?.({ id: 'lock-file', label: 'Locking file', status: 'running', progress: 40, detail: normalized })
    await exec([...gitAuthArgs(token, remoteUrl), 'lfs', 'lock', normalized], repoPath)
    onProgress?.({ id: 'lock-refresh', label: 'Confirming lock', status: 'running', progress: 80, detail: normalized })
    const locks = await this.listLocksUnguarded(repoPath)
    const lock  = locks.find(l => l.path === normalized)
    if (!lock) throw new Error(`Lock not found for "${normalized}" after locking`)
    const now = Date.now()
    this.lockTimestamps.set(`${repoPath}::${lock.id}`, now)
    heatmapService.recordLockEvent({
      repoPath, filePath: normalized, eventType: 'locked', lockId: lock.id,
      actorLogin: actorLogin || lock.owner.login,
      actorName:  actorName  || lock.owner.name,
      timestamp: now, durationMs: 0,
    })
    onProgress?.({ id: 'lock-file', label: 'File locked', status: 'done', progress: 100, detail: normalized })
    return lock
  }

  async unlockFile(repoPath: string, filePath: string, force = false, lockId?: string, actorLogin = '', actorName = '', onProgress?: ProgressCallback): Promise<void> {
    const normalized = filePath.replace(/\\/g, '/')
    onProgress?.({ id: 'unlock-auth', label: 'Preparing unlock', status: 'running', progress: 10, detail: normalized })
    const token = await authService.getCurrentToken()
    const remoteUrl = await gitService.getRemoteUrl(repoPath)
    onProgress?.({ id: 'unlock-file', label: 'Unlocking file', status: 'running', progress: 40, detail: normalized })
    await this.withLfsLock(repoPath, () =>
      this.unlockFileWithToken(repoPath, filePath, force, lockId, token, actorLogin, actorName, { attempted: false }, remoteUrl))
    onProgress?.({ id: 'unlock-file', label: 'File unlocked', status: 'done', progress: 100, detail: normalized })
  }

  async unlockFiles(repoPath: string, targets: UnlockTarget[], actorLogin = '', actorName = '', onProgress?: ProgressCallback): Promise<BulkUnlockResult> {
    if (targets.length === 0) return { unlocked: [], failed: [] }

    // Keychain access and Git authentication setup happen once for the entire batch.
    // The unlocks themselves run strictly one at a time: concurrent `git lfs
    // unlock` against a single repo corrupts `lockcache.db` (see `lfsQueues`),
    // and git-lfs offers no way to make it safe.
    onProgress?.({ id: 'unlock-batch', label: 'Preparing unlocks', status: 'running', progress: 5, current: 0, total: targets.length })
    const token = await authService.getCurrentToken()
    const remoteUrl = await gitService.getRemoteUrl(repoPath)
    const unlocked: string[] = []
    const failed: BulkUnlockResult['failed'] = []
    // One repair allowance for the whole batch, shared by every file in it.
    const cacheRepair: CacheRepairState = { attempted: false }

    return this.withLfsLock(repoPath, async () => {
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index]
        try {
          await this.unlockFileWithToken(repoPath, target.filePath, target.force ?? false, target.lockId, token, actorLogin, actorName, cacheRepair, remoteUrl)
          unlocked.push(target.filePath.replace(/\\/g, '/'))
        } catch (error) {
          const message = String(error)
          failed.push({ filePath: target.filePath, error: message })
          // A corrupt lock cache is repo-wide, and by this point one repair has
          // already been tried and failed. Every remaining file would fail the
          // same way, so stop instead of grinding through hundreds of doomed
          // unlocks (the incident log shows 105 of them in five seconds).
          if (this.isLockCacheCorruptError(message)) {
            for (const remaining of targets.slice(index + 1)) {
              failed.push({ filePath: remaining.filePath, error: `Skipped: ${message}` })
            }
            onProgress?.({
              id: 'unlock-batch', label: 'Unlock stopped', status: 'error',
              progress: 100, current: targets.length, total: targets.length,
              detail: 'Git LFS lock cache is unusable — clear the lock cache, then retry',
            })
            break
          }
        }
        const completed = index + 1
        onProgress?.({
          id: 'unlock-batch', label: 'Unlocking files', status: completed === targets.length ? 'done' : 'running',
          progress: Math.round(5 + (completed / targets.length) * 95), current: completed, total: targets.length,
          detail: target.filePath.replace(/\\/g, '/'),
        })
      }
      return { unlocked, failed }
    })
  }

  private async unlockFileWithToken(
    repoPath: string, filePath: string, force: boolean, lockId: string | undefined, token: string | null,
    actorLogin = '', actorName = '',
    // Defaults to a fresh allowance so a single unlock still gets one repair.
    cacheRepair: CacheRepairState = { attempted: false },
    remoteUrl?: string | null,
  ): Promise<void> {
    // Deleting every local lockcache.db and re-verifying against the server is
    // the only recovery from a corrupt cache, and it fixes the repo, not the
    // file — so it runs at most once per caller, not once per file.
    const repairLockCache = async (): Promise<void> => {
      if (cacheRepair.attempted) return
      cacheRepair.attempted = true
      await gitService.lfsLocksMaintenance(repoPath, true)
    }
    const normalized = filePath.replace(/\\/g, '/')
    const fullPath = path.join(repoPath, normalized)
    // Prefer --id when available: works even when the file no longer exists on disk (ghost file).
    // If the caller did not provide a lockId, resolve one from current LFS locks.
    let resolvedLockId = lockId
    if (!resolvedLockId) {
      const locks = await this.listLocksUnguarded(repoPath)
      resolvedLockId = locks.find(l => l.path === normalized)?.id
    }
    const fileExists = fs.existsSync(fullPath)
    if (!resolvedLockId && !fileExists) {
      await repairLockCache()
      const refreshedLocks = await this.listLocksUnguarded(repoPath)
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
      ...gitAuthArgs(token, remoteUrl),
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
      } else if (this.isLockCacheCorruptError(msg) || this.isMissingFileUnlockCacheError(msg)) {
        // Both failures mean the local lock cache is unusable. Rebuild it from
        // the server and retry once; if the retry fails too, the error carries
        // the original message so callers can recognise a corrupt cache.
        await repairLockCache()
        const refreshedLocks = await this.listLocksUnguarded(repoPath)
        const refreshedLockId = refreshedLocks.find(l => l.path === normalized)?.id ?? resolvedLockId
        await exec(makeArgs(refreshedLockId), repoPath)
        resolvedLockId = refreshedLockId
      } else {
        throw error
      }
    }
    const now = Date.now()
    const lockedAt = this.lockTimestamps.get(`${repoPath}::${resolvedLockId}`) ?? now
    this.lockTimestamps.delete(`${repoPath}::${resolvedLockId}`)
    this.recentSelfUnlocks.set(`${repoPath}::${normalized}`, now)
    heatmapService.recordLockEvent({
      repoPath, filePath: normalized, eventType: force ? 'force-unlocked' : 'unlocked', lockId: resolvedLockId,
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

  private pollTokens = new Map<string, object>()

  startPolling(repoPath: string, intervalMs = 30_000): void {
    if (this.pollTimers.has(repoPath)) return
    for (const previous of this.pollTimers.keys()) this.stopPolling(previous)
    const token = {}
    this.pollTokens.set(repoPath, token)
    // Seed the previous-lock snapshot immediately so the first real poll
    // doesn't fire spurious "new lock" events for existing locks
    this.listLocks(repoPath).then(locks => {
      if (this.pollTokens.get(repoPath) === token) this.prevLocks.set(repoPath, locks)
    }).catch(() => {})
    const id = setInterval(() => { void this.poll(repoPath).catch(() => {}) }, intervalMs)
    this.pollTimers.set(repoPath, id)
  }

  stopPolling(repoPath: string): void {
    this.pollTokens.delete(repoPath)
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
    // Queued: deleting lockcache.db out from under a running lock/unlock is
    // exactly the interleaving that corrupts it in the first place.
    await this.withLfsLock(repoPath, () => gitService.clearLfsLockCache(repoPath))
    return this.refresh(repoPath)
  }

  // Check / repair from the Locks panel. Both walk and (for a repair) delete
  // the lock cache databases, so they queue behind any in-flight git-lfs work.
  async locksMaintenance(repoPath: string, repair: boolean) {
    return this.withLfsLock(repoPath, () => gitService.lfsLocksMaintenance(repoPath, repair))
  }

  // ── Folder-level locking ──────────────────────────────────────────────────────

  private filesUnderFolder(files: string[], folderPath: string): string[] {
    const prefix = folderPath.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    return files.filter(f => f.replace(/\\/g, '/').startsWith(prefix))
  }

  // Lock every LFS-tracked file under a folder that isn't already locked by anyone.
  async lockFolder(repoPath: string, folderPath: string, onProgress?: ProgressCallback): Promise<{ locked: number; skipped: number; failed: number }> {
    onProgress?.({ id: 'lock-folder-scan', label: 'Scanning folder', status: 'running', progress: 5 })
    // The scan and every lock share one queue slot, so a concurrent unlock
    // batch or poll can't interleave git-lfs processes with this one.
    let total = 0
    const result = await this.withLfsLock(repoPath, async () => {
      const [lfsFiles, currentLocks] = await Promise.all([
        gitService.lfsTrackedFiles(repoPath),
        this.listLocksUnguarded(repoPath),
      ])
      const lockedPaths = new Set(currentLocks.map(l => l.path.replace(/\\/g, '/')))
      const candidates = this.filesUnderFolder(lfsFiles, folderPath)
      total = candidates.length

      let locked = 0, skipped = 0, failed = 0
      for (let index = 0; index < candidates.length; index++) {
        const filePath = candidates[index]
        if (lockedPaths.has(filePath)) {
          skipped++
        } else {
          try {
            await this.lockFileUnguarded(repoPath, filePath)
            locked++
          } catch {
            failed++
          }
        }
        const completed = index + 1
        onProgress?.({
          id: 'lock-folder', label: 'Locking files', status: 'running',
          progress: Math.round(10 + (completed / Math.max(candidates.length, 1)) * 85),
          current: completed, total: candidates.length, detail: filePath,
        })
      }
      return { locked, skipped, failed }
    })
    // One broadcast after the batch keeps the UI snappy and avoids per-file
    // churn. Outside the queue slot: refresh takes one of its own.
    await this.refresh(repoPath)
    onProgress?.({ id: 'lock-folder', label: 'Folder locked', status: 'done', progress: 100, current: total, total })
    return result
  }

  // Unlock only the files under a folder that the current user owns.
  async unlockFolderMine(repoPath: string, folderPath: string, onProgress?: ProgressCallback): Promise<{ unlocked: number; failed: number }> {
    onProgress?.({ id: 'unlock-folder-scan', label: 'Finding your locks', status: 'running', progress: 5 })
    const login = this.currentUserLogin()
    const currentLocks = await this.listLocks(repoPath)
    const mine = currentLocks.filter(l =>
      login && l.owner.login === login && this.filesUnderFolder([l.path], folderPath).length > 0,
    )
    const result = await this.unlockFiles(
      repoPath,
      mine.map(lock => ({ filePath: lock.path, lockId: lock.id })),
      '',
      '',
      onProgress,
    )
    await this.refresh(repoPath)
    onProgress?.({ id: 'unlock-folder', label: 'Folder unlocked', status: 'done', progress: 100, current: mine.length, total: mine.length })
    return { unlocked: result.unlocked.length, failed: result.failed.length }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Git LFS cannot initialise its lock system at all: `.git/lfs/lockcache.db`
   * is structurally invalid. Typically the result of two git-lfs processes
   * writing it at once. Every lock operation in the repo fails until the cache
   * is deleted, so this is worth recognising wherever an unlock is attempted.
   *
   * Deliberately matches only failures of the cache itself. A bare mention of
   * `lockcache.db` is not enough: the per-file "missing cache file" error names
   * it too, and that one must not abort a whole batch.
   */
  private isLockCacheCorruptError(message: string): boolean {
    return /unable to create lock system|lock cache initialization|init lock cache/i.test(message)
      || /database disk image is malformed|file is not a database/i.test(message)
  }

  private isMissingFileUnlockCacheError(message: string): boolean {
    return /Unable to unlock/i.test(message)
      && /(CreateFile|open)\s+/i.test(message)
      && /(cannot find the (file|path)|no such file or directory)/i.test(message)
  }

  private async poll(repoPath: string): Promise<void> {
    // A bulk lock/unlock can hold the git-lfs queue for minutes. Ticking polls
    // would queue up behind it and then all run back to back against identical
    // state; skip instead and pick the change up on the next tick.
    if (this.isLfsBusy(repoPath)) return
    const token = this.pollTokens.get(repoPath)
    if (!token) return
    let current: Lock[]
    try { current = await this.listLocks(repoPath) }
    catch (error) {
      if (this.pollTokens.get(repoPath) === token) this.broadcastLocks(repoPath, this.prevLocks.get(repoPath) ?? [], String(error))
      return
    }
    if (this.pollTokens.get(repoPath) !== token) return
    const previous = this.prevLocks.get(repoPath) ?? []

    // New locks since last poll
    for (const lock of current) {
      if (!previous.find(l => l.id === lock.id)) {
        const title = `${lock.owner.name} locked a file`
        const body  = lock.path
        const n = notificationService.push(repoPath, 'lock', title, body, { ownerLogin: lock.owner.login })
        this.emitNotification(n)
        webhookService.send(repoPath, 'fileLocked', title, body).catch(() => {})
        const now = Date.now()
        this.lockTimestamps.set(`${repoPath}::${lock.id}`, now)
        heatmapService.recordLockEvent({
          repoPath, filePath: lock.path, eventType: 'locked', lockId: lock.id,
          actorLogin: lock.owner.login, actorName: lock.owner.name,
          timestamp: now, durationMs: 0,
        })
      }
    }

    // Released locks since last poll
    const currentUserLogin = this.currentUserLogin()
    const externalUnlocksOfMine: string[] = []
    for (const lock of previous) {
      if (!current.find(l => l.id === lock.id)) {
        const title = 'File unlocked'
        const body  = `${lock.path} released by ${lock.owner.name}`
        const n = notificationService.push(repoPath, 'unlock', title, body)
        this.emitNotification(n)
        webhookService.send(repoPath, 'fileUnlocked', title, body).catch(() => {})
        const now = Date.now()
        const lockedAt = this.lockTimestamps.get(`${repoPath}::${lock.id}`) ?? now
        this.lockTimestamps.delete(`${repoPath}::${lock.id}`)
        heatmapService.recordLockEvent({
          repoPath, filePath: lock.path, eventType: 'unlocked', lockId: lock.id,
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

  private broadcastLocks(repoPath: string, locks: Lock[], error?: string): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.EVT_LOCK_CHANGED, { repoPath, locks, error })
      }
    })
  }


}

export const lockService = new LockService()
