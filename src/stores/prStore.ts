import { create } from 'zustand'

interface PRDialogState {
  open: boolean
  repoPath: string | null
  headBranch: string | null
  remoteUrl: string | null
  openDialog: (repoPath: string, headBranch: string, remoteUrl: string) => void
  closeDialog: () => void
}

export const usePRStore = create<PRDialogState>(set => ({
  open: false,
  repoPath: null,
  headBranch: null,
  remoteUrl: null,
  openDialog: (repoPath, headBranch, remoteUrl) =>
    set({ open: true, repoPath, headBranch, remoteUrl }),
  closeDialog: () => set({ open: false }),
}))
