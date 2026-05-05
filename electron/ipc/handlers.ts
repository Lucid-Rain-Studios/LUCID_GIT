import { ipcMain, dialog, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
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

type IpcHandler<TArgs extends unknown[]> = (event: IpcMainInvokeEvent, ...args: TArgs) => unknown

function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[MaxDepth]'
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }
  if (Array.isArray(value)) return value.map(item => sanitizeForLog(item, depth + 1))
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/token|authorization|password|secret|credential|extraheader/i.test(key)) {
      out[key] = '[REDACTED]'
    } else {
      out[key] = sanitizeForLog(entry, depth + 1)
    }
  }
  return out
}

function formatIpcFailure(channel: string, args: unknown[], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && error.stack ? `\nStack:\n${error.stack}` : ''
  return [
    `IPC handler failed: ${channel}`,
    `Message: ${message}`,
    `Args: ${JSON.stringify(sanitizeForLog(args), null, 2)}`,
    stack.trimEnd(),
  ].filter(Boolean).join('\n')
}

function spawnDetachedLogged(source: string, command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', cwd })
    child.once('error', (error) => {
      logService.error(source, `Failed to launch ${command}\nCwd: ${cwd ?? process.cwd()}\nArgs: ${JSON.stringify(args)}\nMessage: ${error.message}\nStack:\n${error.stack ?? ''}`)
      reject(error)
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

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
  const handle = <TArgs extends unknown[]>(channel: string, fn: IpcHandler<TArgs>): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await fn(event, ...(args as TArgs))
      } catch (error) {
        logService.error(`ipc.${channel}`, formatIpcFailure(channel, args, error))
        throw error
      }
    })
  }

  const runGitOp = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`${op} failed: ${msg}`)
    }
  }

  // ── Shell ──────────────────────────────────────────────────────────────────
  handle(CHANNELS.SHELL_OPEN_EXTERNAL, async (_event, url: string) => {
    await shell.openExternal(url)
  })

  handle(CHANNELS.SHELL_SHOW_IN_FOLDER, async (_event, fullPath: string) => {
    shell.showItemInFolder(fullPath)
  })

  handle(CHANNELS.SHELL_OPEN_PATH, async (_event, fullPath: string) => {
    const message = await shell.openPath(fullPath)
    if (message) throw new Error(`Could not open path "${fullPath}": ${message}`)
  })

  handle(CHANNELS.SHELL_OPEN_TERMINAL, async (_event, cwd?: string) => {
    const dir = cwd ?? process.cwd()
    if (process.platform === 'win32') {
      try {
        await spawnDetachedLogged('shell.openTerminal', 'wt.exe', ['-d', dir])
      } catch {
        await spawnDetachedLogged('shell.openTerminal', 'cmd.exe', ['/K', `cd /d "${dir}"`])
      }
    } else if (process.platform === 'darwin') {
      await spawnDetachedLogged('shell.openTerminal', 'open', ['-a', 'Terminal', dir])
    } else {
      const terms = ['gnome-terminal', 'xterm', 'konsole', 'xfce4-terminal']
      let lastError: unknown = null
      for (const term of terms) {
        try {
          await spawnDetachedLogged('shell.openTerminal', term, ['--working-directory', dir])
          return
        } catch (error) {
          lastError = error
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`No supported terminal emulator could be launched for ${dir}`)
    }
  })

  // ── OS Dialogs ─────────────────────────────────────────────────────────────
  handle(CHANNELS.DIALOG_OPEN_DIRECTORY, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Repository Folder',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle(CHANNELS.DIALOG_OPEN_FILE, async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      properties: ['openFile'],
      title: 'Select File',
      defaultPath,
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // ── Git — Phase 2 ──────────────────────────────────────────────────────────
  handle(CHANNELS.GIT_IS_REPO, async (_event, repoPath: string) => {
    return gitService.isRepo(repoPath)
  })

  handle(CHANNELS.GIT_STATUS, async (_event, repoPath: string) => {
    return gitService.status(repoPath)
  })

  handle(CHANNELS.GIT_CURRENT_BRANCH, async (_event, repoPath: string) => {
    return gitService.currentBranch(repoPath)
  })

  handle(CHANNELS.GIT_CLONE, async (event, args: { url: string; dir: string; depth?: number }) => {
    await gitService.clone(args, (step) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
      }
    })
  })

  handle(CHANNELS.GIT_STAGE, async (_event, repoPath: string, paths: string[]) => {
    return gitService.stage(repoPath, paths)
  })

  handle(CHANNELS.GIT_UNSTAGE, async (_event, repoPath: string, paths: string[]) => {
    return gitService.unstage(repoPath, paths)
  })

  handle(CHANNELS.GIT_COMMIT, async (_event, repoPath: string, message: string, noVerify?: boolean) => {
    return gitService.commit(repoPath, message, noVerify)
  })

  handle(CHANNELS.GIT_PUSH, async (event, repoPath: string) => {
    const [branch, filesAhead] = await Promise.all([
      gitService.currentBranch(repoPath),
      gitService.aheadFilePaths(repoPath),
    ])

    const result = await gitService.push(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })

    if (branch.trim().toLowerCase() === 'main' && filesAhead.length > 0) {
      try {
        const { accounts, currentAccountId } = authService.listAccounts()
        const currentLogin = accounts.find(a => a.userId === currentAccountId)?.login
        if (currentLogin) {
          const locks = await lockService.listLocks(repoPath)
          const pushedFiles = new Set(filesAhead)
          await Promise.allSettled(
            locks
              .filter(lock => lock.owner.login === currentLogin && pushedFiles.has(lock.path))
              .map(lock => lockService.unlockFile(repoPath, lock.path, false, lock.id, currentLogin, currentLogin))
          )
        }
      } catch {
        // Best-effort lock cleanup — do not fail successful push
      }
    }

    return result
  })

  handle(CHANNELS.GIT_PULL, async (event, repoPath: string) => {
    return gitService.pull(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handle(CHANNELS.GIT_FETCH, async (event, repoPath: string) => {
    const result = await gitService.fetch(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
    prMonitorService.checkNow(repoPath).catch(() => {})
    return result
  })

  handle(CHANNELS.GIT_LOG, async (_event, repoPath: string, args?: { limit?: number; all?: boolean; filePath?: string; refs?: string[] }) => {
    return gitService.log(repoPath, args)
  })

  handle(CHANNELS.GIT_BRANCH_LIST, async (_event, repoPath: string) => {
    return gitService.branchList(repoPath)
  })

  handle(CHANNELS.GIT_BRANCH_CREATE, async (_event, repoPath: string, name: string, from?: string) => {
    return gitService.createBranch(repoPath, name, from)
  })

  handle(CHANNELS.GIT_BRANCH_RENAME, async (_event, repoPath: string, oldName: string, newName: string) => {
    return gitService.renameBranch(repoPath, oldName, newName)
  })

  handle(CHANNELS.GIT_BRANCH_DELETE, async (_event, repoPath: string, name: string, force: boolean) => {
    if (force) await requireAdmin(repoPath)
    return gitService.deleteBranch(repoPath, name, force)
  })

  handle(CHANNELS.GIT_BRANCH_DELETE_REMOTE, async (_event, repoPath: string, remoteName: string, branch: string) => {
    await requireAdmin(repoPath)
    return gitService.deleteRemoteBranch(repoPath, remoteName, branch)
  })

  handle(CHANNELS.GIT_REMOTE_URL, async (_event, repoPath: string) => {
    return gitService.getRemoteUrl(repoPath)
  })

  handle(CHANNELS.GIT_SYNC_STATUS, async (_event, repoPath: string) => {
    return gitService.getSyncStatus(repoPath)
  })

  handle(CHANNELS.GIT_UPDATE_FROM_MAIN, async (_event, repoPath: string) => {
    return gitService.updateFromMain(repoPath)
  })

  handle(CHANNELS.GIT_DIFF, async (_event, repoPath: string, filePath: string, staged: boolean) => {
    return gitService.diff(repoPath, filePath, staged)
  })

  handle(CHANNELS.GIT_DISCARD, async (_event, repoPath: string, paths: string[], isUntracked: boolean) => {
    return gitService.discard(repoPath, paths, isUntracked)
  })

  handle(CHANNELS.GIT_DISCARD_ALL, async (_event, repoPath: string) => {
    return gitService.discardAll(repoPath)
  })

  handle(CHANNELS.GIT_COMMIT_FILES, async (_event, repoPath: string, hash: string) => {
    return gitService.commitFiles(repoPath, hash)
  })

  handle(CHANNELS.GIT_ADD_GITIGNORE, async (_event, repoPath: string, pattern: string) => {
    return gitService.addToGitignore(repoPath, pattern)
  })

  handle(CHANNELS.GIT_STASH_LIST, async (_event, repoPath: string) => {
    return gitService.stashList(repoPath)
  })

  handle(CHANNELS.GIT_STASH_SAVE, async (_event, repoPath: string, message?: string, paths?: string[]) => {
    return gitService.stashSave(repoPath, message, paths)
  })

  handle(CHANNELS.GIT_STASH_POP, async (_event, repoPath: string, ref: string) => {
    return runGitOp('Stash pop', () => gitService.stashPop(repoPath, ref))
  })

  handle(CHANNELS.GIT_STASH_APPLY, async (_event, repoPath: string, ref: string) => {
    return gitService.stashApply(repoPath, ref)
  })

  handle(CHANNELS.GIT_STASH_DROP, async (_event, repoPath: string, ref: string) => {
    return gitService.stashDrop(repoPath, ref)
  })

  // ── Auth — Phase 3 ────────────────────────────────────────────────────────
  handle(CHANNELS.AUTH_START_DEVICE_FLOW, async () => {
    return authService.startDeviceFlow()
  })

  handle(CHANNELS.AUTH_POLL_DEVICE_FLOW, async (_event, deviceCode: string) => {
    return authService.pollDeviceFlow(deviceCode)
  })

  handle(CHANNELS.AUTH_LIST_ACCOUNTS, async () => {
    return authService.listAccounts()
  })

  handle(CHANNELS.AUTH_LOGOUT, async (_event, userId: string) => {
    return authService.logout(userId)
  })

  handle(CHANNELS.AUTH_SET_CURRENT_ACCOUNT, async (_event, userId: string) => {
    return authService.setCurrentAccount(userId)
  })

  // ── Permissions — Phase 20 ────────────────────────────────────────────────
  handle(CHANNELS.AUTH_FETCH_REPO_PERMISSION, async (_event, repoPath: string) => {
    return permissionService.fetchPermission(repoPath)
  })

  handle(CHANNELS.AUTH_GET_REPO_PERMISSION, async (_event, repoPath: string) => {
    return permissionService.getCachedPermission(repoPath)
  })

  handle(CHANNELS.GIT_CHECKOUT, async (_event, repoPath: string, branch: string) => {
    return runGitOp('Checkout', () => gitService.checkout(repoPath, branch))
  })

  handle(CHANNELS.GIT_MERGE_PREVIEW, async (_event, repoPath: string, targetBranch: string) => {
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

  handle(CHANNELS.GIT_POTENTIAL_MERGE_CONFLICTS, async (_event, repoPath: string, mode: 'lightweight' | 'deep') => {
    return gitService.potentialMergeConflicts(repoPath, mode)
  })

  handle(CHANNELS.GIT_MERGE, async (_event, repoPath: string, targetBranch: string) => {
    await runGitOp('Merge', () => gitService.merge(repoPath, targetBranch))
    const ourBranch = await gitService.currentBranch(repoPath)
    heatmapService.markConflictsResolved(repoPath, ourBranch, targetBranch)
  })

  handle(CHANNELS.GIT_MERGE_GET_CONFLICT_TEXT, async (_event, repoPath: string, filePath: string) => {
    return gitService.getMergeConflictText(repoPath, filePath)
  })

  handle(CHANNELS.GIT_MERGE_RESOLVE_TEXT, async (_event, repoPath: string, filePath: string, choice: 'ours' | 'theirs') => {
    await runGitOp('Resolve conflict', () => gitService.resolveMergeConflictText(repoPath, filePath, choice))
  })

  handle(CHANNELS.GIT_MERGE_CONTINUE, async (_event, repoPath: string, targetBranch: string) => {
    await runGitOp('Finalize merge', () => gitService.continueMerge(repoPath, targetBranch))
    const ourBranch = await gitService.currentBranch(repoPath)
    heatmapService.markConflictsResolved(repoPath, ourBranch, targetBranch)
  })

  handle(CHANNELS.GIT_MERGE_ABORT, async (_event, repoPath: string) => {
    await runGitOp('Abort merge', () => gitService.abortMerge(repoPath))
  })

  handle(CHANNELS.GIT_MERGE_IN_PROGRESS, async (_event, repoPath: string) => {
    const state = await gitService.mergeInProgress(repoPath)
    if (!state) return null
    const conflicts = await gitService.listInProgressConflicts(repoPath)
    return { ...state, conflicts }
  })

  handle(
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
  handle(CHANNELS.LOCK_LIST, async (_event, repoPath: string) => {
    return lockService.listLocks(repoPath)
  })

  handle(CHANNELS.LOCK_FILE, async (_event, repoPath: string, filePath: string) => {
    return lockService.lockFile(repoPath, filePath)
  })

  handle(CHANNELS.LOCK_UNLOCK, async (_event, repoPath: string, filePath: string, force?: boolean, lockId?: string) => {
    if (force) await requireAdmin(repoPath)
    return lockService.unlockFile(repoPath, filePath, force, lockId)
  })

  handle(CHANNELS.LOCK_WATCH, async (_event, repoPath: string, filePath: string) => {
    return lockService.watchFile(repoPath, filePath)
  })

  handle(CHANNELS.LOCK_START_POLLING, async (_event, repoPath: string) => {
    lockService.startPolling(repoPath)
  })

  handle(CHANNELS.LOCK_STOP_POLLING, async (_event, repoPath: string) => {
    lockService.stopPolling(repoPath)
  })

  handle(CHANNELS.LFS_STATUS, async (_event, repoPath: string) => {
    return gitService.lfsStatus(repoPath)
  })

  handle(CHANNELS.LFS_TRACK, async (_event, repoPath: string, patterns: string[]) => {
    return gitService.lfsTrack(repoPath, patterns)
  })

  handle(CHANNELS.LFS_UNTRACK, async (_event, repoPath: string, pattern: string) => {
    return gitService.lfsUntrack(repoPath, pattern)
  })

  handle(CHANNELS.LFS_AUTODETECT, async (_event, repoPath: string) => {
    return gitService.lfsAutodetect(repoPath)
  })

  handle(CHANNELS.LFS_LOCKS_CHECK, async (_event, repoPath: string) => {
    return gitService.lfsLocksMaintenance(repoPath, false)
  })

  handle(CHANNELS.LFS_LOCKS_REPAIR, async (_event, repoPath: string) => {
    const result = await gitService.lfsLocksMaintenance(repoPath, true)
    await lockService.refresh(repoPath)
    return result
  })

  handle(CHANNELS.LFS_MIGRATE, async (event, repoPath: string, patterns: string[]) => {
    await requireAdmin(repoPath)
    return gitService.lfsMigrate(repoPath, patterns, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handle(CHANNELS.CLEANUP_SIZE, async (event, repoPath: string) => {
    return withTimeout(
      gitService.cleanupSize(repoPath, (step) => {
        if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
      }),
      30_000,
      'cleanupSize'
    )
  })

  handle(CHANNELS.CLEANUP_GC, async (event, repoPath: string, aggressive?: boolean) => {
    await requireAdmin(repoPath)
    return gitService.cleanupGc(repoPath, aggressive, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handle(CHANNELS.CLEANUP_PRUNE_LFS, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return gitService.cleanupPruneLfs(repoPath)
  })

  handle(CHANNELS.CLEANUP_SHALLOW, async (event, repoPath: string, depth: number) => {
    await requireAdmin(repoPath)
    return gitService.cleanupShallow(repoPath, depth, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handle(CHANNELS.CLEANUP_UNSHALLOW, async (event, repoPath: string) => {
    await requireAdmin(repoPath)
    return gitService.cleanupUnshallow(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handle(CHANNELS.NOTIFICATION_LIST, async (_event, repoPath: string) => {
    return notificationService.list(repoPath)
  })

  handle(CHANNELS.NOTIFICATION_MARK_READ, async (_event, id: number) => {
    notificationService.markRead(id)
  })

  handle(CHANNELS.WEBHOOK_TEST, async (_event, url: string) => {
    return webhookService.test(url)
  })
  handle(CHANNELS.WEBHOOK_LOAD, async (_event, repoPath: string) => {
    return webhookService.loadConfig(repoPath)
  })

  handle(CHANNELS.WEBHOOK_SAVE, async (_event, repoPath: string, config: WebhookConfig) => {
    await requireAdmin(repoPath)
    webhookService.saveConfig(repoPath, config)
  })

  // ── Auto-fix helpers — Phase 13 ───────────────────────────────────────────
  handle(CHANNELS.GIT_REBASE_ABORT, (_event, repoPath: string) =>
    gitService.rebaseAbort(repoPath)
  )

  handle(CHANNELS.GIT_SET_UPSTREAM, (_event, repoPath: string, branch: string) =>
    gitService.setUpstream(repoPath, branch)
  )

  handle(CHANNELS.GIT_SET_CONFIG, (_event, repoPath: string, key: string, value: string) =>
    gitService.setGitConfig(repoPath, key, value)
  )

  handle(CHANNELS.GIT_GET_CONFIG, (_event, repoPath: string, key: string) =>
    gitService.getGitConfig(repoPath, key)
  )

  handle(CHANNELS.GIT_GET_GLOBAL_IDENTITY, () =>
    gitService.getGlobalGitIdentity()
  )

  handle(CHANNELS.GIT_SET_GLOBAL_IDENTITY, (_event, name: string, email: string) =>
    gitService.setGlobalGitIdentity(name, email)
  )

  // ── Hooks — Phase 12 ──────────────────────────────────────────────────────
  handle(CHANNELS.HOOK_LIST, (_event, repoPath: string) =>
    hookService.listHooks(repoPath)
  )

  handle(CHANNELS.HOOK_ENABLE, (_event, repoPath: string, name: string) =>
    hookService.enableHook(repoPath, name)
  )

  handle(CHANNELS.HOOK_DISABLE, (_event, repoPath: string, name: string) =>
    hookService.disableHook(repoPath, name)
  )

  handle(CHANNELS.HOOK_BUILTINS, () =>
    hookService.builtins()
  )

  handle(CHANNELS.HOOK_INSTALL_BUILTIN, async (_event, repoPath: string, id: string) => {
    await requireAdmin(repoPath)
    return hookService.installBuiltin(repoPath, id)
  })

  handle(CHANNELS.HOOK_RUN_PRECOMMIT, (_event, repoPath: string) =>
    hookService.runPreCommit(repoPath)
  )

  handle(CHANNELS.UE_DETECT, (_event, repoPath: string) =>
    unrealService.detect(repoPath)
  )

  handle(CHANNELS.UE_SETUP_STATUS, (_event, repoPath: string) =>
    unrealService.setupStatus(repoPath)
  )

  handle(CHANNELS.UE_TEMPLATES, () =>
    unrealService.templates()
  )

  handle(CHANNELS.UE_WRITE_GITATTRIBUTES, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return unrealService.writeGitattributes(repoPath)
  })

  handle(CHANNELS.UE_WRITE_GITIGNORE, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return unrealService.writeGitignore(repoPath)
  })

  handle(CHANNELS.UE_PAK_SIZE, (_event, repoPath: string, stagedPaths: string[]) =>
    unrealService.pakSizeEstimate(repoPath, stagedPaths)
  )

  handle(CHANNELS.UE_PLUGIN_STATUS, (_event, repoPath: string) =>
    unrealService.pluginStatus(repoPath)
  )

  handle(CHANNELS.UE_CONFIG_STATUS, (_event, repoPath: string) =>
    unrealService.ueConfigStatus(repoPath)
  )

  handle(CHANNELS.UE_WRITE_EDITOR_CONFIG, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return unrealService.writeEditorConfig(repoPath)
  })

  handle(CHANNELS.UE_WRITE_ENGINE_CONFIG, async (_event, repoPath: string) => {
    await requireAdmin(repoPath)
    return unrealService.writeEngineConfig(repoPath)
  })

  handle(CHANNELS.GIT_GET_IDENTITY, (_event, repoPath: string) =>
    gitService.getIdentity(repoPath)
  )

  handle(CHANNELS.GIT_LINK_IDENTITY, (_event, repoPath: string, login: string, name: string) =>
    gitService.linkIdentity(repoPath, login, name)
  )

  // ── App Settings — Phase 15 ───────────────────────────────────────────────
  handle(CHANNELS.SETTINGS_GET, () =>
    settingsService.getAll()
  )

  handle(CHANNELS.SETTINGS_SAVE, async (_event, settings: AppSettings) => {
    settingsService.save(settings)
    const defaultBranch = (settings.defaultBranchName ?? 'main').trim() || 'main'
    await gitService.setGlobalDefaultBranch(defaultBranch)
  })

  // ── Team Config — Phase 15 ────────────────────────────────────────────────
  handle(CHANNELS.TEAM_CONFIG_LOAD, (_event, repoPath: string) =>
    teamConfigService.load(repoPath)
  )

  handle(CHANNELS.TEAM_CONFIG_SAVE, async (_event, repoPath: string, config: TeamConfig) => {
    await requireAdmin(repoPath)
    return teamConfigService.save(repoPath, config)
  })

  // ── Git Tools ─────────────────────────────────────────────────────────────
  handle(CHANNELS.GIT_LS_FILES, (_event, repoPath: string) =>
    gitService.lsFiles(repoPath)
  )

  handle(CHANNELS.GIT_RESTORE_FILE, (_event, repoPath: string, filePath: string, fromHash: string) =>
    gitService.restoreFile(repoPath, filePath, fromHash)
  )

  handle(CHANNELS.GIT_REVERT, (_event, repoPath: string, hash: string, noCommit: boolean) =>
    runGitOp('Revert', () => gitService.revert(repoPath, hash, noCommit))
  )

  handle(CHANNELS.GIT_CHERRY_PICK, (_event, repoPath: string, hash: string, noCommit?: boolean) =>
    runGitOp('Cherry-pick', () => gitService.cherryPick(repoPath, hash, noCommit))
  )

  handle(CHANNELS.GIT_RESET_TO, async (_event, repoPath: string, hash: string, mode: 'soft' | 'mixed' | 'hard') => {
    if (mode === 'hard') await requireAdmin(repoPath)
    return runGitOp('Reset', () => gitService.resetTo(repoPath, hash, mode))
  })

  handle(CHANNELS.GIT_FILE_LOG, (_event, repoPath: string, filePath: string, limit?: number) =>
    gitService.log(repoPath, { limit: limit ?? 100, filePath })
  )

  handle(CHANNELS.GIT_BRANCH_ACTIVITY, (_event, repoPath: string) =>
    gitService.branchActivity(repoPath)
  )

  handle(CHANNELS.GIT_BRANCH_DIFF, (_event, repoPath: string, base: string, compare: string) =>
    gitService.branchDiff(repoPath, base, compare)
  )

  handle(CHANNELS.GIT_DEFAULT_BRANCH, (_event, repoPath: string) =>
    gitService.defaultBranch(repoPath)
  )

  handle(CHANNELS.GIT_BLAME, (_event, repoPath: string, filePath: string, rev: string) =>
    gitService.blame(repoPath, filePath, rev)
  )

  handle(CHANNELS.GIT_DIFF_COMMIT, (_event, repoPath: string, filePath: string, hash: string) =>
    gitService.diffCommit(repoPath, filePath, hash)
  )

  // ── Asset diff previews — Phase 17 ───────────────────────────────────────
  handle(CHANNELS.ASSET_DIFF_PREVIEW, (_event, repoPath: string, filePath: string, leftRef: string, rightRef: string, editorBinaryOverride?: string) =>
    assetDiffService.diff({ repoPath, filePath, leftRef, rightRef, editorBinaryOverride })
  )

  handle(CHANNELS.ASSET_RENDER_THUMBNAIL, (_event, repoPath: string, filePath: string, ref: string) =>
    assetDiffService.renderThumbnail(repoPath, filePath, ref)
  )

  handle(CHANNELS.ASSET_EXTRACT_METADATA, (_event, repoPath: string, filePath: string, ref: string) =>
    assetDiffService.extractMetadata(repoPath, filePath, ref)
  )

  // ── File-system watcher ───────────────────────────────────────────────────
  handle(CHANNELS.GIT_WATCH_STATUS, (event, repoPath: string) => {
    const sender = event.sender
    watcherService.watch(repoPath, () => {
      if (sender.isDestroyed()) return
      const win = BrowserWindow.fromWebContents(sender)
      if (win && !win.isDestroyed()) {
        win.webContents.send(CHANNELS.EVT_STATUS_CHANGED)
      }
    })
  })

  handle(CHANNELS.GIT_UNWATCH_STATUS, (_event, repoPath: string) => {
    watcherService.unwatch(repoPath)
  })

  // ── Presence ─────────────────────────────────────────────────────────────
  handle(CHANNELS.PRESENCE_READ, (_event, repoPath: string) => {
    presenceService.removeStale(repoPath)
    return presenceService.read(repoPath)
  })

  handle(CHANNELS.PRESENCE_UPDATE, (_event, repoPath: string, login: string, entry: PresenceEntry) =>
    presenceService.update(repoPath, login, entry)
  )

  // ── Lock Heatmap & Conflict Forecasting — Phase 19 ───────────────────────
  handle(CHANNELS.HEATMAP_COMPUTE, (_event, repoPath: string, timeWindowDays: number, groupBy: 'folder' | 'type') =>
    heatmapService.computeHeatmap(repoPath, timeWindowDays, groupBy)
  )

  handle(CHANNELS.HEATMAP_TIMELINE, (_event, repoPath: string, filePath: string, timeWindowDays: number) =>
    heatmapService.getTimeline(repoPath, filePath, timeWindowDays)
  )

  handle(CHANNELS.HEATMAP_TOP, (_event, repoPath: string, timeWindowDays: number, limit?: number) =>
    heatmapService.topContended(repoPath, timeWindowDays, limit)
  )

  handle(CHANNELS.FORECAST_START, (_event, repoPath: string, intervalMinutes?: number) =>
    forecastService.start(repoPath, intervalMinutes)
  )

  handle(CHANNELS.FORECAST_STOP, (_event, repoPath: string) => {
    forecastService.stop(repoPath)
  })

  handle(CHANNELS.FORECAST_STATUS, (_event, repoPath: string) =>
    forecastService.getStatus(repoPath)
  )

  // ── Dependency-Aware Blame — Phase 18 ────────────────────────────────────
  handle(CHANNELS.DEP_BUILD_GRAPH, (event, repoPath: string) =>
    dependencyService.buildGraph(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  )

  handle(CHANNELS.DEP_GRAPH_STATUS, (_event, repoPath: string) =>
    dependencyService.graphStatus(repoPath)
  )

  handle(CHANNELS.DEP_BLAME_ASSET, (_event, repoPath: string, filePath: string) =>
    dependencyService.blameWithDependencies(repoPath, filePath)
  )

  handle(CHANNELS.DEP_LOOKUP_REFERENCES, (_event, repoPath: string, packageName: string) =>
    dependencyService.findReferences(repoPath, packageName)
  )

  handle(CHANNELS.DEP_REFRESH_CACHE, (_event, repoPath: string) =>
    dependencyService.refreshCache(repoPath)
  )

  // ── Bug logs ─────────────────────────────────────────────────────────────────
  handle(CHANNELS.LOG_GET_TEXT, () =>
    logService.getFormattedText()
  )

  handle(CHANNELS.LOG_GET_SUGGESTION, () =>
    logService.getSuggestion()
  )

  handle(CHANNELS.LOG_SAVE_DIALOG, async (event) => {
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


  handle(CHANNELS.LOG_RENDERER_EVENT, async (_event, source: string, message: string, detail?: unknown) => {
    const suffix = detail === undefined ? '' : `\nDetail: ${JSON.stringify(sanitizeForLog(detail), null, 2)}`
    logService.error(source || 'renderer', `${message || 'Renderer error'}${suffix}`)
  })
  // ── GitHub API ─────────────────────────────────────────────────────────────
  handle(CHANNELS.GITHUB_CREATE_PR, async (_event, args: PRCreateArgs) => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    return gitHubService.createPR(token, args)
  })

  handle(CHANNELS.GITHUB_LIST_PRS, async (_event, args: PRListArgs) => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    return gitHubService.listPRs(token, args)
  })

  handle(CHANNELS.GITHUB_PR_FILES, async (_event, args: PRActionArgs) => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    return gitHubService.getPRFiles(token, args)
  })

  handle(CHANNELS.GITHUB_MERGE_PR, async (_event, args: PRActionArgs & { repoPath: string }) => {
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

  handle(CHANNELS.GITHUB_CLOSE_PR, async (_event, args: PRActionArgs) => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    return gitHubService.closePR(token, args)
  })

  // ── PR Monitor ─────────────────────────────────────────────────────────────
  handle(CHANNELS.PR_MONITOR_START, async (_event, repoPath: string) => {
    return prMonitorService.start(repoPath)
  })

  handle(CHANNELS.PR_MONITOR_STOP, (_event, repoPath: string) => {
    prMonitorService.stop(repoPath)
  })

  handle(CHANNELS.PR_MONITOR_RECORD, (
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

  handle(CHANNELS.PR_MONITOR_CHECK, async (_event, repoPath: string) => {
    return prMonitorService.checkNow(repoPath)
  })
}
