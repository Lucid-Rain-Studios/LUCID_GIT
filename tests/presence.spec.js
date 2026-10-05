const { test, expect } = require('@playwright/test')
const path = require('path')
const { component, find, store } = require('./renderer-harness')
const { PresenceSession } = require('../dist-electron/services/PresenceSession')
const { CHANNELS } = require('../dist-electron/ipc/channels')
const flush = () => new Promise(resolve => setImmediate(resolve))
const status = component('src/lib/presence.ts').exports.presenceStatus

 test('app session publishes Active/Away/Offline across idle, lock, account and repository changes', () => {
  let identity = { login: 'alice', name: 'Alice' }, idle = 'active'
  const writes = []
  const session = new PresenceSession(() => identity, () => idle, (...args) => writes.push(args))
  session.start('one'); expect(writes.at(-1)[2].status).toBe('active')
  idle = 'idle'; session.tick(); expect(writes.at(-1)[2].status).toBe('away')
  idle = 'active'; session.setLocked(true); session.tick(); expect(writes.at(-1)[2].status).toBe('away')
  session.setLocked(false); session.tick(); expect(writes.at(-1)[2].status).toBe('active')
  session.start('two'); expect(writes.at(-2)[0]).toBe('one'); expect(writes.at(-2)[2].status).toBe('offline')
  identity = { login: 'bob', name: 'Bob' }; session.tick(); expect(writes.at(-1)[1]).toBe('alice'); expect(writes.at(-1)[2].status).toBe('offline')
  const count = writes.length; session.tick(); expect(writes.length).toBe(count)
  session.start('two'); identity = null; session.tick(); expect(writes.at(-1)[2].status).toBe('offline')
  expect(() => session.start('two')).toThrow('Sign in')
  for (const [, , entry] of writes) { expect(entry.modifiedFiles).toEqual([]); expect(entry.branch).toBe('') }
 })

 test('expired, invalid, future and legacy entries are Offline', () => {
  const now = Date.now(), entry = { lastSeen: new Date(now - 179999).toISOString(), status: 'active' }
  expect(status(entry, now)).toBe('active')
  expect(status({ ...entry, status: 'away' }, now)).toBe('away')
  expect(status(entry, now + 1)).toBe('offline')
  for (const lastSeen of ['invalid', new Date(now + 1).toISOString()]) expect(status({ ...entry, lastSeen }, now)).toBe('offline')
  expect(status({ ...entry, status: undefined }, now)).toBe('offline')
 })

 test('main presence samples 60-second inactivity once a minute and sends Offline immediately on quit', async () => {
  const handlers = new Map(), powerEvents = new Map(), appEvents = new Map()
  const timers = [], cleared = [], idleThresholds = [], writes = []
  let idleSeconds = 0, quits = 0, prevented = false
  const account = { userId: 'alice', login: 'alice', name: 'Alice' }
  const api = component('electron/ipc/handlers.ts', {
    path, './channels': { CHANNELS },
    electron: {
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      powerMonitor: {
        on: (name, fn) => powerEvents.set(name, fn),
        getSystemIdleState: threshold => { idleThresholds.push(threshold); return idleSeconds >= threshold ? 'idle' : 'active' },
      },
      app: { on: (name, fn) => appEvents.set(name, fn), quit: () => { quits++ } },
    },
    '../services/PresenceSession': { PresenceSession },
    '../services/AuthService': { authService: { listAccounts: () => ({ accounts: [account], currentAccountId: 'alice' }) } },
    '../services/FirebasePresenceService': { firebasePresenceService: {
      load: () => ({ enabled: true }),
      publish: async (_repo, entry) => { writes.push(entry.status) }, drain: async () => {},
    } },
    '../services/LogService': { logService: { error() {} } },
  }, {
    setInterval: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
    clearInterval: id => cleared.push(id), setTimeout: () => 0,
  }).exports
  api.registerHandlers()
  await handlers.get(CHANNELS.PRESENCE_UPDATE)({ sender: { isDestroyed: () => true } }, 'repo')
  expect(timers.map(timer => timer.delay)).toEqual([60000])
  expect(writes).toEqual(['active'])
  idleSeconds = 59; timers[0].callback(); expect(writes.at(-1)).toBe('active')
  idleSeconds = 60; timers[0].callback(); expect(writes.at(-1)).toBe('away')
  const count = writes.length
  powerEvents.get('lock-screen')(); powerEvents.get('unlock-screen')()
  expect(writes).toHaveLength(count)
  idleSeconds = 0; timers[0].callback(); expect(writes.at(-1)).toBe('active')
  expect(idleThresholds.every(threshold => threshold === 60)).toBe(true)
  const quitDrain = api.stopPresenceForQuit()
  expect(writes.at(-1)).toBe('offline')
  expect(cleared).toEqual([1]); expect(prevented).toBe(false)
  expect(appEvents.has('before-quit')).toBe(false)
  expect(api.stopPresenceForQuit()).toBe(quitDrain)
  await quitDrain; await flush(); expect(quits).toBe(0)
  await expect(handlers.get(CHANNELS.PRESENCE_UPDATE)({}, 'repo')).rejects.toThrow('shutting down')
 })

 test('presence IPC requires admin before reading data, including cache miss', async () => {
  const handlers = new Map(); let permission = 'write', fetched = 'read', reads = 0
  component('electron/ipc/handlers.ts', {
    path,
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    './channels': { CHANNELS },
    '../services/PermissionService': { permissionService: { getCachedPermission: () => permission, fetchPermission: async () => fetched } },
    '../services/FirebasePresenceService': { firebasePresenceService: { load: () => null } },
    '../services/PresenceService': { presenceService: { read: () => { reads++; return { entries: {} } } } },
    '../services/AuthService': { authService: { listAccounts: () => ({ currentAccountId: 'admin' }) } },
    '../services/LogService': { logService: { error() {} } },
  }).exports.registerHandlers()
  const event = { sender: { isDestroyed: () => true } }
  const read = () => handlers.get(CHANNELS.PRESENCE_READ)(event, 'repo')
  for (const value of ['read', 'write', null]) { permission = value; await expect(read()).rejects.toThrow('Admin access') }
  expect(reads).toBe(0)
  fetched = 'admin'; await read(); expect(reads).toBe(1)
  permission = 'admin'; await read(); expect(reads).toBe(2)
 })

function panel(read, auth = { isAdmin: () => true, currentAccountId: 'a' }) {
  const callbacks = [], intervals = []
  const api = component('src/components/presence/PresencePanel.tsx', {
    '@/ipc': { ipc: { presenceRead: read } },
    '@/stores/authStore': { useAuthStore: store(auth) },
    '@/lib/presence': { presenceStatus: status },
  }, { setInterval: (fn, delay) => { callbacks.push(fn); intervals.push(delay); return callbacks.length }, clearInterval() {} })
  return { api, callbacks, intervals }
}
const text = tree => JSON.stringify(tree)
 test('Team polls once a minute and explains idle, close and lost-heartbeat timing', async () => {
  let reads = 0
  const { api, callbacks, intervals } = panel(async () => { reads++; return { source: 'firebase', entries: {} } })
  api.render('PresencePanel', { repoPath: 'repo' }); api.effects[0](); await flush()
  expect(reads).toBe(1); expect(intervals).toEqual([60000])
  const tree = text(api.render('PresencePanel', { repoPath: 'repo' }))
  expect(tree).toContain('refreshes every 60 seconds')
  expect(tree).toContain('60 seconds when sampled')
  expect(tree).toContain('Closing the app sends Offline immediately')
  expect(tree).toContain('three minutes without an update')
  callbacks[0](); await flush(); expect(reads).toBe(2)
 })
 test('UI-036 distinguishes unavailable, empty and stale local sessions', async () => {
  let result = 'error'
  const { api } = panel(async () => {
    if (result === 'error') throw Error('disk unavailable')
    return { entries: result === 'empty' ? {} : { alice: { login: 'alice', name: 'Alice', status: 'active', lastSeen: '2020-01-01' } } }
  })
  api.render('PresencePanel', { repoPath: 'repo' }); api.effects[0](); await flush()
  expect(text(api.render('PresencePanel', { repoPath: 'repo' }))).toContain('Activity is unavailable')
  result = 'empty'; api.effects[0](); await flush()
  expect(text(api.render('PresencePanel', { repoPath: 'repo' }))).toContain('No local app sessions')
  result = 'stale'; api.effects[0](); await flush()
  const tree = api.render('PresencePanel', { repoPath: 'repo' })
  expect(text(tree)).toContain('Offline'); expect(text(tree)).toContain('Shared team presence is not connected')
 })
 test('non-admin panel never fetches and unmounted requests cannot publish data', async () => {
  let reads = 0, resolve
  const auth = { isAdmin: () => false, currentAccountId: 'a' }
  const { api } = panel(() => { reads++; return new Promise(r => { resolve = r }) }, auth)
  expect(text(api.render('PresencePanel', { repoPath: 'repo' }))).toContain('Admin access is required')
  api.effects[0](); expect(reads).toBe(0)
  auth.isAdmin = () => true; api.render('PresencePanel', { repoPath: 'repo' }); const cancel = api.effects[0]()
  cancel(); resolve({ entries: { secret: { login: 'secret' } } }); await flush()
  expect(text(api.render('PresencePanel', { repoPath: 'repo' }))).not.toContain('secret')
 })
 test('Team visibility migrates from Tools to Admin', () => {
  const api = component('src/components/layout/Sidebar.tsx', {}, {
    __privateExports: ['loadVisibility'],
    localStorage: { getItem: () => JSON.stringify({ tools: ['tools', 'presence'], admin: ['overview'] }) },
  })
  const visibility = api.exports.loadVisibility()
  expect(visibility.tools).not.toContain('presence'); expect(visibility.admin).toContain('presence')
 })
