export type SyncBusyState = 'idle' | 'fetch' | 'pull' | 'push'

export function fetchButtonLabel(busy: SyncBusyState): string {
  return busy === 'fetch' ? 'Fetching…' : 'Fetch'
}

export function pullButtonLabel(busy: SyncBusyState): string {
  return busy === 'pull' ? 'Pulling…' : 'Pull'
}

export function pushButtonLabel(busy: SyncBusyState, hasPublishedBranch: boolean = true): string {
  if (busy === 'push') return hasPublishedBranch ? 'Pushing…' : 'Pushing Branch…'
  return hasPublishedBranch ? 'Push' : 'Push Branch'
}

function busyReason(busy: SyncBusyState): string | null {
  if (busy === 'fetch') return 'Fetch in progress'
  if (busy === 'pull') return 'Pull in progress'
  if (busy === 'push') return 'Push in progress'
  return null
}

export function canPull(hasFetched: boolean, behind: number, busy: SyncBusyState, allowUpToDate = false): boolean {
  return busy === 'idle' && hasFetched && (behind > 0 || allowUpToDate)
}

export function canPush(_hasFetched: boolean, _behind: number, ahead: number, busy: SyncBusyState, hasPublishedBranch: boolean = true, _hasIntegrated = true): boolean {
  if (busy !== 'idle') return false
  // An unpublished branch can inherit another branch's upstream. Allow push regardless
  // of fetch state or ahead count; `git push --set-upstream` handles it.
  if (!hasPublishedBranch) return true
  // Fetch and incoming-update checks run when Push is clicked.
  return ahead > 0
}

// "ahead" here is intentionally NOT taken as a gate. SyncStatus.ahead measures
// how far HEAD is ahead of its UPSTREAM remote tracking branch, which becomes
// 0 the moment you push — yet a PR is exactly what you want to open after
// pushing. The relevant check ("does this branch have commits not on main?")
// would require a separate branchDiff call; for the button gate it's enough
// that the branch exists, isn't main, has a GitHub remote, and isn't busy.
// GitHub itself reports "no commits between" if the branch has nothing new.
export function canCreatePR(hasRemote: boolean, branchName: string | null | undefined, busy: SyncBusyState): boolean {
  const normalized = (branchName ?? '').trim().toLowerCase()
  const isMainBranch = normalized === 'main'
  return hasRemote && !!normalized && !isMainBranch && busy === 'idle'
}

export function fetchDisabledReason(busy: SyncBusyState): string | null {
  return busyReason(busy)
}

export function pullDisabledReason(hasFetched: boolean, behind: number, busy: SyncBusyState, allowUpToDate = false): string | null {
  return busyReason(busy) ?? (!hasFetched ? 'Please Fetch first' : behind === 0 && !allowUpToDate ? 'Nothing to merge' : null)
}

export function pushDisabledReason(_hasFetched: boolean, _behind: number, ahead: number, busy: SyncBusyState, hasPublishedBranch: boolean = true, _hasIntegrated = true): string | null {
  const busy_ = busyReason(busy)
  if (busy_) return busy_
  if (!hasPublishedBranch) return null
  return ahead === 0 ? 'Nothing to push' : null
}

export function createPRDisabledReason(hasRemote: boolean, branchName: string | null | undefined, busy: SyncBusyState): string | null {
  const normalized = (branchName ?? '').trim().toLowerCase()
  return busyReason(busy)
    ?? (!hasRemote ? 'No GitHub remote detected'
      : !normalized ? 'No branch selected'
        : normalized === 'main' ? 'Create PR from a feature branch'
          : null)
}
