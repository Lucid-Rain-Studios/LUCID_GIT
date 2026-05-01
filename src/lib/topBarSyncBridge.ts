import { SyncStatus } from '@/ipc'

export type SyncOpState = 'idle' | 'fetching' | 'pulling' | 'pushing'

export interface TopBarSyncSnapshot {
  repoPath: string | null
  sync: SyncStatus | null
  syncOp: SyncOpState
  hasFetched: boolean
  canPushNow: boolean
  canCreatePRNow: boolean
}

interface TopBarSyncHandlers {
  fetch: () => Promise<void> | void
  pull: () => Promise<void> | void
  push: () => Promise<void> | void
  createPR: () => Promise<void> | void
}

let snapshot: TopBarSyncSnapshot = {
  repoPath: null,
  sync: null,
  syncOp: 'idle',
  hasFetched: false,
  canPushNow: false,
  canCreatePRNow: false,
}

let handlers: TopBarSyncHandlers | null = null
const listeners = new Set<() => void>()

function emit() { listeners.forEach(l => l()) }

export function updateTopBarSyncSnapshot(next: Partial<TopBarSyncSnapshot>) {
  snapshot = { ...snapshot, ...next }
  emit()
}

export function setTopBarSyncHandlers(next: TopBarSyncHandlers | null) {
  handlers = next
  emit()
}

export function getTopBarSyncSnapshot(): TopBarSyncSnapshot { return snapshot }
export function getTopBarSyncHandlers(): TopBarSyncHandlers | null { return handlers }

export function onTopBarSyncChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
