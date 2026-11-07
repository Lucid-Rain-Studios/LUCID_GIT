import type { Lock } from '@/ipc'

/** Build once per lock snapshot, then check each displayed file in constant time. */
export function createStageGuard(locks: Lock[], login: string | null): (path: string) => boolean {
  const owners = new Map<string, string>()
  for (const lock of locks) {
    const path = lock.path.replace(/\\/g, '/')
    if (!owners.has(path)) owners.set(path, lock.owner.login)
  }
  return path => {
    const normalized = path.replace(/\\/g, '/')
    return !owners.has(normalized) || owners.get(normalized) === login
  }
}

export function canStagePath(path: string, locks: Lock[], login: string | null): boolean {
  const lock = locks.find(item => item.path.replace(/\\/g, '/') === path.replace(/\\/g, '/'))
  return !lock || lock.owner.login === login
}
