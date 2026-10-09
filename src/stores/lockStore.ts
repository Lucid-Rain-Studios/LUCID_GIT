import { create } from 'zustand'
import { useRepoStore, repoSessionVersion } from './repoStore'
import { ipc, Lock, type BulkUnlockResult, type UnlockTarget } from '@/ipc'

let loadRequest = 0
const active = (repoPath: string, session: number) => useRepoStore.getState().repoPath === repoPath && repoSessionVersion() === session

function parseGitHubSlug(url: string): string | null {
  const ssh = url.match(/^git@github\.com:(.+?)\/(.+?)(?:\.git)?$/i)
  if (ssh) return `${ssh[1]}/${ssh[2]}`
  const https = url.match(/^https?:\/\/github\.com\/(.+?)\/(.+?)(?:\.git)?$/i)
  if (https) return `${https[1]}/${https[2]}`
  return null
}

interface LockState {
  locks: Lock[]
  prLocks: Lock[]
  isLoading: boolean
  error: string | null

  loadLocks:   (repoPath: string) => Promise<void>
  lockFile:    (repoPath: string, filePath: string) => Promise<void>
  unlockFile:  (repoPath: string, filePath: string, force?: boolean, lockId?: string) => Promise<void>
  unlockFiles: (repoPath: string, targets: UnlockTarget[]) => Promise<BulkUnlockResult>
  watchFile:   (repoPath: string, filePath: string) => Promise<void>
  setLocks:    (locks: Lock[]) => void
  clearLocks:  () => void
}

export const useLockStore = create<LockState>((set, get) => ({
  locks:     [],
  prLocks: [],
  isLoading: false,
  error:     null,

  loadLocks: async (repoPath) => {
    const session = repoSessionVersion()
    if (!active(repoPath, session)) return
    const request = ++loadRequest
    set({ isLoading: true, error: null })
    try {
      const locks = await ipc.listLocks(repoPath)
      if (!active(repoPath, session) || request !== loadRequest) return

      // PR "ghost lock" overlay: all files in open PRs are treated as locked by a synthetic user.
      // This keeps ownership stable until the PR is resolved:
      // - accepted/merged PRs disappear from list => ghost locks removed => files unlocked
      // - declined/closed PRs disappear from list => base lock owner becomes visible again
      let ghostLocks: Lock[] = []
      try {
        const remoteUrl = await ipc.getRemoteUrl(repoPath)
        const slug = remoteUrl ? parseGitHubSlug(remoteUrl) : null
        if (slug) {
          const [owner, repo] = slug.split('/')
          const prs = await ipc.githubListPRs({ owner, repo })
          const fileLists = []
          for (let i = 0; i < prs.length; i += 4) fileLists.push(...await Promise.all(
            prs.slice(i, i + 4).map(async pr => ({ pr, files: await ipc.githubPrFiles({ owner, repo, prNumber: pr.number, expectedSha: pr.headSha }) }))
          ))
          const ghostByPath = new Map<string, Lock>()
          for (const { pr, files } of fileLists) {
            for (const p of files) {
              const normalized = p.replace(/\\/g, '/')
              if (ghostByPath.has(normalized)) continue
              ghostByPath.set(normalized, {
                id: `ghost-pr-${pr.number}-${normalized}`,
                path: normalized,
                owner: { name: pr.author ? `Ghost (${pr.author})` : 'Ghost (PR #' + pr.number + ')', login: 'ghost' },
                lockedAt: pr.updatedAt,
                prOverlay: { number: pr.number, author: pr.author, htmlUrl: pr.htmlUrl },
              })
            }
          }
          ghostLocks = [...ghostByPath.values()]
        }
      } catch {
        // Best-effort overlay; if GitHub is unavailable, show authoritative LFS locks only.
      }

      const realPaths = new Set(locks.map(l => l.path.replace(/\\/g, '/')))
      const mergedLocks = [
        ...locks,
        ...ghostLocks.filter(l => !realPaths.has(l.path)),
      ]
      if (active(repoPath, session) && request === loadRequest) set({ locks: mergedLocks, prLocks: ghostLocks, isLoading: false })
    } catch (error) {
      if (active(repoPath, session) && request === loadRequest) set({ error: 'Lock data is stale: ' + String(error), isLoading: false })
    }
  },

  lockFile: async (repoPath, filePath) => {
    const session = repoSessionVersion()
    if (!active(repoPath, session)) throw new Error('Repository changed. Retry the lock action in the active repository.')
    set({ error: null })
    try {
      // ipc.lockFile returns the created Lock — use it immediately, no second round-trip
      const lock = await ipc.lockFile(repoPath, filePath)
      if (!active(repoPath, session)) return
      set(state => ({
        locks: [...state.locks.filter(l => l.path !== filePath), lock],
      }))
    } catch (e) {
      if (active(repoPath, session)) set({ error: String(e) })
      throw e
    }
  },

  unlockFile: async (repoPath, filePath, force, lockId) => {
    const session = repoSessionVersion()
    if (!active(repoPath, session)) throw new Error('Repository changed. Retry the unlock action in the active repository.')
    const normalizedPath = filePath.replace(/\\/g, '/')
    const resolvedLockId = lockId ?? get().locks.find(l => l.path.replace(/\\/g, '/') === normalizedPath)?.id
    set({ error: null })
    // PR-ghost locks are synthetic client overlays and have no backing LFS lock to release.
    if (resolvedLockId?.startsWith('ghost-pr-')) {
      return
    }
    const removedLocks = get().locks.filter(l => l.path.replace(/\\/g, '/') === normalizedPath)
    // Optimistic remove — badge disappears before the network call returns
    set(state => ({ locks: state.locks.filter(l => l.path.replace(/\\/g, '/') !== normalizedPath) }))
    try {
      await ipc.unlockFile(repoPath, normalizedPath, force, resolvedLockId)
    } catch (e) {
      // Roll back on failure by reloading authoritative list
      const locks = await ipc.listLocks(repoPath).catch(() => [...get().locks, ...removedLocks])
      if (active(repoPath, session)) set({ locks, error: String(e) })
      throw e
    }
  },

  unlockFiles: async (repoPath, targets) => {
    const session = repoSessionVersion()
    if (!active(repoPath, session)) throw new Error('Repository changed. Retry the unlock action in the active repository.')
    const realTargets = targets.filter(target => !target.lockId?.startsWith('ghost-pr-'))
    if (realTargets.length === 0) return { unlocked: [], failed: [] }

    const targetPaths = new Set(realTargets.map(target => target.filePath.replace(/\\/g, '/')))
    const removedLocks = get().locks.filter(lock => targetPaths.has(lock.path.replace(/\\/g, '/')))
    set(state => ({
      error: null,
      locks: state.locks.filter(lock => !targetPaths.has(lock.path.replace(/\\/g, '/'))),
    }))

    try {
      const result = await ipc.unlockFiles(repoPath, realTargets)
      if (active(repoPath, session) && result.locks) get().setLocks(result.locks)
      if (active(repoPath, session) && !result.locks && result.failed.length > 0) {
        const failedPaths = new Set(result.failed.map(item => item.filePath.replace(/\\/g, '/')))
        const failedLocks = removedLocks.filter(lock => failedPaths.has(lock.path.replace(/\\/g, '/')))
        set(state => ({
          locks: [...state.locks.filter(lock => !failedPaths.has(lock.path.replace(/\\/g, '/'))), ...failedLocks],
          error: `${result.failed.length} file${result.failed.length === 1 ? '' : 's'} failed to unlock`,
        }))
      }
      if (active(repoPath, session) && result.refreshError) set({ error: result.refreshError })
      return result
    } catch (error) {
      if (active(repoPath, session)) set(state => ({
        locks: [...state.locks.filter(lock => !targetPaths.has(lock.path.replace(/\\/g, '/'))), ...removedLocks],
        error: String(error),
      }))
      throw error
    }
  },

  watchFile: async (repoPath, filePath) => {
    await ipc.watchLock(repoPath, filePath)
  },

  setLocks: (locks) => set(state => ({ locks: [...locks, ...state.prLocks.filter(lock => !locks.some(real => real.path === lock.path))], error: null })),
  clearLocks: ()      => { loadRequest++; set({ locks: [], prLocks: [], isLoading: false, error: null }) },
}))
