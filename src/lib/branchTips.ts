import type { BranchInfo } from '@/ipc'

/** Labels and lanes use the branch-list snapshot, without per-branch Git calls. */
export function groupBranchTips(branches: BranchInfo[]): Map<string, BranchInfo[]> {
  const tips = new Map<string, BranchInfo[]>()
  for (const branch of branches) {
    if (!branch.tipHash) continue
    const group = tips.get(branch.tipHash) ?? []
    if (!group.some(existing => existing.name === branch.name)) group.push(branch)
    tips.set(branch.tipHash, group)
  }
  return tips
}

export function selectedBranchTips(branches: BranchInfo[], refs: string[]): Map<string, string> {
  const hashes = new Map(branches.map(branch => [branch.name, branch.tipHash]))
  const tips = new Map<string, string>()
  for (const ref of refs) {
    const hash = hashes.get(ref)
    if (hash) tips.set(hash, ref)
  }
  return tips
}
