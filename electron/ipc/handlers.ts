import { ipcMain, dialog, shell, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { permissionService } from '../services/PermissionService'
import { watcherService } from '../services/WatcherService'
import { dependencyService } from '../services/DependencyService'
import { heatmapService } from '../services/HeatmapService'
import { forecastService } from '../services/ForecastService'
import { assetDiffService } from '../services/AssetDiffService'
import { presenceService } from '../services/PresenceService'
import type { PresenceEntry } from '../types'
import { CHANNELS } from './channels'
import { withTimeout } from '../util/dugite-exec'
import { gitService } from '../services/GitService'
import { authService } from '../services/AuthService'
import { logService } from '../services/LogService'
import { lockService } from '../services/LockService'
import { notificationService } from '../services/NotificationService'
import { desktopNotificationService } from '../services/DesktopNotificationService'
import { webhookService } from '../services/WebhookService'
import { unrealService } from '../services/UnrealService'
import { hookService } from '../services/HookService'
import { settingsService } from '../services/SettingsService'
import { terminalService } from '../services/TerminalService'
import { teamConfigService } from '../services/TeamConfigService'
import { gitHubService } from '../services/GitHubService'
import type { PRCreateArgs, PRListArgs, PRActionArgs } from '../services/GitHubService'
import { prMonitorService } from '../services/PRMonitorService'
import { undoService, UndoableOp } from '../services/UndoService'
import type { WebhookConfig, AppSettings, TeamConfig } from '../types'

type IpcHandler<TArgs extends unknown[]> = (event: IpcMainInvokeEvent, ...args: TArgs) => unknown

// Ceiling for a read the UI waits on. Generous enough that a large repo on a
// slow disk still answers, short enough that a wedged process surfaces as an
// error instead of an endless spinner.
const READ_TIMEOUT_MS = 30_000

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

/**
 * Gate for operations any collaborator may perform — branch deletion included.
 * Only read-only users are turned away.
 *
 * `fetchPermission` fails open to 'write' on network or API trouble, so a
 * flaky connection leaves ordinary work unblocked; the remote is still the
 * final authority on anything that leaves the machine.
 */
async function requireWrite(repoPath: string): Promise<void> {
  const cached = permissionService.getCachedPermission(repoPath)
  if (cached === 'admin' || cached === 'write') return
  if (cached === 'read') {
    throw new Error('PERMISSION_DENIED: Write access required for this operation')
  }
  const perm = await permissionService.fetchPermission(repoPath)
  if (perm === 'read') throw new Error('PERMISSION_DENIED: Write access required for this operation')
}

export function registerHandlers(): void {
  const handle = <TArgs extends unknown[]>(channel: string, fn: IpcHandler<TArgs>): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await fn(event, ...(args as TArgs))
      } catch (error) {
        logService.error(`ipc.${channel}`, formatIpcFailure(channel, args, error))
        if ((channel === CHANNELS.GIT_PUSH || channel === CHANNELS.GIT_PULL) && !event.sender.isDestroyed()) {
          event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, {
            id: `${channel}-error`, label: channel === CHANNELS.GIT_PUSH ? 'Push failed' : 'Pull failed',
            status: 'error', detail: error instanceof Error ? error.message : String(error),
          })
        }
        throw error
      }
    })
  }

  /**
   * Register a read-only handler the UI blocks on, bounded by a deadline.
   *
   * These are all sub-second in a healthy repo, so a hang is always
   * pathological — a stalled credential prompt, a disconnected network share,
   * a git process wedged behind an antivirus scan. Unbounded, the renderer's
   * promise simply never settles and the panel spins forever with no error to
   * act on; that is the failure mode that hid a slow `git lfs ls-files` behind
   * an empty Overview.
   *
   * Deliberately NOT applied to writes: a checkout that smudges 40k LFS
   * objects, a fetch, or an `lfs migrate` legitimately runs for many minutes,
   * and those already stream progress so the user can see they are alive.
   *
   * dugite gives no handle to kill the underlying process, so this frees the
   * UI rather than the subprocess — the orphan finishes on its own.
   */
  const handleRead = <TArgs extends unknown[]>(channel: string, fn: IpcHandler<TArgs>): void => {
    handle(channel, async (event, ...args) =>
      withTimeout(Promise.resolve(fn(event, ...(args as TArgs))), READ_TIMEOUT_MS, channel))
  }

  const runGitOp = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new Error(`${op} failed: ${msg}`)
    }
  }

  // Wrap a HEAD-moving operation with an undo checkpoint: snapshot state before,
  // offer Undo on success, drop the checkpoint on failure.
  const withUndo = async <T>(repoPath: string, op: UndoableOp, label: string, fn: () => Promise<T>): Promise<T> => {
    await undoService.recordCheckpoint(repoPath, op, label)
    try {
      const result = await fn()
      undoService.markAvailable(repoPath)
      return result
    } catch (error) {
      undoService.discard(repoPath)
      throw error
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

  handle(CHANNELS.SHELL_LIST_TERMINALS, async () => terminalService.list())

  handle(CHANNELS.SHELL_OPEN_TERMINAL, async (_event, cwd?: string, terminalId?: string) => {
    const dir = cwd ?? process.cwd()
    // An explicit id (from the picker) wins; otherwise use the saved preference.
    const chosen = terminalId ?? settingsService.getAll().preferredTerminal ?? 'auto'
    await terminalService.open(dir, chosen)
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
  handleRead(CHANNELS.GIT_IS_REPO, async (_event, repoPath: string) => {
    return gitService.isRepo(repoPath)
  })

  handleRead(CHANNELS.GIT_STATUS, async (_event, repoPath: string) => {
    return gitService.status(repoPath)
  })

  handleRead(CHANNELS.GIT_CURRENT_BRANCH, async (_event, repoPath: string) => {
    return gitService.currentBranch(repoPath)
  })

  handle(CHANNELS.GIT_CLONE, async (event, args: { url: string; dir: string; depth?: number }) => {
    await gitService.clone(args, (step) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
      }
    })
  })

  handle(CHANNELS.GIT_STAGE, async (event, repoPath: string, paths: string[]) => {
    return gitService.stage(repoPath, paths, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handle(CHANNELS.GIT_UNSTAGE, async (event, repoPath: string, paths: string[]) => {
    return gitService.unstage(repoPath, paths, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handle(CHANNELS.GIT_COMMIT, async (_event, repoPath: string, message: string, noVerify?: boolean) => {
    return gitService.commit(repoPath, message, noVerify)
  })

  handle(CHANNELS.GIT_PUSH, async (event, repoPath: string) => {
    if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, { id: 'push-prepare', label: 'Preparing push', status: 'running', progress: 3 })
    const { branch, filesAhead } = await gitService.push(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })

    if (branch.trim().toLowerCase() === 'main' && filesAhead.length > 0) {
      try {
        const { accounts, currentAccountId } = authService.listAccounts()
        const currentLogin = accounts.find(a => a.userId === currentAccountId)?.login
        if (currentLogin) {
          const locks = await lockService.listLocks(repoPath)
          const pushedFiles = new Set(filesAhead)
          await lockService.unlockFiles(
            repoPath,
            locks
              .filter(lock => lock.owner.login === currentLogin && pushedFiles.has(lock.path))
              .map(lock => ({ filePath: lock.path, lockId: lock.id })),
            currentLogin,
            currentLogin,
            step => {
              if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
            },
          )
        }
      } catch {
        // Best-effort lock cleanup — do not fail successful push
      }
    }

    if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, { id: 'push-complete', label: 'Push complete', status: 'done', progress: 100, overallProgress: 100 })

  })

  handle(CHANNELS.GIT_PULL, async (event, repoPath: string) => {
    if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, { id: 'pull-checkpoint', label: 'Preparing pull', status: 'running', progress: 3 })
    const result = await withUndo(repoPath, 'pull', 'Pull', () => gitService.pull(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    }))
    // After pulling, locked files whose work just landed in main can be unlocked.
    prMonitorService.checkMainMerges(repoPath).catch(() => {})
    if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, { id: 'pull-complete', label: 'Pull complete', status: 'done', progress: 100, overallProgress: 100 })
    return result
  })

  handle(CHANNELS.GIT_FETCH, async (event, repoPath: string) => {
    const result = await gitService.fetch(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
    prMonitorService.checkNow(repoPath).catch(() => {})
    prMonitorService.checkMainMerges(repoPath).catch(() => {})
    return result
  })

  handleRead(CHANNELS.GIT_LOG, async (_event, repoPath: string, args?: { limit?: number; all?: boolean; filePath?: string; refs?: string[] }) => {
    return gitService.log(repoPath, args)
  })

  handleRead(CHANNELS.GIT_CHANGELOG, async (_event, repoPath: string, query: { fromDate?: string; toDate?: string; fromCommit?: string; toCommit?: string; ref?: string }) => {
    await requireAdmin(repoPath)
    return gitService.changelog(repoPath, query ?? {})
  })

  handleRead(CHANNELS.GIT_BRANCH_LIST, async (_event, repoPath: string) => {
    return gitService.branchList(repoPath)
  })

  handle(CHANNELS.GIT_BRANCH_CREATE, async (_event, repoPath: string, name: string, from?: string) => {
    return gitService.createBranch(repoPath, name, from)
  })

  handle(CHANNELS.GIT_BRANCH_RENAME, async (_event, repoPath: string, oldName: string, newName: string) => {
    return gitService.renameBranch(repoPath, oldName, newName)
  })

  handle(CHANNELS.GIT_BRANCH_DELETE, async (_event, repoPath: string, name: string, force: boolean) => {
    // Force-delete only discards local commits; any collaborator may clean up
    // their own branches. The UI still confirms before the unmerged-work case.
    if (force) await requireWrite(repoPath)
    return gitService.deleteBranch(repoPath, name, force)
  })

  handle(CHANNELS.GIT_BRANCH_DELETE_REMOTE, async (_event, repoPath: string, remoteName: string, branch: string) => {
    // Branch protection and push rules are enforced by the remote, which is the
    // authority here — a local admin check only hid the button from people the
    // remote would have allowed.
    await requireWrite(repoPath)
    return gitService.deleteRemoteBranch(repoPath, remoteName, branch)
  })

  handleRead(CHANNELS.GIT_REMOTE_URL, async (_event, repoPath: string) => {
    return gitService.getRemoteUrl(repoPath)
  })

  handleRead(CHANNELS.GIT_SYNC_STATUS, async (_event, repoPath: string) => {
    return gitService.getSyncStatus(repoPath)
  })

  handle(CHANNELS.GIT_UPDATE_FROM_MAIN, async (event, repoPath: string) => {
    return withUndo(repoPath, 'update-from-main', 'Update from main', () =>
      gitService.updateFromMain(repoPath, (step) => {
        if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
      }))
  })

  handle(CHANNELS.GIT_MERGE_OVERLAP, async (_event, repoPath: string, mergeRef: string) => {
    return gitService.mergeOverlapFiles(repoPath, mergeRef)
  })

  handle(CHANNELS.GIT_UPDATE_FROM_MAIN_CONFLICTS, async (_event, repoPath: string) => {
    return gitService.updateFromMainConflicts(repoPath)
  })

  handleRead(CHANNELS.GIT_DIFF, async (_event, repoPath: string, filePath: string, staged: boolean) => {
    return gitService.diff(repoPath, filePath, staged)
  })

  handle(CHANNELS.GIT_DISCARD, async (event, repoPath: string, paths: string[], isUntracked: boolean) => {
    return gitService.discard(repoPath, paths, isUntracked, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handle(CHANNELS.GIT_DISCARD_ALL, async (event, repoPath: string) => {
    return gitService.discardAll(repoPath, (step) => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
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

  handle(CHANNELS.GIT_STASH_SHOW_FILES, async (_event, repoPath: string, ref: string) => {
    return gitService.stashShowFiles(repoPath, ref)
  })

  handle(CHANNELS.GIT_STASH_FILE_DIFF, async (_event, repoPath: string, ref: string, filePath: string) => {
    return gitService.stashFileDiff(repoPath, ref, filePath)
  })

  handle(CHANNELS.GIT_COMMIT_AMEND, async (_event, repoPath: string, message: string, noVerify?: boolean) => {
    return gitService.commitAmend(repoPath, message, noVerify)
  })

  handle(CHANNELS.GIT_LAST_COMMIT_MESSAGE, async (_event, repoPath: string) => {
    return gitService.lastCommitMessage(repoPath)
  })

  handle(CHANNELS.GIT_COMMIT_MESSAGE, async (_event, repoPath: string, hash: string) => {
    return gitService.commitMessage(repoPath, hash)
  })

  handle(CHANNELS.GIT_IS_HEAD_PUSHED, async (_event, repoPath: string) => {
    return gitService.isHeadPushed(repoPath)
  })

  handleRead(CHANNELS.GIT_DIFF_RAW, async (_event, repoPath: string, filePath: string, staged: boolean) => {
    return gitService.diffRaw(repoPath, filePath, staged)
  })

  handle(CHANNELS.GIT_APPLY_PATCH, async (_event, repoPath: string, patch: string, reverse?: boolean) => {
    return gitService.applyPatch(repoPath, patch, { reverse })
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
    return withUndo(repoPath, 'checkout', 'Checkout', () => runGitOp('Checkout', () => gitService.checkout(repoPath, branch)))
  })

  handle(CHANNELS.GIT_MERGE_PREVIEW, async (_event, repoPath: string, targetBranch: string, baseBranch?: string) => {
    const conflicts = await gitService.mergePreview(repoPath, targetBranch, baseBranch)
    const ourBranch = baseBranch ?? await gitService.currentBranch(repoPath)
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
    await withUndo(repoPath, 'merge', 'Merge', () => runGitOp('Merge', () => gitService.merge(repoPath, targetBranch)))
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

// ── Locks — Phase 5 ───────────────────────────────────────────────────────
  handleRead(CHANNELS.LOCK_LIST, async (_event, repoPath: string) => {
    return lockService.listLocks(repoPath)
  })

  handle(CHANNELS.LOCK_FILE, async (event, repoPath: string, filePath: string) => {
    try {
      return await lockService.lockFile(repoPath, filePath, '', '', step => {
        if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
      })
    } catch (error) {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, { id: 'lock-file', label: 'Lock failed', status: 'error', detail: String(error) })
      throw error
    }
  })

  handle(CHANNELS.LOCK_UNLOCK, async (event, repoPath: string, filePath: string, force?: boolean, lockId?: string) => {
    if (force) await requireAdmin(repoPath)
    try {
      return await lockService.unlockFile(repoPath, filePath, force, lockId, '', '', step => {
        if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
      })
    } catch (error) {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, { id: 'unlock-file', label: 'Unlock failed', status: 'error', detail: String(error) })
      throw error
    }
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

  handle(CHANNELS.LOCK_CLEAR_CACHE, async (_event, repoPath: string) => {
    return lockService.clearCacheAndRefresh(repoPath)
  })

  handle(CHANNELS.LOCK_FOLDER, async (event, repoPath: string, folderPath: string) => {
    return lockService.lockFolder(repoPath, folderPath, step => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handle(CHANNELS.UNLOCK_FOLDER_MINE, async (event, repoPath: string, folderPath: string) => {
    return lockService.unlockFolderMine(repoPath, folderPath, step => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
  })

  handleRead(CHANNELS.LFS_STATUS, async (_event, repoPath: string) => {
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
    // The renderer reloads locks immediately after this returns. Avoid a
    // duplicate remote `git lfs locks --json` round trip here.
    return gitService.lfsLocksMaintenance(repoPath, true)
  })

  handle(CHANNELS.LOCK_UNLOCK_BATCH, async (event, repoPath: string, targets: Array<{ filePath: string; force?: boolean; lockId?: string }>) => {
    if (targets.some(target => target.force)) await requireAdmin(repoPath)
    const result = await lockService.unlockFiles(repoPath, targets, '', '', step => {
      if (!event.sender.isDestroyed()) event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, step)
    })
    if (result.failed.length > 0 && !event.sender.isDestroyed()) {
      event.sender.send(CHANNELS.EVT_OPERATION_PROGRESS, { id: 'unlock-batch', label: 'Some unlocks failed', status: 'error', detail: `${result.failed.length} of ${targets.length} files failed to unlock` })
    }
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
    // GC only repairs/optimizes this local clone's object database. It does
    // not modify the remote repository, so GitHub admin permission is neither
    // required nor relevant. This also allows collaborators to use the stale
    // pack recovery action offered after a failed push.
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

  handle(CHANNELS.NOTIFICATION_DESKTOP_NOTIFY, async (_event, request: {
    event: 'appUpdate' | 'prResolved' | 'forceUnlock' | 'operationComplete' | 'fatalError' | 'conflictForecast' | 'lockOnDirtyFile'
    title: string
    body:  string
    urgent?: boolean
  }) => {
    desktopNotificationService.notify({
      event:  request.event,
      title:  request.title,
      body:   request.body,
      urgent: request.urgent,
    })
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

  handle(CHANNELS.GIT_OPEN_GLOBAL_CONFIG, async () => {
    const configPath = gitService.getGlobalGitConfigPath()
    const message = await shell.openPath(configPath)
    if (message) throw new Error(`Could not open global git config "${configPath}": ${message}`)
  })

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
    withUndo(repoPath, 'revert', 'Revert', () => runGitOp('Revert', () => gitService.revert(repoPath, hash, noCommit)))
  )

  handle(CHANNELS.GIT_CHERRY_PICK, (_event, repoPath: string, hash: string, noCommit?: boolean) =>
    withUndo(repoPath, 'cherry-pick', 'Cherry-pick', () => runGitOp('Cherry-pick', () => gitService.cherryPick(repoPath, hash, noCommit)))
  )

  handle(CHANNELS.GIT_CHERRY_PICK_IN_PROGRESS, async (_event, repoPath: string) => {
    const state = await gitService.cherryPickInProgress(repoPath)
    if (!state) return null
    const conflicts = await gitService.listInProgressCherryPickConflicts(repoPath)
    return { ...state, conflicts }
  })

  handle(CHANNELS.GIT_CHERRY_PICK_CONTINUE, async (_event, repoPath: string) => {
    await runGitOp('Finalize cherry-pick', () => gitService.continueCherryPick(repoPath))
  })

  handle(CHANNELS.GIT_CHERRY_PICK_ABORT, async (_event, repoPath: string) => {
    await runGitOp('Abort cherry-pick', () => gitService.abortCherryPick(repoPath))
  })

  handle(CHANNELS.GIT_INDEX_LOCK_INFO, async (_event, repoPath: string) => {
    return gitService.getIndexLockInfo(repoPath)
  })

  handle(CHANNELS.GIT_INDEX_LOCK_REMOVE, async (_event, repoPath: string) => {
    return gitService.removeIndexLock(repoPath)
  })

  handle(CHANNELS.GIT_AHEAD_FILE_PATHS, async (_event, repoPath: string) => {
    return gitService.aheadFilePaths(repoPath)
  })

  handle(CHANNELS.GIT_RESET_TO, async (_event, repoPath: string, hash: string, mode: 'soft' | 'mixed' | 'hard') => {
    if (mode === 'hard') await requireAdmin(repoPath)
    return withUndo(repoPath, 'reset', 'Reset', () => runGitOp('Reset', () => gitService.resetTo(repoPath, hash, mode)))
  })

  handleRead(CHANNELS.GIT_FILE_LOG, (_event, repoPath: string, filePath: string, limit?: number) =>
    gitService.log(repoPath, { limit: limit ?? 100, filePath })
  )

  handleRead(CHANNELS.GIT_BRANCH_ACTIVITY, (_event, repoPath: string) =>
    gitService.branchActivity(repoPath)
  )

  handleRead(CHANNELS.GIT_BRANCH_DIFF, (_event, repoPath: string, base: string, compare: string) =>
    gitService.branchDiff(repoPath, base, compare)
  )

  handleRead(CHANNELS.GIT_DEFAULT_BRANCH, (_event, repoPath: string) =>
    gitService.defaultBranch(repoPath)
  )

  handle(CHANNELS.GIT_BLAME, (_event, repoPath: string, filePath: string, rev: string) =>
    gitService.blame(repoPath, filePath, rev)
  )

  handleRead(CHANNELS.GIT_DIFF_COMMIT, (_event, repoPath: string, filePath: string, hash: string) =>
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

  handle(CHANNELS.FORECAST_PAUSE, () => {
    forecastService.pause()
  })

  handle(CHANNELS.FORECAST_RESUME, () => {
    forecastService.resume()
  })

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

  handle(CHANNELS.GITHUB_LIST_REPOS, async () => {
    const token = await authService.getCurrentToken()
    if (!token) throw new Error('Not authenticated with GitHub')
    return gitHubService.listRepos(token)
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

  handle(CHANNELS.PR_MONITOR_STATUS, async (_event, repoPath: string) => {
    return prMonitorService.getStatus(repoPath)
  })

  handle(CHANNELS.PR_MONITOR_RESOLVE, (_event, repoPath: string, prNumber: number) => {
    prMonitorService.markResolved(repoPath, prNumber)
  })

  handle(CHANNELS.UNDO_GET, (_event, repoPath: string) => {
    return undoService.peek(repoPath)
  })

  handle(CHANNELS.UNDO_LAST, async (_event, repoPath: string) => {
    return undoService.undo(repoPath)
  })

  handle(CHANNELS.SEARCH_REPO, async (_event, repoPath: string, query: string) => {
    return gitService.searchRepo(repoPath, query)
  })
}
