import type { BranchInfo } from '@/ipc'

export function timelineBranches(branches: BranchInfo[]): BranchInfo[] {
  const origin = branches.filter(b => b.isRemote && (b.remoteName === 'origin' || b.name.startsWith('origin/')))
  if (origin.length) return origin
  const remote = branches.filter(b => b.isRemote)
  return remote.length ? remote : branches.filter(b => !b.isRemote)
}
