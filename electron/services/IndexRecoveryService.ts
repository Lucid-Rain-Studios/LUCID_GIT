import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execSafe, execWithStdin, withGitTimeout, preemptRepoReads, repoGitTasks, stopRepoGitTasks, gitOpActivity } from '../util/dugite-exec'
import { withRepoSlot } from '../util/repo-gate'
import type { IndexDiagnosis, IndexRepairResult, IndexRecoveryBlockers, IndexLockRecoveryResult, RecoveryIndexLock, RecoveryGitTask } from '../indexRecoveryTypes'

const LIMIT = 128 * 1024 * 1024
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']
const indexError = /index file corrupt|index file smaller than expected|bad index version|bad index file .*signature|unknown index entry format|index uses .*extension|sharedindex\.[0-9a-f]+.*index file|broken index, expect/i

interface Context {
  root: string
  gitDir: string
  index: string
  head: string
  branch: string
  bytes: Buffer | null
  format: 'sha1' | 'sha256'
}
interface Journal {
  version: 1
  id: string
  head: string
  branch: string
  before: string | null
  after: string
  fingerprint: string
  phase: 'prepared' | 'installed' | 'undone'
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}
async function readIndex(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The index is not a regular file. Automatic recovery is unavailable.')
    if (stat.size > LIMIT) throw new Error('The index exceeds the 128 MiB recovery limit. No files were changed.')
    return await fs.readFile(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}
async function durable(file: string, bytes: Buffer | string): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}
async function owned(file: string, identity: { dev: number; ino: number }): Promise<boolean> {
  try { const stat = await fs.lstat(file); return stat.dev === identity.dev && stat.ino === identity.ino }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}
async function git(repo: string, args: string[], index?: string) {
  return withGitTimeout(() => execSafe(['--no-optional-locks', '-c', 'core.splitIndex=false', '-c', 'core.fsmonitor=false', ...args], repo,
    { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', ...(index ? { GIT_INDEX_FILE: index } : {}) }), 60_000, 'Index recovery Git check')
}
async function required(repo: string, args: string[], index?: string): Promise<string> {
  const result = await git(repo, args, index)
  if (result.exitCode) throw new Error(result.stderr || result.stdout || 'Git check failed')
  return result.stdout.trim()
}

async function recoveryPaths(repo: string): Promise<Pick<Context, 'root' | 'gitDir' | 'index'>> {
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    if (process.env[key]) throw new Error(`${key} overrides the repository environment. Restart Lucid Git without this override before using recovery.`)
  }
  if (await required(repo, ['rev-parse', '--is-bare-repository']) !== 'false') throw new Error('Bare repositories do not have a working index to repair.')
  const root = await fs.realpath(await required(repo, ['rev-parse', '--show-toplevel']))
  if (root.toLowerCase() !== (await fs.realpath(repo)).toLowerCase()) throw new Error('Select the repository root before running recovery.')
  const gitDir = await fs.realpath(await required(repo, ['rev-parse', '--absolute-git-dir']))
  const index = path.join(gitDir, 'index')
  return { root, gitDir, index }
}

async function context(repo: string): Promise<Context> {
  const { root, gitDir, index } = await recoveryPaths(repo)
  const format = await required(repo, ['rev-parse', '--show-object-format'])
  if (format !== 'sha1' && format !== 'sha256') throw new Error('Unsupported repository object format.')
  const branchRead = await git(repo, ['symbolic-ref', '-q', 'HEAD'])
  if (branchRead.exitCode > 1) throw new Error(branchRead.stderr)
  const branch = branchRead.stdout.trim()
  const headRead = await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}'])
  let head = headRead.stdout.trim()
  if (headRead.exitCode) {
    // A genuinely unborn branch is safe to rebuild as an empty index. A broken
    // existing ref/object or detached HEAD is a different failure.
    const ref = branch ? await git(repo, ['show-ref', '--verify', '--quiet', branch]) : null
    if (ref?.exitCode !== 1) throw new Error('HEAD is missing or corrupt. Object/history recovery is required; the index was not changed.')
    head = ''
  } else await required(repo, ['cat-file', '-e', `${head}^{tree}`])
  return { root, gitDir, index, head, branch, format, bytes: await readIndex(index) }
}

async function blockers(c: Context, ignoreLock = false): Promise<void> {
  if (!ignoreLock && await exists(c.index + '.lock')) throw new Error('Index.lock exists; its owner is unknown. Automatic index repair preserves the lock. Use Check tasks and lock below, stop Lucid Git tasks if needed, and close other Git clients before deliberate lock recovery.')
  for (const name of operations) if (await exists(path.join(c.gitDir, name))) {
    throw new Error(`An operation is in progress (${name}). Finish or abort that operation before index recovery.`)
  }
  const sparse = await git(c.root, ['config', '--bool', '--get', 'core.sparseCheckout'])
  if (sparse.exitCode > 1) throw new Error(sparse.stderr || 'Could not check sparse-checkout configuration.')
  if (sparse.stdout.trim() === 'true') {
    throw new Error('Sparse checkout requires specialized recovery to preserve skip-worktree state. No files were changed.')
  }
}
function checksumBad(c: Context): boolean {
  if (!c.bytes || c.bytes.length < 12) return false
  const size = c.format === 'sha1' ? 20 : 32
  if (c.bytes.length < 12 + size || c.bytes.subarray(0, 4).toString() !== 'DIRC') return false
  const saved = c.bytes.subarray(-size)
  // Git deliberately allows an all-zero checksum with index.skipHash.
  return saved.some(b => b !== 0) && !createHash(c.format).update(c.bytes.subarray(0, -size)).digest().equals(saved)
}
function token(c: Context): string {
  return hash(JSON.stringify([c.root, c.gitDir, c.head, c.branch, c.bytes ? hash(c.bytes) : null]))
}
async function fingerprint(c: Context, index = c.index): Promise<string> {
  // Ignore stat-cache refreshes but include stage/content/mode, file flags and
  // intent-to-add visibility. This permits Undo after normal status refreshes,
  // while rejecting new staging, conflict stages or changed flags.
  const entries = await required(c.root, ['ls-files', '--stage', '-v', '-z'], index)
  const intent = await required(c.root, ['diff', '--cached', '--raw', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', ...(c.head ? [c.head] : [])], index)
  return hash(entries + '\n' + intent)
}
async function validateObjects(c: Context, index: string): Promise<void> {
  const records = (await required(c.root, ['ls-files', '--stage', '-z'], index)).split('\0').filter(Boolean)
  const objects = new Map<string, string>()
  for (const record of records) {
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) [0-3]\t/.exec(record)
    if (!match) throw new Error('Invalid staged entry in the replacement index.')
    if (match[1] !== '160000') objects.set(match[2], match[1] === '040000' ? 'tree' : 'blob')
  }
  if (!objects.size) return
  // One deduplicated batch; no per-file processes or working-tree traversal.
  const result = await withGitTimeout(() => execWithStdin(['cat-file', '--batch-check=%(objecttype)'], c.root,
    [...objects.keys()].join('\n') + '\n', { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_INDEX_FILE: index }), 60_000, 'Validate staged objects')
  const types = result.stdout.trim().split('\n')
  if (types.length !== objects.size || [...objects.values()].some((type, i) => types[i].trim() !== type)) {
    throw new Error('The replacement refers to missing or invalid staged objects. Object/database recovery is required; the original index was not changed.')
  }
}
async function storage(c: Pick<Context, 'gitDir'>): Promise<string> {
  const base = path.join(c.gitDir, 'lucid-index-recovery')
  await fs.mkdir(base, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(base)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery storage must be a regular metadata directory.')
  return base
}
async function journal(c: Context, id: string): Promise<{ j: Journal; folder: string }> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid recovery ID.')
  const folder = path.join(c.gitDir, 'lucid-index-recovery', id)
  if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error('Invalid recovery storage.')
  const j = JSON.parse(await fs.readFile(path.join(folder, 'journal.json'), 'utf8')) as Journal
  if (j.version !== 1 || j.id !== id || typeof j.head !== 'string' || typeof j.branch !== 'string' ||
      (j.before !== null && !/^[a-f0-9]{64}$/.test(j.before)) || !/^[a-f0-9]{64}$/.test(j.after) || !/^[a-f0-9]{64}$/.test(j.fingerprint) ||
      !['prepared', 'installed', 'undone'].includes(j.phase)) throw new Error('The recovery journal is invalid. Backups were retained.')
  return { j, folder }
}
async function latest(c: Context): Promise<string | undefined> {
  try { return (await fs.readFile(path.join(c.gitDir, 'lucid-index-recovery', 'latest'), 'utf8')).trim() }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}
async function update(file: string, data: string): Promise<void> {
  const temp = file + '.' + randomUUID()
  await durable(temp, data)
  try { await fs.rename(temp, file) } finally { await fs.rm(temp, { force: true }) }
}

export class IndexRecoveryService {
  /** This check deliberately bypasses the gate: a stuck write is what the
   * user needs to inspect and stop. All Git probes are metadata-only reads. */
  async checkBlockers(repo: string): Promise<IndexRecoveryBlockers> {
    const c = await recoveryPaths(repo)
    let lock: RecoveryIndexLock | null = null, lockError: string | undefined
    try { lock = (await this.lockSnapshot(c.index + '.lock'))?.info ?? null }
    catch (error) { lockError = String(error) }
    return { repoPath: repo, tasks: repoGitTasks(repo), pendingGitCommands: gitOpActivity(repo).inFlight, lock, lockError }
  }

  async stopTasks(repo: string, reviewed: Array<Pick<RecoveryGitTask, 'pid' | 'startedAt'>>, confirmed: boolean): Promise<number> {
    if (confirmed !== true) throw new Error('Confirm stopping the listed Lucid Git tasks first.')
    return stopRepoGitTasks(repo, reviewed)
  }

  private async lockSnapshot(file: string): Promise<{ info: RecoveryIndexLock; bytes: Buffer } | null> {
    try {
      const before = await fs.lstat(file)
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('The index lock is not a regular file. Manual filesystem recovery is required.')
      if (before.size > LIMIT) throw new Error('The index lock exceeds the 128 MiB recovery limit. Nothing was removed.')
      const handle = await fs.open(file, 'r')
      let bytes: Buffer
      try {
        const opened = await handle.stat()
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('The index lock changed. Check tasks and lock again.')
        // Read at most the reviewed size plus one byte, even if a live writer
        // grows the file while it is open. A changed size fails below.
        const buffer = Buffer.alloc(before.size + 1)
        let offset = 0
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
          if (!bytesRead) break
          offset += bytesRead
        }
        bytes = buffer.subarray(0, offset)
      } finally { await handle.close() }
      const after = await fs.lstat(file)
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size) {
        throw new Error('The index lock changed. Check tasks and lock again.')
      }
      const token = hash(JSON.stringify([file, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs, hash(bytes)]))
      return { info: { path: file, ageSeconds: Math.max(0, Math.floor((Date.now() - before.mtimeMs) / 1000)), size: before.size, token }, bytes }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** Operator recovery, never automatic: Git locks expose no owner PID. */
  async recoverLock(repo: string, expectedToken: string, externalWritersStopped: boolean): Promise<IndexLockRecoveryResult> {
    if (externalWritersStopped !== true || !expectedToken) throw new Error('Confirm all external Git writers are stopped before recovering the lock.')
    return withRepoSlot(repo, 'write', async () => {
      const c = await recoveryPaths(repo)
      const assertQuiet = () => {
        if (repoGitTasks(repo).length || gitOpActivity(repo).inFlight) throw new Error('Lucid Git tasks are still running or finishing. Stop them and check again before lock recovery.')
      }
      assertQuiet()
      const file = c.index + '.lock', snapshot = await this.lockSnapshot(file)
      if (!snapshot) return { backupPath: null, summary: 'The lock is already gone. No removal was needed.', blockers: await this.checkBlockers(repo) }
      if (snapshot.info.token !== expectedToken) throw new Error('The index lock changed after review. Nothing was removed. Check tasks and lock again.')
      const folder = path.join(await storage(c), randomUUID())
      await fs.mkdir(folder, { mode: 0o700 })
      const backup = path.join(folder, 'original-index.lock')
      await durable(backup, snapshot.bytes)
      // Verify the persisted backup before checking the exact reviewed lock
      // again. Age never establishes ownership; the operator attests quiescence.
      if (hash(await fs.readFile(backup)) !== hash(snapshot.bytes)) throw new Error('Lock backup verification failed. Nothing was removed.')
      const now = await this.lockSnapshot(file)
      assertQuiet()
      if (!now || now.info.token !== expectedToken) throw new Error(`The index lock changed during backup. Nothing was removed. Backup retained at ${folder}`)
      await fs.unlink(file)
      // Once removal succeeds, return the retained backup even if a later
      // diagnostic probe fails; never leave the user guessing what changed.
      const checked = await this.checkBlockers(repo).catch((error): IndexRecoveryBlockers => ({
        repoPath: repo, tasks: repoGitTasks(repo), pendingGitCommands: gitOpActivity(repo).inFlight, lock: null,
        lockError: `The reviewed lock was removed, but the follow-up check failed: ${String(error)}`,
      }))
      return { backupPath: folder, summary: 'The reviewed lock was backed up and removed. Check the index before retrying your Git operation.',
        blockers: checked }
    }, preemptRepoReads)
  }

  async diagnose(repo: string): Promise<IndexDiagnosis> {
    // A diagnosis must not hide cancellation behind a stuck exclusive task.
    if (repoGitTasks(repo).length || gitOpActivity(repo).inFlight) return { repoPath: repo, issue: 'blocked',
      summary: 'Lucid Git tasks are still in progress', detail: 'Use Check tasks and lock below to review and stop tasks, then diagnose again.',
      gitVersion: '', canRepair: false, token: '', canUndo: false }
    return withRepoSlot(repo, 'read', () => this.inspect(repo))
  }
  private async inspect(repo: string): Promise<IndexDiagnosis> {
    const d: IndexDiagnosis = { repoPath: repo, issue: 'blocked', summary: 'Recovery is unavailable', detail: '', gitVersion: '', canRepair: false, token: '', canUndo: false }
    try {
      d.gitVersion = await required(repo, ['--version'])
      const c = await context(repo)
      await blockers(c)
      const status = await git(repo, ['status', '--porcelain=v1', '--ignore-submodules=all', '-z'])
      d.token = token(c)
      if (!c.bytes) {
        d.issue = 'missing'; d.summary = 'The staging index is missing'
      } else if (status.exitCode && indexError.test(status.stderr + status.stdout)) {
        d.issue = 'corrupt'; d.summary = 'Git cannot read the staging index'
        d.detail = status.stderr.trim()
      } else if (status.exitCode) throw new Error(status.stderr || status.stdout)
      else if (checksumBad(c)) { d.issue = 'checksum'; d.summary = 'The index checksum is damaged' }
      else {
        d.issue = 'healthy'; d.summary = 'The staging index is readable and healthy'
        d.detail = 'No staging-index repair is needed for this repository. A continuing error may concern a submodule, pack indexes, permissions or storage; retain the full operation error for support.'
      }
      d.canRepair = d.issue !== 'healthy'
      if (d.canRepair) d.detail += (d.detail ? '\n\n' : '') + (d.issue === 'checksum'
        ? 'Repair will correct the checksum and preserve staging.'
        : 'Repair will rebuild staging from the current commit (or an empty index for a new repository). Working files and branches stay intact. Changes become unstaged; the original index is saved for Undo.')
      const id = await latest(c)
      if (id) {
        d.backupId = id
        try {
          const { j, folder } = await journal(c, id)
          d.backupPath = folder
          if (j.phase === 'undone') throw new Error('The last repair has already been undone.')
          if (j.head !== c.head || j.branch !== c.branch) throw new Error('HEAD or branch changed since repair; automatic Undo would target a different state.')
          if (j.phase === 'prepared' && c.bytes && hash(c.bytes) === j.before) throw new Error('Replacement was not installed; the original index is still present.')
          if (!c.bytes || (hash(c.bytes) !== j.after && await fingerprint(c) !== j.fingerprint)) throw new Error('Staged content or flags changed since repair; Undo is disabled to protect newer work.')
          d.canUndo = true
        } catch (e) { d.undoReason = String(e) }
      }
    } catch (e) { d.canRepair = false; d.issue = 'blocked'; d.summary = 'Recovery stopped safely'; d.detail = String(e) }
    return d
  }

  async repair(repo: string, expectedToken: string): Promise<IndexRepairResult> {
    return withRepoSlot(repo, 'write', async () => {
      const diagnosis = await this.inspect(repo)
      if (!diagnosis.canRepair || !expectedToken || diagnosis.token !== expectedToken) throw new Error('Repository state changed or repair is blocked. Diagnose again. ' + diagnosis.detail)
      const c = await context(repo)
      await blockers(c)
      if (token(c) !== expectedToken) throw new Error('Index or HEAD changed. Diagnose again.')
      const base = await storage(c), id = randomUUID(), folder = path.join(base, id)
      await fs.mkdir(folder, { mode: 0o700 })
      const lockPath = c.index + '.lock'
      const lock = await fs.open(lockPath, 'wx', 0o600)
      const identity = await lock.stat()
      let installed = false
      try {
        if (c.bytes) await durable(path.join(folder, 'original-index'), c.bytes)
        // Preserve split-index sidecars without altering or expiring originals.
        const shared = (await fs.readdir(c.gitDir)).filter(n => /^sharedindex\.[a-f0-9]+$/.test(n))
        if (shared.length > 64) throw new Error('Too many split-index sidecars for bounded automatic recovery. Original index was not changed.')
        let total = c.bytes?.length ?? 0
        for (const name of shared) {
          const bytes = await readIndex(path.join(c.gitDir, name))
          if (bytes) { total += bytes.length; if (total > LIMIT) throw new Error('Recovery backup exceeds 128 MiB. Original index was not changed.'); await durable(path.join(folder, name), bytes) }
        }
        const candidate = path.join(folder, 'candidate-index')
        if (diagnosis.issue === 'checksum' && c.bytes) {
          const size = c.format === 'sha1' ? 20 : 32
          const body = c.bytes.subarray(0, -size)
          await durable(candidate, Buffer.concat([body, createHash(c.format).update(body).digest()]))
        } else await required(repo, ['read-tree', ...(c.head ? [c.head] : ['--empty'])], candidate)
        // write-tree verifies staged object references without filters, hooks,
        // worktree writes or resetting operation/history metadata.
        await validateObjects(c, candidate)
        await required(repo, ['write-tree'], candidate)
        const candidateBytes = await readIndex(candidate)
        if (!candidateBytes) throw new Error('Git did not create a replacement index.')
        const j: Journal = { version: 1, id, head: c.head, branch: c.branch, before: c.bytes ? hash(c.bytes) : null,
          after: hash(candidateBytes), fingerprint: await fingerprint(c, candidate), phase: 'prepared' }
        await durable(path.join(folder, 'journal.json'), JSON.stringify(j))
        await update(path.join(base, 'latest'), id)
        // Recheck under our canonical index.lock immediately before installation.
        const now = await context(repo)
        await blockers(now, true)
        if (token(now) !== expectedToken) throw new Error('Repository changed during preparation. No replacement was installed.')
        if (!await owned(lockPath, identity)) throw new Error('Recovery lock was replaced by another writer. Nothing installed.')
        await lock.writeFile(candidateBytes); await lock.sync(); await lock.close()
        await fs.rename(lockPath, c.index)
        installed = true
        try {
          await required(repo, ['status', '--porcelain=v1', '--ignore-submodules=all', '-z'])
          if (await fingerprint(c) !== j.fingerprint) throw new Error('Installed index verification failed.')
          const verified = await context(repo)
          if (verified.head !== c.head || verified.branch !== c.branch) throw new Error('HEAD or branch changed during verification.')
          j.phase = 'installed'
          await update(path.join(folder, 'journal.json'), JSON.stringify(j))
        } catch (e) {
          // Restore only if no external client replaced the installed index.
          const current = await readIndex(c.index)
          if (current && hash(current) === j.after) await this.restore(c, j, folder)
          throw new Error('Repair verification failed. Backup retained at ' + folder + '. ' + String(e))
        }
        return { backupId: id, backupPath: folder,
          diagnosis: { repoPath: repo, issue: 'healthy', summary: 'Repair verified; Git can read the index', detail: '', gitVersion: diagnosis.gitVersion,
            canRepair: false, token: token({ ...c, bytes: candidateBytes }), canUndo: true, backupId: id, backupPath: folder },
          summary: diagnosis.issue === 'checksum'
          ? 'Checksum repaired and staging preserved. Git status verified.'
          : 'Index rebuilt and Git status verified. Working files and branches preserved; changes are now unstaged.' }
      } catch (e) {
        throw new Error(`${String(e)}\nRecovery backup folder: ${folder}`)
      } finally {
        await lock.close().catch(() => {})
        if (!installed && await owned(lockPath, identity)) await fs.rm(lockPath, { force: true })
      }
    }, preemptRepoReads)
  }

  private async restore(c: Context, j: Journal, folder: string): Promise<void> {
    if (c.head !== j.head || c.branch !== j.branch) throw new Error('HEAD or branch changed. Nothing restored.')
    const lockPath = c.index + '.lock', lock = await fs.open(lockPath, 'wx', 0o600)
    const identity = await lock.stat()
    let installed = false
    try {
      const current = await readIndex(c.index)
      if (j.phase === 'prepared' && current && hash(current) === j.before) throw new Error('Replacement was not installed; the original index is still present.')
      if (!current || (hash(current) !== j.after && await fingerprint(c) !== j.fingerprint)) throw new Error('Staged state changed. Backup retained; nothing restored.')
      const now = await context(c.root)
      await blockers(now, true)
      if (now.head !== j.head || now.branch !== j.branch) throw new Error('HEAD or branch changed. Nothing restored.')
      await durable(path.join(folder, 'index-before-undo-' + randomUUID()), current)
      if (!await owned(lockPath, identity)) throw new Error('Recovery lock was replaced. Nothing restored.')
      if (j.before) {
        const bytes = await readIndex(path.join(folder, 'original-index'))
        if (!bytes || hash(bytes) !== j.before) throw new Error('Original backup is missing or damaged. Nothing restored.')
        // The repair never alters sharedindex originals. If one changed later,
        // refuse restoration rather than overwriting shared data used elsewhere.
        for (const name of (await fs.readdir(folder)).filter(n => /^sharedindex\.[a-f0-9]+$/.test(n))) {
          const saved = await readIndex(path.join(folder, name)), live = await readIndex(path.join(c.gitDir, name))
          if (!saved || !live || hash(saved) !== hash(live)) throw new Error('Shared index data changed or disappeared; automatic Undo is unsafe.')
        }
        await lock.writeFile(bytes); await lock.sync(); await lock.close()
        await fs.rename(lockPath, c.index); installed = true
      } else { await fs.unlink(c.index) }
      j.phase = 'undone'
      await update(path.join(folder, 'journal.json'), JSON.stringify(j))
    } finally {
      await lock.close().catch(() => {})
      if (!installed && await owned(lockPath, identity)) await fs.rm(lockPath, { force: true })
    }
  }

  async undo(repo: string, id: string): Promise<void> {
    return withRepoSlot(repo, 'write', async () => {
      const c = await context(repo)
      await blockers(c)
      const { j, folder } = await journal(c, id)
      if (j.phase === 'undone') throw new Error('This repair was already undone.')
      await this.restore(c, j, folder)
    }, preemptRepoReads)
  }
}
export const indexRecoveryService = new IndexRecoveryService()
