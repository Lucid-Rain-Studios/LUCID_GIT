import { GitProcess } from 'dugite'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { exec, execSafe, execWithProgress, gitAuthArgs, ProgressCallback } from '../util/dugite-exec'
import { authService } from './AuthService'
import { parseGitLog, GIT_LOG_FORMAT } from '../util/git-log-parse'
import { FileStatus, BranchInfo, CommitEntry, DiffContent, StashEntry, ContributorInfo, ConflictPreviewFile, SyncStatus, LFSStatus, LfsLockCacheFile, LfsLocksMaintenanceResult, SizeBreakdown, CleanupResult, BranchActivity, BranchDiffSummary, BranchDiffFile, PotentialMergeConflictReport } from '../types'

// ── Diff helpers ──────────────────────────────────────────────────────────────

const BINARY_EXTS = new Set([
  '.uasset', '.umap', '.udk', '.ubulk', '.upk', '.pak', '.uexp', '.ucas',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.psd', '.tiff', '.ico',
  '.wav', '.mp3', '.ogg', '.flac', '.aiff', '.wem',
  '.ttf', '.otf', '.woff', '.woff2',
  '.exe', '.dll', '.so', '.dylib', '.lib', '.pdb',
  '.zip', '.7z', '.rar', '.tar', '.gz', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.mp4', '.avi', '.mov', '.mkv', '.webm',
  '.fbx', '.obj', '.dae',
])

function langFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript',
    '.json': 'json', '.md': 'markdown',
    '.css': 'css', '.html': 'html', '.htm': 'html',
    '.py': 'python', '.rs': 'rust', '.go': 'go',
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
    '.c': 'c', '.h': 'cpp', '.hpp': 'cpp',
    '.cs': 'csharp', '.java': 'java', '.kt': 'kotlin',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.xml': 'xml', '.sh': 'shell', '.bash': 'shell',
    '.ini': 'ini', '.toml': 'toml', '.cfg': 'ini',
    '.sql': 'sql', '.lua': 'lua', '.glsl': 'glsl',
    '.hlsl': 'hlsl', '.usf': 'hlsl', '.ush': 'hlsl',
  }
  return map[ext] ?? 'plaintext'
}

// ── Status parser ─────────────────────────────────────────────────────────────

function parseStatus(raw: string): FileStatus[] {
  if (!raw) return []

  const result: FileStatus[] = []
  // git status --porcelain=v1 -z: null-terminated records
  // Format: "XY path\0" or "XY new-path\0orig-path\0" for renames
  const entries = raw.split('\0')
  let i = 0

  while (i < entries.length) {
    const entry = entries[i]
    if (!entry || entry.length < 3) { i++; continue }

    const indexStatus  = entry[0]  // X: staged status
    const workingStatus = entry[1] // Y: working-tree status
    const path = entry.slice(3)

    if (!path) { i++; continue }

    result.push({
      path,
      indexStatus,
      workingStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!',
    })

    // Renamed / copied files consume an extra entry (the original path)
    i += (indexStatus === 'R' || indexStatus === 'C') ? 2 : 1
  }

  return result
}

// ── GitService ────────────────────────────────────────────────────────────────

class GitService {
  private async hasUncommittedChanges(repoPath: string): Promise<boolean> {
    const res = await execSafe(['status', '--porcelain=v1', '-z'], repoPath)
    return res.exitCode === 0 && res.stdout.length > 0
  }

  private async remoteDefaultBranch(repoPath: string): Promise<{ name: string; ref: string }> {
    const symbolic = await execSafe(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repoPath)
    if (symbolic.exitCode === 0) {
      const ref = symbolic.stdout.trim()
      const name = ref.replace(/^origin\//, '')
      if (name) return { name, ref }
    }

    const remoteShow = await execSafe(['remote', 'show', 'origin'], repoPath)
    if (remoteShow.exitCode === 0) {
      const match = remoteShow.stdout.match(/HEAD branch:\s*(\S+)/)
      if (match?.[1]) return { name: match[1], ref: `origin/${match[1]}` }
    }

    for (const name of ['main', 'master']) {
      const remote = await execSafe(['rev-parse', '--verify', `refs/remotes/origin/${name}`], repoPath)
      if (remote.exitCode === 0) return { name, ref: `origin/${name}` }
      const local = await execSafe(['rev-parse', '--verify', `refs/heads/${name}`], repoPath)
      if (local.exitCode === 0) return { name, ref: name }
    }

    return { name: 'main', ref: 'origin/main' }
  }

  /** Returns the bundled git version string. */
  async version(): Promise<string> {
    const { stdout } = await exec(['version'], process.cwd())
    return stdout.trim()
  }

  /** True if `repoPath` is inside a git repository. */
  async isRepo(repoPath: string): Promise<boolean> {
    const { exitCode } = await execSafe(['rev-parse', '--git-dir'], repoPath)
    return exitCode === 0
  }

  /** Clone a repository. Streams progress events if `onProgress` supplied. */
  async clone(
    args: { url: string; dir: string; depth?: number },
    onProgress?: ProgressCallback
  ): Promise<void> {
    const token = await authService.getCurrentToken()
    const cmdArgs = [...gitAuthArgs(token, args.url), 'clone', '--progress']
    if (args.depth) cmdArgs.push('--depth', String(args.depth))
    cmdArgs.push(args.url, args.dir)
    await execWithProgress(cmdArgs, process.cwd(), onProgress)
  }

  /** git status --porcelain=v1 */
  async status(repoPath: string): Promise<FileStatus[]> {
    const { exitCode, stdout, stderr } = await execSafe(
      ['status', '--porcelain=v1', '-z'],
      repoPath
    )
    if (exitCode !== 0) throw new Error(stderr || `git status failed (exit ${exitCode})`)
    return parseStatus(stdout)
  }

  /** Returns the short name of HEAD (branch name, or "HEAD" if detached). */
  async currentBranch(repoPath: string): Promise<string> {
    const { exitCode, stdout } = await execSafe(
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      repoPath
    )
    return exitCode === 0 ? stdout.trim() : 'unknown'
  }

  /** Stage specific paths. */
  async stage(repoPath: string, paths: string[]): Promise<void> {
    await exec(['add', '--', ...paths], repoPath)
  }

  /** Unstage specific paths (moves them back to working tree). */
  async unstage(repoPath: string, paths: string[]): Promise<void> {
    await exec(['restore', '--staged', '--', ...paths], repoPath)
  }

  /** Create a commit with the given message. Pass noVerify=true to skip hooks. */
  async commit(repoPath: string, message: string, noVerify = false): Promise<void> {
    const args = ['commit', '-m', message]
    if (noVerify) args.push('--no-verify')
    await exec(args, repoPath)
  }

  /** Push current branch to its upstream. Streams progress. */
  async push(repoPath: string, onProgress?: ProgressCallback): Promise<void> {
    const token = await authService.getCurrentToken()
    const remoteUrl = await this.getRemoteUrl(repoPath)
    const upstreamRes = await execSafe(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoPath)
    if (upstreamRes.exitCode !== 0) {
      const branch = await this.currentBranch(repoPath)
      if (!branch || branch === 'HEAD' || branch === 'unknown') {
        throw new Error('Cannot push from a detached HEAD. Switch to a branch first.')
      }
      await execWithProgress([...gitAuthArgs(token, remoteUrl), 'push', '--progress', '--set-upstream', 'origin', branch], repoPath, onProgress)
      return
    }
    await execWithProgress([...gitAuthArgs(token, remoteUrl), 'push', '--progress'], repoPath, onProgress)
  }

  /** Files changed in commits that are ahead of upstream (what push would publish). */
  async aheadFilePaths(repoPath: string): Promise<string[]> {
    const upstreamRes = await execSafe(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repoPath)
    if (upstreamRes.exitCode !== 0) return []
    const upstream = upstreamRes.stdout.trim()
    if (!upstream) return []
    const diffRes = await execSafe(['diff', '--name-only', `${upstream}..HEAD`], repoPath)
    if (diffRes.exitCode !== 0) return []
    return diffRes.stdout
      .split('\n')
      .map(line => line.trim().replace(/\\/g, '/'))
      .filter(Boolean)
  }

  /** Pull current branch. Streams progress. */
  async pull(repoPath: string, onProgress?: ProgressCallback): Promise<void> {
    const token = await authService.getCurrentToken()
    try {
      const remoteUrl = await this.getRemoteUrl(repoPath)
      await execWithProgress([...gitAuthArgs(token, remoteUrl), 'pull', '--progress'], repoPath, onProgress)
    } catch (error) {
      if (!this.shouldRunLfsRecovery(error)) throw error
      await this.recoverLfsAndMergeState(repoPath)
      const remoteUrl = await this.getRemoteUrl(repoPath)
      await execWithProgress([...gitAuthArgs(token, remoteUrl), 'pull', '--progress'], repoPath, onProgress)
    }
  }


  private shouldRunLfsRecovery(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    return (
      message.includes('smudge filter lfs failed') ||
      message.includes('batch response: bad credentials') ||
      message.includes('unable to write index')
    )
  }

  private async recoverLfsAndMergeState(repoPath: string): Promise<void> {
    await execSafe(['lfs', 'uninstall'], repoPath)
    await execSafe(['lfs', 'install'], repoPath)
    await execSafe(['merge', '--abort'], repoPath)

    const gitDirRes = await execSafe(['rev-parse', '--git-dir'], repoPath)
    if (gitDirRes.exitCode !== 0) return
    const gitDir = path.resolve(repoPath, gitDirRes.stdout.trim())
    const lockPath = path.join(gitDir, 'index.lock')
    try {
      await fs.promises.rm(lockPath, { force: true })
    } catch {
      // best-effort cleanup
    }
  }

  /** Fetch all remotes. Streams progress. */
  async fetch(repoPath: string, onProgress?: ProgressCallback): Promise<void> {
    const token = await authService.getCurrentToken()
    const remoteUrl = await this.getRemoteUrl(repoPath)
    await execWithProgress([...gitAuthArgs(token, remoteUrl), 'fetch', '--all', '--progress'], repoPath, onProgress)
  }

  /** List local AND remote-tracking branches with upstream tracking info. */
  async branchList(repoPath: string): Promise<BranchInfo[]> {
    const [refRes, currentRes] = await Promise.all([
      execSafe(
        [
          'for-each-ref',
          '--format=%(refname)\t%(refname:short)\t%(upstream:short)\t%(upstream:track)',
          'refs/heads/',
          'refs/remotes/origin/',
        ],
        repoPath
      ),
      execSafe(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath),
    ])

    if (refRes.exitCode !== 0) return []
    const current = currentRes.stdout.trim()

    const results: BranchInfo[] = []

    for (const line of refRes.stdout.trim().split('\n').filter(Boolean)) {
      const [refname, shortName, upstream, track] = line.split('\t')

      // Skip the symbolic remote HEAD pointer (origin/HEAD)
      if (shortName === 'origin/HEAD' || shortName.endsWith('/HEAD')) continue

      const isRemote = refname.startsWith('refs/remotes/')
      const remoteName = isRemote ? shortName.split('/')[0] : undefined
      const displayName = isRemote && remoteName
        ? shortName.slice(remoteName.length + 1)   // strip "origin/"
        : shortName

      let ahead = 0, behind = 0
      if (track) {
        const a = track.match(/ahead (\d+)/);  if (a) ahead  = parseInt(a[1])
        const b = track.match(/behind (\d+)/); if (b) behind = parseInt(b[1])
      }

      results.push({
        name:        shortName,
        displayName,
        current:     !isRemote && shortName === current,
        upstream:    upstream || undefined,
        ahead,
        behind,
        isRemote,
        remoteName,
        // hasLocal is filled in below after we have all branches
      })
    }

    // Mark remote branches that have a corresponding local branch
    const localNames = new Set(results.filter(b => !b.isRemote).map(b => b.name))
    for (const b of results) {
      if (b.isRemote) b.hasLocal = localNames.has(b.displayName)
    }

    return results
  }

  private async changedFilesSinceMergeBase(repoPath: string, targetRef: string): Promise<string[]> {
    const baseRes = await execSafe(['merge-base', 'HEAD', targetRef], repoPath)
    if (baseRes.exitCode !== 0) return []
    const base = baseRes.stdout.trim()
    if (!base) return []

    const diffRes = await execSafe(['diff', '--name-only', base, targetRef], repoPath)
    if (diffRes.exitCode !== 0) return []
    return diffRes.stdout
      .split('\n')
      .map(line => line.trim().replace(/\\/g, '/'))
      .filter(Boolean)
  }

  private async workingChangePaths(repoPath: string): Promise<string[]> {
    const [status, ahead] = await Promise.all([
      this.status(repoPath).catch(() => [] as FileStatus[]),
      this.aheadFilePaths(repoPath).catch(() => [] as string[]),
    ])

    return [...new Set([
      ...status.map(file => file.path.replace(/\\/g, '/')),
      ...ahead.map(file => file.replace(/\\/g, '/')),
    ].filter(Boolean))].sort()
  }

  async potentialMergeConflicts(repoPath: string, mode: 'lightweight' | 'deep'): Promise<PotentialMergeConflictReport> {
    const changedFiles = await this.workingChangePaths(repoPath)
    const changedSet = new Set(changedFiles)
    const current = await this.currentBranch(repoPath)
    const branches = await this.branchList(repoPath)
    const activity = await this.branchActivity(repoPath).catch(() => [] as BranchActivity[])
    const activityRank = new Map(activity.map((entry, index) => [entry.ref, index]))

    const candidates = branches
      .filter(branch =>
        !branch.current &&
        branch.name !== current &&
        branch.name !== 'origin/HEAD' &&
        !branch.name.endsWith('/HEAD')
      )
      .sort((a, b) => (activityRank.get(a.name) ?? 9999) - (activityRank.get(b.name) ?? 9999))
      .slice(0, mode === 'deep' ? 40 : 30)

    const branchesWithConflicts: PotentialMergeConflictReport['branchesWithConflicts'] = []

    if (changedFiles.length > 0) {
      for (const branch of candidates) {
        if (mode === 'deep') {
          const conflicts = await this.mergePreview(repoPath, branch.name).catch(() => [])
          let files = conflicts
            .map(conflict => conflict.path.replace(/\\/g, '/'))
            .filter(file => changedSet.has(file))
          if (files.length === 0) {
            const targetRef = await this.resolveBranchRef(repoPath, branch.name).catch(() => null)
            files = targetRef
              ? (await this.changedFilesSinceMergeBase(repoPath, targetRef)).filter(file => changedSet.has(file))
              : []
          }
          const uniqueFiles = [...new Set(files)].sort()
          if (uniqueFiles.length > 0) {
            branchesWithConflicts.push({
              branch: branch.name,
              isRemote: branch.isRemote,
              files: uniqueFiles,
              conflictCount: uniqueFiles.length,
            })
          }
          continue
        }

        const targetRef = await this.resolveBranchRef(repoPath, branch.name).catch(() => null)
        if (!targetRef) continue
        const branchFiles = await this.changedFilesSinceMergeBase(repoPath, targetRef)
        const overlap = branchFiles.filter(file => changedSet.has(file))
        const uniqueFiles = [...new Set(overlap)].sort()
        if (uniqueFiles.length > 0) {
          branchesWithConflicts.push({
            branch: branch.name,
            isRemote: branch.isRemote,
            files: uniqueFiles,
            conflictCount: uniqueFiles.length,
          })
        }
      }
    }

    return {
      checkedAt: Date.now(),
      mode,
      changedFiles,
      branchesChecked: candidates.length,
      branchesWithConflicts,
    }
  }

  /** Delete a remote branch via `git push <remote> --delete <branch>`. */
  async deleteRemoteBranch(repoPath: string, remoteName: string, branch: string): Promise<void> {
    const token = await authService.getCurrentToken()
    const remoteUrl = await this.getRemoteUrl(repoPath)
    await exec([...gitAuthArgs(token, remoteUrl), 'push', remoteName, '--delete', branch], repoPath)
    // Ensure local remote-tracking refs are pruned immediately so branch lists
    // reflect the deletion without requiring a manual fetch.
    await execSafe([...gitAuthArgs(token, remoteUrl), 'fetch', remoteName, '--prune'], repoPath)
  }

  /** Create a new branch (and optionally check it out). */
  async createBranch(repoPath: string, name: string, from?: string): Promise<void> {
    const args = from
      ? ['checkout', '-b', name, from]
      : ['checkout', '-b', name]
    await exec(args, repoPath)
  }

  /** Rename a branch. Renames the current branch when oldName === HEAD. */
  async renameBranch(repoPath: string, oldName: string, newName: string): Promise<void> {
    await exec(['branch', '-m', oldName, newName], repoPath)
  }

  /** Delete a branch. Uses -D (force) when force=true. */
  async deleteBranch(repoPath: string, name: string, force: boolean): Promise<void> {
    await exec(['branch', force ? '-D' : '-d', name], repoPath)
  }

  /** Return the URL of the 'origin' remote, or null if not set. */
  async getRemoteUrl(repoPath: string): Promise<string | null> {
    const res = await execSafe(['remote', 'get-url', 'origin'], repoPath)
    return res.exitCode === 0 ? res.stdout.trim() : null
  }

  /** Return ahead/behind counts for HEAD vs its upstream. */
  async getSyncStatus(repoPath: string): Promise<SyncStatus> {
    const upRes = await execSafe(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      repoPath
    )
    if (upRes.exitCode !== 0) {
      return { ahead: 0, behind: 0, remoteName: 'origin', remoteBranch: '', hasUpstream: false }
    }
    const remoteBranch = upRes.stdout.trim()
    const remoteName   = remoteBranch.split('/')[0]

    const [aRes, bRes] = await Promise.all([
      execSafe(['rev-list', '--count', `${remoteBranch}..HEAD`], repoPath),
      execSafe(['rev-list', '--count', `HEAD..${remoteBranch}`], repoPath),
    ])

    return {
      ahead:        parseInt(aRes.stdout.trim())  || 0,
      behind:       parseInt(bRes.stdout.trim())  || 0,
      remoteName,
      remoteBranch,
      hasUpstream:  true,
    }
  }

  /** Fetch origin then merge origin/main into HEAD. */
  async updateFromMain(repoPath: string): Promise<void> {
    if (await this.hasUncommittedChanges(repoPath)) {
      throw new Error('Update from main needs a clean working tree. Commit or stash your current changes first so incoming files are not mixed with local edits.')
    }

    const token = await authService.getCurrentToken()
    const remoteUrl = await this.getRemoteUrl(repoPath)
    const fetchRes = await execSafe([...gitAuthArgs(token, remoteUrl), 'fetch', 'origin', '--prune', '--progress'], repoPath)
    if (fetchRes.exitCode !== 0) {
      throw new Error(fetchRes.stderr || fetchRes.stdout || `Fetch from origin failed (exit ${fetchRes.exitCode})`)
    }

    const defaultBranch = await this.remoteDefaultBranch(repoPath)
    const check = await execSafe(['rev-parse', '--verify', defaultBranch.ref], repoPath)
    if (check.exitCode !== 0) {
      throw new Error(`Could not find ${defaultBranch.ref}`)
    }

    const mergeArgs = [...gitAuthArgs(token, remoteUrl), 'merge', '--no-edit', defaultBranch.ref]
    try {
      await exec(mergeArgs, repoPath)
    } catch (error) {
      if (!this.shouldRunLfsRecovery(error)) throw error
      await this.recoverLfsAndMergeState(repoPath)
      await exec(mergeArgs, repoPath)
    }
  }

  private async runWithLfsRecovery(repoPath: string, args: string[]): Promise<void> {
    try {
      await exec(args, repoPath)
    } catch (error) {
      if (!this.shouldRunLfsRecovery(error)) throw error
      await this.recoverLfsAndMergeState(repoPath)
      await exec(args, repoPath)
    }
  }

  private async authenticatedArgs(repoPath: string, args: string[]): Promise<string[]> {
    const token = await authService.getCurrentToken()
    const remoteUrl = await this.getRemoteUrl(repoPath)
    return [...gitAuthArgs(token, remoteUrl), ...args]
  }

  private isMergeConflictError(error: unknown): boolean {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    return (
      message.includes('automatic merge failed') ||
      message.includes('fix conflicts') ||
      message.includes('merge conflict') ||
      message.includes('conflict (') ||
      message.includes('conflict:') ||
      message.includes('cannot merge binary')
    )
  }

  /** git log with parsed output. Pass filePath to filter to a single file, or refs to limit to specific branches. */
  async log(
    repoPath: string,
    args: { limit?: number; all?: boolean; filePath?: string; refs?: string[] } = {}
  ): Promise<CommitEntry[]> {
    const cmdArgs = ['log', `--format=${GIT_LOG_FORMAT}`, '--topo-order']
    if (args.all && !args.filePath && !args.refs?.length) cmdArgs.push('--all')
    if (args.limit) cmdArgs.push(`-${args.limit}`)
    if (args.refs?.length) cmdArgs.push(...args.refs)
    if (args.filePath) cmdArgs.push('--follow', '--', args.filePath)

    const { exitCode, stdout } = await execSafe(cmdArgs, repoPath)
    if (exitCode !== 0) return []
    return parseGitLog(stdout)
  }

  /** Returns the preferred branch label for update UX. */
  async defaultBranch(repoPath: string): Promise<string> {
    return (await this.remoteDefaultBranch(repoPath)).name
  }

  /** Per-branch activity: last committer + timestamp for each local + remote branch. */
  async branchActivity(repoPath: string): Promise<BranchActivity[]> {
    const fmt = '%(refname:short)\t%(authorname)\t%(authoremail)\t%(authordate:iso-strict)\t%(subject)'
    const { exitCode, stdout } = await execSafe(
      ['for-each-ref', `--format=${fmt}`, '--sort=-authordate', 'refs/heads/', 'refs/remotes/origin/'],
      repoPath
    )
    if (exitCode !== 0) return []
    return stdout.trim().split('\n').filter(Boolean)
      .filter(line => !line.includes('HEAD'))
      .map(line => {
        const [ref, author, email, date, ...msg] = line.split('\t')
        return { ref: ref.trim(), author: author.trim(), email: email.trim(), date: date.trim(), message: msg.join('\t').trim() }
      })
  }

  /** Diff summary between two branches: commits ahead/behind + changed files with line counts. */
  async branchDiff(repoPath: string, base: string, compare: string): Promise<BranchDiffSummary> {
    const [baseRef, compareRef] = await Promise.all([
      this.resolveBranchRef(repoPath, base),
      this.resolveBranchRef(repoPath, compare),
    ])

    const [aheadR, behindR, numstatR, namestatR] = await Promise.all([
      execSafe(['log', '--format=%H\t%s\t%an\t%ai', `${baseRef}..${compareRef}`], repoPath),
      execSafe(['log', '--format=%H\t%s\t%an\t%ai', `${compareRef}..${baseRef}`], repoPath),
      execSafe(['diff', '--numstat', `${baseRef}...${compareRef}`], repoPath),
      execSafe(['diff', '--name-status', `${baseRef}...${compareRef}`], repoPath),
    ])

    const parseLog = (out: string) =>
      out.trim().split('\n').filter(Boolean).map(line => {
        const [hash, subject, author, date] = line.split('\t')
        return { hash: hash?.trim() ?? '', message: subject?.trim() ?? '', author: author?.trim() ?? '', date: date?.trim() ?? '' }
      })

    const statusMap = new Map<string, string>()
    namestatR.stdout.trim().split('\n').filter(Boolean).forEach(line => {
      const parts = line.split('\t')
      // R100\told\tnew  or  M\tpath
      const status = parts[0]?.charAt(0) ?? 'M'
      const path   = parts.length >= 3 ? parts[2] : parts[1]
      if (path) statusMap.set(path.trim(), status)
    })

    let totalAdditions = 0
    let totalDeletions = 0
    const files = numstatR.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [addStr, delStr, ...pathParts] = line.split('\t')
      const path      = pathParts.join('\t').trim()
      const additions = parseInt(addStr ?? '0', 10) || 0
      const deletions = parseInt(delStr ?? '0', 10) || 0
      totalAdditions += additions
      totalDeletions += deletions
      return { path, status: (statusMap.get(path) ?? 'M') as BranchDiffFile['status'], additions, deletions }
    })

    return {
      aheadCommits:  parseLog(aheadR.stdout),
      behindCommits: parseLog(behindR.stdout),
      files,
      totalAdditions,
      totalDeletions,
    }
  }

  /** Restore a single file to its state at a given commit. */
  async restoreFile(repoPath: string, filePath: string, fromHash: string): Promise<void> {
    await exec(['checkout', fromHash, '--', filePath], repoPath)
  }

  /** Revert a commit (creates a new revert commit, or stages without committing). */
  async revert(repoPath: string, hash: string, noCommit = false): Promise<void> {
    const args = ['revert', hash]
    if (noCommit) args.push('--no-commit')
    await exec(args, repoPath)
  }

  /** Cherry-pick a commit onto HEAD. noCommit=true stages changes without creating a commit. */
  async cherryPick(repoPath: string, hash: string, noCommit = false): Promise<void> {
    const args = ['cherry-pick', hash]
    if (noCommit) args.push('--no-commit')
    await exec(args, repoPath)
  }

  /** Reset HEAD to a given commit with the specified mode. */
  async resetTo(repoPath: string, hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await exec(['reset', `--${mode}`, hash], repoPath)
  }

  /** Files changed in a specific commit (uses diff-tree). */
  async commitFiles(
    repoPath: string,
    hash: string,
  ): Promise<Array<{ status: string; path: string; oldPath?: string }>> {
    const { exitCode, stdout } = await execSafe(
      ['diff-tree', '--no-commit-id', '-r', '--name-status', '-M', hash],
      repoPath,
    )
    if (exitCode !== 0 || !stdout.trim()) return []
    return stdout.trim().split('\n')
      .filter(Boolean)
      .map(line => {
        const parts = line.split('\t')
        const status  = parts[0].trim().charAt(0)  // M, A, D, R, C, T
        const path    = parts[parts.length - 1].trim()
        const oldPath = parts.length === 3 ? parts[1].trim() : undefined
        return { status, path, oldPath }
      })
  }

  /** Discard changes to the given paths. Untracked files are deleted from disk. */
  async discard(repoPath: string, paths: string[], isUntracked: boolean): Promise<void> {
    if (isUntracked) {
      for (const p of paths) {
        try {
          const fullPath = path.join(repoPath, p)
          const stat = fs.lstatSync(fullPath)
          if (stat.isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true })
          else fs.unlinkSync(fullPath)
        } catch { /* ignore */ }
      }
    } else {
      // Unstage first (no-op if not staged), then restore working tree
      await execSafe(['restore', '--staged', '--', ...paths], repoPath)
      await execSafe(['restore', '--', ...paths], repoPath)
    }
  }

  /** Discard all working-tree modifications (does not delete untracked files). */
  async discardAll(repoPath: string): Promise<void> {
    await execSafe(['restore', '--staged', '.'], repoPath)
    await execSafe(['restore', '.'], repoPath)
  }

  /** Append a pattern to .gitignore, creating the file if needed. */
  async addToGitignore(repoPath: string, pattern: string): Promise<void> {
    const p = path.join(repoPath, '.gitignore')
    let existing = ''
    try { existing = fs.readFileSync(p, 'utf8') } catch { /* new file */ }
    if (existing.split('\n').map(l => l.trim()).includes(pattern)) return
    const sep = existing && !existing.endsWith('\n') ? '\n' : ''
    fs.writeFileSync(p, existing + sep + pattern + '\n', 'utf8')
  }

  // ── Stash ─────────────────────────────────────────────────────────────────

  async stashList(repoPath: string): Promise<StashEntry[]> {
    const { exitCode, stdout } = await execSafe(
      ['stash', 'list', '--format=%gd\x1f%gs\x1f%ci'],
      repoPath
    )
    if (exitCode !== 0 || !stdout.trim()) return []
    return stdout
      .trim()
      .split('\n')
      .map((line, i) => {
        const [ref, subject, date] = line.split('\x1f')
        const branchMatch = subject?.match(/(?:WIP on|On) ([^:]+):/)
        return {
          index:   i,
          ref:     ref?.trim()     ?? `stash@{${i}}`,
          message: subject?.trim() ?? 'stash',
          branch:  branchMatch?.[1] ?? '',
          date:    date?.trim()    ?? '',
        }
      })
  }

  async stashSave(repoPath: string, message?: string, paths?: string[]): Promise<void> {
    const args = ['stash', 'push']
    if (message?.trim()) args.push('-m', message.trim())
    if (paths && paths.length > 0) args.push('--', ...paths)
    await exec(args, repoPath)
  }

  async stashPop(repoPath: string, ref: string): Promise<void> {
    await exec(['stash', 'pop', ref], repoPath)
  }

  async stashApply(repoPath: string, ref: string): Promise<void> {
    await exec(['stash', 'apply', ref], repoPath)
  }

  async stashDrop(repoPath: string, ref: string): Promise<void> {
    await exec(['stash', 'drop', ref], repoPath)
  }

  /** Switch to an existing branch. */
  async checkout(repoPath: string, branch: string): Promise<void> {
    const checkout = async (args: string[]) => this.runWithLfsRecovery(repoPath, await this.authenticatedArgs(repoPath, args))
    const localExists = (await execSafe(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath)).exitCode === 0
    if (localExists) {
      await checkout(['checkout', branch])
      return
    }

    const remoteRef = `origin/${branch}`
    const remoteExists = (await execSafe(['rev-parse', '--verify', `refs/remotes/${remoteRef}`], repoPath)).exitCode === 0
    if (remoteExists) {
      await checkout(['checkout', '--track', '-b', branch, remoteRef])
      return
    }

    await checkout(['checkout', branch])
  }

  /** Dry-run merge: returns files that would conflict. Does not modify the working tree. */
  async mergePreview(repoPath: string, targetBranch: string): Promise<ConflictPreviewFile[]> {
    const targetRef = await this.resolveBranchRef(repoPath, targetBranch)
    // 1. Find the common ancestor
    const baseRes = await execSafe(['merge-base', 'HEAD', targetRef], repoPath)
    if (baseRes.exitCode !== 0) throw new Error(`Could not find merge base with "${targetBranch}"`)
    const base = baseRes.stdout.trim()

    // 2. Files changed on each side since the merge base
    const [oursRes, theirsRes] = await Promise.all([
      execSafe(['diff', '--name-status', base, 'HEAD'], repoPath),
      execSafe(['diff', '--name-status', base, targetRef], repoPath),
    ])

    const parseNameStatus = (out: string): Map<string, string> => {
      const m = new Map<string, string>()
      for (const line of out.trim().split('\n')) {
        const parts = line.trim().split('\t')
        if (parts.length >= 2) {
          // Rename lines look like "R100\told\tnew" — use the new name
          const filePath = parts[parts.length - 1]
          const status   = parts[0][0]  // first char: M A D R C
          if (filePath) m.set(filePath, status)
        }
      }
      return m
    }

    const oursMap   = parseNameStatus(oursRes.stdout)
    const theirsMap = parseNameStatus(theirsRes.stdout)

    const UE_EXTS = new Set(['.uasset', '.umap', '.udk', '.ubulk', '.uexp', '.ucas'])
    const currentBranch = await this.currentBranch(repoPath)

    const conflicts: ConflictPreviewFile[] = []
    for (const [filePath, oursStatus] of oursMap) {
      if (!theirsMap.has(filePath)) continue   // only one side changed it — no conflict
      const theirsStatus = theirsMap.get(filePath)!

      const ext    = path.extname(filePath).toLowerCase()
      const isBin  = BINARY_EXTS.has(ext)
      const type: ConflictPreviewFile['type'] = UE_EXTS.has(ext) ? 'ue-asset'
        : isBin ? 'binary' : 'text'

      const conflictType: ConflictPreviewFile['conflictType'] =
        (oursStatus === 'D' || theirsStatus === 'D') ? 'delete-modify'
        : isBin ? 'binary'
        : 'content'

      const [oursInfo, theirsInfo] = await Promise.all([
        this._contributorInfo(repoPath, filePath, 'HEAD', currentBranch),
        this._contributorInfo(repoPath, filePath, targetRef, targetBranch),
      ])

      conflicts.push({ path: filePath, type, conflictType, ours: oursInfo, theirs: theirsInfo })
    }

    return conflicts
  }

  private async _contributorInfo(
    repoPath: string, filePath: string, ref: string, branch: string
  ): Promise<ContributorInfo> {
    const SEP = '\x1f'
    const [logRes, sizeRes] = await Promise.all([
      execSafe(['log', '-1', `--format=%an${SEP}%ae${SEP}%aI${SEP}%s`, ref, '--', filePath], repoPath),
      execSafe(['cat-file', '-s', `${ref}:${filePath}`], repoPath),
    ])
    const parts = logRes.stdout.trim().split(SEP)
    return {
      branch,
      lastContributor: { name: parts[0] ?? '', email: parts[1] ?? '' },
      lastEditedAt:    parts[2] ?? new Date().toISOString(),
      lastCommitMessage: parts[3]?.trim() ?? '',
      sizeBytes: sizeRes.exitCode === 0 ? (parseInt(sizeRes.stdout.trim(), 10) || 0) : 0,
    }
  }

  /** Merge targetBranch into HEAD. Throws if there are conflicts. */
  async merge(repoPath: string, targetBranch: string): Promise<void> {
    const targetRef = await this.resolveBranchRef(repoPath, targetBranch)
    await this.runWithLfsRecovery(repoPath, await this.authenticatedArgs(repoPath, ['merge', targetRef]))
  }


  async getMergeConflictText(repoPath: string, filePath: string): Promise<{ ours: string; theirs: string }> {
    const oursRes = await execSafe(['show', `:2:${filePath}`], repoPath)
    const theirsRes = await execSafe(['show', `:3:${filePath}`], repoPath)
    return { ours: oursRes.stdout ?? '', theirs: theirsRes.stdout ?? '' }
  }

  async resolveMergeConflictText(repoPath: string, filePath: string, choice: 'ours' | 'theirs'): Promise<void> {
    const stage = choice === 'ours' ? '2' : '3'
    const stageRes = await execSafe(['ls-files', '-u', '--', filePath], repoPath)

    // No unmerged stages means git auto-resolved this file; nothing to do.
    if (!stageRes.stdout.trim()) return

    const hasChosenVersion = stageRes.stdout
      .split('\n')
      .some(line => line.trim().split(/\s+/)[2] === stage)

    if (hasChosenVersion) {
      await this.runWithLfsRecovery(
        repoPath,
        await this.authenticatedArgs(repoPath, ['checkout', choice === 'theirs' ? '--theirs' : '--ours', '--', filePath]),
      )
      await exec(['add', '--', filePath], repoPath)
      return
    }

    // The selected side deleted the file in a delete/modify conflict.
    await exec(['rm', '-f', '--', filePath], repoPath)
  }

  async continueMerge(repoPath: string, targetBranch: string): Promise<void> {
    const unresolved = await execSafe(['diff', '--name-only', '--diff-filter=U'], repoPath)
    const unresolvedFiles = unresolved.stdout.trim().split('\n').filter(Boolean)
    if (unresolvedFiles.length > 0) {
      throw new Error(`Resolve all merge conflicts before finalizing:\n${unresolvedFiles.join('\n')}`)
    }
    // Use git's prepared MERGE_MSG (matches GitHub Desktop's "Merge branch
    // 'X' into Y" format). The fallback only fires if MERGE_MSG is missing.
    await exec(['commit', '--no-edit'], repoPath).catch(async () => {
      const branchLabel = targetBranch.replace(/^origin\//, '')
      await exec(['commit', '-m', `Merge branch '${branchLabel}'`], repoPath)
    })
  }

  async abortMerge(repoPath: string): Promise<void> {
    const res = await execSafe(['merge', '--abort'], repoPath)
    if (res.exitCode !== 0) {
      throw new Error(res.stderr || res.stdout || 'No merge is currently in progress.')
    }
  }

  /**
   * Returns the in-progress merge state, or null if no merge is active.
   * - mergeHead: the commit being merged into HEAD
   * - mergedBranch: best-guess branch name for that commit (refs/heads/X if a
   *   branch points at it, otherwise the short SHA)
   * - unresolvedFiles: paths still listed by git status as unmerged (UU/AU/UD/...)
   * - autoResolvedFiles: paths that git auto-resolved as part of this merge but
   *   that the caller may want to confirm (currently empty — we report only
   *   files needing user input).
   */
  async mergeInProgress(repoPath: string): Promise<{
    mergeHead: string
    mergedBranch: string
    unresolvedFiles: string[]
  } | null> {
    const gitDirRes = await execSafe(['rev-parse', '--git-dir'], repoPath)
    if (gitDirRes.exitCode !== 0) return null
    const gitDir = path.resolve(repoPath, gitDirRes.stdout.trim())
    const mergeHeadPath = path.join(gitDir, 'MERGE_HEAD')

    let mergeHead: string
    try {
      mergeHead = (await fs.promises.readFile(mergeHeadPath, 'utf8')).trim().split(/\s+/)[0]
    } catch {
      return null
    }
    if (!mergeHead) return null

    const branchRes = await execSafe(['for-each-ref', '--points-at', mergeHead, '--format=%(refname:short)', 'refs/heads/', 'refs/remotes/'], repoPath)
    const mergedBranch = branchRes.stdout.trim().split('\n').filter(Boolean)[0] ?? mergeHead.slice(0, 7)

    const unresolvedRes = await execSafe(['diff', '--name-only', '--diff-filter=U'], repoPath)
    const unresolvedFiles = unresolvedRes.stdout.split('\n').map(s => s.trim()).filter(Boolean)

    return { mergeHead, mergedBranch, unresolvedFiles }
  }

  /**
   * Build ConflictPreviewFile records for every unmerged file in an in-progress
   * merge. Used when the UI is recovering from a failed `merge` / `pull` /
   * `updateFromMain` and needs to show conflicts without re-running the merge.
   */
  async listInProgressConflicts(repoPath: string): Promise<ConflictPreviewFile[]> {
    const merge = await this.mergeInProgress(repoPath)
    if (!merge) return []

    const UE_EXTS = new Set(['.uasset', '.umap', '.udk', '.ubulk', '.uexp', '.ucas'])
    const currentBranch = await this.currentBranch(repoPath)
    const status = await this.status(repoPath)
    const statusByPath = new Map(status.map(f => [f.path, f]))

    const out: ConflictPreviewFile[] = []
    for (const filePath of merge.unresolvedFiles) {
      const ext = path.extname(filePath).toLowerCase()
      const isBin = BINARY_EXTS.has(ext)
      const type: ConflictPreviewFile['type'] = UE_EXTS.has(ext) ? 'ue-asset'
        : isBin ? 'binary' : 'text'

      // Porcelain XY for unmerged files:
      //   UD = modified by us, deleted by them   → delete-modify
      //   DU = deleted by us, modified by them   → delete-modify
      //   DD = both deleted                       → delete-modify (both sides agree)
      //   AA / UU = both added/modified           → content/binary conflict
      //   AU / UA = added on one side             → content/binary conflict
      const fileStatus = statusByPath.get(filePath)
      const xy = fileStatus ? `${fileStatus.indexStatus}${fileStatus.workingStatus}` : ''
      const isDeleteModify = xy === 'UD' || xy === 'DU' || xy === 'DD'
      const conflictType: ConflictPreviewFile['conflictType'] =
        isDeleteModify ? 'delete-modify'
        : isBin ? 'binary'
        : 'content'

      const [oursInfo, theirsInfo] = await Promise.all([
        this._contributorInfo(repoPath, filePath, 'HEAD', currentBranch).catch(() => ({
          branch: currentBranch, lastContributor: { name: '', email: '' }, lastEditedAt: '', lastCommitMessage: '', sizeBytes: 0,
        } as ContributorInfo)),
        this._contributorInfo(repoPath, filePath, 'MERGE_HEAD', merge.mergedBranch).catch(() => ({
          branch: merge.mergedBranch, lastContributor: { name: '', email: '' }, lastEditedAt: '', lastCommitMessage: '', sizeBytes: 0,
        } as ContributorInfo)),
      ])

      out.push({ path: filePath, type, conflictType, ours: oursInfo, theirs: theirsInfo })
    }
    return out
  }

  async resolveMergeIntoBranch(
    repoPath: string,
    targetBranch: string,
    baseBranch: string,
    fileChoices: Record<string, 'ours' | 'theirs'>,
  ): Promise<void> {
    const startBranch = await this.currentBranch(repoPath)
    const targetRef = await this.resolveBranchRef(repoPath, targetBranch)
    const baseRef = await this.resolveBranchRef(repoPath, baseBranch)
    const targetLocal = targetRef.replace(/^origin\//, '')
    const localBranchExists = (await execSafe(['rev-parse', '--verify', `refs/heads/${targetLocal}`], repoPath)).exitCode === 0
    const temporaryLocalBranch = !localBranchExists && targetRef.startsWith('origin/')

    try {
      if (localBranchExists) await this.runWithLfsRecovery(repoPath, await this.authenticatedArgs(repoPath, ['checkout', targetLocal]))
      else await this.runWithLfsRecovery(repoPath, await this.authenticatedArgs(repoPath, ['checkout', '-b', targetLocal, '--track', targetRef]))

      await execSafe(['merge', '--abort'], repoPath)
      try {
        await this.runWithLfsRecovery(repoPath, await this.authenticatedArgs(repoPath, ['merge', '--no-ff', '--no-commit', baseRef]))
      } catch (error) {
        if (!this.isMergeConflictError(error)) throw error
      }

      for (const [file, side] of Object.entries(fileChoices)) {
        await this.resolveMergeConflictText(repoPath, file, side)
      }

      // git prepared MERGE_MSG already says "Merge branch '<base>' into <target>".
      // Use --no-edit so the commit message matches GitHub Desktop / vanilla git.
      // Fall back to an explicit message only if MERGE_MSG was somehow consumed.
      try {
        await exec(['commit', '--no-edit'], repoPath)
      } catch {
        await exec(['commit', '-m', `Merge branch '${baseBranch.replace(/^origin\//, '')}' into ${targetLocal}`], repoPath)
      }
      await exec(await this.authenticatedArgs(repoPath, ['push', 'origin', targetLocal]), repoPath)
    } finally {
      await execSafe(['merge', '--abort'], repoPath)
      await execSafe(await this.authenticatedArgs(repoPath, ['checkout', startBranch]), repoPath)
      if (temporaryLocalBranch) await execSafe(['branch', '-D', targetLocal], repoPath)
    }
  }

  private async resolveBranchRef(repoPath: string, targetBranch: string): Promise<string> {
    const defaultBranch = await this.remoteDefaultBranch(repoPath)
    const candidates = targetBranch === defaultBranch.name
      ? [defaultBranch.ref, targetBranch]
      : [targetBranch, `origin/${targetBranch}`]
    for (const ref of candidates) {
      const res = await execSafe(['rev-parse', '--verify', ref], repoPath)
      if (res.exitCode === 0) return ref
    }
    return targetBranch
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  // TTL caches so repeated callers (OverviewPanel refresh, GC before/after) don't re-scan
  private _sizeCache = new Map<string, { ts: number; result: SizeBreakdown }>()
  private _lfsCache  = new Map<string, { ts: number; result: LFSStatus }>()
  private static readonly SIZE_TTL = 2  * 60 * 1000 // 2 minutes
  private static readonly LFS_TTL  = 5  * 60 * 1000 // 5 minutes

  /** Walk a small directory tree and sum file sizes. Only for LFS/logs — NOT for .git/objects. */
  private async _dirBytes(dirPath: string): Promise<number> {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    } catch {
      return 0
    }
    let total = 0
    // Process in batches of 32 to avoid exhausting OS file descriptors
    for (let i = 0; i < entries.length; i += 32) {
      const batch = entries.slice(i, i + 32)
      const sizes = await Promise.all(batch.map(async entry => {
        const full = path.join(dirPath, entry.name)
        if (entry.isDirectory()) return this._dirBytes(full)
        if (entry.isFile() || entry.isSymbolicLink()) {
          try { return (await fs.promises.stat(full)).size } catch { return 0 }
        }
        return 0
      }))
      for (const s of sizes) total += s
    }
    return total
  }

  /**
   * Measure repository disk usage.
   * Uses `git count-objects -v` for objects/packs (instant, even on huge repos)
   * and small directory walks for LFS cache and reflogs.
   * Results are cached for 2 minutes per repo.
   */
  async cleanupSize(repoPath: string, onProgress?: ProgressCallback): Promise<SizeBreakdown> {
    const cached = this._sizeCache.get(repoPath)
    if (cached && Date.now() - cached.ts < GitService.SIZE_TTL) return cached.result

    const gitDir  = path.join(repoPath, '.git')
    const lfsDir  = path.join(gitDir, 'lfs')
    const logsDir = path.join(gitDir, 'logs')

    onProgress?.({ id: 'size', label: 'Measuring repository', status: 'running', progress: 20, detail: 'Counting objects…' })

    // git count-objects -v is a native git builtin — milliseconds on any size repo
    let objectsBytes = 0
    let packsBytes   = 0
    try {
      const { stdout } = await exec(['count-objects', '-v'], repoPath)
      const kib = (key: string): number => {
        const m = stdout.match(new RegExp(`^${key}:\\s*(\\d+)`, 'm'))
        return m ? parseInt(m[1], 10) * 1024 : 0
      }
      objectsBytes = kib('size') + kib('size-garbage')
      packsBytes   = kib('size-pack')
    } catch { /* no objects yet */ }

    onProgress?.({ id: 'size', label: 'Measuring repository', status: 'running', progress: 60, detail: 'Measuring LFS cache…' })
    const lfsCacheBytes = await this._dirBytes(lfsDir)

    onProgress?.({ id: 'size', label: 'Measuring repository', status: 'running', progress: 85, detail: 'Scanning reflog…' })
    const logsBytes = await this._dirBytes(logsDir)

    const totalBytes = objectsBytes + packsBytes + lfsCacheBytes + logsBytes
    onProgress?.({ id: 'size', label: 'Measuring repository', status: 'done', progress: 100, detail: 'Done' })

    const result: SizeBreakdown = { totalBytes, objectsBytes, packsBytes, lfsCacheBytes, logsBytes }
    this._sizeCache.set(repoPath, { ts: Date.now(), result })
    return result
  }

  async cleanupGc(repoPath: string, aggressive = false, onProgress?: ProgressCallback): Promise<CleanupResult> {
    onProgress?.({ id: 'gc', label: 'Git GC', status: 'running', detail: 'Measuring current size…' })
    this._sizeCache.delete(repoPath)
    const before = await this.cleanupSize(repoPath)
    const args = ['gc']
    if (aggressive) args.push('--aggressive')
    await execWithProgress(args, repoPath, onProgress)
    onProgress?.({ id: 'gc', label: 'Git GC', status: 'running', detail: 'Recalculating size…' })
    this._sizeCache.delete(repoPath) // GC restructured objects — measure fresh
    const after = await this.cleanupSize(repoPath)
    return {
      beforeBytes: before.totalBytes,
      afterBytes:  after.totalBytes,
      savedBytes:  Math.max(0, before.totalBytes - after.totalBytes),
    }
  }

  async cleanupPruneLfs(repoPath: string): Promise<void> {
    await exec(['lfs', 'prune'], repoPath)
  }

  async cleanupShallow(repoPath: string, depth: number, onProgress?: ProgressCallback): Promise<void> {
    const token = await authService.getCurrentToken()
    const remoteUrl = await this.getRemoteUrl(repoPath)
    await execWithProgress([...gitAuthArgs(token, remoteUrl), 'fetch', '--depth', String(depth), '--progress'], repoPath, onProgress)
  }

  async cleanupUnshallow(repoPath: string, onProgress?: ProgressCallback): Promise<void> {
    const token = await authService.getCurrentToken()
    const remoteUrl = await this.getRemoteUrl(repoPath)
    await execWithProgress([...gitAuthArgs(token, remoteUrl), 'fetch', '--unshallow', '--progress'], repoPath, onProgress)
  }

  // ── LFS ───────────────────────────────────────────────────────────────────

  private async gitCommonDir(repoPath: string): Promise<string | null> {
    const commonDir = await execSafe(['rev-parse', '--git-common-dir'], repoPath)
    const raw = commonDir.exitCode === 0 ? commonDir.stdout.trim() : ''
    if (!raw) return null
    return path.resolve(repoPath, raw)
  }

  private async findLfsLockCacheFiles(repoPath: string): Promise<string[]> {
    const gitDir = await this.gitCommonDir(repoPath)
    if (!gitDir) return []

    const lfsDir = path.join(gitDir, 'lfs')
    const found: string[] = []

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6) return
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
        } else if (entry.isFile() && entry.name.toLowerCase() === 'lockcache.db') {
          found.push(full)
        }
      }
    }

    await walk(lfsDir, 0)
    return found.sort()
  }

  private async inspectLfsLockCacheFile(filePath: string): Promise<LfsLockCacheFile> {
    try {
      const stat = await fs.promises.stat(filePath)
      if (stat.size === 0) {
        return { path: filePath, sizeBytes: 0, exists: true, integrity: 'empty' }
      }

      let db: Database.Database | null = null
      try {
        db = new Database(filePath, { readonly: true, fileMustExist: true })
        const row = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined
        const value = row ? String(Object.values(row)[0] ?? '') : ''
        return {
          path: filePath,
          sizeBytes: stat.size,
          exists: true,
          integrity: value.toLowerCase() === 'ok' ? 'ok' : 'corrupt',
          error: value && value.toLowerCase() !== 'ok' ? value : undefined,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/file is not a database|database disk image is malformed/i.test(message) && stat.size < 1024) {
          return {
            path: filePath,
            sizeBytes: stat.size,
            exists: true,
            integrity: 'stale',
            error: 'Small unreadable lock cache; clearing and refreshing is recommended.',
          }
        }
        return {
          path: filePath,
          sizeBytes: stat.size,
          exists: true,
          integrity: 'corrupt',
          error: message,
        }
      } finally {
        db?.close()
      }
    } catch {
      return { path: filePath, sizeBytes: 0, exists: false, integrity: 'missing' }
    }
  }

  private parseLfsLocksCount(stdout: string): number | null {
    if (!stdout.trim()) return 0
    try {
      const parsed = JSON.parse(stdout) as unknown
      if (Array.isArray(parsed)) return parsed.length
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { locks?: unknown[] }).locks)) {
        return (parsed as { locks: unknown[] }).locks.length
      }
      if (parsed && typeof parsed === 'object') {
        const lockGroups = parsed as { ours?: unknown[]; theirs?: unknown[] }
        if (Array.isArray(lockGroups.ours) || Array.isArray(lockGroups.theirs)) {
          return (lockGroups.ours?.length ?? 0) + (lockGroups.theirs?.length ?? 0)
        }
      }
    } catch {
      // Older Git LFS versions can emit plain text if --json is unavailable.
    }
    return null
  }

  private async runLfsLocksCheck(repoPath: string): Promise<{ stdout: string; stderr: string; exitCode: number; usedVerify: boolean }> {
    const token = await authService.getCurrentToken()
    const remoteUrl = await this.getRemoteUrl(repoPath)
    const verify = await execSafe([...gitAuthArgs(token, remoteUrl), 'lfs', 'locks', '--verify', '--json'], repoPath)
    if (verify.exitCode === 0 || !/unknown flag:\s*--verify/i.test(verify.stderr)) {
      return { ...verify, usedVerify: true }
    }

    const plain = await execSafe([...gitAuthArgs(token, remoteUrl), 'lfs', 'locks', '--json'], repoPath)
    return {
      ...plain,
      usedVerify: false,
      stderr: [plain.stderr.trim(), 'Note: this Git LFS version does not support locks --verify; used git lfs locks --json instead.'].filter(Boolean).join('\n'),
    }
  }

  async lfsLocksMaintenance(repoPath: string, repair: boolean): Promise<LfsLocksMaintenanceResult> {
    const beforePaths = await this.findLfsLockCacheFiles(repoPath)
    const before = await Promise.all(beforePaths.map(filePath => this.inspectLfsLockCacheFile(filePath)))
    const deletedLockCacheFiles: string[] = []

    if (repair) {
      for (const filePath of beforePaths) {
        try {
          await fs.promises.rm(filePath, { force: true })
          deletedLockCacheFiles.push(filePath)
        } catch {
          // The verify step below will report any remaining cache issues.
        }
      }
    }

    const verify = await this.runLfsLocksCheck(repoPath)
    const afterPaths = repair ? await this.findLfsLockCacheFiles(repoPath) : beforePaths
    const after = repair
      ? await Promise.all(afterPaths.map(filePath => this.inspectLfsLockCacheFile(filePath)))
      : before

    const lockCount = this.parseLfsLocksCount(verify.stdout)
    const corruptCount = after.filter(file => file.integrity === 'corrupt' || file.integrity === 'empty').length
    const staleCount = after.filter(file => file.integrity === 'stale').length
    const hasErrors = verify.exitCode !== 0 || corruptCount > 0
    const summaryText = hasErrors
      ? [
          verify.exitCode !== 0 ? 'Git LFS lock verification failed.' : '',
          corruptCount > 0 ? `${corruptCount} lock cache file${corruptCount === 1 ? '' : 's'} need attention.` : '',
        ].filter(Boolean).join(' ')
      : [
          verify.usedVerify ? 'Git LFS locks verified' : 'Git LFS locks checked',
          lockCount === null ? '' : `(${lockCount} lock${lockCount === 1 ? '' : 's'})`,
          staleCount > 0 ? `${staleCount} stale cache file${staleCount === 1 ? '' : 's'} can be cleared.` : '',
        ].filter(Boolean).join(' ')
    const summary = /[.!?]$/.test(summaryText) ? summaryText : `${summaryText}.`

    return {
      lockCacheFiles: after,
      deletedLockCacheFiles,
      verifyExitCode: verify.exitCode,
      verifyOutput: verify.stdout.trim(),
      verifyError: verify.stderr.trim(),
      usedVerify: verify.usedVerify,
      lockCount,
      hasErrors,
      summary,
    }
  }

  /** Parse .gitattributes + count LFS objects + suggest untracked binary exts. Cached 5 min. */
  async lfsStatus(repoPath: string): Promise<LFSStatus> {
    const cached = this._lfsCache.get(repoPath)
    if (cached && Date.now() - cached.ts < GitService.LFS_TTL) return cached.result

    // Tracked patterns from .gitattributes
    const tracked: string[] = []
    try {
      const content = fs.readFileSync(path.join(repoPath, '.gitattributes'), 'utf8')
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (trimmed && trimmed.includes('filter=lfs')) {
          const pattern = trimmed.split(/\s+/)[0]
          if (pattern) tracked.push(pattern)
        }
      }
    } catch { /* no .gitattributes */ }

    // Count LFS objects and estimate total bytes
    let objects = 0, totalBytes = 0
    const lsRes = await execSafe(['lfs', 'ls-files', '-s'], repoPath)
    if (lsRes.exitCode === 0 && lsRes.stdout.trim()) {
      for (const line of lsRes.stdout.trim().split('\n').filter(Boolean)) {
        objects++
        // Format: "oid * path (1.23 MB)"
        const m = line.match(/\(([\d.]+)\s*(B|KB|MB|GB|TB)\)$/)
        if (m) {
          const n = parseFloat(m[1])
          const u = m[2]
          totalBytes += u === 'TB' ? n * 1e12
            : u === 'GB' ? n * 1e9
            : u === 'MB' ? n * 1e6
            : u === 'KB' ? n * 1e3 : n
        }
      }
    }

    // Suggest binary extensions in the repo not yet covered by a tracked pattern
    const trackedExts = new Set(
      tracked.map(p => path.extname(p.split('/').pop() ?? p).toLowerCase()).filter(Boolean)
    )
    const untrackedSet = new Set<string>()
    const lsFiles = await execSafe(['ls-files'], repoPath)
    if (lsFiles.exitCode === 0) {
      for (const f of lsFiles.stdout.trim().split('\n').filter(Boolean)) {
        const ext = path.extname(f).toLowerCase()
        if (ext && BINARY_EXTS.has(ext) && !trackedExts.has(ext)) {
          untrackedSet.add(`*${ext}`)
        }
      }
    }

    const result: LFSStatus = { tracked, untracked: [...untrackedSet].sort(), objects, totalBytes }
    this._lfsCache.set(repoPath, { ts: Date.now(), result })
    return result
  }

  /** Invalidate the LFS cache for a repo (call after lfsTrack/Untrack). */
  invalidateLfsCache(repoPath: string): void {
    this._lfsCache.delete(repoPath)
  }

  /** Run `git lfs track` for each pattern. */
  async lfsTrack(repoPath: string, patterns: string[]): Promise<void> {
    for (const p of patterns) {
      await exec(['lfs', 'track', p], repoPath)
    }
    this.invalidateLfsCache(repoPath)
  }

  /** Remove a pattern from LFS tracking (edits .gitattributes). */
  async lfsUntrack(repoPath: string, pattern: string): Promise<void> {
    await exec(['lfs', 'untrack', pattern], repoPath)
    this.invalidateLfsCache(repoPath)
  }

  /** Return binary-extension patterns present in the repo but not yet LFS-tracked. */
  async lfsAutodetect(repoPath: string): Promise<string[]> {
    const status = await this.lfsStatus(repoPath)
    return status.untracked
  }

  /**
   * Migrate existing committed files to LFS.
   * ⚠ Rewrites history — callers must warn the user and force-push afterward.
   */
  async lfsMigrate(repoPath: string, patterns: string[], onProgress?: ProgressCallback): Promise<void> {
    const include = patterns.join(',')
    await execWithProgress(['lfs', 'migrate', 'import', `--include=${include}`, '--everything'], repoPath, onProgress)
  }

  /** Return old/new content for the Monaco diff viewer. */
  async diff(repoPath: string, filePath: string, staged: boolean): Promise<DiffContent> {
    const isBinary = BINARY_EXTS.has(path.extname(filePath).toLowerCase())
    const language = langFromPath(filePath)

    if (isBinary) return { oldContent: '', newContent: '', isBinary: true, language }

    // HEAD content — empty string for new files
    const headRes = await execSafe(['show', `HEAD:${filePath}`], repoPath)
    const oldContent = headRes.exitCode === 0 ? headRes.stdout : ''

    // Working/index content
    let newContent = ''
    if (staged) {
      const idxRes = await execSafe(['show', `:${filePath}`], repoPath)
      newContent = idxRes.exitCode === 0 ? idxRes.stdout : ''
    } else {
      try {
        newContent = fs.readFileSync(path.join(repoPath, filePath), 'utf8')
      } catch {
        // deleted in working tree
      }
    }

    return { oldContent, newContent, isBinary: false, language }
  }

  // ── Auto-fix helpers ────────────────────────────────────────────────────────

  async rebaseAbort(repoPath: string): Promise<void> {
    await exec(['rebase', '--abort'], repoPath)
  }

  async setUpstream(repoPath: string, branch: string): Promise<void> {
    const token = await authService.getCurrentToken()
    const remoteUrl = await this.getRemoteUrl(repoPath)
    await execWithProgress([...gitAuthArgs(token, remoteUrl), 'push', '--set-upstream', 'origin', branch], repoPath)
  }

  async setGitConfig(repoPath: string, key: string, value: string): Promise<void> {
    await exec(['config', key, value], repoPath)
  }

  async getGitConfig(repoPath: string, key: string): Promise<string | null> {
    const { exitCode, stdout } = await execSafe(['config', '--get', key], repoPath)
    if (exitCode !== 0) return null
    return stdout.trim() || null
  }

  async getGlobalGitIdentity(): Promise<{ name: string; email: string }> {
    const home = require('os').homedir()
    const [nameRes, emailRes] = await Promise.all([
      execSafe(['config', '--global', 'user.name'],  home),
      execSafe(['config', '--global', 'user.email'], home),
    ])
    return { name: nameRes.stdout.trim(), email: emailRes.stdout.trim() }
  }

  async setGlobalGitIdentity(name: string, email: string): Promise<void> {
    const home = require('os').homedir()
    await Promise.all([
      exec(['config', '--global', 'user.name', name],  home),
      exec(['config', '--global', 'user.email', email], home),
    ])
  }

  async setGlobalDefaultBranch(defaultBranchName: string): Promise<void> {
    const home = require('os').homedir()
    await exec(['config', '--global', 'init.defaultBranch', defaultBranchName], home)
  }

  /** Read the repo-local git identity (user.name + user.email). */
  async getIdentity(repoPath: string): Promise<{ name: string; email: string }> {
    const [nameRes, emailRes] = await Promise.all([
      execSafe(['config', 'user.name'],  repoPath),
      execSafe(['config', 'user.email'], repoPath),
    ])
    return {
      name:  nameRes.stdout.trim(),
      email: emailRes.stdout.trim(),
    }
  }

  /**
   * Write the GitHub login as the local git user.name so that LFS lock
   * owners created by Lucid Git and the GitSourceControl plugin reconcile correctly.
   * Also enables lfs.locksverify to block pushes on locked files.
   */
  async linkIdentity(repoPath: string, login: string, name: string): Promise<void> {
    // Use login as user.name — LFS lock owner.name is the GitHub login
    await exec(['config', '--local', 'user.name', login], repoPath)
    if (name && name !== login) {
      // Store display name in a custom key (non-standard but useful for UE attribution)
      await exec(['config', '--local', 'lucidgit.displayname', name], repoPath)
    }
    // Prevent pushing if you're modifying a file locked by someone else
    await exec(['config', '--local', 'lfs.locksverify', 'true'], repoPath)
  }

  /** List all tracked files in the working tree (includes untracked non-ignored). */
  async lsFiles(repoPath: string): Promise<string[]> {
    const res = await execSafe(['ls-files', '--cached', '--others', '--exclude-standard'], repoPath)
    if (res.exitCode !== 0) return []
    return res.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  }

  /** Return per-line blame data for a file at a specific revision. */
  async blame(repoPath: string, filePath: string, rev: string): Promise<BlameEntry[]> {
    const { exitCode, stdout } = await execSafe(
      ['blame', '--line-porcelain', rev, '--', filePath],
      repoPath,
    )
    if (exitCode !== 0 || !stdout.trim()) return []
    return parsePorcelainBlame(stdout)
  }

  async diffCommit(repoPath: string, filePath: string, hash: string): Promise<DiffContent> {
    const [newRes, oldRes] = await Promise.all([
      execSafe(['show', `${hash}:${filePath}`], repoPath),
      execSafe(['show', `${hash}^:${filePath}`], repoPath),
    ])
    const newContent = newRes.exitCode === 0 ? newRes.stdout : ''
    const oldContent = oldRes.exitCode === 0 ? oldRes.stdout : ''
    const isBinary = BINARY_EXTS.has(path.extname(filePath).toLowerCase())
    return { oldContent, newContent, isBinary, language: langFromPath(filePath) }
  }
}

export interface BlameEntry {
  hash: string
  author: string
  timestamp: number
  summary: string
  lineNo: number
  line: string
}

function parsePorcelainBlame(output: string): BlameEntry[] {
  const lines = output.split('\n')
  const result: BlameEntry[] = []
  let i = 0

  while (i < lines.length) {
    const header = lines[i]
    if (!header || !/^[0-9a-f]{40} /.test(header)) { i++; continue }

    const parts = header.split(' ')
    const hash = parts[0]
    const resultLineNo = parseInt(parts[2], 10)

    const meta: Record<string, string> = {}
    i++
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const ln = lines[i]
      const sp = ln.indexOf(' ')
      if (sp > 0) meta[ln.slice(0, sp)] = ln.slice(sp + 1)
      i++
    }

    const content = lines[i]?.startsWith('\t') ? lines[i].slice(1) : ''
    result.push({
      hash,
      author: meta['author'] ?? 'Unknown',
      timestamp: parseInt(meta['author-time'] ?? '0', 10) * 1000,
      summary: meta['summary'] ?? '',
      lineNo: isNaN(resultLineNo) ? result.length + 1 : resultLineNo,
      line: content,
    })
    i++
  }

  return result
}

export const gitService = new GitService()
