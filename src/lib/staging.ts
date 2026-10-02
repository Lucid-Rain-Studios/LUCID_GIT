import type { Lock } from '@/ipc'

export function canStagePath(path: string, locks: Lock[], login: string | null): boolean {
  const lock = locks.find(item => item.path.replace(/\\/g, '/') === path.replace(/\\/g, '/'))
  return !lock || lock.owner.login === login
}
