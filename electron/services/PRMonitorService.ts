import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { execSafe } from '../util/dugite-exec'
import { authService } from './AuthService'
import { gitHubService } from './GitHubService'
import { notificationService } from './NotificationService'
import { lockService } from './LockService'
import { CHANNELS } from '../ipc/channels'
import type { AppNotification } from '../types'

const POLL_INTERVAL_MS = 2 * 60 * 1000  // 2 minutes

interface TrackedPR {
  owner:       string
  repo:        string
  lockedFiles: string[]
  state:       'open' | 'closed-merged' | 'closed-denied'
  title:       string
  recordedAt:  string
}

interface MonitorState {
  trackedPRs: Record<string, TrackedPR>
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

  // ── Private ─────────────────────────────────────────────────────────────────

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
          n = notificationService.push(
            repoPath,
            'pr-merged',
            `PR #${prNumber} merged`,
            stillLocked.length > 0
              ? `${stillLocked.length} locked file${stillLocked.length !== 1 ? 's' : ''} ready to unlock`
              : 'Your pull request was accepted',
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
