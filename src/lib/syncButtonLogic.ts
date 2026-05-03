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

function busyReason(busy: SyncBusyState): string | null {
  if (busy === 'fetch') return 'Fetch in progress'
  if (busy === 'pull') return 'Pull in progress'
  if (busy === 'push') return 'Push in progress'
  return null
}

export function canPull(hasFetched: boolean, behind: number, busy: SyncBusyState): boolean {
  return busy === 'idle' && hasFetched && behind > 0
}

export function canPush(hasFetched: boolean, behind: number, ahead: number, busy: SyncBusyState): boolean {
  return busy === 'idle' && hasFetched && behind === 0 && ahead > 0
}

export function canCreatePR(hasRemote: boolean, branchName: string | null | undefined, ahead: number, busy: SyncBusyState): boolean {
  const normalized = (branchName ?? '').trim().toLowerCase()
  const isMainBranch = normalized === 'main'
  return hasRemote && !!normalized && !isMainBranch && busy === 'idle' && ahead > 0
}

export function fetchDisabledReason(busy: SyncBusyState): string | null {
  return busyReason(busy)
}

export function pullDisabledReason(hasFetched: boolean, behind: number, busy: SyncBusyState): string | null {
  return busyReason(busy) ?? (!hasFetched ? 'Please Fetch first' : behind === 0 ? 'Nothing to merge' : null)
}

export function pushDisabledReason(hasFetched: boolean, behind: number, ahead: number, busy: SyncBusyState): string | null {
  return busyReason(busy) ?? (!hasFetched ? 'Please Fetch first' : behind > 0 ? 'Please Pull first' : ahead === 0 ? 'Nothing to push' : null)
}

export function createPRDisabledReason(hasRemote: boolean, branchName: string | null | undefined, ahead: number, busy: SyncBusyState): string | null {
  const normalized = (branchName ?? '').trim().toLowerCase()
  return busyReason(busy)
    ?? (!hasRemote ? 'No GitHub remote detected'
      : !normalized ? 'No branch selected'
        : normalized === 'main' ? 'Create PR from a feature branch'
          : ahead === 0 ? 'Nothing to publish'
            : null)
}
