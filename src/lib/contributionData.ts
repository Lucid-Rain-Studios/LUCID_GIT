import { ipc, CommitEntry } from '@/ipc'

interface ContributionData { commits: CommitEntry[]; identity: { name: string; email: string } }
const cache = new Map<string, { tick: number; data: ContributionData }>()
const pending = new Map<string, { tick: number; request: Promise<ContributionData> }>()

export function contributionData(repoPath: string, tick: number): Promise<ContributionData> {
  const cached = cache.get(repoPath)
  if (cached?.tick === tick) return Promise.resolve(cached.data)
  const active = pending.get(repoPath)
  if (active?.tick === tick) return active.request
  const request = Promise.all([
    ipc.log(repoPath, { all: true, limit: 10000 }),
    ipc.gitGetIdentity(repoPath).catch(() => ({ name: '', email: '' })),
  ]).then(([commits, identity]) => {
    const data = { commits, identity }
    if (pending.get(repoPath)?.request === request) {
      cache.delete(repoPath)
      cache.set(repoPath, { tick, data })
      if (cache.size > 5) cache.delete(cache.keys().next().value!)
    }
    return data
  }).finally(() => { if (pending.get(repoPath)?.request === request) pending.delete(repoPath) })
  pending.set(repoPath, { tick, request })
  return request
}
