import { create } from 'zustand'
import { FileStatus, BranchInfo } from '@/ipc'
import { useOperationStore } from './operationStore'

const RECENT_REPOS_KEY = 'lucid-git:recent-repos'
const MAX_RECENT = 10
let repoGeneration = 0
let statusRequest = 0
let branchRequest = 0
export const repoSessionVersion = () => repoGeneration

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
    const generation = ++repoGeneration
    const request = ++statusRequest
    const branchesRequest = ++branchRequest
    const current = () => repoGeneration === generation && get().repoPath === path && statusRequest === request
    set({ isLoading: true, error: null })
    try {
      if (!await window.lucidGit.isRepo(path)) throw new Error('This folder is not a Git repository.')
    } catch (error) {
      if (repoGeneration === generation) set({ isLoading: false, error: String(error) })
      return
    }
    if (repoGeneration !== generation) return
    set({ repoPath: path, fileStatus: [], currentBranch: '', branches: [], isLoading: true, isSilentRefreshing: false, error: null })
    get().addRecentRepo(path)
    const op = useOperationStore.getState()
    try {
      await op.run('Opening repository…', async () => {
        // Hydrate shell immediately so large repos don't appear frozen while
        // expensive git status/branch scans are still running.
        if (!current()) return

        const branchPromise = window.lucidGit.currentBranch(path)
        const statusPromise = window.lucidGit.status(path)
        const branchesPromise = window.lucidGit.branchList(path)

        let branchError: unknown
        const branch = await branchPromise.catch(error => { branchError = error; return 'unknown' })
        if (current() && statusRequest === request) set({ currentBranch: branch ?? 'unknown' })

        const [statusRes, branchesRes] = await Promise.allSettled([statusPromise, branchesPromise])

        if (!current() || statusRequest !== request) return
        set({
          fileStatus: statusRes.status === 'fulfilled' ? (statusRes.value ?? []) : [],
          ...(branchRequest === branchesRequest ? { branches: branchesRes.status === 'fulfilled' ? (branchesRes.value ?? []) : [] } : {}),
          error: [...(branchError ? [String(branchError)] : []), ...[statusRes, branchesRes].filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason))].join('; ') || null,
        })
      })
    } catch (err) {
      if (current()) set({ error: err instanceof Error ? err.message : 'Failed to open repository' })
    } finally {
      if (current()) set({ isLoading: false })
    }
  },

  refreshStatus: async () => {
    const { repoPath } = get()
    if (!repoPath) return
    const generation = repoGeneration
    const request = ++statusRequest
    const branchesRequest = ++branchRequest
    const current = () => generation === repoGeneration && get().repoPath === repoPath && request === statusRequest
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
        if (!current()) return
        const [statusR, branchR, branchesR] = await Promise.allSettled([
          window.lucidGit.status(repoPath),
          window.lucidGit.currentBranch(repoPath),
          window.lucidGit.branchList(repoPath),
        ])
        if (!current()) return
        if (statusR.status   === 'fulfilled') set({ fileStatus: statusR.value ?? [] })
        if (branchR.status   === 'fulfilled') set({ currentBranch: branchR.value ?? '' })
        if (branchRequest === branchesRequest && branchesR.status === 'fulfilled') set({ branches: branchesR.value ?? [] })
        set({ error: [statusR, branchR, branchesR].filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason)).join('; ') || null })
      })
    } catch (error) {
      if (current()) set({ error: String(error) })
    } finally {
      if (current()) set({ isLoading: false })
    }
  },

  silentRefresh: async () => {
    const { repoPath, isLoading, isSilentRefreshing } = get()
    // Skip if an explicit refreshStatus is already in flight — it will win
    if (!repoPath || isLoading || isSilentRefreshing) return
    const generation = repoGeneration
    const request = ++statusRequest
    set({ isSilentRefreshing: true })
    try {
      const [statusR, branchR] = await Promise.allSettled([
        window.lucidGit.status(repoPath),
        window.lucidGit.currentBranch(repoPath),
      ])
      // Only write if no explicit refresh started while we were waiting
      if (repoGeneration === generation && get().repoPath === repoPath && statusRequest === request && !get().isLoading) {
        if (statusR.status === 'fulfilled') set({ fileStatus: statusR.value ?? [] })
        if (branchR.status === 'fulfilled') set({ currentBranch: branchR.value ?? '' })
        set({ error: [statusR, branchR].filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason)).join('; ') || null })
      }
    } catch { /* ignore */ }
    finally { if (generation === repoGeneration && get().repoPath === repoPath) set({ isSilentRefreshing: false }) }
  },

  loadBranches: async () => {
    const { repoPath } = get()
    if (!repoPath) return
    const generation = repoGeneration
    const request = ++branchRequest
    const branches = await window.lucidGit.branchList(repoPath).catch(error => {
      if (generation === repoGeneration && request === branchRequest) set({ error: String(error) })
      return null
    })
    if (generation === repoGeneration && repoPath === get().repoPath && request === branchRequest && branches) set({ branches })
  },

  checkout: async (branch: string) => {
    const { repoPath } = get()
    if (!repoPath) return
    const op = useOperationStore.getState()
    const generation = repoGeneration
    await op.run(`Switching to ${branch}…`, async () => {
      if (generation !== repoGeneration || get().repoPath !== repoPath) return
      await window.lucidGit.checkout(repoPath, branch)
      if (generation !== repoGeneration || get().repoPath !== repoPath) return
      const request = ++statusRequest
      const branchesRequest = ++branchRequest
      // The checkout already succeeded. Refreshing what it changed is
      // follow-up work, so a failure here must not surface as "Switching to X
      // failed" for a branch the user is now standing on.
      const [statusR, currentBranchR, branchesR] = await Promise.allSettled([
        window.lucidGit.status(repoPath),
        window.lucidGit.currentBranch(repoPath),
        window.lucidGit.branchList(repoPath),
      ])
      if (generation !== repoGeneration || get().repoPath !== repoPath || request !== statusRequest) return
      set(s => ({
        isLoading: false,
        currentBranch: currentBranchR.status === 'fulfilled' ? currentBranchR.value : branch,
        fileStatus:    statusR.status        === 'fulfilled' ? (statusR.value ?? []) : s.fileStatus,
        branches:      branchesRequest === branchRequest && branchesR.status === 'fulfilled' ? (branchesR.value ?? s.branches) : s.branches,
        error: [statusR, currentBranchR, branchesR].filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason)).join('; ') || null,
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

  clearRepo: () => {
    repoGeneration++
    statusRequest++
    branchRequest++
    set({ repoPath: null, fileStatus: [], currentBranch: '', branches: [], isLoading: false, isSilentRefreshing: false, error: null })
  },

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
