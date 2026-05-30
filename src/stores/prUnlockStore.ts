import { create } from 'zustand'
import { ipc, PRMonitorStatus, PRMonitorMergedInfo } from '@/ipc'

interface PRUnlockState {
  status:     PRMonitorStatus | null
  dialogOpen: boolean
  dialogPR:   PRMonitorMergedInfo | null
  repoPath:   string | null

  refresh:      (repoPath: string) => Promise<void>
  openDialog:   (repoPath: string, pr: PRMonitorMergedInfo) => void
  closeDialog:  () => void
  markResolved: (repoPath: string, prNumber: number) => Promise<void>
}

export const usePRUnlockStore = create<PRUnlockState>((set, get) => ({
  status:     null,
  dialogOpen: false,
  dialogPR:   null,
  repoPath:   null,

  refresh: async (repoPath) => {
    try {
      const status = await ipc.prMonitorStatus(repoPath)
      set({ status, repoPath })
    } catch {
      // Best-effort; leave previous status in place on transient failure.
    }
  },

  openDialog: (repoPath, pr) => set({ dialogOpen: true, dialogPR: pr, repoPath }),

  closeDialog: () => set({ dialogOpen: false, dialogPR: null }),

  markResolved: async (repoPath, prNumber) => {
    try { await ipc.prMonitorResolve(repoPath, prNumber) } catch { /* best-effort */ }
    await get().refresh(repoPath)
  },
}))
