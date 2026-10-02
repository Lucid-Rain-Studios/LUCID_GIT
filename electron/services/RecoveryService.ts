import { app, BrowserWindow, shell } from 'electron'

let recovery: BrowserWindow | null = null
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Does not depend on the renderer bundle, preload, settings, or log initialization. */
export function showRecovery(message: string, retry: () => void): void {
  if (recovery && !recovery.isDestroyed()) { recovery.focus(); return }
  const window = new BrowserWindow({ width: 680, height: 420, show: true, title: 'Lucid Git recovery',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  recovery = window
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url === 'lucid-recovery://reload') { window.close(); retry() }
    else if (url === 'lucid-recovery://logs') void shell.openPath(app.getPath('userData'))
  })
  window.on('closed', () => { if (recovery === window) recovery = null })
  const html = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Lucid Git recovery</title>' +
    '<style>body{background:#131720;color:#e1e7ef;font:15px system-ui;padding:30px}pre{white-space:pre-wrap;max-height:180px;overflow:auto}a{display:inline-block;padding:10px;margin:8px;border:1px solid #6baaff;color:#9ec9ff}</style>' +
    '<h1>Lucid Git could not start</h1><p>Reload the app or open the log folder for troubleshooting.</p><pre>' + escapeHtml(message) +
    '</pre><a href="lucid-recovery://reload">Reload</a><a href="lucid-recovery://logs">Open log folder</a>'
  void window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(error => console.error('Recovery view failed to load:', error))
}
