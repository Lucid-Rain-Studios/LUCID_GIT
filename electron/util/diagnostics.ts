import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'node:child_process'
import { GitProcess } from 'dugite'
import { logService } from '../services/LogService'
import { ownGitPids } from './dugite-exec'

// ── Diagnostic context for logs ──────────────────────────────────────────────
//
// What a failure log needs beyond the error itself: the machine, where the
// repository lives, how much disk is left, and which other programs were running
// that are known to hold or scan files in a Git index. Collected only when
// something has already gone wrong (or once at startup), bounded in time and
// never allowed to throw into the operation being diagnosed.

const CONTEXT_BUDGET_MS = 4_000
const PROCESS_LIST_CACHE_MS = 10_000

const EDITORS = /^(UnrealEditor|UE4Editor|UnrealEditor-Cmd|UnrealBuildTool|UnrealHeaderTool|ShaderCompileWorker|UnrealVersionSelector|devenv|rider64|Rider|MSBuild|Code|Cursor|VBCSCompiler)\.exe$/i
const GIT_CLIENTS = /^(GitHubDesktop|TortoiseGit|TortoiseGitProc|SourceTree|SmartGit|GitKraken|gitk|git-gui|Fork|GitExtensions)\.exe$/i
const SYNC_AND_INDEXERS = /^(OneDrive|Dropbox|GoogleDriveFS|SearchIndexer|SearchProtocolHost|iCloudDrive|Box)\.exe$/i
const ANTIVIRUS = /^(MsMpEng|NisSrv|MsSense|SenseIR|avgsvc|AvastSvc|mcshield|SentinelAgent|CylanceSvc|CSFalconService|bdagent|ekrn|SophosFS|SavService|MBAMService)\.exe$/i
const GIT_PROCESSES = /^(git|git-lfs|git-remote-https|git-credential-manager)\.exe$/i

// ── Repository location ──────────────────────────────────────────────────────

const CLOUD_FOLDER = /[\\/](OneDrive[^\\/]*|Dropbox[^\\/]*|Google Drive|GoogleDrive|iCloudDrive|Box|pCloudDrive|MEGAsync|Sync)(?=[\\/]|$)/i

/** Where a repository lives, in terms that explain file-locking trouble. */
export function classifyRepoPath(repoPath: string, env: NodeJS.ProcessEnv = process.env): {
  drive: string | null
  network: boolean
  cloudSync: string | null
  pathLength: number
} {
  const unc = /^[\\/]{2}[^\\/?]/.test(repoPath)
  const drive = /^[A-Za-z]:/.test(repoPath) ? repoPath.slice(0, 2).toUpperCase() : null
  let cloudSync: string | null = CLOUD_FOLDER.exec(repoPath)?.[1] ?? null
  if (!cloudSync) {
    const lower = path.resolve(repoPath).toLowerCase()
    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const root = env[key]
      if (root && lower.startsWith(path.resolve(root).toLowerCase())) { cloudSync = 'OneDrive'; break }
    }
  }
  return { drive, network: unc, cloudSync, pathLength: repoPath.length }
}

async function diskSpace(target: string): Promise<{ freeMB: number; totalMB: number } | { error: string }> {
  try {
    const stats = await fs.promises.statfs(target)
    const mb = (blocks: number | bigint) => Math.round(Number(blocks) * Number(stats.bsize) / (1024 * 1024))
    return { freeMB: mb(stats.bavail), totalMB: mb(stats.blocks) }
  } catch (error) { return { error: String(error).slice(0, 200) } }
}

// ── Other programs ───────────────────────────────────────────────────────────

/** Image names from `tasklist /fo csv /nh` output. */
export function parseTasklist(csv: string): string[] {
  const names: string[] = []
  for (const line of csv.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line)
    if (match) names.push(match[1])
  }
  return names
}

function countBy(names: string[], pattern: RegExp): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const name of names) if (pattern.test(name)) counts[name] = (counts[name] ?? 0) + 1
  return counts
}

/** Group process names into the categories that matter for index and file locks. */
export function categorizeProcesses(names: string[], lucidGitProcesses: number): {
  editors: Record<string, number>
  gitClients: Record<string, number>
  syncAndIndexers: Record<string, number>
  antivirus: Record<string, number>
  gitProcessesTotal: number
  lucidGitProcesses: number
} {
  return {
    editors: countBy(names, EDITORS),
    gitClients: countBy(names, GIT_CLIENTS),
    syncAndIndexers: countBy(names, SYNC_AND_INDEXERS),
    antivirus: countBy(names, ANTIVIRUS),
    // Includes git helpers that Lucid Git's own commands spawn, so a number above
    // `lucidGitProcesses` is a hint, not proof of another client.
    gitProcessesTotal: Object.values(countBy(names, GIT_PROCESSES)).reduce((a, b) => a + b, 0),
    lucidGitProcesses,
  }
}

let processListCache: { at: number; names: Promise<string[]> } | null = null

function listProcessNames(): Promise<string[]> {
  if (processListCache && Date.now() - processListCache.at < PROCESS_LIST_CACHE_MS) return processListCache.names
  const names = new Promise<string[]>((resolve, reject) => {
    const win = process.platform === 'win32'
    execFile(win ? 'tasklist' : 'ps', win ? ['/fo', 'csv', '/nh'] : ['-A', '-o', 'comm='],
      { windowsHide: true, timeout: 3_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(error)
        resolve(win ? parseTasklist(stdout) : stdout.split('\n').map(line => path.basename(line.trim())).filter(Boolean))
      })
  })
  processListCache = { at: Date.now(), names }
  return names
}

async function externalProcesses(): Promise<ReturnType<typeof categorizeProcesses> | { unavailable: string }> {
  try { return categorizeProcesses(await listProcessNames(), ownGitPids().size) }
  catch (error) { return { unavailable: String(error).slice(0, 200) } }
}

// ── Public entry points ──────────────────────────────────────────────────────

/**
 * Context for a failure in `repoPath`, bounded to a few seconds. Resolves even
 * when parts of it cannot be collected; a missing part says why instead.
 */
export async function failureContext(repoPath: string): Promise<Record<string, unknown>> {
  const collect = async () => {
    const [disk, processes] = await Promise.all([diskSpace(repoPath), externalProcesses()])
    return { location: classifyRepoPath(repoPath), disk, processes }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      collect(),
      new Promise<Record<string, unknown>>(resolve => { timer = setTimeout(() => resolve({ unavailable: `timed out after ${CONTEXT_BUDGET_MS}ms` }), CONTEXT_BUDGET_MS) }),
    ])
  } catch (error) {
    return { unavailable: String(error).slice(0, 200) }
  } finally { if (timer) clearTimeout(timer) }
}

/**
 * Fire-and-forget: log `headline` followed by the failure context. Used where
 * the failing code path must not wait for the extra detail.
 */
export function logFailureContext(source: string, repoPath: string, headline: string): void {
  void failureContext(repoPath)
    .then(context => logService.warn(source, `${headline} — context: ${JSON.stringify(context)}`))
    .catch(() => { /* diagnostics must never become a second failure */ })
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  try {
    const result = await GitProcess.exec(args, cwd)
    return (result.exitCode === 0 ? result.stdout : `unavailable (exit ${result.exitCode})`).trim().split('\n')[0]
  } catch (error) { return `unavailable (${String(error).slice(0, 100)})` }
}

/** The machine and runtime, in one line, for the top of a session. */
export async function logSessionEnvironment(info: {
  appVersion: string
  packaged: boolean
  userDataPath: string
  electron?: string
  chrome?: string
}): Promise<void> {
  try {
    const mb = (bytes: number) => Math.round(bytes / (1024 * 1024))
    const [git, lfs, disk] = await Promise.all([
      gitOutput(['--version'], info.userDataPath),
      gitOutput(['lfs', 'version'], info.userDataPath),
      diskSpace(info.userDataPath),
    ])
    logService.info('app.environment', `Environment: ${JSON.stringify({
      app: info.appVersion, packaged: info.packaged,
      os: `${os.version()} ${os.release()}`, platform: process.platform, arch: process.arch,
      electron: info.electron ?? process.versions.electron ?? null, chrome: info.chrome ?? process.versions.chrome ?? null, node: process.versions.node,
      cpus: os.cpus().length, memoryMB: { total: mb(os.totalmem()), free: mb(os.freemem()) },
      git, gitLfs: lfs, userData: info.userDataPath, userDataDisk: disk,
      // Recorded here so a later "who else touches the repo" question starts from a baseline.
      processes: await externalProcesses(),
    })}`)
  } catch (error) {
    logService.warn('app.environment', `Could not record the environment: ${String(error)}`)
  }
}
