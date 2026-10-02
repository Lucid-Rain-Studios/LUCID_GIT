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
  const now = Date.now(), entry = { lastSeen: new Date(now - 89999).toISOString(), status: 'active' }
  expect(status(entry, now)).toBe('active')
  expect(status({ ...entry, status: 'away' }, now)).toBe('away')
  expect(status(entry, now + 1)).toBe('offline')
  for (const lastSeen of ['invalid', new Date(now + 1).toISOString()]) expect(status({ ...entry, lastSeen }, now)).toBe('offline')
  expect(status({ ...entry, status: undefined }, now)).toBe('offline')
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
  const callbacks = []
  const api = component('src/components/presence/PresencePanel.tsx', {
    '@/ipc': { ipc: { presenceRead: read } },
    '@/stores/authStore': { useAuthStore: store(auth) },
    '@/lib/presence': { presenceStatus: status },
  }, { setInterval: fn => { callbacks.push(fn); return callbacks.length }, clearInterval() {} })
  return { api, callbacks }
}
const text = tree => JSON.stringify(tree)
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
