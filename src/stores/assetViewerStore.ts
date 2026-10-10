import { create } from 'zustand'

interface AssetViewerState {
  repoPath: string | null
  filePath: string | null
  isOpen: boolean
  view: 'asset' | 'blueprint'
  revision: string
  openBlueprint: (repoPath: string, filePath: string, revision?: string) => void
  open: (repoPath: string, filePath: string) => void
  close: () => void
}

export const useAssetViewerStore = create<AssetViewerState>((set) => ({
  repoPath: null,
  filePath: null,
  isOpen: false,
  view: 'asset',
  revision: 'WORKING',
  open: (repoPath, filePath) => set({ repoPath, filePath, isOpen: true, view: 'asset', revision: 'WORKING' }),
  openBlueprint: (repoPath, filePath, revision = 'WORKING') => set({ repoPath, filePath, revision, view: 'blueprint', isOpen: true }),
  close: () => set({ isOpen: false }),
}))
