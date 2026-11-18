import type { CommitEntry } from '@/ipc'

/** Display only: never infer a historical destination from today's branch tips. */
export function commitDisplayMessage(commit: Pick<CommitEntry, 'message' | 'parentHashes'>): string {
  const { message, parentHashes } = commit
  if (parentHashes.length < 2) return message

  const pr = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)(?: into (\S+))?$/.exec(message)
  if (pr) return `[MERGE] PR #${pr[1]} from ${pr[2]}${pr[3] ? ` -> ${pr[3]}` : ''}`

  const branch = /^Merge (branch|remote-tracking branch) '([^']+)'(?: of (\S+))?(?: into (\S+))?$/.exec(message)
  if (!branch) return message
  const [, kind, ref, repository, destination] = branch
  const remote = kind === 'remote-tracking branch' || Boolean(repository)
  // Remote-tracking refs have a remote name followed by the complete branch path.
  const source = kind === 'remote-tracking branch' ? ref.replace(/^[^/]+\//, '') : ref
  return `[MERGE] ${source}${remote ? ' (Remote)' : ''}${destination ? ` -> ${destination}` : ''}`
}
