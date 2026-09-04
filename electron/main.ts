import { app, BrowserWindow, Menu, shell, ipcMain } from 'electron'
import path from 'path'
import { autoUpdater } from 'electron-updater'
import { registerHandlers } from './ipc/handlers'
import { CHANNELS } from './ipc/channels'
import { watcherService } from './services/WatcherService'
import { logService } from './services/LogService'
import { desktopNotificationService } from './services/DesktopNotificationService'
import { settingsService } from './services/SettingsService'
import { killAllGitProcesses } from './util/dugite-exec'

const isDev = !app.isPackaged
const openDevToolsOnStart = process.env.LUCID_OPEN_DEVTOOLS === '1'

// Required on Windows so toast notifications are attributed to "Lucid Git"
// rather than electron.exe. Must match the AppUserModelId baked into the
// installer shortcut (electron-builder uses appId by default).
if (process.platform === 'win32') {
  app.setAppUserModelId('com.lucidrainstudios.lucidgit')
}

// ── Auto-updater setup ────────────────────────────────────────────────────────

autoUpdater.autoDownload     = false  // user explicitly initiates download
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.logger           = null   // suppress verbose logging in prod

let mainWin: BrowserWindow | null = null

function sendToRenderer(channel: string, ...args: unknown[]) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, ...args)
  }
}

autoUpdater.on('update-available', (info) => {
  sendToRenderer(CHANNELS.EVT_UPDATE_AVAILABLE, {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
  })
  desktopNotificationService.notify({
    event:  'appUpdate',
    title:  'Lucid Git update available',
    body:   `Version ${info.version} is ready to download.`,
    urgent: true,
  })
})

autoUpdater.on('download-progress', (progress) => {
  const pct = Math.round(progress.percent)
  sendToRenderer(CHANNELS.EVT_OPERATION_PROGRESS, {
    id:       'update-download',
    label:    `Downloading update ${pct}%`,
    status:   pct >= 100 ? 'done' : 'running',
    progress: pct,
    detail:   `${fmt(progress.transferred)} / ${fmt(progress.total)} · ${fmt(progress.bytesPerSecond)}/s`,
  })
})

autoUpdater.on('update-downloaded', () => {
  sendToRenderer(CHANNELS.EVT_UPDATE_READY)
})

autoUpdater.on('error', (err) => {
  // Treat update-check failures (private repo, 404, network errors) as benign:
  // log at info level so the user-facing flow stays silent.
  logService.info('updater', `Auto-updater check skipped: ${err.message}`)
  if (isDev) console.info('[updater]', err.message)
})

process.on('uncaughtException', (error) => {
  logService.error('main.uncaughtException', `${error.message}
Stack:
${error.stack ?? ''}`)
  desktopNotificationService.notify({
    event:  'fatalError',
    title:  'Lucid Git encountered an error',
    body:   error.message.length > 140 ? error.message.slice(0, 137) + '…' : error.message,
    urgent: true,
  })
})

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error
    ? `${reason.message}
Stack:
${reason.stack ?? ''}`
    : String(reason)
  logService.error('main.unhandledRejection', message)
  const display = reason instanceof Error ? reason.message : String(reason)
  desktopNotificationService.notify({
    event:  'fatalError',
    title:  'Lucid Git encountered an error',
    body:   display.length > 140 ? display.slice(0, 137) + '…' : display,
    urgent: true,
  })
})

function fmt(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`
  if (bytes < 1_048_576)   return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

// ── Periodic update checking ─────────────────────────────────────────────────

let updateCheckTimer: NodeJS.Timeout | null = null
let currentUpdateIntervalMs = 0

function silentCheckForUpdates(): void {
  autoUpdater.checkForUpdates().catch(() => { /* swallowed; the 'error' event already logs */ })
}

function applyUpdateCheckInterval(minutes: number): void {
  if (isDev) return
  const ms = Math.max(0, Math.floor(minutes)) * 60_000
  if (ms === currentUpdateIntervalMs) return
  currentUpdateIntervalMs = ms
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer)
    updateCheckTimer = null
  }
  if (ms > 0) {
    updateCheckTimer = setInterval(silentCheckForUpdates, ms)
  }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(): BrowserWindow {
  const iconPath = isDev
    ? path.join(process.cwd(), 'assets/icon.png')
    : path.join(process.resourcesPath, 'assets/icon.png')

  const win = new BrowserWindow({
    width:     1400,
    height:    900,
    minWidth:  900,
    minHeight: 600,
    backgroundColor: '#0d0f14',
    icon:      iconPath,
    frame:     false,
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false, // required for preload to use Node APIs
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  attachWindowDiagnostics(win)

  if (isDev) {
    win.loadURL('http://localhost:5173')
    if (openDevToolsOnStart) win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '../dist-renderer/index.html'))
  }

  win.once('ready-to-show', () => {
    win.show()
    // Check for updates 4 seconds after window is visible so startup isn't blocked,
    // then re-check on the user-configured interval.
    if (!isDev) {
      setTimeout(silentCheckForUpdates, 4000)
      applyUpdateCheckInterval(settingsService.getAll().updateCheckIntervalMinutes)
    }
  })

  mainWin = win

  win.on('closed', () => {
    watcherService.unwatchAll()
    mainWin = null
  })

  return win
}

function attachWindowDiagnostics(win: BrowserWindow): void {
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    const message = `Renderer failed to load ${validatedURL || '(unknown URL)'}: ${errorDescription} (${errorCode})`
    logService.error('renderer.load', message)
    if (isDev) console.error('[renderer.load]', message)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    const message = `Renderer process gone: ${details.reason} (exitCode ${details.exitCode})`
    logService.error('renderer.process', message)
    if (isDev) console.error('[renderer.process]', message)
  })

  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    const message = `Preload failed: ${preloadPath}\n${error.message}\nStack:\n${error.stack ?? ''}`
    logService.error('renderer.preload', message)
    if (isDev) console.error('[renderer.preload]', message)
  })

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (!message || /^Request Autofill\./.test(message)) return
    if (level < 2) return
    const source = sourceId ? `${sourceId}:${line}` : `line ${line}`
    const formatted = `${message}\nSource: ${source}`
    logService.error('renderer.console', formatted)
    if (isDev) console.log(`[renderer:${level}] ${message} (${source})`)
  })
}

// ── Window control IPC ────────────────────────────────────────────────────────

function registerWindowHandlers() {
  const handle = (channel: string, fn: () => unknown) => {
    ipcMain.handle(channel, async () => {
      try {
        return await fn()
      } catch (error) {
        const message = error instanceof Error ? `${error.message}\nStack:\n${error.stack ?? ''}` : String(error)
        logService.error(`ipc.${channel}`, message)
        throw error
      }
    })
  }

  handle(CHANNELS.WIN_MINIMIZE, () => { mainWin?.minimize() })
  handle(CHANNELS.WIN_MAXIMIZE_TOGGLE, () => {
    if (!mainWin) return
    if (mainWin.isMaximized()) mainWin.unmaximize()
    else mainWin.maximize()
  })
  handle(CHANNELS.WIN_CLOSE, () => { mainWin?.close() })
  handle(CHANNELS.WIN_IS_MAXIMIZED, () => mainWin?.isMaximized() ?? false)
}

// ── IPC handlers for updater ─────────────────────────────────────────────────
// Registered after app is ready so ipcMain is available

function registerUpdaterHandlers() {
  const handle = (channel: string, fn: () => unknown) => {
    ipcMain.handle(channel, async () => {
      try {
        return await fn()
      } catch (error) {
        const message = error instanceof Error ? `${error.message}\nStack:\n${error.stack ?? ''}` : String(error)
        logService.error(`ipc.${channel}`, message)
        throw error
      }
    })
  }

  handle(CHANNELS.UPDATE_CHECK, async () => {
    if (isDev) return { available: false, version: null as string | null, source: 'dev' as const }
    try {
      const result = await autoUpdater.checkForUpdates()
      return {
        available: !!result?.updateInfo?.version,
        version: result?.updateInfo?.version ?? null,
        source: 'release' as const,
      }
    } catch {
      // Silent failure (e.g., release feed unreachable or repo is private).
      return { available: false, version: null as string | null, source: 'unavailable' as const }
    }
  })

  handle(CHANNELS.UPDATE_DOWNLOAD, async () => {
    await autoUpdater.downloadUpdate()
  })

  handle(CHANNELS.UPDATE_INSTALL, () => {
    autoUpdater.quitAndInstall(false, true)
  })
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// Suppress GPU shader cache noise (cache_util_win.cc errors) and Autofill CDP noise.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication')

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  logService.init(app.getPath('userData'))
  registerHandlers()
  registerUpdaterHandlers()
  registerWindowHandlers()
  settingsService.onChange((next) => applyUpdateCheckInterval(next.updateCheckIntervalMinutes))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // Git children are not in our job object on Windows, so anything still
  // running outlives the app — and a `git.exe` waiting on a stalled transfer
  // keeps its `git-lfs.exe` filter process alive with it. Nothing is left to
  // read their output once we go, so end them here rather than letting them
  // accumulate across restarts. An index write cut short this way leaves
  // `.git/index.lock`, which the stale-lock recovery clears on next launch.
  killAllGitProcesses()
  logService.endSession()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
