import { app, BrowserWindow, Menu, shell, ipcMain } from 'electron'
import path from 'path'
import { autoUpdater } from 'electron-updater'
import { registerHandlers } from './ipc/handlers'
import { CHANNELS } from './ipc/channels'
import { watcherService } from './services/WatcherService'
import { logService } from './services/LogService'

const isDev = !app.isPackaged

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
  // Silently ignore update errors — don't surface to user unless they triggered a manual check
  if (isDev) console.error('[updater]', err.message)
})

function fmt(bytes: number): string {
  if (bytes < 1024)        return `${bytes} B`
  if (bytes < 1_048_576)   return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
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

  if (isDev) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '../dist-renderer/index.html'))
  }

  win.once('ready-to-show', () => {
    win.show()
    // Check for updates 4 seconds after window is visible so startup isn't blocked
    if (!isDev) {
      setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000)
    }
  })

  mainWin = win

  win.on('closed', () => {
    watcherService.unwatchAll()
    mainWin = null
  })

  return win
}

// ── Window control IPC ────────────────────────────────────────────────────────

function registerWindowHandlers() {
  ipcMain.handle(CHANNELS.WIN_MINIMIZE, () => { mainWin?.minimize() })
  ipcMain.handle(CHANNELS.WIN_MAXIMIZE_TOGGLE, () => {
    if (!mainWin) return
    mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize()
  })
  ipcMain.handle(CHANNELS.WIN_CLOSE, () => { mainWin?.close() })
  ipcMain.handle(CHANNELS.WIN_IS_MAXIMIZED, () => mainWin?.isMaximized() ?? false)
}

// ── IPC handlers for updater ─────────────────────────────────────────────────
// Registered after app is ready so ipcMain is available

function registerUpdaterHandlers() {
  const { ipcMain } = require('electron')

  ipcMain.handle(CHANNELS.UPDATE_CHECK, async () => {
    if (isDev) return
    await autoUpdater.checkForUpdates()
  })

  ipcMain.handle(CHANNELS.UPDATE_DOWNLOAD, async () => {
    await autoUpdater.downloadUpdate()
  })

  ipcMain.handle(CHANNELS.UPDATE_INSTALL, () => {
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
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  logService.endSession()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
