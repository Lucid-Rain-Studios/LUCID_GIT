import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import { CHANNELS } from '../ipc/channels'
import { attachTextContextMenu } from '../util/text-context-menu'
import { logService } from './LogService'
import type { MergeWindowContext } from '../mergeWindowTypes'

/** One repository-bound review window. The parent is disabled while it is open. */
export class MergeWindowService {
  private window: BrowserWindow | null = null
  private context: MergeWindowContext | null = null
  private allowClose = false
  private ready = false

  constructor(private getParent: () => BrowserWindow | null, private canQuit: () => boolean) {}

  register(): void {
    ipcMain.handle(CHANNELS.MERGE_WINDOW_OPEN, async (event, context: MergeWindowContext) => {
      const parent = this.getParent()
      if (!parent || event.sender !== parent.webContents) throw new Error('Only the main window can open Merge.')
      if (!context || ![context.repoPath, context.targetBranch, context.currentBranch].every(v => typeof v === 'string' && v.length > 0)) {
        throw new Error('Merge requires a repository and both branches.')
      }
      await this.open(parent, context)
    })
    ipcMain.handle(CHANNELS.MERGE_WINDOW_CONTEXT, event => {
      if (event.sender !== this.window?.webContents) throw new Error('Merge window is unavailable.')
      this.ready = true
      return this.context
    })
    ipcMain.handle(CHANNELS.MERGE_WINDOW_CLOSE, event => {
      if (event.sender !== this.window?.webContents) throw new Error('Only Merge can close its window.')
      this.allowClose = true
      this.window.close()
    })
  }

  /** Keep parent close from implicitly destroying an active review or Git write. */
  closeWithParent(event: { preventDefault(): void }): void {
    if (this.window && !this.canQuit()) {
      event.preventDefault()
      this.window.close()
    }
  }

  private async open(parent: BrowserWindow, context: MergeWindowContext): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore()
      this.window.focus()
      return
    }
    this.context = { ...context }
    this.allowClose = false
    this.ready = false
    const win = new BrowserWindow({
      parent, modal: true, title: `Merge ${context.targetBranch} → ${context.currentBranch} — Lucid Git`,
      width: 1000, height: 780, minWidth: 640, minHeight: 480,
      backgroundColor: '#0d0f14', show: false, autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    })
    this.window = win
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // This window has a fixed entrypoint and must keep its repository context.
    win.webContents.on('will-navigate', event => event.preventDefault())
    attachTextContextMenu(win)
    win.once('ready-to-show', () => win.show())
    win.on('close', event => {
      if (this.allowClose || !this.ready || this.canQuit()) return
      event.preventDefault()
      win.webContents.send(CHANNELS.EVT_MERGE_WINDOW_CLOSE_REQUEST)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      logService.error('merge.renderer', `Merge window stopped: ${details.reason}. Any unfinished merge can be resumed.`)
      this.allowClose = true
      win.close()
    })
    win.on('closed', () => {
      this.window = null
      this.context = null
      if (!parent.isDestroyed()) parent.webContents.send(CHANNELS.EVT_MERGE_WINDOW_CLOSED, context.repoPath)
    })
    try {
      if (!app.isPackaged) {
        await win.loadURL('http://localhost:5173/?window=merge')
      } else {
        await win.loadFile(path.join(__dirname, '../../dist-renderer/index.html'), { query: { window: 'merge' } })
      }
    } catch (error) {
      this.allowClose = true
      if (!win.isDestroyed()) win.close()
      throw error
    }
  }
}
