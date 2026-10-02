import { create } from 'zustand'
import type { ForecastConflict } from '@/ipc'

interface ForecastState {
  conflicts: ForecastConflict[]
  error: string | null
  enabled: boolean
  lastPolledAt: number | null
  setConflicts: (c: ForecastConflict[]) => void
  setEnabled: (v: boolean) => void
  setLastPolledAt: (t: number) => void
  clear: () => void
}

export const useForecastStore = create<ForecastState>((set) => ({
  conflicts: [],
  error: null,
  enabled: false,
  lastPolledAt: null,
  setConflicts: (conflicts) => set({ conflicts }),
  setEnabled: (enabled) => set({ enabled }),
  setLastPolledAt: (t) => set({ lastPolledAt: t }),
  clear: () => set({ conflicts: [], enabled: false, lastPolledAt: null, error: null }),
}))
