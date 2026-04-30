import { create } from 'zustand'
import { ipc, Lock } from '@/ipc'

function parseGitHubSlug(url: string): string | null {
  const ssh = url.match(/^git@github\.com:(.+?)\/(.+?)(?:\.git)?$/i)
  if (ssh) return `${ssh[1]}/${ssh[2]}`
  const https = url.match(/^https?:\/\/github\.com\/(.+?)\/(.+?)(?:\.git)?$/i)
  if (https) return `${https[1]}/${https[2]}`
  return null
}

interface LockState {
  locks: Lock[]
  isLoading: boolean
  error: string | null

  loadLocks:   (repoPath: string) => Promise<void>
  lockFile:    (repoPath: string, filePath: string) => Promise<void>
  unlockFile:  (repoPath: string, filePath: string, force?: boolean) => Promise<void>
  watchFile:   (repoPath: string, filePath: string) => Promise<void>
  setLocks:    (locks: Lock[]) => void
  clearLocks:  () => void
}

export const useLockStore = create<LockState>((set, get) => ({
  locks:     [],
  isLoading: false,
  error:     null,

  loadLocks: async (repoPath) => {
    set({ isLoading: true, error: null })
    try {
      const locks = await ipc.listLocks(repoPath)

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
          const fileLists = await Promise.all(
            prs.map(async pr => ({ pr, files: await ipc.githubPrFiles({ owner, repo, prNumber: pr.number }) }))
          )
          const ghostByPath = new Map<string, Lock>()
          for (const { pr, files } of fileLists) {
            for (const p of files) {
              const normalized = p.replace(/\\/g, '/')
              if (ghostByPath.has(normalized)) continue
              ghostByPath.set(normalized, {
                id: `ghost-pr-${pr.number}-${normalized}`,
                path: normalized,
                owner: { name: 'PR Ghost', login: 'ghost' },
                lockedAt: pr.updatedAt,
              })
            }
          }
          ghostLocks = [...ghostByPath.values()]
        }
      } catch {
        // Best-effort overlay; if GitHub is unavailable, show authoritative LFS locks only.
      }

      const ghostPaths = new Set(ghostLocks.map(l => l.path))
      const mergedLocks = [
        ...locks.filter(l => !ghostPaths.has(l.path.replace(/\\/g, '/'))),
        ...ghostLocks,
      ]
      set({ locks: mergedLocks, isLoading: false })
    } catch (e) {
      // LFS may not be initialised — treat as empty, don't surface error
      set({ locks: [], isLoading: false })
    }
  },

  lockFile: async (repoPath, filePath) => {
    set({ error: null })
    try {
      // ipc.lockFile returns the created Lock — use it immediately, no second round-trip
      const lock = await ipc.lockFile(repoPath, filePath)
      set(state => ({
        locks: [...state.locks.filter(l => l.path !== filePath), lock],
      }))
    } catch (e) {
      set({ error: String(e) })
      throw e
    }
  },

  unlockFile: async (repoPath, filePath, force) => {
    const lockId = get().locks.find(l => l.path === filePath)?.id
    set({ error: null })
    // Optimistic remove — badge disappears before the network call returns
    set(state => ({ locks: state.locks.filter(l => l.path !== filePath) }))
    try {
      await ipc.unlockFile(repoPath, filePath, force, lockId)
    } catch (e) {
      // Roll back on failure by reloading authoritative list
      const locks = await ipc.listLocks(repoPath).catch(() => [])
      set({ locks, error: String(e) })
      throw e
    }
  },

  watchFile: async (repoPath, filePath) => {
    await ipc.watchLock(repoPath, filePath)
  },

  setLocks:   (locks) => set({ locks }),
  clearLocks: ()      => set({ locks: [], error: null }),
}))
