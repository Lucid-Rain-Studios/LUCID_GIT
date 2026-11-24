import { create } from 'zustand'

export const useBackgroundRepoTaskStore = create<{ repoPath: string | null }>(() => ({ repoPath: null }))
