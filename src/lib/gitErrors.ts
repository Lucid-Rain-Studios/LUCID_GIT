// Git error parsing library — 14 error codes
// Each error is matched from raw git stderr output.

export type ErrorSeverity = 'warning' | 'error' | 'fatal'

export type FixAction =
  | { type: 'reauth' }
  | { type: 'open-conflict-resolver' }
  | { type: 'run-lfs-migrate'; patterns: string[] }
  | { type: 'open-settings'; section: string }
  | { type: 'set-upstream'; branch: string }
  | { type: 'abort-rebase' }
  | { type: 'clean-pack-files' }
  | { type: 'increase-buffer' }
  | { type: 'retry-with-ssh' }
  | { type: 'clear-lock-cache' }

export interface FixStep {
  label: string
  command?: string
  action?: FixAction
}

export interface LucidGitError {
  code: string
  gitMessage: string
  title: string
  description: string
  causes: string[]
  fixes: FixStep[]
  docsUrl?: string
  severity: ErrorSeverity
  canAutoFix: boolean
}

// ── Pattern definitions ───────────────────────────────────────────────────────

interface ErrorDef {
  code: string
  test: RegExp
  title: string
  description: string
  causes: string[]
  fixes: FixStep[]
  docsUrl?: string
  severity: ErrorSeverity
  canAutoFix: boolean
}

const DEFS: ErrorDef[] = [
  {
    code: 'DISK_SPACE',
    test: /no space left|disk quota exceeded|ENOSPC|not enough space/i,
    title: 'Disk full',
    description: 'There is not enough disk space to complete this operation.',
    causes: ['System drive is full', 'Git pack files or LFS cache are too large'],
    severity: 'fatal',
    canAutoFix: true,
    fixes: [
      { label: 'Run Git cleanup to free space', action: { type: 'clean-pack-files' } },
      { label: 'Check disk usage', command: 'df -h' },
    ],
  },
  {
    code: 'EAUTH',
    test: /Authentication failed|could not read Username|Invalid credentials|bad credentials|401 Authorization Required|403 Forbidden/i,
    title: 'Authentication failed',
    description: 'Your GitHub credentials are missing, expired, or revoked.',
    causes: ['OAuth token expired or revoked', 'Wrong account selected', 'Missing required scopes (repo, write:lfs)', 'Token not authorized for organization SSO'],
    severity: 'error',
    canAutoFix: true,
    fixes: [
      { label: 'Sign in again', action: { type: 'reauth' } },
      { label: 'Authorize token for org SSO: github.com → Settings → Applications → find this app → Grant', command: 'start https://github.com/settings/connections/applications' },
      { label: 'Verify token scopes', command: 'gh auth status' },
    ],
  },
  {
    code: 'PERMISSION_DENIED',
    test: /Permission denied \(publickey\)|publickey.*denied|Could not open.*Permission denied|EACCES/i,
    title: 'SSH permission denied',
    description: 'Your SSH key is not authorized for this repository.',
    causes: ['SSH key not added to your GitHub account', 'Wrong SSH key in use', 'Repository access not granted'],
    severity: 'error',
    canAutoFix: true,
    fixes: [
      { label: 'Switch to HTTPS authentication', action: { type: 'retry-with-ssh' } },
      { label: 'Add SSH key to GitHub', command: 'ssh-keygen -t ed25519 && cat ~/.ssh/id_ed25519.pub' },
      { label: 'Test SSH connection', command: 'ssh -T git@github.com' },
    ],
    docsUrl: 'https://docs.github.com/en/authentication/troubleshooting-ssh',
  },
  {
    code: 'NETWORK_TIMEOUT',
    test: /timed? ?out|connection (refused|reset|timed)|Could not resolve host|curl error|SSL_connect/i,
    title: 'Network error',
    description: 'Could not reach the remote server. Check your internet connection.',
    causes: ['No internet connection', 'Firewall blocking Git traffic', 'DNS resolution failure', 'Proxy misconfiguration'],
    severity: 'error',
    canAutoFix: false,
    fixes: [
      { label: 'Retry the operation', command: 'git fetch --retry' },
      { label: 'Test connectivity', command: 'curl -I https://github.com' },
    ],
  },
  {
    code: 'DIRTY_WORKING_TREE',
    test: /needs a clean working tree|Your local changes.*would be overwritten|Please commit your changes or stash them|cannot pull with rebase.*unstaged changes|working tree has modifications/i,
    title: 'Uncommitted changes block the update',
    description: 'Update from main needs a clean working tree. Commit or stash your current changes first so incoming files are not mixed with local edits.',
    causes: [
      'You have edits in the working tree that have not been committed or stashed',
      'A previous merge / rebase left files modified',
      'Files are still open and saving from an external editor (e.g. Unreal Editor, Photoshop) — close that program before retrying',
    ],
    severity: 'error',
    canAutoFix: false,
    fixes: [
      { label: 'Close any program editing files in this repo (Unreal Editor, Photoshop, Blender, …) and retry', action: { type: 'open-settings', section: 'changes' } },
      { label: 'Commit your changes first', command: 'git commit -am "WIP"' },
      { label: 'Or stash them temporarily', command: 'git stash push -m "before update from main"' },
      { label: 'Discard local changes (destructive)', command: 'git reset --hard HEAD' },
    ],
  },
  {
    code: 'WORKING_TREE_LOCKED',
    test: /unable to unlink old.*Invalid argument|unable to unlink old.*Permission denied|unable to (?:create|write) file.*(Permission denied|Access is denied|Invalid argument)|being used by another process|cannot access the file because it is being used|The process cannot access the file/i,
    title: 'Files locked by another program',
    description: 'Git could not update the working tree because one or more files are open in another program. Close the program holding those files (most often Unreal Editor for .uasset / .umap files), then retry.',
    causes: [
      'Unreal Editor has the project open and is holding .uasset / .umap files — close the editor and retry',
      'A file is open in an external editor (Photoshop, Audition, Blender, etc.) — close it before retrying',
      'OneDrive / Dropbox / antivirus has the file briefly locked — pause sync or exclude the repo folder',
    ],
    severity: 'error',
    canAutoFix: true,
    fixes: [
      { label: 'Close Unreal Editor (and any other program editing the listed files), then retry the update', action: { type: 'open-conflict-resolver' } },
      { label: 'Open the merge resolver to pick ours/theirs for the locked files', action: { type: 'open-conflict-resolver' } },
      { label: 'Abort the in-progress merge', command: 'git merge --abort' },
    ],
  },
  {
    code: 'MERGE_CONFLICT',
    test: /CONFLICT|Automatic merge failed|fix conflicts and then commit|Cannot merge|Merge conflict/i,
    title: 'Merge conflicts',
    description: 'Git could not automatically merge all files. Manual resolution is needed.',
    causes: ['Both branches modified the same lines', 'Binary files changed on both branches', 'Deleted on one side, modified on the other'],
    severity: 'warning',
    canAutoFix: true,
    fixes: [
      { label: 'Open conflict resolver', action: { type: 'open-conflict-resolver' } },
      { label: 'Abort and return to pre-merge state', command: 'git merge --abort' },
    ],
  },
  {
    code: 'LFS_LOCK_CONFLICT',
    test: /cannot lock|locked by|lfs lock conflict|file locked by|already locked/i,
    title: 'File is locked',
    description: 'A file you are trying to modify is locked by another user via Git LFS.',
    causes: ['A teammate has locked this file', 'Your own lock was not released after previous work'],
    severity: 'error',
    canAutoFix: false,
    fixes: [
      { label: 'View all active locks', action: { type: 'open-settings', section: 'locks' } },
      { label: 'List locks', command: 'git lfs locks' },
      { label: 'Force unlock (use with caution)', command: 'git lfs unlock --force <path>' },
    ],
  },
  {
    code: 'LFS_LOCK_CACHE',
    test: /database disk image is malformed|file is not a database|lockcache(\.db)?|lock id could not be resolved|could not be resolved after refreshing|refreshing the Git LFS lock cache|locks cache.*(corrupt|malformed|stale)/i,
    title: 'Git LFS lock cache problem',
    description: "Your local Git LFS lock cache (lockcache.db) is stale or corrupted, so locks couldn't be read or released. Clearing the cache rebuilds it from the server — it does not unlock any files or change commits.",
    causes: [
      'The lock cache database was corrupted or interrupted mid-write',
      "A lock id couldn't be resolved from the stale cache when unlocking",
      'Different Git LFS versions wrote incompatible cache files',
    ],
    severity: 'error',
    canAutoFix: true,
    fixes: [
      { label: 'Clear the lock cache and refresh from the server', action: { type: 'clear-lock-cache' } },
      { label: 'Open the Locked Files panel to Check & Repair', action: { type: 'open-settings', section: 'locks' } },
      { label: 'List locks from the server', command: 'git lfs locks --json' },
    ],
  },
  {
    code: 'PUSH_REJECTED',
    test: /rejected.*non-fast-forward|fetch first|Updates were rejected|push.*rejected|remote rejected/i,
    title: 'Push rejected',
    description: 'The remote has commits your local branch does not have. Pull first.',
    causes: ['Someone else pushed to this branch since your last pull', 'Force push is needed but not advised'],
    severity: 'error',
    canAutoFix: false,
    fixes: [
      { label: 'Pull and rebase before pushing', command: 'git pull --rebase' },
      { label: 'Force push (WARNING: overwrites remote history)', command: 'git push --force-with-lease' },
    ],
  },
  {
    code: 'NO_UPSTREAM',
    test: /no tracking information|no upstream branch|--set-upstream|has no upstream|does not track/i,
    title: 'No upstream branch',
    description: "This branch has no remote tracking branch. It hasn't been pushed yet.",
    causes: ['Branch was created locally and never pushed', 'Remote tracking reference was deleted'],
    severity: 'warning',
    canAutoFix: true,
    fixes: [
      { label: 'Push and set upstream', action: { type: 'set-upstream', branch: '' } },
      { label: 'Push with upstream manually', command: 'git push -u origin HEAD' },
    ],
  },
  {
    code: 'DETACHED_HEAD',
    test: /HEAD detached|detached HEAD|not on any branch/i,
    title: 'Detached HEAD',
    description: "You are not on a branch. Commits made now won't belong to any branch.",
    causes: ['Checked out a specific commit hash', 'Checked out a tag', 'Rebase or bisect left HEAD detached'],
    severity: 'warning',
    canAutoFix: false,
    fixes: [
      { label: 'Create a branch here', command: 'git switch -c <new-branch-name>' },
      { label: 'Return to main', command: 'git switch main' },
    ],
  },
  {
    code: 'LARGE_FILE_NO_LFS',
    test: /File.*over.*limit|GH001|file is (too )?larger than|exceeds GitHub.s file size limit|this exceeds.*maximum.*file size/i,
    title: 'File too large for Git',
    description: 'One or more files exceed the size limit for regular Git commits. Use Git LFS.',
    causes: ['Large binary files committed without LFS tracking', 'LFS patterns not configured for these file types'],
    severity: 'error',
    canAutoFix: true,
    fixes: [
      { label: 'Migrate large files to LFS', action: { type: 'run-lfs-migrate', patterns: [] } },
      { label: 'Track file type in LFS', command: 'git lfs track "*.ext"' },
    ],
  },
  {
    code: 'LFS_QUOTA_EXCEEDED',
    test: /exceeded.*storage|LFS.*storage.*exceeded|bandwidth.*exceeded|LFS.*quota|storage quota/i,
    title: 'LFS quota exceeded',
    description: 'Your GitHub LFS storage or bandwidth quota has been exceeded.',
    causes: ['Free tier limit reached (1 GB storage / 1 GB bandwidth)', 'Large assets pushed without a paid LFS plan'],
    severity: 'fatal',
    canAutoFix: false,
    fixes: [
      { label: 'Prune unreferenced LFS objects', action: { type: 'clean-pack-files' } },
      { label: 'Upgrade LFS storage on GitHub', command: '# github.com → Settings → Billing → Git LFS Data' },
    ],
    docsUrl: 'https://docs.github.com/en/billing/managing-billing-for-git-large-file-storage',
  },
  {
    code: 'PACK_CORRUPT',
    test: /pack.*corrupt|packfile.*corrupt|bad object|loose object.*missing|object.*corrupt|index-pack failed/i,
    title: 'Pack file corrupted',
    description: 'Git object database has a corruption. The repository may need repair.',
    causes: ['Interrupted write during gc or repack', 'Filesystem error or disk failure', 'Incomplete clone or fetch'],
    severity: 'fatal',
    canAutoFix: true,
    fixes: [
      { label: 'Run fsck and gc to repair', action: { type: 'clean-pack-files' } },
      { label: 'Check repository integrity', command: 'git fsck --full' },
      { label: 'Re-clone if repair fails', command: 'git clone <url> <dir>' },
    ],
  },
  {
    code: 'STASH_CONFLICT',
    test: /stash.*conflict|cannot apply.*stash|stash.*already exists|CONFLICT.*stash/i,
    title: 'Stash conflict',
    description: 'Could not apply the stash because it conflicts with your current changes.',
    causes: ['Working tree modified the same files as the stash', 'Stash was created on a different branch'],
    severity: 'warning',
    canAutoFix: false,
    fixes: [
      { label: 'Open conflict resolver', action: { type: 'open-conflict-resolver' } },
      { label: 'Drop the conflicting stash', command: 'git stash drop' },
      { label: 'View stash diff before applying', command: 'git stash show -p' },
    ],
  },
  {
    code: 'REBASE_ABORT_NEEDED',
    test: /rebase in progress|interactive rebase already started|rebasing.*in progress|You need to resolve.*conflicts.*rebase/i,
    title: 'Rebase in progress',
    description: 'A rebase operation is in progress and has conflicts. Resolve or abort.',
    causes: ['Conflicts during rebase', 'Rebase was interrupted (power loss, crash)'],
    severity: 'error',
    canAutoFix: true,
    fixes: [
      { label: 'Abort the rebase', action: { type: 'abort-rebase' } },
      { label: 'Open conflict resolver', action: { type: 'open-conflict-resolver' } },
      { label: 'Continue rebase after resolving', command: 'git rebase --continue' },
    ],
  },
]

// ── Parser ─────────────────────────────────────────────────────────────────────

/** Parse a raw git error string into a LucidGitError, or null if unrecognised. */
export function parseGitError(raw: string): LucidGitError | null {
  for (const def of DEFS) {
    if (!def.test.test(raw)) continue
    return {
      code: def.code,
      gitMessage: raw,
      title: def.title,
      description: def.description,
      causes: def.causes,
      fixes: def.fixes,
      docsUrl: def.docsUrl,
      severity: def.severity,
      canAutoFix: def.canAutoFix,
    }
  }
  return null
}

/**
 * Pull the most meaningful single line out of raw git/CLI stderr so an
 * unrecognized error still says something specific instead of "An unexpected
 * error occurred." Prefers explicit fatal/error/remote lines, then any line
 * mentioning a failure, then the first non-empty line.
 */
export function summarizeRawError(raw: string): string {
  const lines = raw
    .replace(/^Error:\s*/i, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return 'An unexpected error occurred.'
  const tagged   = lines.find(l => /^(fatal|error|remote|hint|warning):/i.test(l))
  const failureish = lines.find(l => /(fail|denied|rejected|conflict|cannot|could not|unable|not found|refused|corrupt|malformed|locked|timed? ?out)/i.test(l))
  const pick = tagged ?? failureish ?? lines[0]
  return pick.replace(/^(fatal|error|remote|hint|warning):\s*/i, '').slice(0, 400)
}

/** Parse or fall back to a generic error that still surfaces the real message. */
export function parseGitErrorOrGeneric(raw: string): LucidGitError {
  return parseGitError(raw) ?? {
    code: 'UNKNOWN',
    gitMessage: raw,
    title: 'Git operation failed',
    description: summarizeRawError(raw),
    causes: [],
    fixes: [],
    severity: 'error',
    canAutoFix: false,
  }
}
