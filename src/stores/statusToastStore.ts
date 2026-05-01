import { create } from 'zustand'

export interface StatusToast {
  id: number
  message: string
}

interface StatusToastState {
  toasts: StatusToast[]
  show: (message: string) => number
  remove: (id: number) => void
}

let nextToastId = 1

export const useStatusToastStore = create<StatusToastState>((set) => ({
  toasts: [],

  show: (message) => {
    const id = nextToastId++
    set((state) => ({
      toasts: [...state.toasts, { id, message }],
    }))
    return id
  },

  remove: (id) => set((state) => ({
    toasts: state.toasts.filter(t => t.id !== id),
  })),
}))
