// Typed wrappers around window.lucidGit.*
// This file is the single source of truth for the renderer-side IPC contract.

// ── Domain types ─────────────────────────────────────────────────────────────

export interface DeviceFlowStart {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export interface Account {
  userId: string
  login: string
  name: string
  avatarUrl: string
}

export interface FileStatus {
  path: string
  indexStatus: string
  workingStatus: string
  staged: boolean
}

export interface CommitEntry {
  hash: string
  parentHashes: string[]
  author: string
  email: string
  timestamp: number
  message: string
}

export interface CommitFileChange {
  status:   string   // 'M' | 'A' | 'D' | 'R' | 'C' | 'T'
  path:     string
  oldPath?: string   // only for renames/copies
}

export interface BranchInfo {
  name: string          // full short name: "main" or "origin/main"
  displayName: string   // name without remote prefix: always "main"
  current: boolean
  upstream?: string
  ahead: number
  behind: number
  isRemote: boolean
  remoteName?: string
  hasLocal?: boolean    // remote branches: true if a local tracking branch exists
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

export interface SyncStatus {
  ahead: number
  behind: number
  remoteName: string
  remoteBranch: string
  hasUpstream: boolean
}

export interface Lock {
  id: string
  path: string
  owner: { name: string; login: string }
  lockedAt: string   // ISO date string
  isGhost?: boolean  // true when the file no longer exists on disk
}

export interface LFSStatus {
  tracked: string[]
  untracked: string[]
  objects: number
  totalBytes: number
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

export interface AppNotification {
  id: number
  type: string
  title: string
  body: string
  repoPath: string
  createdAt: string  // ISO date string
  read: boolean
  meta?: Record<string, unknown>  // structured payload for pr-merged / pr-closed
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

export interface UEProject {
  name: string
  uprojectPath: string
  engineVersion: string
}

export interface HookInfo {
  name: string
  enabled: boolean
  isBuiltin: boolean
  scriptPreview: string
}

export interface HookRunResult {
  exists: boolean
  exitCode: number
  output: string
  durationMs: number
}

export interface BuiltinDef {
  id: string
  hookName: string
  description: string
  script: string
}

export interface UESetupStatus {
  hasGitattributes: boolean
  hasUeGitattributes: boolean
  hasGitignore: boolean
  hasUeGitignore: boolean
}

export interface UEPluginStatus {
  installed: boolean
  location: 'project' | 'engine' | null
  pluginFolder: string | null
}

export interface UEConfigStatus {
  editorConfigExists: boolean
  editorConfigHasSccSettings: boolean
  editorConfigHasCheckoutSettings: boolean
  engineConfigExists: boolean
  engineConfigHasSkipCheck: boolean
}

export interface GitIdentity {
  name: string
  email: string
}

export interface OperationStep {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
  progress?: number
  detail?: string
  duration?: number
}

export interface StashEntry {
  index:   number
  ref:     string
  message: string
  branch:  string
  date:    string
}

export interface DiffContent {
  oldContent: string
  newContent: string
  isBinary: boolean
  language: string
}

export interface BlameEntry {
  hash:      string
  author:    string
  timestamp: number   // Unix ms
  summary:   string
  lineNo:    number
  line:      string
}

// ── Asset diff (Phase 17) ─────────────────────────────────────────────────────

export type AssetType = 'texture' | 'audio' | 'video' | 'level' | 'generic-ue' | 'binary'

export interface AssetPreviewData {
  previewPath: string | null   // absolute path to cached PNG preview
  sizeBytes: number
  width?: number
  height?: number
  format?: string
}

export type AssetDelta =
  | { kind: 'texture'
      sizeDelta: number
      widthBefore: number; heightBefore: number
      widthAfter: number;  heightAfter: number
      formatBefore: string; formatAfter: string }
  | { kind: 'metadata'
      before: Record<string, string>
      after:  Record<string, string> }
  | { kind: 'unavailable'; reason: string }

export interface AssetDiffResult {
  assetType: AssetType
  left:  AssetPreviewData
  right: AssetPreviewData
  delta: AssetDelta
  cacheKey: string
  ueAvailable: boolean
  fallbackReason: string | null
}

export interface UpdateInfo {
  version: string
  releaseDate: string
  releaseNotes?: string
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

export interface PresenceEntry {
  login: string
  name: string
  branch: string
  modifiedCount: number
  modifiedFiles: string[]
  lastSeen: string
  lastPush?: string
}

export interface PresenceFile {
  version: number
  entries: Record<string, PresenceEntry>
}

// ── Lock Heatmap & Conflict Forecasting (Phase 19) ───────────────────────────

export interface HeatmapNode {
  name: string
  path: string
  score: number
  value: number
  lockCount: number
  conflictCount: number
  uniqueContributors: number
  meanDurationMs: number
  children?: HeatmapNode[]
}

export interface HeatmapTimelineEntry {
  id: number
  timestamp: number
  eventType: string
  actor: string
  durationMs: number
  source: 'lock' | 'conflict'
}

export interface ForecastConflict {
  filePath: string
  remoteBranch: string
  remoteLastCommit: string
  remoteLastAuthor: string
  remoteLastMessage: string
  severity: 'high' | 'medium' | 'low'
}

export interface ForecastStatus {
  repoPath: string
  enabled: boolean
  lastPolledAt: number | null
  intervalMinutes: number
  conflicts: ForecastConflict[]
}

// ── Dependency-Aware Blame (Phase 18) ─────────────────────────────────────────

export interface DepNodeInfo {
  packageName: string
  filePath: string
  assetClass: string
  hardRefs: string[]
  softRefs: string[]
}

export interface DepCommit {
  hash: string
  author: string
  email: string
  timestamp: number
  message: string
  churnCount: number
}

export interface DepBlameEntry {
  filePath: string
  packageName: string
  assetClass: string
  hopDistance: number
  recentCommits: DepCommit[]
}

export interface SuspectEntry {
  hash: string
  author: string
  email: string
  timestamp: number
  message: string
  score: number
  reasons: string[]
  filePath: string
}

export interface DepBlameResult {
  target: DepBlameEntry
  dependencies: DepBlameEntry[]
  suspects: SuspectEntry[]
}

export interface DepGraphStatus {
  cacheKey: string
  nodeCount: number
  edgeCount: number
  builtAt: number
}

export interface DepRefResult {
  packageName: string
  referencedBy: DepNodeInfo[]
}

// ── Branch diff ───────────────────────────────────────────────────────────────

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

// ── GitHub Pull Requests ──────────────────────────────────────────────────────

export interface PullRequest {
  number: number
  title: string
  htmlUrl: string
  author: string
  headBranch: string
  baseBranch: string
  draft: boolean
  createdAt: string
  updatedAt: string
}

// ── Permissions (Phase 20) ────────────────────────────────────────────────────

export type RepoPermission = 'admin' | 'write' | 'read'

// ── API surface type ──────────────────────────────────────────────────────────

export interface LucidGitAPI {
  // OS dialogs + shell
  openDirectory:  () => Promise<string | null>
  openFile:       (defaultPath?: string) => Promise<string | null>
  openExternal:   (url: string) => Promise<void>
  showInFolder:   (fullPath: string) => Promise<void>
  openPath:       (fullPath: string) => Promise<void>
  openTerminal:   (cwd?: string) => Promise<void>

  // Auth
  startDeviceFlow: () => Promise<DeviceFlowStart>
  pollDeviceFlow: (deviceCode: string) => Promise<{ token: string; userId: string } | null>
  listAccounts: () => Promise<{ accounts: Account[]; currentAccountId: string | null }>
  logout: (userId: string) => Promise<void>
  setCurrentAccount: (userId: string) => Promise<void>

  // Permissions — Phase 20
  fetchRepoPermission: (repoPath: string) => Promise<RepoPermission>
  getRepoPermission: (repoPath: string) => Promise<RepoPermission | null>

  // Git core
  isRepo: (repoPath: string) => Promise<boolean>
  clone: (args: { url: string; dir: string; depth?: number }) => Promise<void>
  status: (repoPath: string) => Promise<FileStatus[]>
  currentBranch: (repoPath: string) => Promise<string>
  stage: (repoPath: string, paths: string[]) => Promise<void>
  unstage: (repoPath: string, paths: string[]) => Promise<void>
  commit: (repoPath: string, message: string, noVerify?: boolean) => Promise<void>
  push: (repoPath: string) => Promise<void>
  pull: (repoPath: string) => Promise<void>
  fetch: (repoPath: string) => Promise<void>
  log: (repoPath: string, args?: { limit?: number; all?: boolean; filePath?: string; refs?: string[] }) => Promise<CommitEntry[]>
  commitFiles: (repoPath: string, hash: string) => Promise<CommitFileChange[]>
  branchList:    (repoPath: string) => Promise<BranchInfo[]>
  createBranch:  (repoPath: string, name: string, from?: string) => Promise<void>
  renameBranch:  (repoPath: string, oldName: string, newName: string) => Promise<void>
  deleteBranch:        (repoPath: string, name: string, force: boolean) => Promise<void>
  deleteRemoteBranch:  (repoPath: string, remoteName: string, branch: string) => Promise<void>
  getRemoteUrl:  (repoPath: string) => Promise<string | null>
  getSyncStatus: (repoPath: string) => Promise<SyncStatus>
  updateFromMain:(repoPath: string) => Promise<void>
  diff:           (repoPath: string, filePath: string, staged: boolean) => Promise<DiffContent>
  discard:        (repoPath: string, paths: string[], isUntracked: boolean) => Promise<void>
  discardAll:     (repoPath: string) => Promise<void>
  addToGitignore: (repoPath: string, pattern: string) => Promise<void>
  stashList:      (repoPath: string) => Promise<StashEntry[]>
  stashSave:      (repoPath: string, message?: string, paths?: string[]) => Promise<void>
  stashPop:       (repoPath: string, ref: string) => Promise<void>
  stashApply:     (repoPath: string, ref: string) => Promise<void>
  stashDrop:      (repoPath: string, ref: string) => Promise<void>
  checkout: (repoPath: string, branch: string) => Promise<void>
  branchDiff: (repoPath: string, base: string, compare: string) => Promise<BranchDiffSummary>
  mergePreview: (repoPath: string, targetBranch: string) => Promise<ConflictPreviewFile[]>
  merge: (repoPath: string, targetBranch: string) => Promise<void>

  // Locks
  listLocks: (repoPath: string) => Promise<Lock[]>
  lockFile: (repoPath: string, filePath: string) => Promise<Lock>
  unlockFile: (repoPath: string, filePath: string, force?: boolean, lockId?: string) => Promise<void>
  watchLock: (repoPath: string, filePath: string) => Promise<void>
  startLockPolling: (repoPath: string) => Promise<void>
  stopLockPolling: (repoPath: string) => Promise<void>

  // LFS
  lfsStatus:    (repoPath: string) => Promise<LFSStatus>
  lfsTrack:     (repoPath: string, patterns: string[]) => Promise<void>
  lfsUntrack:   (repoPath: string, pattern: string) => Promise<void>
  lfsMigrate:   (repoPath: string, patterns: string[]) => Promise<void>
  lfsAutodetect:(repoPath: string) => Promise<string[]>

  // Cleanup
  cleanupSize: (repoPath: string) => Promise<SizeBreakdown>
  cleanupGc: (repoPath: string, aggressive?: boolean) => Promise<CleanupResult>
  cleanupPruneLfs: (repoPath: string) => Promise<void>
  cleanupShallow: (repoPath: string, depth: number) => Promise<void>
  cleanupUnshallow: (repoPath: string) => Promise<void>

  // Notifications + webhooks
  notificationList: (repoPath: string) => Promise<AppNotification[]>
  notificationMarkRead: (id: number) => Promise<void>
  webhookTest: (url: string) => Promise<boolean>
  webhookLoad: (repoPath: string) => Promise<WebhookConfig | null>
  webhookSave: (repoPath: string, config: WebhookConfig) => Promise<void>

  // Auto-updater
  updateCheck: () => Promise<void>
  updateDownload: () => Promise<void>
  updateInstall: () => Promise<void>
  onUpdateReady: (cb: () => void) => () => void

  // Auto-fix helpers
  rebaseAbort: (repoPath: string) => Promise<void>
  setUpstream: (repoPath: string, branch: string) => Promise<void>
  setGitConfig: (repoPath: string, key: string, value: string) => Promise<void>
  getGitConfig: (repoPath: string, key: string) => Promise<string | null>

  // Hooks
  hookList: (repoPath: string) => Promise<HookInfo[]>
  hookEnable: (repoPath: string, name: string) => Promise<void>
  hookDisable: (repoPath: string, name: string) => Promise<void>
  hookBuiltins: () => Promise<BuiltinDef[]>
  hookInstallBuiltin: (repoPath: string, id: string) => Promise<void>
  hookRunPreCommit: (repoPath: string) => Promise<HookRunResult>

  // Unreal
  ueDetect: (repoPath: string) => Promise<UEProject | null>
  ueSetupStatus: (repoPath: string) => Promise<UESetupStatus>
  ueTemplates: () => Promise<{ gitattributes: string; gitignore: string }>
  ueWriteGitattributes: (repoPath: string) => Promise<void>
  ueWriteGitignore: (repoPath: string) => Promise<void>
  uePakSize: (repoPath: string, stagedPaths: string[]) => Promise<number>
  uePluginStatus: (repoPath: string) => Promise<UEPluginStatus>
  ueConfigStatus: (repoPath: string) => Promise<UEConfigStatus>
  ueWriteEditorConfig: (repoPath: string) => Promise<void>
  ueWriteEngineConfig: (repoPath: string) => Promise<void>

  // Git identity + locking config
  gitGetIdentity: (repoPath: string) => Promise<GitIdentity>
  gitLinkIdentity: (repoPath: string, login: string, name: string) => Promise<void>
  getGlobalGitIdentity: () => Promise<GitIdentity>
  setGlobalGitIdentity: (name: string, email: string) => Promise<void>

  // App Settings
  settingsGet: () => Promise<AppSettings>
  settingsSave: (settings: AppSettings) => Promise<void>

  // Team Config
  teamConfigLoad: (repoPath: string) => Promise<TeamConfig | null>
  teamConfigSave: (repoPath: string, config: TeamConfig) => Promise<void>

  // Git Tools
  gitRestoreFile: (repoPath: string, filePath: string, fromHash: string) => Promise<void>
  gitRevert: (repoPath: string, hash: string, noCommit: boolean) => Promise<void>
  gitCherryPick: (repoPath: string, hash: string, noCommit?: boolean) => Promise<void>
  gitResetTo: (repoPath: string, hash: string, mode: 'soft' | 'mixed' | 'hard') => Promise<void>
  gitLsFiles: (repoPath: string) => Promise<string[]>
  gitFileLog: (repoPath: string, filePath: string, limit?: number) => Promise<CommitEntry[]>
  gitBranchActivity: (repoPath: string) => Promise<BranchActivity[]>
  gitDefaultBranch: (repoPath: string) => Promise<string>
  gitBlame: (repoPath: string, filePath: string, rev: string) => Promise<BlameEntry[]>
  gitCommitFileDiff: (repoPath: string, filePath: string, hash: string) => Promise<DiffContent>

  // Asset diff previews — Phase 17
  assetDiffPreview: (repoPath: string, filePath: string, leftRef: string, rightRef: string, editorBinaryOverride?: string) => Promise<AssetDiffResult>
  assetRenderThumbnail: (repoPath: string, filePath: string, ref: string) => Promise<string | null>
  assetExtractMetadata: (repoPath: string, filePath: string, ref: string) => Promise<Record<string, string>>

  // File-system watcher
  watchStatusChanges: (repoPath: string) => Promise<void>
  unwatchStatusChanges: (repoPath: string) => Promise<void>

  // Presence
  presenceRead: (repoPath: string) => Promise<PresenceFile>
  presenceUpdate: (repoPath: string, login: string, entry: PresenceEntry) => Promise<void>

  // Lock Heatmap & Conflict Forecasting — Phase 19
  heatmapCompute: (repoPath: string, timeWindowDays: number, groupBy: 'folder' | 'type') => Promise<HeatmapNode>
  heatmapTimeline: (repoPath: string, filePath: string, timeWindowDays: number) => Promise<HeatmapTimelineEntry[]>
  heatmapTop: (repoPath: string, timeWindowDays: number, limit?: number) => Promise<HeatmapNode[]>
  forecastStart: (repoPath: string, intervalMinutes?: number) => Promise<ForecastStatus>
  forecastStop: (repoPath: string) => Promise<void>
  forecastStatus: (repoPath: string) => Promise<ForecastStatus | null>
  onForecastConflict: (cb: (conflicts: ForecastConflict[]) => void) => () => void

  // Dependency-Aware Blame — Phase 18
  depBuildGraph: (repoPath: string) => Promise<DepGraphStatus>
  depGraphStatus: (repoPath: string) => Promise<DepGraphStatus | null>
  depBlameAsset: (repoPath: string, filePath: string) => Promise<DepBlameResult>
  depLookupReferences: (repoPath: string, packageName: string) => Promise<DepRefResult>
  depRefreshCache: (repoPath: string) => Promise<void>

  // GitHub API
  githubCreatePR: (args: { owner: string; repo: string; head: string; base: string; title: string; body: string; draft: boolean }) => Promise<{ number: number; htmlUrl: string; title: string }>
  githubListPRs:  (args: { owner: string; repo: string }) => Promise<PullRequest[]>
  githubPrFiles:  (args: { owner: string; repo: string; prNumber: number }) => Promise<string[]>
  githubMergePR:  (args: { owner: string; repo: string; prNumber: number; repoPath: string }) => Promise<void>
  githubClosePR:  (args: { owner: string; repo: string; prNumber: number }) => Promise<void>

  // PR Monitor
  prMonitorStart:  (repoPath: string) => Promise<void>
  prMonitorStop:   (repoPath: string) => Promise<void>
  prMonitorRecord: (repoPath: string, prNumber: number, owner: string, repo: string, lockedFiles: string[], title: string) => Promise<void>
  prMonitorCheck:  (repoPath: string) => Promise<void>

  // Bug logs
  logGetText: () => Promise<string>
  logGetSuggestion: () => Promise<string | null>
  logSaveDialog: () => Promise<string | null>

  // Window controls (frameless)
  windowMinimize: () => Promise<void>
  windowMaximizeToggle: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>

  // Events: main → renderer — each returns an unsubscribe function
  onOperationProgress: (cb: (step: OperationStep) => void) => () => void
  onLockChanged: (cb: (locks: Lock[]) => void) => () => void
  onNotification: (cb: (notification: AppNotification) => void) => () => void
  onUpdateAvailable: (cb: (info: UpdateInfo) => void) => () => void
  onStatusChanged: (cb: () => void) => () => void
}

// ── Window augmentation ───────────────────────────────────────────────────────

declare global {
  interface Window {
    lucidGit: LucidGitAPI
  }
}

// ── Typed accessor ────────────────────────────────────────────────────────────

export const ipc: LucidGitAPI = window.lucidGit
