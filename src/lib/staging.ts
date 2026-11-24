import type { Lock } from '@/ipc'
import { isGitHubLockOwner } from '../../electron/util/github-login'

/** Build once per lock snapshot, then check each displayed file in constant time. */
export function createStageGuard(locks: Lock[], login: string | null): (path: string) => boolean {
  const eligibility = new Map<string, boolean>()
  for (const lock of locks) {
    const path = lock.path.replace(/\\/g, '/')
    if (!eligibility.has(path)) eligibility.set(path, isGitHubLockOwner(lock, login))
  }
  return path => {
    const normalized = path.replace(/\\/g, '/')
    return eligibility.get(normalized) ?? true
  }
}

export function canStagePath(path: string, locks: Lock[], login: string | null): boolean {
  const lock = locks.find(item => item.path.replace(/\\/g, '/') === path.replace(/\\/g, '/'))
  return !lock || isGitHubLockOwner(lock, login)
}
