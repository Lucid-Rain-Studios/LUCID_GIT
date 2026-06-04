import { create } from 'zustand'
import { ipc, PRMonitorStatus } from '@/ipc'

// The unlock dialog handles two sources of "your merged files":
//  - 'pr':   a pull request created through the app, tracked by number.
//  - 'main': work detected (purely from git) as already present in main,
//            regardless of how it landed (direct merge, squash, external PR).
export type UnlockTarget =
  | { kind: 'pr';   prNumber: number; title: string; htmlUrl: string; availableToUnlock: string[]; containsLocalChanges: string[] }
  | { kind: 'main'; title: string; availableToUnlock: string[]; containsLocalChanges: string[] }

interface PRUnlockState {
  status:     PRMonitorStatus | null
  dialogOpen: boolean
  target:     UnlockTarget | null
  repoPath:   string | null

  refresh:      (repoPath: string) => Promise<void>
  openDialog:   (repoPath: string, target: UnlockTarget) => void
  closeDialog:  () => void
  markResolved: (repoPath: string, prNumber: number) => Promise<void>
}

export const usePRUnlockStore = create<PRUnlockState>((set, get) => ({
  status:     null,
  dialogOpen: false,
  target:     null,
  repoPath:   null,

  refresh: async (repoPath) => {
    try {
      const status = await ipc.prMonitorStatus(repoPath)
      set({ status, repoPath })
    } catch {
      // Best-effort; leave previous status in place on transient failure.
    }
  },

  openDialog: (repoPath, target) => set({ dialogOpen: true, target, repoPath }),

  closeDialog: () => set({ dialogOpen: false, target: null }),

  markResolved: async (repoPath, prNumber) => {
    try { await ipc.prMonitorResolve(repoPath, prNumber) } catch { /* best-effort */ }
    await get().refresh(repoPath)
  },
}))
