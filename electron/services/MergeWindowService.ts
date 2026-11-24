import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'
import { CHANNELS } from '../ipc/channels'
import { attachTextContextMenu } from '../util/text-context-menu'
import { logService } from './LogService'
import type { MergeWindowContext, MergeWindowProgress } from '../mergeWindowTypes'

/** One repository-bound review window. A confirmed operation can hide it. */
export class MergeWindowService {
  private window: BrowserWindow | null = null
  private context: MergeWindowContext | null = null
  private allowClose = false
  private ready = false
  private progress: MergeWindowProgress | null = null

  constructor(private getParent: () => BrowserWindow | null, private canQuit: () => boolean) {}

  blocksWrite(sender: Electron.WebContents, repoPath: string): boolean {
    if (!this.window || !this.context || !this.progress || this.progress.phase === 'complete') return false
    const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    return sender !== this.window.webContents && normalize(repoPath) === normalize(this.context.repoPath)
  }

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
      if (this.progress?.phase === 'running') throw new Error('Wait for the merge operation to finish.')
      this.allowClose = true
      this.window.close()
    })
    ipcMain.handle(CHANNELS.MERGE_WINDOW_PROGRESS, (event, progress: MergeWindowProgress | null, hide: boolean) => {
      if (event.sender !== this.window?.webContents || !this.context) throw new Error('Only Merge can report its progress.')
      if (progress) {
        this.progress = progress
        this.getParent()?.webContents.send(CHANNELS.EVT_MERGE_WINDOW_PROGRESS, progress, this.context)
      }
      if (hide && this.progress?.phase === 'running') {
        this.window.hide()
        this.getParent()?.focus()
      }
    })
    ipcMain.handle(CHANNELS.MERGE_WINDOW_SHOW, event => {
      if (event.sender !== this.getParent()?.webContents) throw new Error('Only the main window can restore Merge.')
      this.show()
    })
  }

  /** Keep parent close from implicitly destroying an active review or Git write. */
  closeWithParent(event: { preventDefault(): void }): void {
    if (this.window && !this.canQuit()) {
      event.preventDefault()
      if (this.progress?.phase === 'running') return
      if (!this.window.isVisible()) {
        this.show()
        return
      }
      this.window.close()
    }
  }

  private show(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  private async open(parent: BrowserWindow, context: MergeWindowContext): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      this.show()
      return
    }
    this.context = { ...context }
    this.allowClose = false
    this.ready = false
    this.progress = null
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
      if (!parent.isDestroyed()) {
        if (this.progress?.phase !== 'complete') parent.webContents.send(CHANNELS.EVT_MERGE_WINDOW_PROGRESS, null, context)
        parent.webContents.send(CHANNELS.EVT_MERGE_WINDOW_CLOSED, context.repoPath)
      }
      this.progress = null
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
