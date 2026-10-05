const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const ts = require('typescript')

const flush = () => new Promise(resolve => setImmediate(resolve))

function launch({ response = 1, downloadError, packaged = true, checkError, version = '1.2.0', loadError, bootstrapError } = {}) {
  const listeners = {}, timers = [], dialogs = [], downloads = [], checks = []
  let ready
  const handlers = {}, events = [], recoveries = [], windowEvents = {}
  const CHANNELS = { UPDATE_CHECK: 'check', UPDATE_DOWNLOAD: 'download', EVT_UPDATE_ERROR: 'update-error', EVT_OPERATION_PROGRESS: 'progress' }
  const win = {
    webContents: { send: (...args) => events.push(args), on: (event, fn) => { windowEvents[event] = fn }, setWindowOpenHandler() {} },
    on() {}, once: (event, callback) => { if (event === 'ready-to-show') ready = callback },
    loadFile: () => loadError ? Promise.reject(Error(loadError)) : Promise.resolve(), loadURL: () => Promise.resolve(), show() {}, isDestroyed: () => false,
  }
  const updater = {
    on: (event, callback) => { listeners[event] = callback },
    checkForUpdates: async () => { checks.push(true); if(checkError) throw Error(checkError); return { updateInfo: { version } } },
    currentVersion: new (require('semver').SemVer)('1.2.0'),
    downloadUpdate: async () => { downloads.push(true); if (downloadError) throw new Error(downloadError) },
  }
  const noop = () => {}
  const service = new Proxy({}, { get: () => noop })
  const electron = {
    app: {
      isPackaged: packaged, getVersion: () => '1.2.0', getPath: () => 'test',
      whenReady: () => Promise.resolve(), on: noop, commandLine: { appendSwitch: noop },
    },
    BrowserWindow: function () { return win }, Menu: { setApplicationMenu: noop },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn } },
    dialog: { showMessageBox: async (_, options) => { dialogs.push(options); return { response } } },
  }
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../electron/main.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(source, {
    exports: {}, __dirname: '.', console,
    process: { platform: 'test', env: {}, resourcesPath: '.', on: noop, cwd: () => '.' },
    setTimeout: callback => { timers.push(callback) }, setInterval: noop, clearInterval: noop,
    require: name => {
      if (name === 'electron') return electron
      if (name === 'path') return path
      if (name === 'electron-updater') return { autoUpdater: updater }
      if (name === './ipc/channels') return { CHANNELS }
      if (name === './services/RecoveryService') return { showRecovery: (...args) => recoveries.push(args) }
      if (name === './ipc/handlers') return { registerHandlers: () => { if(bootstrapError) throw Error(bootstrapError) }, describeInFlightIpc: noop }
      if (name === './services/SettingsService') return {
        settingsService: { onChange: noop, getAll: () => ({ updateCheckIntervalMinutes: 0 }) },
      }
      return new Proxy({}, { get: (_, key) => key.endsWith('Service') ? service : noop })
    },
  })
  return { listeners, timers, dialogs, downloads, checks, handlers, events, recoveries, windowEvents, show: () => ready() }
}

test('startup checks even with periodic checks disabled; Later repeats next launch', async () => {
  for (let launchNumber = 0; launchNumber < 2; launchNumber++) {
    const app = launch()
    await flush()
    app.show()
    expect(app.timers).toHaveLength(1)
    app.timers[0]()
    await flush()
    expect(app.checks).toHaveLength(1)
    expect(app.dialogs).toHaveLength(0)
    app.listeners['update-available']({ version: '1.3.0' })
    await flush()
    expect(app.dialogs[0].message).toContain('1.3.0')
    expect(app.dialogs[0].detail).toContain('1.2.0')
    expect(app.downloads).toHaveLength(0)
    app.listeners['update-available']({ version: '1.3.0' })
    await flush()
    expect(app.dialogs).toHaveLength(1)
    app.listeners['update-available']({ version: '1.4.0' })
    await flush()
    expect(app.dialogs).toHaveLength(2)
  }
})

test('accepting starts a download and a failure shows retry guidance', async () => {
  for (const downloadError of [undefined, 'Network unavailable']) {
    const app = launch({ response: 0, downloadError })
    await flush()
    app.listeners['update-available']({ version: '1.3.0' })
    await flush()
    expect(app.downloads).toHaveLength(1)
    expect(app.dialogs).toHaveLength(downloadError ? 2 : 1)
    if (downloadError) expect(app.dialogs[1].detail).toContain('retry using the update banner')
  }
})

test('development startup does not check the release feed', async () => {
  const app = launch({ packaged: false })
  await flush()
  app.show()
  expect(app.timers).toHaveLength(0)
  expect(app.checks).toHaveLength(0)
})

test('LG-075 manual checks distinguish current, available and unreachable feeds; downloads terminate with errors', async () => {
  const current = launch(); await flush(); expect(await current.handlers.check()).toMatchObject({ available: false, source: 'release' })
  const newer = launch({ version: '1.3.0' }); await flush(); expect(await newer.handlers.check()).toMatchObject({ available: true })
  const offline = launch({ checkError: 'feed unavailable', downloadError: 'download failed' }); await flush()
  expect(await offline.handlers.check()).toMatchObject({ available: false, source: 'unavailable' })
  await expect(offline.handlers.download()).rejects.toThrow('download failed')
  expect(offline.events).toContainEqual(['update-error',expect.stringContaining('download failed')])
  expect(offline.events.find(e => e[0] === 'progress')[1].status).toBe('error')
  offline.listeners.error(Error('native download failure')); expect(offline.events).toContainEqual(['update-error','native download failure'])
})

test('LG-076 load, preload, crash and bootstrap errors open recovery independently of renderer IPC', async () => {
  const failed = launch({ loadError: 'bundle missing' }); await flush(); expect(failed.recoveries[0][0]).toContain('bundle missing')
  failed.windowEvents['preload-error']({}, 'preload.js', Error('preload broke')); expect(failed.recoveries.at(-1)[0]).toContain('preload broke')
  failed.windowEvents['render-process-gone']({}, { reason: 'crashed', exitCode: 1 }); expect(failed.recoveries.at(-1)[0]).toContain('crashed')
  const bootstrap = launch({ bootstrapError: 'settings initialization failed' }); await flush(); expect(bootstrap.recoveries[0][0]).toContain('initialization failed')
})
