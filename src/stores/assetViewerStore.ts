import { create } from 'zustand'

interface AssetViewerState {
  repoPath: string | null
  filePath: string | null
  isOpen: boolean
  open: (repoPath: string, filePath: string) => void
  close: () => void
}

export const useAssetViewerStore = create<AssetViewerState>((set) => ({
  repoPath: null,
  filePath: null,
  isOpen: false,
  open: (repoPath, filePath) => set({ repoPath, filePath, isOpen: true }),
  close: () => set({ isOpen: false }),
}))
