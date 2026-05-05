// Shared types for the Electron main process.
// Mirror of the domain types in src/ipc.ts — kept separate because
// the main and renderer processes are compiled independently.

export type RepoPermission = 'admin' | 'write' | 'read'

export interface PermissionCacheEntry {
  permission: RepoPermission
  fetchedAt: number  // unix ms
}

export interface OperationStep {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
  progress?: number
  detail?: string
  duration?: number
}

export interface FileStatus {
  path: string
  indexStatus: string   // staged status  (X in XY)
  workingStatus: string // working status (Y in XY)
  staged: boolean
}

export interface BranchInfo {
  name: string          // full short name: "main" or "origin/main"
  displayName: string   // name without remote prefix: always "main"
  current: boolean      // true only for the checked-out local branch
  upstream?: string     // tracking remote ref, e.g. "origin/main"
  ahead: number
  behind: number
  isRemote: boolean
  remoteName?: string   // e.g. "origin"
  hasLocal?: boolean    // remote branches: whether a local tracking branch exists
}

export interface CommitEntry {
  hash: string
  parentHashes: string[]
  author: string
  email: string
  timestamp: number
  message: string
}

export interface Account {
  userId: string
  login: string
  name: string
  avatarUrl: string
}

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export interface Lock {
  id: string
  path: string
  owner: { name: string; login: string }
  lockedAt: string  // ISO date string
  isGhost?: boolean  // true when the file no longer exists on disk
}

export interface StashEntry {
  index:   number
  ref:     string   // stash@{0}
  message: string
  branch:  string
  date:    string   // ISO date string
}

export interface DiffContent {
  oldContent: string
  newContent: string
  isBinary: boolean
  language: string
}

export interface AppNotification {
  id: number
  type: string
  title: string
  body: string
  repoPath: string
  createdAt: string  // ISO date string
  read: boolean
  meta?: Record<string, unknown>  // structured payload for pr-merged / pr-closed notifications
}

export interface WebhookConfig {
  url: string
  enabled: boolean
  events: {
    fileLocked: boolean
    fileUnlocked: boolean
    mergeConflictDetected: boolean
    pushToMain: boolean
    branchCreated: boolean
    forceUnlock: boolean
    largeFileWarning: boolean
    fatalError: boolean
    cleanupCompleted: boolean
    branchDeleted: boolean
  }
  mentionRoles?: string[]
  quietHours?: { start: string; end: string }
}

export interface ContributorInfo {
  branch: string
  lastContributor: { name: string; email: string }
  lastEditedAt: string   // ISO date string
  lastCommitMessage: string
  sizeBytes: number
}

export interface ConflictPreviewFile {
  path: string
  type: 'text' | 'binary' | 'ue-asset'
  conflictType: 'content' | 'binary' | 'delete-modify'
  ours: ContributorInfo
  theirs: ContributorInfo
}

export interface PotentialMergeConflictBranch {
  branch: string
  isRemote: boolean
  files: string[]
  conflictCount: number
}

export interface PotentialMergeConflictReport {
  checkedAt: number
  mode: 'lightweight' | 'deep'
  changedFiles: string[]
  branchesChecked: number
  branchesWithConflicts: PotentialMergeConflictBranch[]
}

export interface LFSStatus {
  tracked: string[]    // patterns from .gitattributes with filter=lfs
  untracked: string[]  // suggested patterns (binary exts in repo not yet tracked)
  objects: number
  totalBytes: number
}

export interface LfsLockCacheFile {
  path: string
  sizeBytes: number
  exists: boolean
  integrity: 'ok' | 'missing' | 'empty' | 'stale' | 'corrupt' | 'unknown'
  error?: string
}

export interface LfsLocksMaintenanceResult {
  lockCacheFiles: LfsLockCacheFile[]
  deletedLockCacheFiles: string[]
  verifyExitCode: number
  verifyOutput: string
  verifyError: string
  usedVerify: boolean
  lockCount: number | null
  hasErrors: boolean
  summary: string
}

export interface SyncStatus {
  ahead: number
  behind: number
  remoteName: string
  remoteBranch: string
  hasUpstream: boolean
}

export interface SizeBreakdown {
  totalBytes: number
  objectsBytes: number
  packsBytes: number
  lfsCacheBytes: number
  logsBytes: number
}

export interface CleanupResult {
  beforeBytes: number
  afterBytes: number
  savedBytes: number
}

export interface UEProject {
  name: string
  uprojectPath: string
  engineVersion: string
}

export interface AppSettings {
  autoFetchIntervalMinutes: number
  defaultCloneDepth: number
  largeFileWarnMB: number
  scheduledCleanup: {
    enabled: boolean
    frequencyDays: number
    includeGc: boolean
    includePruneLfs: boolean
  }
  // Appearance
  fontFamily: string
  fontSize: number
  uiDensity: 'compact' | 'normal' | 'relaxed'
  theme: 'dark' | 'darker' | 'midnight' | 'dracula' | 'nord' | 'catppuccin' | 'tokyo-night' | 'ocean' | 'forest' | 'rose-pine' | 'monokai'
  codeFontFamily?: string
  fontWeight?: 300 | 400 | 500 | 600
  borderRadius?: 'sharp' | 'default' | 'rounded' | 'pill'
  accentColor?: string
  defaultBranchName?: string
}

export interface TeamConfig {
  lfsPatterns: string[]
  webhookEvents: Record<string, boolean>
  hookIds: string[]
  largeFileWarnMB?: number
}

export interface BranchActivity {
  ref: string
  author: string
  email: string
  date: string
  message: string
}

export interface BranchDiffCommit {
  hash: string
  message: string
  author: string
  date: string
}

export interface BranchDiffFile {
  path: string
  status: 'A' | 'M' | 'D' | 'R' | 'C'
  additions: number
  deletions: number
}

export interface BranchDiffSummary {
  aheadCommits:  BranchDiffCommit[]
  behindCommits: BranchDiffCommit[]
  files:         BranchDiffFile[]
  totalAdditions: number
  totalDeletions: number
}

export interface PresenceEntry {
  login: string
  name: string
  branch: string
  modifiedCount: number
  modifiedFiles: string[]
  lastSeen: string   // ISO
  lastPush?: string  // ISO
}

export interface PresenceFile {
  version: number
  entries: Record<string, PresenceEntry>
}
