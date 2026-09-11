import { create } from 'zustand'

/**
 * Requests to open the conflict resolver, from anywhere in the tree.
 *
 * The resolver is hosted by AppShell, but conflicts surface far from it — the
 * stash panel is nested two levels inside History and Timeline, and a stash
 * apply conflicts as readily as a merge does. Threading a callback down every
 * one of those paths would be a lot of prop drilling for one rare event, and
 * the next caller would have to do it again.
 */
interface ConflictState {
  /**
   * Label for what was being merged in — a branch name for a real merge, or a
   * description like "the stashed changes". Null when the resolver is closed.
   */
  target: string | null
  open: (target: string) => void
  close: () => void
}

export const useConflictStore = create<ConflictState>(set => ({
  target: null,
  open: (target: string) => set({ target }),
  close: () => set({ target: null }),
}))

/**
 * Open the resolver if `error` is git reporting a conflict.
 *
 * Returns true when it took responsibility for the error, so the caller can
 * skip showing its own message — the resolver is a better answer than a raw
 * "CONFLICT (content): Merge conflict in ..." dump.
 */
export function routeConflictToResolver(error: unknown, target: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!/conflict/i.test(message)) return false
  useConflictStore.getState().open(target)
  return true
}
