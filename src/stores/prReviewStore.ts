import { create } from 'zustand'
import type { PullRequest } from '@/ipc'

interface ReviewRequest { pr: PullRequest; ghSlug: string; repoPath: string }

export function prReviewKey({ repoPath, ghSlug, pr }: ReviewRequest): string {
  return JSON.stringify([repoPath, ghSlug, pr.number])
}

interface PRReviewState {
  request: ReviewRequest | null
  minimized: boolean
  busy: boolean
  completed: Record<string, Record<number, 'accept' | 'decline'>>
  open: (request: ReviewRequest) => void
  close: () => void
  complete: (repoPath: string, prNumber: number, action: 'accept' | 'decline') => void
  reconcile: (repoPath: string, openPRs: PullRequest[]) => void
}

// Owned by the app shell, so changing tabs cannot dispose of a running merge.
export const usePRReviewStore = create<PRReviewState>((set, get) => ({
  request: null, minimized: false, busy: false, completed: {},
  open: request => {
    const { request: active, busy } = get()
    if (active && prReviewKey(active) === prReviewKey(request)) {
      set({ minimized: false })
      return
    }
    if (busy) return
    set({ request, minimized: false })
  },
  close: () => {
    if (get().busy) { set({ minimized: true }); return }
    set({ request: null, minimized: false })
  },
  complete: (repoPath, prNumber, action) => set(s => ({
    completed: { ...s.completed, [repoPath]: { ...s.completed[repoPath], [prNumber]: action } },
  })),
  reconcile: (repoPath, openPRs) => {
    const previous = get().completed[repoPath]
    if (!previous) return
    const open = new Set(openPRs.map(pr => pr.number))
    const next = Object.fromEntries(Object.entries(previous).filter(([number]) => open.has(Number(number))))
    if (Object.keys(next).length !== Object.keys(previous).length) {
      set(s => ({ completed: { ...s.completed, [repoPath]: next } }))
    }
  },
}))
