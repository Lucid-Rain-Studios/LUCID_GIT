// Isolated desktop harness: production preload, renderer, IPC and Git services.
const { app, BrowserWindow } = require('electron')
const path = require('path')
let quitting = false
app.on('before-quit', () => { quitting = true })
app.setPath('userData', process.env.LUCID_MERGE_TEST_USER_DATA)
Object.defineProperty(app, 'isPackaged', { value: true })
app.whenReady().then(async () => {
  const dist = path.join(__dirname, '../../dist-electron')
  const { registerHandlers } = require(path.join(dist, 'ipc/handlers'))
  const { MergeWindowService } = require(path.join(dist, 'services/MergeWindowService'))
  const { logService } = require(path.join(dist, 'services/LogService'))
  logService.init(app.getPath('userData'), app.getVersion())
  registerHandlers()
  global.mergeTestGitService = require(path.join(dist, 'services/GitService')).gitService
  const parent = new BrowserWindow({
    width: 1000, height: 700, show: false,
    webPreferences: { preload: path.join(dist, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  })
  const service = new MergeWindowService(() => parent, () => quitting)
  service.register()
  parent.on('close', event => service.closeWithParent(event))
  await parent.loadURL('data:text/html,<title>Merge test parent</title><h1>Repository</h1>')
  parent.show()
}).catch(error => { console.error(error); app.exit(1) })
