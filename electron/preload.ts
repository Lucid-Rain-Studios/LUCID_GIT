import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS } from './ipc/channels'

const api = {
  // ── OS dialogs + shell ────────────────────────────────────────────────────
  openDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(CHANNELS.DIALOG_OPEN_DIRECTORY),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.SHELL_OPEN_EXTERNAL, url),
  showInFolder: (fullPath: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.SHELL_SHOW_IN_FOLDER, fullPath),
  openPath: (fullPath: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.SHELL_OPEN_PATH, fullPath),

  // ── Auth ──────────────────────────────────────────────────────────────────
  startDeviceFlow: () =>
    ipcRenderer.invoke(CHANNELS.AUTH_START_DEVICE_FLOW),
  pollDeviceFlow: (deviceCode: string) =>
    ipcRenderer.invoke(CHANNELS.AUTH_POLL_DEVICE_FLOW, deviceCode),
  listAccounts: () =>
    ipcRenderer.invoke(CHANNELS.AUTH_LIST_ACCOUNTS),
  logout: (userId: string) =>
    ipcRenderer.invoke(CHANNELS.AUTH_LOGOUT, userId),
  setCurrentAccount: (userId: string) =>
    ipcRenderer.invoke(CHANNELS.AUTH_SET_CURRENT_ACCOUNT, userId),

  // ── Permissions — Phase 20 ────────────────────────────────────────────────
  fetchRepoPermission: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.AUTH_FETCH_REPO_PERMISSION, repoPath),
  getRepoPermission: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.AUTH_GET_REPO_PERMISSION, repoPath),

  // ── Git core ──────────────────────────────────────────────────────────────
  isRepo: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_IS_REPO, repoPath),
  clone: (args: { url: string; dir: string; depth?: number }) =>
    ipcRenderer.invoke(CHANNELS.GIT_CLONE, args),
  status: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_STATUS, repoPath),
  currentBranch: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_CURRENT_BRANCH, repoPath),
  stage: (repoPath: string, paths: string[]) =>
    ipcRenderer.invoke(CHANNELS.GIT_STAGE, repoPath, paths),
  unstage: (repoPath: string, paths: string[]) =>
    ipcRenderer.invoke(CHANNELS.GIT_UNSTAGE, repoPath, paths),
  commit: (repoPath: string, message: string, noVerify?: boolean) =>
    ipcRenderer.invoke(CHANNELS.GIT_COMMIT, repoPath, message, noVerify),
  push: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_PUSH, repoPath),
  pull: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_PULL, repoPath),
  fetch: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_FETCH, repoPath),
  log: (repoPath: string, args?: { limit?: number; all?: boolean; filePath?: string; refs?: string[] }) =>
    ipcRenderer.invoke(CHANNELS.GIT_LOG, repoPath, args),
  branchList: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_BRANCH_LIST, repoPath),
  createBranch: (repoPath: string, name: string, from?: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_BRANCH_CREATE, repoPath, name, from),
  renameBranch: (repoPath: string, oldName: string, newName: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_BRANCH_RENAME, repoPath, oldName, newName),
  deleteBranch: (repoPath: string, name: string, force: boolean) =>
    ipcRenderer.invoke(CHANNELS.GIT_BRANCH_DELETE, repoPath, name, force),
  deleteRemoteBranch: (repoPath: string, remoteName: string, branch: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_BRANCH_DELETE_REMOTE, repoPath, remoteName, branch),
  getRemoteUrl: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_REMOTE_URL, repoPath),
  getSyncStatus: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_SYNC_STATUS, repoPath),
  updateFromMain: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_UPDATE_FROM_MAIN, repoPath),
  diff: (repoPath: string, filePath: string, staged: boolean) =>
    ipcRenderer.invoke(CHANNELS.GIT_DIFF, repoPath, filePath, staged),
  discard: (repoPath: string, paths: string[], isUntracked: boolean) =>
    ipcRenderer.invoke(CHANNELS.GIT_DISCARD, repoPath, paths, isUntracked),
  discardAll: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_DISCARD_ALL, repoPath),
  addToGitignore: (repoPath: string, pattern: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_ADD_GITIGNORE, repoPath, pattern),
  stashList: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_STASH_LIST, repoPath),
  stashSave: (repoPath: string, message?: string, paths?: string[]) =>
    ipcRenderer.invoke(CHANNELS.GIT_STASH_SAVE, repoPath, message, paths),
  stashPop: (repoPath: string, ref: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_STASH_POP, repoPath, ref),
  stashApply: (repoPath: string, ref: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_STASH_APPLY, repoPath, ref),
  stashDrop: (repoPath: string, ref: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_STASH_DROP, repoPath, ref),
  commitFiles: (repoPath: string, hash: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_COMMIT_FILES, repoPath, hash),
  checkout: (repoPath: string, branch: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_CHECKOUT, repoPath, branch),
  branchDiff: (repoPath: string, base: string, compare: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_BRANCH_DIFF, repoPath, base, compare),
  mergePreview: (repoPath: string, targetBranch: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_MERGE_PREVIEW, repoPath, targetBranch),
  potentialMergeConflicts: (repoPath: string, mode: 'lightweight' | 'deep') =>
    ipcRenderer.invoke(CHANNELS.GIT_POTENTIAL_MERGE_CONFLICTS, repoPath, mode),
  merge: (repoPath: string, targetBranch: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_MERGE, repoPath, targetBranch),
  mergeGetConflictText: (repoPath: string, filePath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_MERGE_GET_CONFLICT_TEXT, repoPath, filePath),
  mergeResolveText: (repoPath: string, filePath: string, choice: 'ours' | 'theirs') =>
    ipcRenderer.invoke(CHANNELS.GIT_MERGE_RESOLVE_TEXT, repoPath, filePath, choice),
  mergeContinue: (repoPath: string, targetBranch: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_MERGE_CONTINUE, repoPath, targetBranch),
  mergeAbort: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_MERGE_ABORT, repoPath),
  mergeInProgress: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_MERGE_IN_PROGRESS, repoPath),

  // ── Locks ─────────────────────────────────────────────────────────────────
  listLocks: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.LOCK_LIST, repoPath),
  lockFile: (repoPath: string, filePath: string) =>
    ipcRenderer.invoke(CHANNELS.LOCK_FILE, repoPath, filePath),
  unlockFile: (repoPath: string, filePath: string, force?: boolean, lockId?: string) =>
    ipcRenderer.invoke(CHANNELS.LOCK_UNLOCK, repoPath, filePath, force, lockId),
  watchLock: (repoPath: string, filePath: string) =>
    ipcRenderer.invoke(CHANNELS.LOCK_WATCH, repoPath, filePath),
  startLockPolling: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.LOCK_START_POLLING, repoPath),
  stopLockPolling: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.LOCK_STOP_POLLING, repoPath),

  // ── LFS ───────────────────────────────────────────────────────────────────
  lfsStatus: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.LFS_STATUS, repoPath),
  lfsTrack: (repoPath: string, patterns: string[]) =>
    ipcRenderer.invoke(CHANNELS.LFS_TRACK, repoPath, patterns),
  lfsUntrack: (repoPath: string, pattern: string) =>
    ipcRenderer.invoke(CHANNELS.LFS_UNTRACK, repoPath, pattern),
  lfsMigrate: (repoPath: string, patterns: string[]) =>
    ipcRenderer.invoke(CHANNELS.LFS_MIGRATE, repoPath, patterns),
  lfsAutodetect: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.LFS_AUTODETECT, repoPath),
  lfsLocksCheck: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.LFS_LOCKS_CHECK, repoPath),
  lfsLocksRepair: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.LFS_LOCKS_REPAIR, repoPath),

  // ── Cleanup ───────────────────────────────────────────────────────────────
  cleanupSize: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_SIZE, repoPath),
  cleanupGc: (repoPath: string, aggressive?: boolean) =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_GC, repoPath, aggressive),
  cleanupPruneLfs: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_PRUNE_LFS, repoPath),
  cleanupShallow: (repoPath: string, depth: number) =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_SHALLOW, repoPath, depth),
  cleanupUnshallow: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.CLEANUP_UNSHALLOW, repoPath),

  // ── Notifications + webhooks ──────────────────────────────────────────────
  notificationList: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.NOTIFICATION_LIST, repoPath),
  notificationMarkRead: (id: number) =>
    ipcRenderer.invoke(CHANNELS.NOTIFICATION_MARK_READ, id),
  webhookTest: (url: string) =>
    ipcRenderer.invoke(CHANNELS.WEBHOOK_TEST, url),
  webhookLoad: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.WEBHOOK_LOAD, repoPath),
  webhookSave: (repoPath: string, config: unknown) =>
    ipcRenderer.invoke(CHANNELS.WEBHOOK_SAVE, repoPath, config),

  // ── Auto-updater ──────────────────────────────────────────────────────────
  updateCheck: () =>
    ipcRenderer.invoke(CHANNELS.UPDATE_CHECK),
  updateDownload: () =>
    ipcRenderer.invoke(CHANNELS.UPDATE_DOWNLOAD),
  updateInstall: () =>
    ipcRenderer.invoke(CHANNELS.UPDATE_INSTALL),

  // ── Auto-fix helpers ──────────────────────────────────────────────────────
  rebaseAbort: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_REBASE_ABORT, repoPath),
  setUpstream: (repoPath: string, branch: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_SET_UPSTREAM, repoPath, branch),
  setGitConfig: (repoPath: string, key: string, value: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_SET_CONFIG, repoPath, key, value),
  getGitConfig: (repoPath: string, key: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_GET_CONFIG, repoPath, key),

  // ── Hooks ─────────────────────────────────────────────────────────────────
  hookList: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.HOOK_LIST, repoPath),
  hookEnable: (repoPath: string, name: string) =>
    ipcRenderer.invoke(CHANNELS.HOOK_ENABLE, repoPath, name),
  hookDisable: (repoPath: string, name: string) =>
    ipcRenderer.invoke(CHANNELS.HOOK_DISABLE, repoPath, name),
  hookBuiltins: () =>
    ipcRenderer.invoke(CHANNELS.HOOK_BUILTINS),
  hookInstallBuiltin: (repoPath: string, id: string) =>
    ipcRenderer.invoke(CHANNELS.HOOK_INSTALL_BUILTIN, repoPath, id),
  hookRunPreCommit: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.HOOK_RUN_PRECOMMIT, repoPath),

  // ── Unreal ────────────────────────────────────────────────────────────────
  ueDetect: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.UE_DETECT, repoPath),
  ueSetupStatus: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.UE_SETUP_STATUS, repoPath),
  ueTemplates: () =>
    ipcRenderer.invoke(CHANNELS.UE_TEMPLATES),
  ueWriteGitattributes: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.UE_WRITE_GITATTRIBUTES, repoPath),
  ueWriteGitignore: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.UE_WRITE_GITIGNORE, repoPath),
  uePakSize: (repoPath: string, stagedPaths: string[]) =>
    ipcRenderer.invoke(CHANNELS.UE_PAK_SIZE, repoPath, stagedPaths),
  uePluginStatus: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.UE_PLUGIN_STATUS, repoPath),
  ueConfigStatus: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.UE_CONFIG_STATUS, repoPath),
  ueWriteEditorConfig: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.UE_WRITE_EDITOR_CONFIG, repoPath),
  ueWriteEngineConfig: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.UE_WRITE_ENGINE_CONFIG, repoPath),
  gitGetIdentity: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_GET_IDENTITY, repoPath),
  gitLinkIdentity: (repoPath: string, login: string, name: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_LINK_IDENTITY, repoPath, login, name),
  getGlobalGitIdentity: () =>
    ipcRenderer.invoke(CHANNELS.GIT_GET_GLOBAL_IDENTITY),
  setGlobalGitIdentity: (name: string, email: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_SET_GLOBAL_IDENTITY, name, email),

  // ── App Settings ──────────────────────────────────────────────────────────
  settingsGet: () =>
    ipcRenderer.invoke(CHANNELS.SETTINGS_GET),
  settingsSave: (settings: unknown) =>
    ipcRenderer.invoke(CHANNELS.SETTINGS_SAVE, settings),

  // ── Team Config ───────────────────────────────────────────────────────────
  teamConfigLoad: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.TEAM_CONFIG_LOAD, repoPath),
  teamConfigSave: (repoPath: string, config: unknown) =>
    ipcRenderer.invoke(CHANNELS.TEAM_CONFIG_SAVE, repoPath, config),

  // ── Shell ─────────────────────────────────────────────────────────────────
  openTerminal: (cwd?: string) =>
    ipcRenderer.invoke(CHANNELS.SHELL_OPEN_TERMINAL, cwd),
  openFile: (defaultPath?: string) =>
    ipcRenderer.invoke(CHANNELS.DIALOG_OPEN_FILE, defaultPath),

  // ── Git Tools ─────────────────────────────────────────────────────────────
  gitRestoreFile: (repoPath: string, filePath: string, fromHash: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_RESTORE_FILE, repoPath, filePath, fromHash),
  gitRevert: (repoPath: string, hash: string, noCommit: boolean) =>
    ipcRenderer.invoke(CHANNELS.GIT_REVERT, repoPath, hash, noCommit),
  gitCherryPick: (repoPath: string, hash: string, noCommit?: boolean) =>
    ipcRenderer.invoke(CHANNELS.GIT_CHERRY_PICK, repoPath, hash, noCommit),
  gitResetTo: (repoPath: string, hash: string, mode: 'soft' | 'mixed' | 'hard') =>
    ipcRenderer.invoke(CHANNELS.GIT_RESET_TO, repoPath, hash, mode),
  gitLsFiles: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_LS_FILES, repoPath),
  gitFileLog: (repoPath: string, filePath: string, limit?: number) =>
    ipcRenderer.invoke(CHANNELS.GIT_FILE_LOG, repoPath, filePath, limit),
  gitBranchActivity: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_BRANCH_ACTIVITY, repoPath),
  gitDefaultBranch: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_DEFAULT_BRANCH, repoPath),
  gitBlame: (repoPath: string, filePath: string, rev: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_BLAME, repoPath, filePath, rev),
  gitCommitFileDiff: (repoPath: string, filePath: string, hash: string) =>
    ipcRenderer.invoke(CHANNELS.GIT_DIFF_COMMIT, repoPath, filePath, hash),

  // ── Asset diff previews — Phase 17 ───────────────────────────────────────
  assetDiffPreview: (repoPath: string, filePath: string, leftRef: string, rightRef: string, editorBinaryOverride?: string) =>
    ipcRenderer.invoke(CHANNELS.ASSET_DIFF_PREVIEW, repoPath, filePath, leftRef, rightRef, editorBinaryOverride),
  assetRenderThumbnail: (repoPath: string, filePath: string, ref: string) =>
    ipcRenderer.invoke(CHANNELS.ASSET_RENDER_THUMBNAIL, repoPath, filePath, ref),
  assetExtractMetadata: (repoPath: string, filePath: string, ref: string) =>
    ipcRenderer.invoke(CHANNELS.ASSET_EXTRACT_METADATA, repoPath, filePath, ref),

  // ── File-system watcher ───────────────────────────────────────────────────
  watchStatusChanges: (repoPath: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.GIT_WATCH_STATUS, repoPath),
  unwatchStatusChanges: (repoPath: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.GIT_UNWATCH_STATUS, repoPath),

  // ── Presence ──────────────────────────────────────────────────────────────
  presenceRead: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.PRESENCE_READ, repoPath),
  presenceUpdate: (repoPath: string, login: string, entry: unknown) =>
    ipcRenderer.invoke(CHANNELS.PRESENCE_UPDATE, repoPath, login, entry),

  // ── Lock Heatmap & Conflict Forecasting — Phase 19 ───────────────────────
  heatmapCompute: (repoPath: string, timeWindowDays: number, groupBy: 'folder' | 'type') =>
    ipcRenderer.invoke(CHANNELS.HEATMAP_COMPUTE, repoPath, timeWindowDays, groupBy),
  heatmapTimeline: (repoPath: string, filePath: string, timeWindowDays: number) =>
    ipcRenderer.invoke(CHANNELS.HEATMAP_TIMELINE, repoPath, filePath, timeWindowDays),
  heatmapTop: (repoPath: string, timeWindowDays: number, limit?: number) =>
    ipcRenderer.invoke(CHANNELS.HEATMAP_TOP, repoPath, timeWindowDays, limit),
  forecastStart: (repoPath: string, intervalMinutes?: number) =>
    ipcRenderer.invoke(CHANNELS.FORECAST_START, repoPath, intervalMinutes),
  forecastStop: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.FORECAST_STOP, repoPath),
  forecastStatus: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.FORECAST_STATUS, repoPath),
  onForecastConflict: (cb: (conflicts: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, c: unknown) => cb(c)
    ipcRenderer.on(CHANNELS.EVT_FORECAST_CONFLICT, handler)
    return () => ipcRenderer.removeListener(CHANNELS.EVT_FORECAST_CONFLICT, handler)
  },

  // ── Dependency-Aware Blame — Phase 18 ────────────────────────────────────
  depBuildGraph: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.DEP_BUILD_GRAPH, repoPath),
  depGraphStatus: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.DEP_GRAPH_STATUS, repoPath),
  depBlameAsset: (repoPath: string, filePath: string) =>
    ipcRenderer.invoke(CHANNELS.DEP_BLAME_ASSET, repoPath, filePath),
  depLookupReferences: (repoPath: string, packageName: string) =>
    ipcRenderer.invoke(CHANNELS.DEP_LOOKUP_REFERENCES, repoPath, packageName),
  depRefreshCache: (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.DEP_REFRESH_CACHE, repoPath),

  // ── GitHub API ────────────────────────────────────────────────────────────
  githubCreatePR: (args: { owner: string; repo: string; head: string; base: string; title: string; body: string; draft: boolean }) =>
    ipcRenderer.invoke(CHANNELS.GITHUB_CREATE_PR, args),
  githubListPRs: (args: { owner: string; repo: string }) =>
    ipcRenderer.invoke(CHANNELS.GITHUB_LIST_PRS, args),
  githubPrFiles: (args: { owner: string; repo: string; prNumber: number }) =>
    ipcRenderer.invoke(CHANNELS.GITHUB_PR_FILES, args),
  githubMergePR: (args: { owner: string; repo: string; prNumber: number; repoPath: string }) =>
    ipcRenderer.invoke(CHANNELS.GITHUB_MERGE_PR, args),
  mergeResolve: (repoPath: string, targetBranch: string, baseBranch: string, fileChoices: Record<string, 'ours' | 'theirs'>) =>
    ipcRenderer.invoke(CHANNELS.GIT_MERGE_RESOLVE, repoPath, targetBranch, baseBranch, fileChoices),
  githubClosePR: (args: { owner: string; repo: string; prNumber: number }) =>
    ipcRenderer.invoke(CHANNELS.GITHUB_CLOSE_PR, args),

  // ── PR Monitor ────────────────────────────────────────────────────────────
  prMonitorStart:  (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.PR_MONITOR_START, repoPath),
  prMonitorStop:   (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.PR_MONITOR_STOP, repoPath),
  prMonitorRecord: (repoPath: string, prNumber: number, owner: string, repo: string, lockedFiles: string[], title: string) =>
    ipcRenderer.invoke(CHANNELS.PR_MONITOR_RECORD, repoPath, prNumber, owner, repo, lockedFiles, title),
  prMonitorCheck:  (repoPath: string) =>
    ipcRenderer.invoke(CHANNELS.PR_MONITOR_CHECK, repoPath),

  // ── Bug logs ──────────────────────────────────────────────────────────────
  logGetText: () =>
    ipcRenderer.invoke(CHANNELS.LOG_GET_TEXT),
  logGetSuggestion: () =>
    ipcRenderer.invoke(CHANNELS.LOG_GET_SUGGESTION),
  logSaveDialog: () =>
    ipcRenderer.invoke(CHANNELS.LOG_SAVE_DIALOG),
  logRendererEvent: (source: string, message: string, detail?: unknown) =>
    ipcRenderer.invoke(CHANNELS.LOG_RENDERER_EVENT, source, message, detail),

  // ── Window controls (frameless) ───────────────────────────────────────────
  windowMinimize: (): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.WIN_MINIMIZE),
  windowMaximizeToggle: (): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.WIN_MAXIMIZE_TOGGLE),
  windowClose: (): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.WIN_CLOSE),
  windowIsMaximized: (): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.WIN_IS_MAXIMIZED),

  // ── Events: main → renderer ───────────────────────────────────────────────
  onOperationProgress: (cb: (step: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, step: unknown) => cb(step)
    ipcRenderer.on(CHANNELS.EVT_OPERATION_PROGRESS, handler)
    return () => ipcRenderer.removeListener(CHANNELS.EVT_OPERATION_PROGRESS, handler)
  },
  onLockChanged: (cb: (locks: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, locks: unknown) => cb(locks)
    ipcRenderer.on(CHANNELS.EVT_LOCK_CHANGED, handler)
    return () => ipcRenderer.removeListener(CHANNELS.EVT_LOCK_CHANGED, handler)
  },
  onNotification: (cb: (notification: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, n: unknown) => cb(n)
    ipcRenderer.on(CHANNELS.EVT_NOTIFICATION, handler)
    return () => ipcRenderer.removeListener(CHANNELS.EVT_NOTIFICATION, handler)
  },
  onUpdateAvailable: (cb: (info: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, info: unknown) => cb(info)
    ipcRenderer.on(CHANNELS.EVT_UPDATE_AVAILABLE, handler)
    return () => ipcRenderer.removeListener(CHANNELS.EVT_UPDATE_AVAILABLE, handler)
  },
  onUpdateReady: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on(CHANNELS.EVT_UPDATE_READY, handler)
    return () => ipcRenderer.removeListener(CHANNELS.EVT_UPDATE_READY, handler)
  },
  onStatusChanged: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on(CHANNELS.EVT_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(CHANNELS.EVT_STATUS_CHANGED, handler)
  },
}

contextBridge.exposeInMainWorld('lucidGit', api)
