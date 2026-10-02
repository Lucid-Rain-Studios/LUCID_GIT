const { test, expect } = require('@playwright/test')
const { DatabaseSync } = require('node:sqlite')
const fs = require('fs'), path = require('path')
const { component } = require('./renderer-harness')
const { git, tmpDir, cleanup, DIST } = require('./helpers')
const noop = () => {}
const databases = []
test.afterAll(() => { databases.forEach(db => db.close()); cleanup() })

function setup(legacy = false) {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  if (legacy) db.exec(`
    CREATE TABLE lock_events (id INTEGER PRIMARY KEY, repo_path TEXT, file_path TEXT, event_type TEXT, actor_login TEXT, actor_name TEXT, timestamp INTEGER, duration_ms INTEGER);
    CREATE TABLE conflict_events (id INTEGER PRIMARY KEY, repo_path TEXT, file_path TEXT, our_branch TEXT, their_branch TEXT, conflict_type TEXT, timestamp INTEGER, resolved INTEGER DEFAULT 0);
    INSERT INTO lock_events VALUES (1, 'repo', 'legacy.uasset', 'locked', 'owner', 'Owner', 1, 0);
    INSERT INTO conflict_events VALUES (1, 'repo', 'legacy.uasset', 'main', 'feature', 'content', 2, 0);
  `)
  const { runMigrations } = component('electron/db/migrations.ts').exports
  runMigrations(db)
  const { heatmapService } = component('electron/services/HeatmapService.ts', { '../db/database': { getDb: () => db } }).exports
  return { db, service: heatmapService, migrate: () => runMigrations(db) }
}
const event = (service, lockId, eventType, timestamp, filePath = 'Assets/file.uasset', actorLogin = 'owner') => service.recordLockEvent({
  repoPath: 'repo', filePath, lockId, eventType, timestamp, durationMs: 999999, actorLogin, actorName: actorLogin,
})

test('LG-081 migrations preserve ambiguous history without including it in observed statistics', () => {
  const { db, service, migrate } = setup(true); migrate()
  expect(db.prepare('SELECT source FROM conflict_events').get().source).toBe('legacy')
  expect(db.prepare('SELECT lock_id FROM lock_events').get().lock_id).toBe('')
  expect(service.computeHeatmap('repo', 0, 'folder').children).toEqual([])
  expect(service.getTimeline('repo', 'legacy.uasset', 0)).toEqual([])
  expect(db.prepare('SELECT COUNT(*) as n FROM conflict_events').get().n).toBe(1)
  expect(db.prepare('SELECT COUNT(*) as n FROM lock_events').get().n).toBe(1)
  service.recordConflictEvent({ repoPath: 'repo', filePath: 'observed.uasset', ourBranch: 'main', theirBranch: 'feature', conflictType: 'unmerged' })
  expect(service.topContended('repo', 0)[0]).toMatchObject({ path: 'observed.uasset', conflictCount: 1 })
  expect(service.getTimeline('repo', 'observed.uasset', 0)[0].source).toBe('conflict')
})

test('LG-081 lock identities deduplicate manual/poll records and average only completed pairs', () => {
  const { db, service } = setup()
  event(service, 'one', 'locked', 1000); event(service, 'one', 'locked', 1050)
  event(service, 'one', 'force-unlocked', 1100, undefined, 'admin'); event(service, 'one', 'unlocked', 1200)
  event(service, 'two', 'locked', 2000); event(service, 'two', 'unlocked', 2300)
  event(service, 'open', 'locked', 3000); event(service, 'unknown', 'unlocked', 4000)
  expect(service.topContended('repo', 0)[0]).toMatchObject({ lockCount: 3, meanDurationMs: 200, uniqueContributors: 1 })
  expect(db.prepare('SELECT COUNT(*) as n FROM lock_events').get().n).toBe(6)
  const timeline = service.getTimeline('repo', 'Assets/file.uasset', 0)
  expect(timeline.filter(e => e.eventType === 'force-unlocked')[0].durationMs).toBe(100)
  expect(timeline.find(e => e.timestamp === 4000).durationMs).toBe(0)
})

test('LG-081 completed pairs can cross the selected window and do not cross repository or file identities', () => {
  const { service } = setup(), now = Date.now(), day = 86400000
  event(service, 'across', 'locked', now - 2 * day)
  event(service, 'across', 'unlocked', now - day / 2)
  event(service, 'wrong-file', 'locked', now - 100, 'other/file.uasset')
  event(service, 'wrong-file', 'unlocked', now, 'Assets/file.uasset')
  expect(service.topContended('repo', 1).find(n => n.path === 'Assets/file.uasset')).toMatchObject({ lockCount: 0, meanDurationMs: 1.5 * day, uniqueContributors: 1 })
  expect(service.topContended('different-repo', 0)).toEqual([])
  expect(service.getTimeline('repo', 'Assets/file.uasset', 1).find(e => e.timestamp === now).durationMs).toBe(0)
})

test('LG-081 folder and type averages weight completed intervals without open-file dilution', () => {
  const { service } = setup()
  for (const [id, start] of [['one', 1000], ['two', 2000]]) { event(service, id, 'locked', start, 'Assets/a.uasset'); event(service, id, 'unlocked', start + 100, 'Assets/a.uasset') }
  event(service, 'three', 'locked', 3000, 'Assets/b.uasset'); event(service, 'three', 'unlocked', 3300, 'Assets/b.uasset')
  event(service, 'open', 'locked', 4000, 'Assets/c.uasset')
  expect(service.computeHeatmap('repo', 0, 'folder').children[0].meanDurationMs).toBe(167)
  expect(service.computeHeatmap('repo', 0, 'type').children[0].meanDurationMs).toBe(167)
})

test('LG-081 repeated previews never create history while a real conflicting merge records observed files', async () => {
  const { service, db } = setup(), dir = tmpDir('lg-heatmap-'), handlers = new Map()
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'base\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
  git(dir, 'checkout', '-qb', 'feature'); fs.writeFileSync(path.join(dir, 'file.txt'), 'feature\n'); git(dir, 'commit', '-am', 'feature', '-q')
  git(dir, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'file.txt'), 'main\n'); git(dir, 'commit', '-am', 'main', '-q')
  const { gitService } = require(path.join(DIST, 'services/GitService'))
  const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
  component('electron/ipc/handlers.ts', {
    electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }, './channels': { CHANNELS },
    '../services/GitService': { gitService }, '../services/HeatmapService': { heatmapService: service },
    '../services/UndoService': { undoService: { recordCheckpoint: noop, markAvailable: noop, discard: noop } },
    '../services/LogService': { logService: { error: noop, warn: noop } },
    '../util/repo-gate': { withRepoSlot: (_, __, fn) => fn() },
  }).exports.registerHandlers()
  const sender = { isDestroyed: () => true }, invoke = (channel, ...args) => handlers.get(channel)({ sender }, dir, ...args)
  for (let i = 0; i < 3; i++) expect((await invoke(CHANNELS.GIT_MERGE_PREVIEW, 'feature')).map(c => c.path)).toEqual(['file.txt'])
  expect(db.prepare('SELECT COUNT(*) as n FROM conflict_events').get().n).toBe(0)
  await expect(invoke(CHANNELS.GIT_MERGE, 'feature')).rejects.toThrow(/CONFLICT|Automatic merge failed/)
  expect(service.topContended(dir, 0)[0]).toMatchObject({ path: 'file.txt', conflictCount: 1 })
  await invoke(CHANNELS.GIT_MERGE_PREVIEW, 'feature')
  expect(db.prepare('SELECT COUNT(*) as n FROM conflict_events').get().n).toBe(1)
  await invoke(CHANNELS.GIT_MERGE_ABORT)
  await expect(invoke(CHANNELS.GIT_MERGE, 'missing-ref')).rejects.toThrow()
  expect(db.prepare('SELECT COUNT(*) as n FROM conflict_events').get().n).toBe(1)
})

test('LG-081 local lock actions and polling share IDs and distinguish a replacement on the same path', async () => {
  const { service, db } = setup(); let locks = [], now = 1000
  const lock = id => ({ id, path: 'Assets/file.uasset', owner: { login: 'owner', name: 'Owner' }, lockedAt: new Date(now).toISOString() })
  const { lockService } = component('electron/services/LockService.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    '../util/dugite-exec': { exec: async () => ({}), gitAuthArgs: () => [] },
    './AuthService': { authService: { getCurrentToken: async () => null, listAccounts: () => ({ accounts: [] }) } },
    './GitService': { gitService: { getRemoteUrl: async () => null } },
    './HeatmapService': { heatmapService: service }, './NotificationService': { notificationService: { push: () => ({}) } },
    './WebhookService': { webhookService: { send: async () => {} } },
  }, { Date: { now: () => now }, setInterval: () => 1, clearInterval: noop }).exports
  lockService.listLocksUnguarded = async () => locks
  lockService.startPolling('repo'); await new Promise(r => setImmediate(r))
  locks = [lock('one')]; await lockService.lockFile('repo', 'Assets/file.uasset'); await lockService.poll('repo')
  now = 1100; locks = []; await lockService.unlockFile('repo', 'Assets/file.uasset', true, 'one'); await lockService.poll('repo')
  expect(db.prepare('SELECT COUNT(*) as n FROM lock_events').get().n).toBe(2)
  now = 2000; locks = [lock('two')]; await lockService.poll('repo')
  now = 3000; locks = [lock('three')]; await lockService.poll('repo')
  expect(service.topContended('repo', 0)[0]).toMatchObject({ lockCount: 3, meanDurationMs: 550 })
  expect(db.prepare('SELECT lock_id FROM lock_events ORDER BY id').all().map(r => r.lock_id)).toEqual(['one', 'one', 'two', 'three', 'two'])
  lockService.stopPolling('repo')
})
