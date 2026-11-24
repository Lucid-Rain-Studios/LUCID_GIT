import { create } from 'zustand'
import type { MergeWindowContext, MergeWindowProgress } from '../../electron/mergeWindowTypes'

interface MergeWindowState {
  task: (MergeWindowProgress & MergeWindowContext) | null
}

export const useMergeWindowStore = create<MergeWindowState>(() => ({ task: null }))
