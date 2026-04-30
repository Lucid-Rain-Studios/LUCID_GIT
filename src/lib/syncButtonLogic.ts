export type SyncBusyState = 'idle' | 'fetch' | 'pull' | 'push'

export function fetchButtonLabel(busy: SyncBusyState): string {
  return busy === 'fetch' ? 'Fetching…' : 'Fetch'
}

export function pullButtonLabel(busy: SyncBusyState): string {
  return busy === 'pull' ? 'Pulling…' : 'Pull'
}

export function pushButtonLabel(busy: SyncBusyState): string {
  return busy === 'push' ? 'Pushing…' : 'Push'
}

export function canPull(hasFetched: boolean, busy: SyncBusyState): boolean {
  return busy === 'idle' && hasFetched
}

export function canPush(hasFetched: boolean, behind: number, ahead: number, busy: SyncBusyState): boolean {
  return busy === 'idle' && hasFetched && behind === 0 && ahead > 0
}

export function canCreatePR(hasRemote: boolean, hasBranch: boolean, ahead: number, busy: SyncBusyState): boolean {
  return hasRemote && hasBranch && busy === 'idle' && ahead > 0
}
