import { GitProcess } from 'dugite'
import { OperationStep } from '../types'
import { logService } from '../services/LogService'

export type ProgressCallback = (step: OperationStep) => void

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
  return new Promise((resolve, reject) => {
    const proc = GitProcess.spawn(args, repoPath, {
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
    })

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

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text

      if (onProgress) {
        // Git writes multiple progress lines per chunk, separated by \r or \n
        for (const line of text.split(/[\r\n]+/)) {
          const step = parseGitProgress(line)
          if (step) emitProgress(step)
        }
      }
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
        reject(new Error(`git ${args[0]} failed (exit ${code}):\n${stderr || stdout}`))
      }
    })
  })
}

// ── exec (simple, awaitable, throws on non-zero exit) ─────────────────────────

export async function exec(
  args: string[],
  repoPath: string
): Promise<{ stdout: string; stderr: string }> {
  const result = await GitProcess.exec(args, repoPath, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
    },
  })

  if (result.exitCode !== 0) {
    const combined = [result.stderr, result.stdout].filter(Boolean).join('\n')
    const errText  = combined.slice(0, 1000)
    const subCmd   = detectGitSubcommand(args)
    logService.error(`git.${subCmd}`, `git ${subCmd} failed (exit ${result.exitCode}):\n${errText}`)
    throw new Error(`git ${args[0]} failed (exit ${result.exitCode}):\n${combined}`)
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
  const result = await GitProcess.exec(args, repoPath, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
    },
    stdin,
    stdinEncoding: 'utf8',
  })
  if (result.exitCode !== 0) {
    const combined = [result.stderr, result.stdout].filter(Boolean).join('\n')
    throw new Error(`git ${args[0]} failed (exit ${result.exitCode}):\n${combined}`)
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

// ── gitAuthArgs — injects token via git http extraheader (avoids credential manager) ──

export function gitAuthArgs(token: string | null, remoteUrl?: string | null): string[] {
  // Always reset git's cumulative credential-helper list (an empty value
  // clears it). Without this, a missing/expired token falls through to the
  // system credential manager (GCM), which pops a GUI login dialog that
  // GIT_TERMINAL_PROMPT/GIT_ASKPASS cannot suppress — and password auth is
  // dead on GitHub anyway, so that dialog can never succeed. This -c setting
  // also reaches `git lfs` subprocesses via GIT_CONFIG_PARAMETERS.
  const noCredentialHelper = ['-c', 'credential.helper=']
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
  const result = await GitProcess.exec(args, repoPath, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
    },
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  }
}
