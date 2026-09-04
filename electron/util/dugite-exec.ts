import { GitProcess } from 'dugite'
import path from 'path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, type ChildProcess } from 'node:child_process'
import { OperationStep } from '../types'
import { logService } from '../services/LogService'

export type ProgressCallback = (step: OperationStep) => void

// ── Live git subprocess registry ─────────────────────────────────────────────
//
// A git process Lucid Git starts outlives us: on Windows a child is not in the
// parent's job object, so closing the app — or abandoning a read whose promise
// timed out — leaves `git.exe` running, and with it the `git-lfs.exe
// filter-process` git spawned to smudge content. Both then sit at 0% CPU
// forever waiting on a parent that is never coming back, which is how a
// session ends up with a dozen idle Git/Git LFS entries in Task Manager.
//
// Nothing in dugite exposes the child for `GitProcess.exec`, but its
// `processCallback` option hands it over, so every process we start is
// registered here and can be killed deliberately.

interface LiveGitProcess {
  child: ChildProcess
  args: string[]
  startedAt: number
}

const liveGitProcesses = new Map<number, LiveGitProcess>()

/**
 * PIDs started inside the current `withGitTimeout` scope. AsyncLocalStorage
 * carries this across every `await` in the handler, so a timeout can kill the
 * processes that handler started without touching anyone else's.
 */
const gitProcessScope = new AsyncLocalStorage<Set<number>>()

/** Record a freshly spawned git process, and forget it once it exits. */
function registerGitProcess(child: ChildProcess, args: string[]): void {
  const pid = child.pid
  if (pid === undefined) return

  liveGitProcesses.set(pid, { child, args, startedAt: Date.now() })
  gitProcessScope.getStore()?.add(pid)

  const forget = () => { liveGitProcesses.delete(pid) }
  child.once('close', forget)
  child.once('exit', forget)
  child.once('error', forget)
}

/**
 * Kill a git process *and everything it spawned*. The child that actually
 * matters is `git-lfs filter-process`: killing only `git.exe` reparents it and
 * leaves it running, so the leak we are fixing would half-survive. Windows has
 * no process groups to signal, hence taskkill's /T.
 */
function killProcessTree(pid: number, child: ChildProcess): void {
  if (process.platform === 'win32') {
    // Detached and fully ignored — we never wait on the result, and a failure
    // here (process already gone, access denied) is not worth surfacing.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => { /* best effort */ })
    return
  }
  try { child.kill('SIGKILL') } catch { /* already gone */ }
}

/** Kill the given git processes. Returns how many were still alive. */
export function killGitProcesses(pids: Iterable<number>): number {
  let killed = 0
  for (const pid of pids) {
    const entry = liveGitProcesses.get(pid)
    if (!entry) continue
    liveGitProcesses.delete(pid)
    killProcessTree(pid, entry.child)
    killed++
  }
  return killed
}

/**
 * Kill every git process Lucid Git currently has running. Called on quit: an
 * abandoned `git`/`git-lfs` pair has no one left to read its output, and
 * leaving it behind is what accumulates across app restarts. An index write
 * interrupted this way leaves `.git/index.lock`, which the stale-lock recovery
 * already clears on the next run.
 */
export function killAllGitProcesses(): number {
  const pids = [...liveGitProcesses.keys()]
  if (pids.length === 0) return 0
  const detail = [...liveGitProcesses.values()]
    .map(p => `  git ${detectGitSubcommand(p.args)} (${Math.round((Date.now() - p.startedAt) / 1000)}s)`)
    .join('\n')
  const killed = killGitProcesses(pids)
  logService.warn('git.shutdown', `Terminated ${killed} git process(es) still running at shutdown:\n${detail}`)
  return killed
}

/** Env every git process we start shares. */
const GIT_BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
} as const

// ── Git process bookkeeping ──────────────────────────────────────────────────
//
// Tracks, per repository, how many git processes Lucid Git currently has in
// flight and when the oldest of them started. That is what distinguishes a
// `.git/index.lock` left behind by one of our own crashed subprocesses — safe
// to remove the moment the process exits — from one a live external writer
// (an Unreal source-control plugin, another git client) genuinely owns. Age
// alone cannot tell those apart: a lock our checkout orphaned one second ago
// looks exactly like a lock Unreal created one second ago.

/** Clock-granularity slack when matching a file mtime against a run window. */
const RUN_WINDOW_SLACK_MS = 1000
/** How long a finished run stays relevant for ownership questions. */
const RUN_WINDOW_TTL_MS = 5 * 60_000
const MAX_RUN_WINDOWS = 100

interface RepoGitOps {
  inFlight: number
  /** [start, end] of git processes we ran and that have since exited. */
  windows: { start: number; end: number }[]
}

const repoGitOps = new Map<string, RepoGitOps>()

export interface GitOpActivity {
  /** Git processes Lucid Git has running in this repo right now. */
  inFlight: number
  /** True when `at` falls inside a window where one of our git processes ran. */
  ranDuring: (at: number) => boolean
}

const opsKey = (repoPath: string): string => path.resolve(repoPath).toLowerCase()

/**
 * Snapshot of git-process activity for a repo. Take it BEFORE running any
 * further git command, or `inFlight` describes your own probe.
 *
 * `ranDuring` answers the question age cannot: a `.git/index.lock` whose mtime
 * lands inside one of our own run windows was created by a git or git-lfs
 * subprocess we started, so once nothing of ours is in flight it is orphaned
 * and safe to delete — no matter how recent it is.
 */
export function gitOpActivity(repoPath: string): GitOpActivity {
  const entry = repoGitOps.get(opsKey(repoPath))
  const windows = entry ? [...entry.windows] : []
  return {
    inFlight: entry?.inFlight ?? 0,
    ranDuring: (at: number) => windows.some(
      w => at >= w.start - RUN_WINDOW_SLACK_MS && at <= w.end + RUN_WINDOW_SLACK_MS,
    ),
  }
}

/**
 * Wait until this repo has no git process of ours running, or `timeoutMs`
 * passes. Resolves true if the repo went quiet.
 *
 * A `.git/index.lock` held by one of our own in-flight processes is in use,
 * not stale — and under heavy filesystem load (an antivirus scan over a UE
 * project) a background refresh can hold it for seconds. Waiting for our own
 * work to finish tells the two cases apart, where sampling `inFlight` once
 * reports a live lock of ours as an external writer's.
 */
export async function waitForGitOpsToDrain(repoPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while ((repoGitOps.get(opsKey(repoPath))?.inFlight ?? 0) > 0) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return true
}

function entryFor(repoPath: string): RepoGitOps {
  const key = opsKey(repoPath)
  let entry = repoGitOps.get(key)
  if (!entry) {
    entry = { inFlight: 0, windows: [] }
    repoGitOps.set(key, entry)
  }
  return entry
}

/** Run `fn` with this repo counted as having a git process in flight. */
async function trackGitOp<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const entry = entryFor(repoPath)
  const start = Date.now()
  entry.inFlight++
  try {
    return await fn()
  } finally {
    entry.inFlight = Math.max(0, entry.inFlight - 1)
    const end = Date.now()
    entry.windows.push({ start, end })
    const cutoff = end - RUN_WINDOW_TTL_MS
    if (entry.windows.length > MAX_RUN_WINDOWS || entry.windows[0].end < cutoff) {
      entry.windows = entry.windows.filter(w => w.end >= cutoff).slice(-MAX_RUN_WINDOWS)
    }
  }
}

// ── Progress parser ───────────────────────────────────────────────────────────

interface ProgressPattern {
  regex: RegExp
  id: string
  label: string
}

function detectGitSubcommand(args: string[]): string {
  const topLevel = new Set(['clone', 'status', 'rev-parse', 'add', 'restore', 'commit', 'push', 'pull', 'fetch', 'branch', 'checkout', 'merge', 'rebase', 'log', 'diff', 'show', 'stash', 'reset', 'clean', 'remote', 'tag', 'lfs'])
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-c') { i++; continue }
    if (a.startsWith('-')) continue
    if (topLevel.has(a)) return a
  }
  return args[0] ?? 'git'
}

const PROGRESS_PATTERNS: ProgressPattern[] = [
  { regex: /Enumerating objects:\s+(\d+)/i,              id: 'enumerate',    label: 'Enumerating objects' },
  { regex: /Counting objects:\s+(\d+)/i,                 id: 'count',        label: 'Counting objects' },
  { regex: /Compressing objects:\s+(\d+)%/i,             id: 'compress',     label: 'Compressing objects' },
  { regex: /Receiving objects:\s+(\d+)%/i,               id: 'receive',      label: 'Receiving objects' },
  { regex: /Resolving deltas:\s+(\d+)%/i,                id: 'resolve',      label: 'Resolving deltas' },
  { regex: /Writing objects:\s+(\d+)%/i,                 id: 'write',        label: 'Writing objects' },
  { regex: /remote:\s+Counting objects:\s+(\d+)/i,       id: 'remote-count', label: 'Remote: counting objects' },
  { regex: /remote:\s+Compressing objects:\s+(\d+)%/i,   id: 'remote-zip',   label: 'Remote: compressing' },
  { regex: /Uploading LFS objects:\s+(\d+)%/i,           id: 'lfs-up',       label: 'Uploading LFS objects' },
  { regex: /Downloading LFS objects:\s+(\d+)%/i,         id: 'lfs-down',     label: 'Downloading LFS objects' },
  { regex: /Filtering content:\s+(\d+)%/i,               id: 'lfs-filter',   label: 'Downloading LFS content' },
  { regex: /Packing objects:\s+(\d+)%/i,                 id: 'pack',         label: 'Packing objects' },
  { regex: /Pruning loose objects:\s+(\d+)%/i,           id: 'prune-loose',  label: 'Pruning loose objects' },
  { regex: /Updating references:\s+(\d+)%/i,             id: 'update-refs',  label: 'Updating references' },
  { regex: /migrate:.*Rewriting commits:\s+(\d+)%/i,     id: 'lfs-rewrite',  label: 'Rewriting commits' },
  { regex: /Checking out files:\s+(\d+)%/i,              id: 'checkout',     label: 'Checking out files' },
  { regex: /Updating files:\s+(\d+)%/i,                  id: 'update-files', label: 'Updating files' },
]

function parseGitProgress(line: string): OperationStep | null {
  for (const { regex, id, label } of PROGRESS_PATTERNS) {
    if (!regex.test(line)) continue

    const progressMatch = line.match(/(\d+)%/)
    const isDone = /done\./i.test(line)

    // Counts come in two shapes:
    //   "Receiving objects: 35% (420/1200), …"   → current/total
    //   "Counting objects: 1234, done."          → current only
    let current: number | undefined
    let total: number | undefined
    const pairMatch = line.match(/\((\d+)\/(\d+)\)/)
    if (pairMatch) {
      current = parseInt(pairMatch[1], 10)
      total   = parseInt(pairMatch[2], 10)
    } else if (!progressMatch) {
      const soloMatch = line.match(/:\s+(\d+)(?:,|\s|$)/)
      if (soloMatch) current = parseInt(soloMatch[1], 10)
    }

    return {
      id,
      label,
      status: isDone ? 'done' : 'running',
      progress: progressMatch ? parseInt(progressMatch[1], 10) : undefined,
      current,
      total,
      detail: line.trim().replace(/\r/g, ''),
    }
  }
  return null
}

// ── execWithProgress (uses spawn for real-time stderr) ────────────────────────

export async function execWithProgress(
  args: string[],
  repoPath: string,
  onProgress?: ProgressCallback
): Promise<{ stdout: string; stderr: string }> {
  return trackGitOp(repoPath, () => execWithProgressInner(args, repoPath, onProgress))
}

async function execWithProgressInner(
  args: string[],
  repoPath: string,
  onProgress?: ProgressCallback
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = GitProcess.spawn(args, repoPath, {
      env: {
        ...process.env,
        ...GIT_BASE_ENV,
        // git-lfs checks isatty and silently drops its whole progress meter
        // (both the checkout-time "Filtering content" smudge line and
        // "Downloading LFS objects" from a plain `lfs pull`) when stdio isn't
        // a terminal — which a spawned child process never is. Without this,
        // LFS-heavy clones/pulls (e.g. Unreal projects) go silent for
        // minutes right after the last native git progress line.
        GIT_LFS_FORCE_PROGRESS: '1',
      },
    })
    registerGitProcess(proc, args)

    let stdout = ''
    let stderr = ''
    let lastProgressAt = 0
    let lastProgressId = ''
    let pendingProgress: OperationStep | null = null

    const emitProgress = (step: OperationStep, force = false) => {
      if (!onProgress) return
      const now = Date.now()
      pendingProgress = step
      // Phase changes and completion are delivered immediately. Repetitive
      // percentage updates are capped to reduce Electron IPC/render churn.
      if (force || step.id !== lastProgressId || step.status === 'done' || now - lastProgressAt >= 75) {
        onProgress(step)
        pendingProgress = null
        lastProgressAt = now
        lastProgressId = step.id
      }
    }

    const scanForProgress = (text: string) => {
      if (!onProgress) return
      // Git and git-lfs both write multiple progress lines per chunk,
      // separated by \r or \n
      for (const line of text.split(/[\r\n]+/)) {
        const step = parseGitProgress(line)
        if (step) emitProgress(step)
      }
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      // git-lfs's forced progress meter (e.g. `lfs pull`) writes to stdout,
      // unlike git's own `--progress` output which goes to stderr.
      scanForProgress(text)
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      scanForProgress(text)
    })

    proc.on('error', reject)

    proc.on('close', (code: number | null) => {
      if (pendingProgress) emitProgress(pendingProgress, true)
      if (code === 0 || code === null) {
        resolve({ stdout, stderr })
      } else {
        const errText = (stderr || stdout).slice(0, 1000)
        const subCmd  = detectGitSubcommand(args)
        logService.error(`git.${subCmd}`, `git ${subCmd} failed (exit ${code}):\n${errText}`)
        reject(new Error(`git ${subCmd} failed (exit ${code}):\n${stderr || stdout}`))
      }
    })
  })
}

// ── exec (simple, awaitable, throws on non-zero exit) ─────────────────────────

export async function exec(
  args: string[],
  repoPath: string
): Promise<{ stdout: string; stderr: string }> {
  const result = await trackGitOp(repoPath, () => GitProcess.exec(args, repoPath, {
    env: { ...process.env, ...GIT_BASE_ENV },
    processCallback: child => registerGitProcess(child, args),
  }))

  if (result.exitCode !== 0) {
    const combined = [result.stderr, result.stdout].filter(Boolean).join('\n')
    const errText  = combined.slice(0, 1000)
    const subCmd   = detectGitSubcommand(args)
    logService.error(`git.${subCmd}`, `git ${subCmd} failed (exit ${result.exitCode}):\n${errText}`)
    throw new Error(`git ${subCmd} failed (exit ${result.exitCode}):\n${combined}`)
  }

  return { stdout: result.stdout, stderr: result.stderr }
}

/**
 * Like `exec`, but pipes `stdin` into the git process. Used for commands
 * that read patches from standard input (e.g. `git apply --cached -`).
 */
export async function execWithStdin(
  args: string[],
  repoPath: string,
  stdin: string,
): Promise<{ stdout: string; stderr: string }> {
  const result = await trackGitOp(repoPath, () => GitProcess.exec(args, repoPath, {
    env: { ...process.env, ...GIT_BASE_ENV },
    processCallback: child => registerGitProcess(child, args),
    stdin,
    stdinEncoding: 'utf8',
  }))
  if (result.exitCode !== 0) {
    const combined = [result.stderr, result.stdout].filter(Boolean).join('\n')
    throw new Error(`git ${detectGitSubcommand(args)} failed (exit ${result.exitCode}):\n${combined}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

// ── withTimeout — races a promise against a deadline ─────────────────────────

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
  })
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    deadline,
  ])
}

/**
 * `withTimeout`, but the git processes the work started are killed when the
 * deadline passes instead of being abandoned.
 *
 * Racing a promise only frees the *caller* — the git process it is waiting on
 * keeps running, and a wedged one (stalled LFS transfer, disconnected share)
 * never exits, so every timed-out read used to leak a `git.exe` plus its
 * `git-lfs.exe` filter for the rest of the session. The scope is carried by
 * AsyncLocalStorage, so only processes this call started are killed; anything
 * another operation is legitimately running is left alone.
 */
export async function withGitTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  const scope = new Set<number>()
  return gitProcessScope.run(scope, async () => {
    try {
      return await withTimeout(Promise.resolve(fn()), ms, label)
    } catch (error) {
      // Only a timeout leaves processes behind with nobody to collect them; a
      // command that failed on its own has already exited.
      if (error instanceof Error && error.message.includes('timed out after')) {
        const killed = killGitProcesses(scope)
        if (killed > 0) {
          logService.warn('git.timeout', `${label} timed out after ${ms / 1000}s; killed ${killed} orphaned git process(es)`)
        }
      }
      throw error
    }
  })
}

// ── gitAuthArgs — injects token via git http extraheader (avoids credential manager) ──

export function gitAuthArgs(token: string | null, remoteUrl?: string | null): string[] {
  // Commands such as fetch and pull may start automatic repository
  // maintenance after writing objects. Git normally detaches that work, which
  // lets the command return while a repack is still replacing pack indexes.
  // A push started immediately afterwards (especially its Git LFS pre-push
  // scan) can then try to open an index that disappeared mid-scan. Keep
  // maintenance started by Lucid Git in the foreground so the operation does
  // not report completion until the object store is stable.
  //
  // `gc.autoDetach` is retained as the fallback used by older Git versions;
  // newer versions prefer `maintenance.autoDetach`.
  const foregroundMaintenance = [
    '-c', 'maintenance.autoDetach=false',
    '-c', 'gc.autoDetach=false',
  ]

  // Always reset git's cumulative credential-helper list (an empty value
  // clears it). Without this, a missing/expired token falls through to the
  // system credential manager (GCM), which pops a GUI login dialog that
  // GIT_TERMINAL_PROMPT/GIT_ASKPASS cannot suppress — and password auth is
  // dead on GitHub anyway, so that dialog can never succeed. This -c setting
  // also reaches `git lfs` subprocesses via GIT_CONFIG_PARAMETERS.
  const noCredentialHelper = [...foregroundMaintenance, '-c', 'credential.helper=']
  if (!token) return noCredentialHelper
  const b64 = Buffer.from(`x-access-token:${token}`).toString('base64')

  // Scope auth header to the git remote host so it is not forwarded to signed
  // LFS storage URLs (for example github-cloud.s3.amazonaws.com).
  if (remoteUrl && /^https?:\/\//i.test(remoteUrl)) {
    try {
      const u = new URL(remoteUrl)
      const origin = `${u.protocol}//${u.host}/`
      return [...noCredentialHelper, '-c', `http.${origin}.extraheader=AUTHORIZATION: basic ${b64}`]
    } catch {
      // fall through to global header as compatibility fallback
    }
  }

  return [...noCredentialHelper, '-c', `http.extraheader=AUTHORIZATION: basic ${b64}`]
}

// ── execSafe (never throws — returns exitCode instead) ────────────────────────

export async function execSafe(
  args: string[],
  repoPath: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await trackGitOp(repoPath, () => GitProcess.exec(args, repoPath, {
    env: { ...process.env, ...GIT_BASE_ENV },
    processCallback: child => registerGitProcess(child, args),
  }))
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  }
}
