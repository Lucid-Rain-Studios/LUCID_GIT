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

/** Parse or fall back to a generic unknown error. */
export function parseGitErrorOrGeneric(raw: string): LucidGitError {
  return parseGitError(raw) ?? {
    code: 'UNKNOWN',
    gitMessage: raw,
    title: 'Git error',
    description: 'An unexpected error occurred.',
    causes: [],
    fixes: [{ label: 'View raw output below' }],
    severity: 'error',
    canAutoFix: false,
  }
}
