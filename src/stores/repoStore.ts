import { create } from 'zustand'
import { FileStatus, BranchInfo } from '@/ipc'
import { useOperationStore } from './operationStore'

const RECENT_REPOS_KEY = 'lucid-git:recent-repos'
const MAX_RECENT = 10

function loadRecentRepos(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_REPOS_KEY) ?? '[]') } catch { return [] }
}

function saveRecentRepos(paths: string[]) {
  localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(paths))
}

interface RepoState {
  repoPath: string | null
  currentBranch: string
  branches: BranchInfo[]
  fileStatus: FileStatus[]
  isLoading: boolean
  isSilentRefreshing: boolean
  error: string | null
  recentRepos: string[]
  syncTick: number
  historyTick: number  // bumped when commit history may have changed (fetch, pull, push, checkout, merges, commits)
  prTick: number       // bumped when PR list may have changed (create, merge, close)
  bumpSyncTick: () => void
  bumpHistoryTick: () => void
  bumpPrTick: () => void

  openRepo: (path: string) => Promise<void>
  refreshStatus: () => Promise<void>
  silentRefresh: () => Promise<void>
  loadBranches: () => Promise<void>
  checkout: (branch: string) => Promise<void>
  clearRepo: () => void
  setError: (error: string | null) => void
  addRecentRepo: (path: string) => void
  removeRecentRepo: (path: string) => void
}

export const useRepoStore = create<RepoState>((set, get) => ({
  repoPath: null,
  currentBranch: '',
  branches: [],
  fileStatus: [],
  isLoading: false,
  isSilentRefreshing: false,
  error: null,
  recentRepos: loadRecentRepos(),
  syncTick: 0,
  historyTick: 0,
  prTick: 0,

  openRepo: async (path: string) => {
    set({ isLoading: true, error: null })
    const op = useOperationStore.getState()
    try {
      await op.run('Opening repository…', async () => {
        // Hydrate shell immediately so large repos don't appear frozen while
        // expensive git status/branch scans are still running.
        set({ repoPath: path, fileStatus: [], currentBranch: '', branches: [], error: null })
        get().addRecentRepo(path)

        const branchPromise = window.lucidGit.currentBranch(path)
        const statusPromise = window.lucidGit.status(path)
        const branchesPromise = window.lucidGit.branchList(path)

        const branch = await branchPromise.catch(() => 'unknown')
        set({ currentBranch: branch ?? 'unknown' })

        const [statusRes, branchesRes] = await Promise.allSettled([statusPromise, branchesPromise])

        set({
          fileStatus: statusRes.status === 'fulfilled' ? (statusRes.value ?? []) : [],
          branches: branchesRes.status === 'fulfilled' ? (branchesRes.value ?? []) : [],
          error: null,
        })
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to open repository' })
    } finally {
      set({ isLoading: false })
    }
  },

  refreshStatus: async () => {
    const { repoPath } = get()
    if (!repoPath) return
    set({ isLoading: true })
    const op = useOperationStore.getState()
    try {
      await op.run('Refreshing…', async () => {
        // Settled, not all: these three are independent, and a slow branch
        // list must not throw away a file status that arrived fine. Batching
        // them with Promise.all meant one failure showed the user a stale
        // changes list with nothing to explain it. Each IPC rejection is
        // already logged by the ipc proxy, so a partial refresh is
        // diagnosable in Bug Logs.
        const [statusR, branchR, branchesR] = await Promise.allSettled([
          window.lucidGit.status(repoPath),
          window.lucidGit.currentBranch(repoPath),
          window.lucidGit.branchList(repoPath),
        ])
        if (statusR.status   === 'fulfilled') set({ fileStatus: statusR.value ?? [] })
        if (branchR.status   === 'fulfilled') set({ currentBranch: branchR.value ?? '' })
        if (branchesR.status === 'fulfilled') set({ branches: branchesR.value ?? [] })
      })
    } catch {
      // silent
    } finally {
      set({ isLoading: false })
    }
  },

  silentRefresh: async () => {
    const { repoPath, isLoading, isSilentRefreshing } = get()
    // Skip if an explicit refreshStatus is already in flight — it will win
    if (!repoPath || isLoading || isSilentRefreshing) return
    set({ isSilentRefreshing: true })
    try {
      const [statusR, branchR] = await Promise.allSettled([
        window.lucidGit.status(repoPath),
        window.lucidGit.currentBranch(repoPath),
      ])
      // Only write if no explicit refresh started while we were waiting
      if (!get().isLoading) {
        if (statusR.status === 'fulfilled') set({ fileStatus: statusR.value ?? [] })
        if (branchR.status === 'fulfilled') set({ currentBranch: branchR.value ?? '' })
      }
    } catch { /* ignore */ }
    finally { set({ isSilentRefreshing: false }) }
  },

  loadBranches: async () => {
    const { repoPath } = get()
    if (!repoPath) return
    const branches = await window.lucidGit.branchList(repoPath).catch(() => [])
    set({ branches })
  },

  checkout: async (branch: string) => {
    const { repoPath } = get()
    if (!repoPath) return
    const op = useOperationStore.getState()
    await op.run(`Switching to ${branch}…`, async () => {
      await window.lucidGit.checkout(repoPath, branch)
      // The checkout already succeeded. Refreshing what it changed is
      // follow-up work, so a failure here must not surface as "Switching to X
      // failed" for a branch the user is now standing on.
      const [statusR, currentBranchR, branchesR] = await Promise.allSettled([
        window.lucidGit.status(repoPath),
        window.lucidGit.currentBranch(repoPath),
        window.lucidGit.branchList(repoPath),
      ])
      set(s => ({
        currentBranch: currentBranchR.status === 'fulfilled' ? currentBranchR.value : branch,
        fileStatus:    statusR.status        === 'fulfilled' ? (statusR.value ?? []) : s.fileStatus,
        branches:      branchesR.status      === 'fulfilled' ? (branchesR.value ?? s.branches) : s.branches,
        historyTick: s.historyTick + 1,
      }))
    })
  },

  // Every sync-affecting operation funnels through here, and a fetch prunes
  // branches other people deleted. Reloading the list on the same signal keeps
  // each panel reading `branches` from showing branches that are already gone.
  bumpSyncTick:    () => {
    set(s => ({ syncTick: s.syncTick + 1, historyTick: s.historyTick + 1 }))
    void get().loadBranches()
  },
  bumpHistoryTick: () => set(s => ({ historyTick: s.historyTick + 1 })),
  bumpPrTick:      () => set(s => ({ prTick: s.prTick + 1 })),

  clearRepo: () => set({ repoPath: null, fileStatus: [], currentBranch: '', branches: [], error: null }),

  setError: (error) => set({ error }),

  addRecentRepo: (path: string) => {
    const next = [path, ...get().recentRepos.filter(p => p !== path)].slice(0, MAX_RECENT)
    saveRecentRepos(next)
    set({ recentRepos: next })
  },

  removeRecentRepo: (path: string) => {
    const next = get().recentRepos.filter(p => p !== path)
    saveRecentRepos(next)
    set({ recentRepos: next })
  },
}))
