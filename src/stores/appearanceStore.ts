import { create } from 'zustand'
import type { AppSettings } from '@/ipc'

export const useAppearanceStore = create<{
  settings: Partial<AppSettings>
  apply: (settings: Partial<AppSettings>) => void
}>(set => ({
  settings: { theme: 'dark', fontSize: 13, codeFontFamily: 'Menlo' },
  apply: settings => set(state => ({ settings: { ...state.settings, ...settings } })),
}))
