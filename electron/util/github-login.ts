export function sameGitHubLogin(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase())
}

export function isGitHubLockOwner(
  lock: { id?: string; owner: { login: string }; prOverlay?: unknown } | null | undefined,
  login: string | null | undefined,
): boolean {
  return Boolean(lock && !lock.prOverlay && !lock.id?.startsWith('ghost-pr-') && sameGitHubLogin(lock.owner.login, login))
}
