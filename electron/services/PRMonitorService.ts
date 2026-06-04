import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { execSafe } from '../util/dugite-exec'
import { authService } from './AuthService'
import { gitHubService } from './GitHubService'
import { notificationService } from './NotificationService'
import { desktopNotificationService } from './DesktopNotificationService'
import { lockService } from './LockService'
import { gitService } from './GitService'
import { CHANNELS } from '../ipc/channels'
import type { AppNotification, PRMonitorStatus, PRMonitorMergedInfo, PRMonitorDeniedInfo } from '../types'

const POLL_INTERVAL_MS = 2 * 60 * 1000  // 2 minutes

interface TrackedPR {
  owner:       string
  repo:        string
  lockedFiles: string[]
  state:       'open' | 'closed-merged' | 'closed-denied'
  title:       string
  recordedAt:  string
  resolved?:   boolean   // user has acted on / dismissed the merge-unlock prompt
}

interface MonitorState {
  trackedPRs: Record<string, TrackedPR>
  // Per-file content hash (in the default branch) we've already fired a
  // "merged into main" notification for, so fetch/pull doesn't re-notify the
  // same merge every cycle. Re-notifies if the file changes in main again.
  notifiedMainMerges?: Record<string, string>
}

// ── Disk helpers ──────────────────────────────────────────────────────────────

function stateFile(repoPath: string): string {
  const hash = crypto.createHash('md5').update(repoPath).digest('hex').slice(0, 8)
  return path.join(app.getPath('userData'), `prMonitor-${hash}.json`)
}

function loadState(repoPath: string): MonitorState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(repoPath), 'utf-8')) as MonitorState
  } catch {
    return { trackedPRs: {} }
  }
}

function saveState(repoPath: string, state: MonitorState): void {
  try {
    fs.writeFileSync(stateFile(repoPath), JSON.stringify(state, null, 2), 'utf-8')
  } catch {}
}

function parseGitHubSlug(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  if (!m) return null
  return { owner: m[1], repo: m[2] }
}

// ── Service ───────────────────────────────────────────────────────────────────

class PRMonitorService {
  private timers    = new Map<string, ReturnType<typeof setInterval>>()
  private slugCache = new Map<string, { owner: string; repo: string }>()

  // Start 2-minute polling for a repo. Idempotent.
  async start(repoPath: string): Promise<void> {
    if (this.timers.has(repoPath)) return

    const slug = await this.resolveSlug(repoPath)
    if (!slug) return  // not a GitHub repo — nothing to monitor

    this.slugCache.set(repoPath, slug)
    // Baseline check so first interval doesn't fire on old resolved PRs
    this.check(repoPath, slug).catch(() => {})

    const timer = setInterval(() => {
      this.check(repoPath, slug).catch(() => {})
    }, POLL_INTERVAL_MS)
    this.timers.set(repoPath, timer)
  }

  stop(repoPath: string): void {
    const timer = this.timers.get(repoPath)
    if (timer !== undefined) {
      clearInterval(timer)
      this.timers.delete(repoPath)
    }
    this.slugCache.delete(repoPath)
  }

  // Called from PRDialog after a PR is successfully created.
  recordPR(
    repoPath: string,
    prNumber: number,
    owner: string,
    repo: string,
    lockedFiles: string[],
    title: string,
  ): void {
    const state = loadState(repoPath)
    state.trackedPRs[String(prNumber)] = {
      owner, repo, lockedFiles, title,
      state: 'open',
      recordedAt: new Date().toISOString(),
    }
    saveState(repoPath, state)
  }

  // Trigger an immediate check, called after every Fetch operation.
  async checkNow(repoPath: string): Promise<void> {
    let slug = this.slugCache.get(repoPath)
    if (!slug) {
      slug = await this.resolveSlug(repoPath) ?? undefined
      if (!slug) return
      this.slugCache.set(repoPath, slug)
    }
    await this.check(repoPath, slug)
  }

  // Live status of the user's tracked PRs, used by the dashboard pill and the
  // auto-unlock dialog. The merged-file split is recomputed against the current
  // locks + working tree so it never goes stale relative to the merge-time snapshot.
  async getStatus(repoPath: string): Promise<PRMonitorStatus> {
    const state = loadState(repoPath)
    const entries = Object.entries(state.trackedPRs)

    let pending = 0
    const merged: PRMonitorMergedInfo[] = []
    const denied: PRMonitorDeniedInfo[] = []

    const slug = this.slugCache.get(repoPath) ?? await this.resolveSlug(repoPath) ?? undefined
    if (slug) this.slugCache.set(repoPath, slug)

    const { accounts, currentAccountId } = authService.listAccounts()
    const currentLogin = accounts.find(account => account.userId === currentAccountId)?.login ?? null
    const currentChanges = currentLogin ? await this.currentChangedFileSet(repoPath) : new Set<string>()

    let dirty = false

    for (const [numStr, tracked] of entries) {
      const prNumber = Number(numStr)
      const htmlUrl = slug
        ? `https://github.com/${slug.owner}/${slug.repo}/pull/${prNumber}`
        : ''

      if (tracked.state === 'open') {
        pending++
      } else if (tracked.state === 'closed-merged' && !tracked.resolved) {
        // Can't compute the lock split without knowing who the user is; surface
        // the merged PR with empty lists rather than wrongly auto-resolving it.
        if (!currentLogin) {
          merged.push({ prNumber, title: tracked.title, htmlUrl, availableToUnlock: [], containsLocalChanges: [] })
          continue
        }
        const { availableToUnlock, containsLocalChanges } =
          await this.resolveMergedPRLockState(repoPath, tracked.lockedFiles, currentLogin, currentChanges)
        // Auto-resolve once nothing of this PR remains locked by the user.
        if (availableToUnlock.length === 0 && containsLocalChanges.length === 0) {
          tracked.resolved = true
          dirty = true
          continue
        }
        merged.push({ prNumber, title: tracked.title, htmlUrl, availableToUnlock, containsLocalChanges })
      } else if (tracked.state === 'closed-denied' && !tracked.resolved) {
        denied.push({ prNumber, title: tracked.title, htmlUrl })
      }
    }

    if (dirty) saveState(repoPath, state)

    let mergedToMain: PRMonitorStatus['mergedToMain'] = null
    if (currentLogin) {
      const main = await this.detectMainMerges(repoPath, currentLogin, currentChanges)
      if (main.availableToUnlock.length > 0) {
        mergedToMain = { availableToUnlock: main.availableToUnlock, containsLocalChanges: main.containsLocalChanges }
      }
    }

    return { pending, merged, denied, mergedToMain }
  }

  // Mark a resolved/denied PR as acted-on so it stops surfacing on the pill / dialog.
  markResolved(repoPath: string, prNumber: number): void {
    const state = loadState(repoPath)
    const tracked = state.trackedPRs[String(prNumber)]
    if (!tracked) return
    tracked.resolved = true
    saveState(repoPath, state)
  }

  // Detect files whose committed work has landed in the default branch (merged
  // directly, squash-merged, or via an externally-created PR) and push a
  // one-time "merged into main" notification so the renderer can auto-pop the
  // unlock dialog. Called after fetch/pull. Independent of tracked PRs.
  async checkMainMerges(repoPath: string): Promise<void> {
    const { accounts, currentAccountId } = authService.listAccounts()
    const currentLogin = accounts.find(account => account.userId === currentAccountId)?.login ?? null
    if (!currentLogin) return

    const currentChanges = await this.currentChangedFileSet(repoPath)
    const { availableToUnlock, containsLocalChanges, signatures } =
      await this.detectMainMerges(repoPath, currentLogin, currentChanges)

    const state    = loadState(repoPath)
    const notified = state.notifiedMainMerges ?? {}

    // Files merged at a content hash we haven't notified for yet.
    const fresh = availableToUnlock.filter(p => notified[p] !== signatures[p])

    // Re-sync the notified map to the current set (prune stale paths so a file
    // re-locked later can notify again; record current hashes for merged files).
    const live = new Set(availableToUnlock)
    for (const p of Object.keys(notified)) if (!live.has(p)) delete notified[p]
    for (const p of availableToUnlock) notified[p] = signatures[p]
    state.notifiedMainMerges = notified
    saveState(repoPath, state)

    if (fresh.length === 0) return

    const body = `${availableToUnlock.length} merged file${availableToUnlock.length !== 1 ? 's' : ''} ready to unlock`
    const n = notificationService.push(
      repoPath,
      'main-merged',
      'Changes merged into main',
      body,
      { availableToUnlock, containsLocalChanges },
    )
    desktopNotificationService.notify({
      event:  'prResolved',
      title:  'Changes merged into main',
      body,
      urgent: true,
    })
    this.emitNotification(n)
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  // For each file the user currently holds an LFS lock on, decide whether their
  // committed version is now identical to the default branch AND was actually
  // changed in their work (vs the merge-base) — i.e. their work has been merged.
  // Files with uncommitted local changes are reported separately so the caller
  // can keep them locked ("still editing").
  private async detectMainMerges(
    repoPath: string,
    currentLogin: string,
    currentChanges: Set<string>,
  ): Promise<{ availableToUnlock: string[]; containsLocalChanges: string[]; signatures: Record<string, string> }> {
    const empty = { availableToUnlock: [] as string[], containsLocalChanges: [] as string[], signatures: {} as Record<string, string> }
    try {
      const locks = await lockService.listLocks(repoPath)
      const myLockPaths = locks
        .filter(lock => lock.owner.login === currentLogin)
        .map(lock => lock.path.replace(/\\/g, '/'))
      if (myLockPaths.length === 0) return empty

      const { ref } = await gitService.defaultBranchRef(repoPath)
      // The default-branch ref must exist locally (i.e. it has been fetched).
      if ((await execSafe(['rev-parse', '--verify', '--quiet', ref], repoPath)).exitCode !== 0) return empty

      const mbRes = await execSafe(['merge-base', 'HEAD', ref], repoPath)
      if (mbRes.exitCode !== 0 || !mbRes.stdout.trim()) return empty
      const mergeBase = mbRes.stdout.trim()

      // Files you changed since diverging from main, and files that still differ
      // between your HEAD and main. A file you changed that no longer differs
      // from main has had its content merged in.
      const changedByYou   = await this.diffNames(repoPath, mergeBase, 'HEAD')
      if (changedByYou.size === 0) return empty
      const differFromMain = await this.diffNames(repoPath, 'HEAD', ref)

      const availableToUnlock: string[] = []
      const containsLocalChanges: string[] = []
      const signatures: Record<string, string> = {}

      for (const filePath of myLockPaths) {
        if (!changedByYou.has(filePath)) continue   // not part of your work
        if (differFromMain.has(filePath)) continue  // your version isn't in main yet
        if (currentChanges.has(filePath)) { containsLocalChanges.push(filePath); continue }
        const blob = await execSafe(['rev-parse', `${ref}:${filePath}`], repoPath)
        if (blob.exitCode !== 0 || !blob.stdout.trim()) continue
        signatures[filePath] = blob.stdout.trim()
        availableToUnlock.push(filePath)
      }
      return { availableToUnlock, containsLocalChanges, signatures }
    } catch {
      return empty
    }
  }

  private async diffNames(repoPath: string, a: string, b: string): Promise<Set<string>> {
    const res = await execSafe(['diff', '--name-only', a, b], repoPath)
    if (res.exitCode !== 0) return new Set()
    return new Set(
      res.stdout.split('\n').map(line => line.trim().replace(/\\/g, '/')).filter(Boolean),
    )
  }

  private async resolveSlug(repoPath: string): Promise<{ owner: string; repo: string } | null> {
    try {
      const { exitCode, stdout } = await execSafe(['remote', 'get-url', 'origin'], repoPath)
      if (exitCode !== 0 || !stdout.trim()) return null
      return parseGitHubSlug(stdout.trim())
    } catch {
      return null
    }
  }

  private async check(
    repoPath: string,
    slug: { owner: string; repo: string },
  ): Promise<void> {
    const token = await authService.getCurrentToken()
    if (!token) return

    const state   = loadState(repoPath)
    const openPRs = Object.entries(state.trackedPRs)
      .filter(([, pr]) => pr.state === 'open')

    if (openPRs.length === 0) return

    let dirty = false

    for (const [numStr, tracked] of openPRs) {
      const prNumber = Number(numStr)
      try {
        const status = await gitHubService.getPRStatus(token, {
          owner: slug.owner, repo: slug.repo, prNumber,
        })

        if (status.state === 'open') continue  // still open, nothing to do

        tracked.state = status.merged ? 'closed-merged' : 'closed-denied'
        dirty = true

        const htmlUrl     = `https://github.com/${slug.owner}/${slug.repo}/pull/${prNumber}`
        const { accounts, currentAccountId } = authService.listAccounts()
        const tokenLogin = accounts.find(account => account.userId === currentAccountId)?.login
        if (!tokenLogin) continue
        const currentChanges = await this.currentChangedFileSet(repoPath)
        const resolvedLocks  = await this.resolveMergedPRLockState(repoPath, tracked.lockedFiles, tokenLogin, currentChanges)
        const stillLocked    = resolvedLocks.containsLocalChanges

        let n: AppNotification
        if (status.merged) {
          const body = stillLocked.length > 0
            ? `${stillLocked.length} locked file${stillLocked.length !== 1 ? 's' : ''} ready to unlock`
            : 'Your pull request was accepted'
          n = notificationService.push(
            repoPath,
            'pr-merged',
            `PR #${prNumber} merged`,
            body,
            {
              prNumber,
              owner:       slug.owner,
              repo:        slug.repo,
              lockedFiles: [...resolvedLocks.containsLocalChanges, ...resolvedLocks.availableToUnlock],
              containsLocalChanges: resolvedLocks.containsLocalChanges,
              availableToUnlock:   resolvedLocks.availableToUnlock,
              prTitle:     status.title,
              htmlUrl,
            },
          )
          desktopNotificationService.notify({
            event:  'prResolved',
            title:  `PR #${prNumber} merged`,
            body,
            urgent: stillLocked.length > 0,
          })
        } else {
          n = notificationService.push(
            repoPath,
            'pr-closed',
            `PR #${prNumber} closed without merging`,
            tracked.title,
            {
              prNumber,
              owner:       slug.owner,
              repo:        slug.repo,
              lockedFiles: tracked.lockedFiles,
              prTitle:     status.title,
              htmlUrl,
            },
          )
          desktopNotificationService.notify({
            event:  'prResolved',
            title:  `PR #${prNumber} closed without merging`,
            body:   tracked.title,
            urgent: false,
          })
        }

        this.emitNotification(n)
      } catch {
        // GitHub API error — leave as open, retry next poll
      }
    }

    if (dirty) saveState(repoPath, state)
  }

  private async resolveMergedPRLockState(
    repoPath: string,
    filePaths: string[],
    currentLogin: string,
    currentChanges: Set<string>,
  ): Promise<{ containsLocalChanges: string[]; availableToUnlock: string[] }> {
    try {
      const currentLocks = await lockService.listLocks(repoPath)
      const mine = filePaths
        .map(filePath => currentLocks.find(lock => lock.path === filePath))
        .filter((lock): lock is NonNullable<(typeof currentLocks)[number]> => lock != null)
        .filter(lock => lock.owner.login === currentLogin)

      const containsLocalChanges: string[] = []
      const availableToUnlock: string[] = []
      for (const lock of mine) {
        if (currentChanges.has(lock.path)) containsLocalChanges.push(lock.path)
        else availableToUnlock.push(lock.path)
      }

      return { containsLocalChanges, availableToUnlock }
    } catch {
      return { containsLocalChanges: filePaths, availableToUnlock: [] }
    }
  }

  private async currentChangedFileSet(repoPath: string): Promise<Set<string>> {
    try {
      const { exitCode, stdout } = await execSafe(['status', '--porcelain=v1', '-z'], repoPath)
      if (exitCode !== 0) return new Set()
      const changed = new Set<string>()
      const entries = stdout.split('\0')
      let i = 0

      while (i < entries.length) {
        const entry = entries[i]
        if (!entry || entry.length < 3) { i++; continue }
        const indexStatus = entry[0]
        const filePath = entry.slice(3)
        if (filePath) changed.add(filePath)
        i += (indexStatus === 'R' || indexStatus === 'C') ? 2 : 1
      }
      return changed
    } catch {
      return new Set()
    }
  }

  private emitNotification(n: AppNotification): void {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(CHANNELS.EVT_NOTIFICATION, n)
      }
    })
  }
}

export const prMonitorService = new PRMonitorService()
