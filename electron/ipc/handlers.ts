import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import { permissionService } from '../services/PermissionService'
import { watcherService } from '../services/WatcherService'
import { dependencyService } from '../services/DependencyService'
import { heatmapService } from '../services/HeatmapService'
import { forecastService } from '../services/ForecastService'
import { assetDiffService } from '../services/AssetDiffService'
import { spawn } from 'child_process'
import { presenceService } from '../services/PresenceService'
import type { PresenceEntry } from '../types'
import { CHANNELS } from './channels'
import { withTimeout } from '../util/dugite-exec'
import { gitService } from '../services/GitService'
import { authService } from '../services/AuthService'
import { logService } from '../services/LogService'
import { lockService } from '../services/LockService'
import { notificationService } from '../services/NotificationService'
import { webhookService } from '../services/WebhookService'
import { unrealService } from '../services/UnrealService'
import { hookService } from '../services/HookService'
import { settingsService } from '../services/SettingsService'
import { teamConfigService } from '../services/TeamConfigService'
import { gitHubService } from '../services/GitHubService'
import type { PRCreateArgs, PRListArgs, PRActionArgs } from '../services/GitHubService'
import { prMonitorService } from '../services/PRMonitorService'
import type { WebhookConfig, AppSettings, TeamConfig } from '../types'

async function requireAdmin(repoPath: string): Promise<void> {
  const cached = permissionService.getCachedPermission(repoPath)
  if (cached === 'admin') return
  if (cached === 'write' || cached === 'read') {
    throw new Error('PERMISSION_DENIED: Admin access required for this operation')
  }
  // Cache miss — fetch and check
  const perm = await permissionService.fetchPermission(repoPath)
  if (perm !== 'admin') throw new Error('PERMISSION_DENIED: Admin access required for this operation')
}

export function registerHandlers(): void {
  const runGitOp = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`${op} failed: ${msg}`)
    }
  }

  // ── Shell ──────────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.SHELL_OPEN_EXTERNAL, async (_event, url: string) => {
    await shell.openExternal(url)
  })

  ipcMain.handle(CHANNELS.SHELL_SHOW_IN_FOLDER, async (_event, fullPath: string) => {
    shell.showItemInFolder(fullPath)
  })

  ipcMain.handle(CHANNELS.SHELL_OPEN_PATH, async (_event, fullPath: string) => {
    await shell.openPath(fullPath)
  })

  ipcMain.handle(CHANNELS.SHELL_OPEN_TERMINAL, async (_event, cwd?: string) => {
    const dir = cwd ?? process.cwd()
    if (process.platform === 'win32') {
      // Try Windows Terminal first, fall back to cmd
      spawn('wt.exe', ['-d', dir], { detached: true, stdio: 'ignore' }).on('error', () => {
        spawn('cmd.exe', ['/K', `cd /d "${dir}"`], { detached: true, stdio: 'ignore' })
      })
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', dir], { detached: true, stdio: 'ignore' })
    } else {
      const terms = ['gnome-terminal', 'xterm', 'konsole', 'xfce4-terminal']
      const [term] = terms
      spawn(term, ['--working-directory', dir], { detached: true, stdio: 'ignore' })
    }
  })

  // ── OS Dialogs ─────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.DIALOG_OPEN_DIRECTORY, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Repository Folder',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(CHANNELS.DIALOG_OPEN_FILE, async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      properties: ['openFile'],
      title: 'Select File',
      defaultPath,
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── Git — Phase 2 ──────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.GIT_IS_REPO, async (_event, repoPath: string) => {
    return gitService.isRepo(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_STATUS, async (_event, repoPath: string) => {
    return gitService.status(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_CURRENT_BRANCH, async (_event, repoPath: string) => {
    return gitService.currentBranch(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_CLONE, async (event, args: { url: string; dir: string; depth?: number }) => {
    await gitService.clone(args, (step) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
      }
    })
  })

  ipcMain.handle(CHANNELS.GIT_STAGE, async (_event, repoPath: string, paths: string[]) => {
    return gitService.stage(repoPath, paths)
  })

  ipcMain.handle(CHANNELS.GIT_UNSTAGE, async (_event, repoPath: string, paths: string[]) => {
    return gitService.unstage(repoPath, paths)
  })

  ipcMain.handle(CHANNELS.GIT_COMMIT, async (_event, repoPath: string, message: string, noVerify?: boolean) => {
    return gitService.commit(repoPath, message, noVerify)
  })

  ipcMain.handle(CHANNELS.GIT_PUSH, async (event, repoPath: string) => {
    return gitService.push(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  ipcMain.handle(CHANNELS.GIT_PULL, async (event, repoPath: string) => {
    return gitService.pull(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  ipcMain.handle(CHANNELS.GIT_FETCH, async (event, repoPath: string) => {
    const result = await gitService.fetch(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
    prMonitorService.checkNow(repoPath).catch(() => {})
    return result
  })

  ipcMain.handle(CHANNELS.GIT_LOG, async (_event, repoPath: string, args?: { limit?: number; all?: boolean }) => {
    return gitService.log(repoPath, args)
  })

  ipcMain.handle(CHANNELS.GIT_BRANCH_LIST, async (_event, repoPath: string) => {
    return gitService.branchList(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_BRANCH_CREATE, async (_event, repoPath: string, name: string, from?: string) => {
    return gitService.createBranch(repoPath, name, from)
  })

  ipcMain.handle(CHANNELS.GIT_BRANCH_RENAME, async (_event, repoPath: string, oldName: string, newName: string) => {
    return gitService.renameBranch(repoPath, oldName, newName)
  })

  ipcMain.handle(CHANNELS.GIT_BRANCH_DELETE, async (_event, repoPath: string, name: string, force: boolean) => {
    if (force) await requireAdmin(repoPath)
    return gitService.deleteBranch(repoPath, name, force)
  })

  ipcMain.handle(CHANNELS.GIT_BRANCH_DELETE_REMOTE, async (_event, repoPath: string, remoteName: string, branch: string) => {
    await requireAdmin(repoPath)
    return gitService.deleteRemoteBranch(repoPath, remoteName, branch)
  })

  ipcMain.handle(CHANNELS.GIT_REMOTE_URL, async (_event, repoPath: string) => {
    return gitService.getRemoteUrl(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_SYNC_STATUS, async (_event, repoPath: string) => {
    return gitService.getSyncStatus(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_UPDATE_FROM_MAIN, async (_event, repoPath: string) => {
    return gitService.updateFromMain(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_DIFF, async (_event, repoPath: string, filePath: string, staged: boolean) => {
    return gitService.diff(repoPath, filePath, staged)
  })

  ipcMain.handle(CHANNELS.GIT_DISCARD, async (_event, repoPath: string, paths: string[], isUntracked: boolean) => {
    return gitService.discard(repoPath, paths, isUntracked)
  })

  ipcMain.handle(CHANNELS.GIT_DISCARD_ALL, async (_event, repoPath: string) => {
    return gitService.discardAll(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_COMMIT_FILES, async (_event, repoPath: string, hash: string) => {
    return gitService.commitFiles(repoPath, hash)
  })

  ipcMain.handle(CHANNELS.GIT_ADD_GITIGNORE, async (_event, repoPath: string, pattern: string) => {
    return gitService.addToGitignore(repoPath, pattern)
  })

  ipcMain.handle(CHANNELS.GIT_STASH_LIST, async (_event, repoPath: string) => {
    return gitService.stashList(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_STASH_SAVE, async (_event, repoPath: string, message?: string, paths?: string[]) => {
    return gitService.stashSave(repoPath, message, paths)
  })

  ipcMain.handle(CHANNELS.GIT_STASH_POP, async (_event, repoPath: string, ref: string) => {
    return runGitOp('Stash pop', () => gitService.stashPop(repoPath, ref))
  })

  ipcMain.handle(CHANNELS.GIT_STASH_APPLY, async (_event, repoPath: string, ref: string) => {
    return gitService.stashApply(repoPath, ref)
  })

  ipcMain.handle(CHANNELS.GIT_STASH_DROP, async (_event, repoPath: string, ref: string) => {
    return gitService.stashDrop(repoPath, ref)
  })

  // ── Auth — Phase 3 ────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.AUTH_START_DEVICE_FLOW, async () => {
    return authService.startDeviceFlow()
  })

  ipcMain.handle(CHANNELS.AUTH_POLL_DEVICE_FLOW, async (_event, deviceCode: string) => {
    return authService.pollDeviceFlow(deviceCode)
  })

  ipcMain.handle(CHANNELS.AUTH_LIST_ACCOUNTS, async () => {
    return authService.listAccounts()
  })

  ipcMain.handle(CHANNELS.AUTH_LOGOUT, async (_event, userId: string) => {
    return authService.logout(userId)
  })

  ipcMain.handle(CHANNELS.AUTH_SET_CURRENT_ACCOUNT, async (_event, userId: string) => {
    return authService.setCurrentAccount(userId)
  })

  // ── Permissions — Phase 20 ────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.AUTH_FETCH_REPO_PERMISSION, async (_event, repoPath: string) => {
    return permissionService.fetchPermission(repoPath)
  })

  ipcMain.handle(CHANNELS.AUTH_GET_REPO_PERMISSION, async (_event, repoPath: string) => {
    return permissionService.getCachedPermission(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_CHECKOUT, async (_event, repoPath: string, branch: string) => {
    return runGitOp('Checkout', () => gitService.checkout(repoPath, branch))
  })

  ipcMain.handle(CHANNELS.GIT_MERGE_PREVIEW, async (_event, repoPath: string, targetBranch: string) => {
    const conflicts = await gitService.mergePreview(repoPath, targetBranch)
    const ourBranch = await gitService.currentBranch(repoPath)
    for (const c of conflicts) {
      heatmapService.recordConflictEvent({
        repoPath, filePath: c.path,
        ourBranch, theirBranch: targetBranch,
        conflictType: c.conflictType,
      })
    }
    return conflicts
  })

  ipcMain.handle(CHANNELS.GIT_MERGE, async (_event, repoPath: string, targetBranch: string) => {
    await runGitOp('Merge', () => gitService.merge(repoPath, targetBranch))
    const ourBranch = await gitService.currentBranch(repoPath)
    heatmapService.markConflictsResolved(repoPath, ourBranch, targetBranch)
  })

  ipcMain.handle(
    CHANNELS.GIT_MERGE_RESOLVE,
    async (
      _event,
      repoPath: string,
      targetBranch: string,
      baseBranch: string,
      fileChoices: Record<string, 'ours' | 'theirs'>
    ) => {
      await runGitOp('Resolve merge', () => gitService.resolveMergeIntoBranch(repoPath, targetBranch, baseBranch, fileChoices))
    }
  )

  // ── Locks — Phase 5 ───────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.LOCK_LIST, async (_event, repoPath: string) => {
    return lockService.listLocks(repoPath)
  })

  ipcMain.handle(CHANNELS.LOCK_FILE, async (_event, repoPath: string, filePath: string) => {
    return lockService.lockFile(repoPath, filePath)
  })

  ipcMain.handle(CHANNELS.LOCK_UNLOCK, async (_event, repoPath: string, filePath: string, force?: boolean, lockId?: string) => {
    if (force) await requireAdmin(repoPath)
    return lockService.unlockFile(repoPath, filePath, force, lockId)
  })

  ipcMain.handle(CHANNELS.LOCK_WATCH, async (_event, repoPath: string, filePath: string) => {
    return lockService.watchFile(repoPath, filePath)
  })

  ipcMain.handle(CHANNELS.LOCK_START_POLLING, async (_event, repoPath: string) => {
    lockService.startPolling(repoPath)
  })

  ipcMain.handle(CHANNELS.LOCK_STOP_POLLING, async (_event, repoPath: string) => {
    lockService.stopPolling(repoPath)
  })

  ipcMain.handle(CHANNELS.LFS_STATUS, async (_event, repoPath: string) => {
    return gitService.lfsStatus(repoPath)
  })

  ipcMain.handle(CHANNELS.LFS_TRACK, async (_event, repoPath: string, patterns: string[]) => {
    return gitService.lfsTrack(repoPath, patterns)
  })

  ipcMain.handle(CHANNELS.LFS_UNTRACK, async (_event, repoPath: string, pattern: string) => {
    return gitService.lfsUntrack(repoPath, pattern)
  })

  ipcMain.handle(CHANNELS.LFS_AUTODETECT, async (_event, repoPath: string) => {
    return gitService.lfsAutodetect(repoPath)
  })

  ipcMain.handle(CHANNELS.LFS_MIGRATE, async (event, repoPath: string, patterns: string[]) => {
    await requireAdmin(repoPath)
    return gitService.lfsMigrate(repoPath, patterns, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  ipcMain.handle(CHANNELS.CLEANUP_SIZE, async (event, repoPath: string) => {
    return withTimeout(
      gitService.cleanupSize(repoPath, (step) => {
        if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
      }),
      30_000,
      'cleanupSize'
    )
  })

  ipcMain.handle(CHANNELS.CLEANUP_GC, async (event, repoPath: string, aggressive?: boolean) => {
    await requireAdmin(repoPath)
    return gitService.cleanupGc(repoPath, aggressive, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  ipcMain.handle(CHANNELS.CLEANUP_PRUNE_LFS, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return gitService.cleanupPruneLfs(repoPath)
  })

  ipcMain.handle(CHANNELS.CLEANUP_SHALLOW, async (event, repoPath: string, depth: number) => {
    await requireAdmin(repoPath)
    return gitService.cleanupShallow(repoPath, depth, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  ipcMain.handle(CHANNELS.CLEANUP_UNSHALLOW, async (event, repoPath: string) => {
    await requireAdmin(repoPath)
    return gitService.cleanupUnshallow(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  ipcMain.handle(CHANNELS.NOTIFICATION_LIST, async (_event, repoPath: string) => {
    return notificationService.list(repoPath)
  })

  ipcMain.handle(CHANNELS.NOTIFICATION_MARK_READ, async (_event, id: number) => {
    notificationService.markRead(id)
  })

  ipcMain.handle(CHANNELS.WEBHOOK_TEST, async (_event, url: string) => {
    return webhookService.test(url)
  })
  ipcMain.handle(CHANNELS.WEBHOOK_LOAD, async (_event, repoPath: string) => {
    return webhookService.loadConfig(repoPath)
  })

  ipcMain.handle(CHANNELS.WEBHOOK_SAVE, async (_event, repoPath: string, config: WebhookConfig) => {
    await requireAdmin(repoPath)
    webhookService.saveConfig(repoPath, config)
  })

  // ── Auto-fix helpers — Phase 13 ───────────────────────────────────────────
  ipcMain.handle(CHANNELS.GIT_REBASE_ABORT, (_event, repoPath: string) =>
    gitService.rebaseAbort(repoPath)
  )

  ipcMain.handle(CHANNELS.GIT_SET_UPSTREAM, (_event, repoPath: string, branch: string) =>
    gitService.setUpstream(repoPath, branch)
  )

  ipcMain.handle(CHANNELS.GIT_SET_CONFIG, (_event, repoPath: string, key: string, value: string) =>
    gitService.setGitConfig(repoPath, key, value)
  )

  ipcMain.handle(CHANNELS.GIT_GET_CONFIG, (_event, repoPath: string, key: string) =>
    gitService.getGitConfig(repoPath, key)
  )

  ipcMain.handle(CHANNELS.GIT_GET_GLOBAL_IDENTITY, () =>
    gitService.getGlobalGitIdentity()
  )

  ipcMain.handle(CHANNELS.GIT_SET_GLOBAL_IDENTITY, (_event, name: string, email: string) =>
    gitService.setGlobalGitIdentity(name, email)
  )

  // ── Hooks — Phase 12 ──────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.HOOK_LIST, (_event, repoPath: string) =>
    hookService.listHooks(repoPath)
  )

  ipcMain.handle(CHANNELS.HOOK_ENABLE, (_event, repoPath: string, name: string) =>
    hookService.enableHook(repoPath, name)
  )

  ipcMain.handle(CHANNELS.HOOK_DISABLE, (_event, repoPath: string, name: string) =>
    hookService.disableHook(repoPath, name)
  )

  ipcMain.handle(CHANNELS.HOOK_BUILTINS, () =>
    hookService.builtins()
  )

  ipcMain.handle(CHANNELS.HOOK_INSTALL_BUILTIN, async (_event, repoPath: string, id: string) => {
    await requireAdmin(repoPath)
    return hookService.installBuiltin(repoPath, id)
  })

  ipcMain.handle(CHANNELS.HOOK_RUN_PRECOMMIT, (_event, repoPath: string) =>
    hookService.runPreCommit(repoPath)
  )

  ipcMain.handle(CHANNELS.UE_DETECT, (_event, repoPath: string) =>
    unrealService.detect(repoPath)
  )

  ipcMain.handle(CHANNELS.UE_SETUP_STATUS, (_event, repoPath: string) =>
    unrealService.setupStatus(repoPath)
  )

  ipcMain.handle(CHANNELS.UE_TEMPLATES, () =>
    unrealService.templates()
  )

  ipcMain.handle(CHANNELS.UE_WRITE_GITATTRIBUTES, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return unrealService.writeGitattributes(repoPath)
  })

  ipcMain.handle(CHANNELS.UE_WRITE_GITIGNORE, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return unrealService.writeGitignore(repoPath)
  })

  ipcMain.handle(CHANNELS.UE_PAK_SIZE, (_event, repoPath: string, stagedPaths: string[]) =>
    unrealService.pakSizeEstimate(repoPath, stagedPaths)
  )

  ipcMain.handle(CHANNELS.UE_PLUGIN_STATUS, (_event, repoPath: string) =>
    unrealService.pluginStatus(repoPath)
  )

  ipcMain.handle(CHANNELS.UE_CONFIG_STATUS, (_event, repoPath: string) =>
    unrealService.ueConfigStatus(repoPath)
  )

  ipcMain.handle(CHANNELS.UE_WRITE_EDITOR_CONFIG, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return unrealService.writeEditorConfig(repoPath)
  })

  ipcMain.handle(CHANNELS.UE_WRITE_ENGINE_CONFIG, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return unrealService.writeEngineConfig(repoPath)
  })

  ipcMain.handle(CHANNELS.GIT_GET_IDENTITY, (_event, repoPath: string) =>
    gitService.getIdentity(repoPath)
  )

  ipcMain.handle(CHANNELS.GIT_LINK_IDENTITY, (_event, repoPath: string, login: string, name: string) =>
    gitService.linkIdentity(repoPath, login, name)
  )

  // ── App Settings — Phase 15 ───────────────────────────────────────────────
  ipcMain.handle(CHANNELS.SETTINGS_GET, () =>
    settingsService.getAll()
  )

  ipcMain.handle(CHANNELS.SETTINGS_SAVE, async (_event, settings: AppSettings) => {
    settingsService.save(settings)
    const defaultBranch = (settings.defaultBranchName ?? 'main').trim() || 'main'
    await gitService.setGlobalDefaultBranch(defaultBranch)
  })

  // ── Team Config — Phase 15 ────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.TEAM_CONFIG_LOAD, (_event, repoPath: string) =>
    teamConfigService.load(repoPath)
  )

  ipcMain.handle(CHANNELS.TEAM_CONFIG_SAVE, async (_event, repoPath: string, config: TeamConfig) => {
    await requireAdmin(repoPath)
    return teamConfigService.save(repoPath, config)
  })

  // ── Git Tools ─────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.GIT_LS_FILES, (_event, repoPath: string) =>
    gitService.lsFiles(repoPath)
  )

  ipcMain.handle(CHANNELS.GIT_RESTORE_FILE, (_event, repoPath: string, filePath: string, fromHash: string) =>
    gitService.restoreFile(repoPath, filePath, fromHash)
  )

  ipcMain.handle(CHANNELS.GIT_REVERT, (_event, repoPath: string, hash: string, noCommit: boolean) =>
    runGitOp('Revert', () => gitService.revert(repoPath, hash, noCommit))
  )

  ipcMain.handle(CHANNELS.GIT_CHERRY_PICK, (_event, repoPath: string, hash: string, noCommit?: boolean) =>
    runGitOp('Cherry-pick', () => gitService.cherryPick(repoPath, hash, noCommit))
  )

  ipcMain.handle(CHANNELS.GIT_RESET_TO, async (_event, repoPath: string, hash: string, mode: 'soft' | 'mixed' | 'hard') => {
    if (mode === 'hard') await requireAdmin(repoPath)
    return runGitOp('Reset', () => gitService.resetTo(repoPath, hash, mode))
  })

  ipcMain.handle(CHANNELS.GIT_FILE_LOG, (_event, repoPath: string, filePath: string, limit?: number) =>
    gitService.log(repoPath, { limit: limit ?? 100, filePath })
  )

  ipcMain.handle(CHANNELS.GIT_BRANCH_ACTIVITY, (_event, repoPath: string) =>
    gitService.branchActivity(repoPath)
  )

  ipcMain.handle(CHANNELS.GIT_BRANCH_DIFF, (_event, repoPath: string, base: string, compare: string) =>
    gitService.branchDiff(repoPath, base, compare)
  )

  ipcMain.handle(CHANNELS.GIT_DEFAULT_BRANCH, (_event, repoPath: string) =>
    gitService.defaultBranch(repoPath)
  )

  ipcMain.handle(CHANNELS.GIT_BLAME, (_event, repoPath: string, filePath: string, rev: string) =>
    gitService.blame(repoPath, filePath, rev)
  )

  ipcMain.handle(CHANNELS.GIT_DIFF_COMMIT, (_event, repoPath: string, filePath: string, hash: string) =>
    gitService.diffCommit(repoPath, filePath, hash)
  )

  // ── Asset diff previews — Phase 17 ───────────────────────────────────────
  ipcMain.handle(CHANNELS.ASSET_DIFF_PREVIEW, (_event, repoPath: string, filePath: string, leftRef: string, rightRef: string, editorBinaryOverride?: string) =>
    assetDiffService.diff({ repoPath, filePath, leftRef, rightRef, editorBinaryOverride })
  )

  ipcMain.handle(CHANNELS.ASSET_RENDER_THUMBNAIL, (_event, repoPath: string, filePath: string, ref: string) =>
    assetDiffService.renderThumbnail(repoPath, filePath, ref)
  )

  ipcMain.handle(CHANNELS.ASSET_EXTRACT_METADATA, (_event, repoPath: string, filePath: string, ref: string) =>
    assetDiffService.extractMetadata(repoPath, filePath, ref)
  )

  // ── File-system watcher ───────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.GIT_WATCH_STATUS, (event, repoPath: string) => {
    const sender = event.sender
    watcherService.watch(repoPath, () => {
      if (sender.isDestroyed()) return
      const win = BrowserWindow.fromWebContents(sender)
      if (win && !win.isDestroyed()) {
        win.webContents.send(CHANNELS.EVT_STATUS_CHANGED)
      }
    })
  })

  ipcMain.handle(CHANNELS.GIT_UNWATCH_STATUS, (_event, repoPath: string) => {
    watcherService.unwatch(repoPath)
  })

  // ── Presence ─────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.PRESENCE_READ, (_event, repoPath: string) => {
    presenceService.removeStale(repoPath)
    return presenceService.read(repoPath)
  })

  ipcMain.handle(CHANNELS.PRESENCE_UPDATE, (_event, repoPath: string, login: string, entry: PresenceEntry) =>
    presenceService.update(repoPath, login, entry)
  )

  // ── Lock Heatmap & Conflict Forecasting — Phase 19 ───────────────────────
  ipcMain.handle(CHANNELS.HEATMAP_COMPUTE, (_event, repoPath: string, timeWindowDays: number, groupBy: 'folder' | 'type') =>
    heatmapService.computeHeatmap(repoPath, timeWindowDays, groupBy)
  )

  ipcMain.handle(CHANNELS.HEATMAP_TIMELINE, (_event, repoPath: string, filePath: string, timeWindowDays: number) =>
    heatmapService.getTimeline(repoPath, filePath, timeWindowDays)
  )

  ipcMain.handle(CHANNELS.HEATMAP_TOP, (_event, repoPath: string, timeWindowDays: number, limit?: number) =>
    heatmapService.topContended(repoPath, timeWindowDays, limit)
  )

  ipcMain.handle(CHANNELS.FORECAST_START, (_event, repoPath: string, intervalMinutes?: number) =>
    forecastService.start(repoPath, intervalMinutes)
  )

  ipcMain.handle(CHANNELS.FORECAST_STOP, (_event, repoPath: string) => {
    forecastService.stop(repoPath)
  })

  ipcMain.handle(CHANNELS.FORECAST_STATUS, (_event, repoPath: string) =>
    forecastService.getStatus(repoPath)
  )

  // ── Dependency-Aware Blame — Phase 18 ────────────────────────────────────
  ipcMain.handle(CHANNELS.DEP_BUILD_GRAPH, (event, repoPath: string) =>
    dependencyService.buildGraph(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  )

  ipcMain.handle(CHANNELS.DEP_GRAPH_STATUS, (_event, repoPath: string) =>
    dependencyService.graphStatus(repoPath)
  )

  ipcMain.handle(CHANNELS.DEP_BLAME_ASSET, (_event, repoPath: string, filePath: string) =>
    dependencyService.blameWithDependencies(repoPath, filePath)
  )

  ipcMain.handle(CHANNELS.DEP_LOOKUP_REFERENCES, (_event, repoPath: string, packageName: string) =>
    dependencyService.findReferences(repoPath, packageName)
  )

  ipcMain.handle(CHANNELS.DEP_REFRESH_CACHE, (_event, repoPath: string) =>
    dependencyService.refreshCache(repoPath)
  )

  // ── Bug logs ─────────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.LOG_GET_TEXT, () =>
    logService.getFormattedText()
  )

  ipcMain.handle(CHANNELS.LOG_GET_SUGGESTION, () =>
    logService.getSuggestion()
  )

  ipcMain.handle(CHANNELS.LOG_SAVE_DIALOG, async (event) => {
    const win     = BrowserWindow.fromWebContents(event.sender)
    const dateStr = new Date().toISOString().slice(0, 10)
    const result  = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title:       'Save Bug Log',
      defaultPath: `lucid-git-log-${dateStr}.txt`,
      filters:     [{ name: 'Text Files', extensions: ['txt'] }],
    })
    if (result.canceled || !result.filePath) return null
    logService.saveToFile(result.filePath)
    logService.info('app', `Log saved to: ${result.filePath}`)
    return result.filePath
  })

  // ── GitHub API ─────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.GITHUB_CREATE_PR, async (_event, args: PRCreateArgs) => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    return gitHubService.createPR(token, args)
  })

  ipcMain.handle(CHANNELS.GITHUB_LIST_PRS, async (_event, args: PRListArgs) => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    return gitHubService.listPRs(token, args)
  })

  ipcMain.handle(CHANNELS.GITHUB_PR_FILES, async (_event, args: PRActionArgs) => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    return gitHubService.getPRFiles(token, args)
  })

  ipcMain.handle(CHANNELS.GITHUB_MERGE_PR, async (_event, args: PRActionArgs & { repoPath: string }) => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    try {
      await gitHubService.mergePR(token, args)
      // Auto-unlock only our own locks for files that were part of this accepted PR
      if (args.repoPath) {
        try {
          const { accounts, currentAccountId } = authService.listAccounts()
          const currentLogin = accounts.find(a => a.userId === currentAccountId)?.login
          if (!currentLogin) return
          const [prFiles, currentLocks] = await Promise.all([
            gitHubService.getPRFiles(token, args),
            lockService.listLocks(args.repoPath),
          ])
          const prFileSet = new Set(prFiles)
          await Promise.allSettled(
            currentLocks
              .filter(lock => prFileSet.has(lock.path) && lock.owner.login === currentLogin)
              .map(lock => lockService.unlockFile(args.repoPath, lock.path, false, lock.id))
          )
        } catch {
          // Best-effort — don't fail the merge if lock cleanup errors
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logService.error('github', `PR merge failed for #${args.prNumber}: ${msg}`)
      throw error
    }
  })

  ipcMain.handle(CHANNELS.GITHUB_CLOSE_PR, async (_event, args: PRActionArgs) => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    return gitHubService.closePR(token, args)
  })

  // ── PR Monitor ─────────────────────────────────────────────────────────────
  ipcMain.handle(CHANNELS.PR_MONITOR_START, async (_event, repoPath: string) => {
    return prMonitorService.start(repoPath)
  })

  ipcMain.handle(CHANNELS.PR_MONITOR_STOP, (_event, repoPath: string) => {
    prMonitorService.stop(repoPath)
  })

  ipcMain.handle(CHANNELS.PR_MONITOR_RECORD, (
    _event,
    repoPath: string,
    prNumber: number,
    owner: string,
    repo: string,
    lockedFiles: string[],
    title: string,
  ) => {
    prMonitorService.recordPR(repoPath, prNumber, owner, repo, lockedFiles, title)
  })

  ipcMain.handle(CHANNELS.PR_MONITOR_CHECK, async (_event, repoPath: string) => {
    return prMonitorService.checkNow(repoPath)
  })
}
