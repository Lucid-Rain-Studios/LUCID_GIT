import { create } from 'zustand'

export interface StatusToastAction {
  label: string
  onClick: () => void
}

export interface StatusToast {
  id: number
  message: string
  action?: StatusToastAction
  durationMs?: number
}

interface StatusToastOptions {
  action?: StatusToastAction
  durationMs?: number
}

interface StatusToastState {
  toasts: StatusToast[]
  show: (message: string, opts?: StatusToastOptions) => number
  remove: (id: number) => void
}

let nextToastId = 1

export const useStatusToastStore = create<StatusToastState>((set) => ({
  toasts: [],

  show: (message, opts) => {
    const id = nextToastId++
    set((state) => ({
      toasts: [...state.toasts, { id, message, action: opts?.action, durationMs: opts?.durationMs }],
    }))
    return id
  },

  remove: (id) => set((state) => ({
    toasts: state.toasts.filter(t => t.id !== id),
  })),
}))
