import { create } from 'zustand'
import { ipc } from '@/ipc'
import { DEFAULT_PERFORMANCE, normalizePerformance, type PerformanceSettings } from '../../electron/util/performance'

/** Same event the other settings screens broadcast after saving. */
const SETTINGS_CHANGED_EVENT = 'lucid-git:settings-changed'

interface PerformanceState {
  settings: PerformanceSettings
  load: () => Promise<void>
}

/** Renderer view of the Performance settings; Medium until the saved values arrive. */
export const usePerformanceStore = create<PerformanceState>(set => ({
  settings: DEFAULT_PERFORMANCE,
  load: async () => {
    try { set({ settings: normalizePerformance((await ipc.settingsGet()).performance) }) } catch { /* keep the current values */ }
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener(SETTINGS_CHANGED_EVENT, () => { void usePerformanceStore.getState().load() })
  void usePerformanceStore.getState().load()
}
