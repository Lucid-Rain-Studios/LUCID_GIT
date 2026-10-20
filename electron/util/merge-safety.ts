import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { exec, execSafe } from './dugite-exec'
import { nulPaths } from './git-paths'
import { logService } from '../services/LogService'

const JOURNAL = 'lucid-merge-safety.json'
const BLOCKED = 'Merge completion blocked:'
const NEXT_STEP = 'Save any local edits, then abort this merge and retry it after fixing the reported error. Removing index.lock alone does not reconstruct the merged contents.'

interface MergeContext { gitDir: string; head: string; incoming: string[] }
interface MergeJournal {
  id: string
  operation: string
  startedAt: string
  head: string
  incoming?: string[]
  failure?: string
}

async function optionalFile(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function context(repo: string): Promise<MergeContext> {
  const gitDir = (await exec(['rev-parse', '--absolute-git-dir'], repo)).stdout.trim()
  const incoming = (await optionalFile(path.join(gitDir, 'MERGE_HEAD')))?.trim().split(/\s+/).filter(Boolean) ?? []
  const head = await execSafe(['rev-parse', '--verify', '--quiet', 'HEAD'], repo)
  if (head.exitCode !== 0 && head.exitCode !== 1) throw new Error(head.stderr || 'Could not inspect HEAD for merge safety.')
  return { gitDir, incoming, head: head.stdout.trim() }
}

async function journalReason(state: MergeContext): Promise<string | undefined> {
  if (!state.incoming.length) return undefined
  try {
    const raw = await optionalFile(path.join(state.gitDir, JOURNAL))
    if (raw === null) return undefined
    const record = JSON.parse(raw) as MergeJournal
    if (typeof record.head !== 'string' || !/^[0-9a-f]{40,64}$/.test(record.head)
      || typeof record.id !== 'string' || !record.id
      || (record.incoming !== undefined && (!Array.isArray(record.incoming)
        || !record.incoming.every(ref => typeof ref === 'string' && /^[0-9a-f]{40,64}$/.test(ref))))) {
      throw new Error('Invalid merge safety record')
    }
    if (record.head !== state.head || (record.incoming && record.incoming.join(' ') !== state.incoming.join(' '))) return undefined
    return `${BLOCKED} ${record.failure ? 'The merge failed before its result could be trusted.' : 'The previous merge attempt was interrupted before its result was verified.'} ${NEXT_STEP}${record.failure ? ` Original failure: ${record.failure}` : ''}`
  } catch {
    return `${BLOCKED} The saved merge recovery record could not be read. ${NEXT_STEP}`
  }
}

/** Cheap polling path: only inspect a journal when there is a merge to finish. */
export async function mergeBlockingReason(repo: string): Promise<string | undefined> {
  return journalReason(await context(repo))
}

export function isMergeWriteFailure(error: unknown): boolean {
  return /(?:(?:unable|failed) to|could not|cannot) write (?:the |new )?(?:\.git[\\/])?index|index\.lock|smudge.*fail|filter.*fail|fatal:|permission denied|no space left|read.only file system|disk (?:is )?full/i.test(String(error))
}

/** Diagnostics use index/object metadata only; no worktree scan or asset reads. */
async function diagnostics(repo: string, state: MergeContext) {
  const [staged, unmerged, indexTree, headTree, lock, operationId] = await Promise.all([
    execSafe(['diff', '--cached', '--name-only', '--no-ext-diff', '--no-renames', '-z'], repo),
    execSafe(['diff', '--name-only', '--diff-filter=U', '--no-ext-diff', '-z'], repo),
    execSafe(['write-tree'], repo),
    execSafe(['rev-parse', '--verify', 'HEAD^{tree}'], repo),
    fs.stat(path.join(state.gitDir, 'index.lock')).catch(() => null),
    optionalFile(path.join(state.gitDir, JOURNAL)).then(raw => raw ? (JSON.parse(raw) as MergeJournal).id : null).catch(() => null),
  ])
  const paths = nulPaths(staged.stdout)
  const unresolved = nulPaths(unmerged.stdout)
  return {
    repo, operationId, head: state.head, incoming: state.incoming,
    headTree: headTree.stdout.trim(), indexTree: indexTree.exitCode === 0 ? indexTree.stdout.trim() : null,
    indexError: indexTree.exitCode === 0 ? null : indexTree.stderr.slice(0, 500),
    stagedCount: staged.exitCode === 0 ? paths.length : null, stagedSample: paths.slice(0, 8),
    unresolvedCount: unmerged.exitCode === 0 ? unresolved.length : null,
    lock: lock ? { bytes: lock.size, ageMs: Math.max(0, Date.now() - lock.mtimeMs) } : null,
  }
}

/** Persist BEFORE starting: a process crash must not turn a failed write into a finishable merge. */
export async function guardedMergeOperation<T>(repo: string, operation: string, run: () => Promise<T>): Promise<T> {
  const before = await context(repo)
  if (before.incoming.length) throw new Error((await journalReason(before)) ?? 'A merge is already in progress. Finish or abort it before starting another merge.')
  const record: MergeJournal = { id: randomUUID(), operation, startedAt: new Date().toISOString(), head: before.head }
  const file = path.join(before.gitDir, JOURNAL)
  await fs.writeFile(file, JSON.stringify(record), 'utf8')
  logService.info('git.merge-safety', `Merge started: ${JSON.stringify({ ...record, repo })}`)
  try {
    const result = await run()
    const after = await context(repo)
    logService.info('git.merge-safety', `Merge completed: ${JSON.stringify({ id: record.id, operation, ...await diagnostics(repo, after) })}`)
    await fs.rm(file, { force: true })
    return result
  } catch (error) {
    // Keep the original running record if even inspecting/writing the failure
    // fails. A subsequent session will refuse to finish that interrupted merge.
    try {
      const after = await context(repo)
      const detail = await diagnostics(repo, after)
      const genuineConflict = !isMergeWriteFailure(error)
        && /CONFLICT\s*\(|automatic merge failed|cannot merge binary|fix conflicts|unmerged files|merge conflict/i.test(String(error))
        && detail.unresolvedCount !== null && detail.unresolvedCount > 0
      logService.error('git.merge-safety', `Merge failed: ${JSON.stringify({ id: record.id, operation, error: String(error).slice(0, 3000), genuineConflict, ...detail })}`)
      if (after.incoming.length && !genuineConflict) {
        await fs.writeFile(file, JSON.stringify({ ...record, head: after.head, incoming: after.incoming, failure: String(error).slice(0, 1500) }), 'utf8')
        throw new Error(`${BLOCKED} The merge did not finish safely. ${NEXT_STEP} Original failure: ${String(error)}`)
      }
      await fs.rm(file, { force: true })
    } catch (recordError) {
      if (String(recordError).includes(BLOCKED)) throw recordError
      logService.error('git.merge-safety', `Could not record merge failure; the interrupted-operation guard is retained: ${String(recordError)}`)
    }
    throw error
  }
}

/** Called again on commit retries: clearing a lock does not validate the index. */
export async function assertSafeMergeCommit(repo: string): Promise<MergeContext> {
  const state = await context(repo)
  if (!state.incoming.length) return state
  let reason = await journalReason(state)
  if (!reason) {
    const staged = await execSafe(['diff', '--cached', '--quiet', '--no-ext-diff', 'HEAD', '--'], repo)
    if (staged.exitCode !== 0 && staged.exitCode !== 1) throw new Error(`${BLOCKED} Could not verify the staged merge result. ${NEXT_STEP}`)
    // Also catch unfinished merges created by older app versions or another
    // client, where no journal exists. Compute only for a suspicious empty index.
    if (staged.exitCode === 0) {
      if (state.incoming.length !== 1) reason = `${BLOCKED} Cannot verify an empty multi-head merge. ${NEXT_STEP}`
      else {
        const expected = await execSafe(['merge-tree', '--write-tree', state.head, state.incoming[0]], repo)
        const tree = expected.stdout.split(/[\r\n\0]/)[0]
        if (![0, 1].includes(expected.exitCode) || !/^[0-9a-f]{40,64}$/.test(tree)) {
          reason = `${BLOCKED} Could not independently verify the empty merge result. ${NEXT_STEP}`
        } else if (expected.exitCode === 0) {
          const headTree = (await exec(['rev-parse', 'HEAD^{tree}'], repo)).stdout.trim()
          if (tree !== headTree) reason = `${BLOCKED} The index contains none of the incoming changes, although Git can merge them cleanly. ${NEXT_STEP}`
        }
        // Real conflicts can intentionally be resolved entirely to our side.
        // A genuinely unchanged clean merge is also valid. Log both cases.
        if (!reason) logService.info('git.merge-safety', `Verified empty merge: ${JSON.stringify({ repo, head: state.head, incoming: state.incoming, expectedTree: tree, hasConflicts: expected.exitCode === 1 })}`)
      }
    }
  }
  if (reason) {
    logService.error('git.merge-safety', `Commit blocked: ${JSON.stringify({ reason, ...await diagnostics(repo, state) })}`)
    throw new Error(reason)
  }
  return state
}

export async function guardedMergeCommit<T>(repo: string, run: () => Promise<T>): Promise<T> {
  const before = await assertSafeMergeCommit(repo)
  const commitId = randomUUID()
  if (before.incoming.length) logService.info('git.merge-safety', `Merge commit started: ${JSON.stringify({ commitId, ...await diagnostics(repo, before) })}`)
  try {
    const result = await run()
    if (before.incoming.length) {
      const after = await context(repo)
      logService.info('git.merge-safety', `Merge commit completed: ${JSON.stringify({ commitId, previousHead: before.head, parents: before.incoming, ...await diagnostics(repo, after) })}`)
    }
    return result
  } catch (error) {
    if (before.incoming.length) logService.error('git.merge-safety', `Merge commit failed: ${JSON.stringify({ commitId, error: String(error).slice(0, 3000), ...await diagnostics(repo, await context(repo)) })}`)
    throw error
  }
}

export async function clearMergeGuardAfterAbort(repo: string): Promise<void> {
  const state = await context(repo)
  if (state.incoming.length) throw new Error('Git still reports an active merge after abort. The merge recovery guard was retained.')
  await fs.rm(path.join(state.gitDir, JOURNAL), { force: true })
  logService.info('git.merge-safety', `Merge aborted; recovery guard cleared: ${JSON.stringify({ repo, head: state.head })}`)
}
