const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { tmpDir, cleanup, git, DIST } = require('./helpers')
const { component, find, store } = require('./renderer-harness')
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const noop = () => {}
const logger = { info: noop, warn: noop, error: noop }
test.afterAll(cleanup)

test('LG-078 atomic stores recover schema-valid backups and preserve originals on failed replacement', async () => {
  const { readJson, writeJson, writeJsonAsync } = require(path.join(DIST, 'util/json-store'))
  const file = path.join(tmpDir('lg-json-'), 'state.json'), valid = v => typeof v.name === 'string'
  writeJson(file, { name: 'first' }); await writeJsonAsync(file, { name: 'second' })
  fs.writeFileSync(file, '{broken'); expect(readJson(file, valid, {})).toEqual({ name: 'first' })
  await writeJsonAsync(file, { name: 'recovered' }); expect(JSON.parse(fs.readFileSync(file + '.bak'))).toEqual({ name: 'first' })
  fs.writeFileSync(file, JSON.stringify({ name: 42 })); expect(readJson(file, valid, {})).toEqual({ name: 'first' })
  writeJson(file, { name: 'fixed' }); expect(JSON.parse(fs.readFileSync(file + '.bak'))).toEqual({ name: 'first' })
  const original = fs.readFileSync(file, 'utf8'), rename = fs.promises.rename
  fs.promises.rename = async (from, to) => { if (to === file) throw Error('disk full'); return rename(from, to) }
  try { await expect(writeJsonAsync(file, { name: 'lost' })).rejects.toThrow('disk full') } finally { fs.promises.rename = rename }
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
  expect(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith('.tmp'))).toEqual([])
  fs.unlinkSync(file + '.bak'); fs.writeFileSync(file, '{broken')
  expect(() => readJson(file, valid, {})).toThrow('preserved for recovery')
})

test('LG-065 concurrent settings patches retain unrelated and nested fields and reject invalid values', async () => {
  const dir = tmpDir('lg-settings-')
  const { settingsService } = component('electron/services/SettingsService.ts', { electron: { app: { getPath: () => dir } } }).exports
  await Promise.all([settingsService.save({ fontSize: 16 }), settingsService.save({ autoFetchIntervalMinutes: 7 }),
    settingsService.save({ desktopNotificationEvents: { appUpdate: false } }), settingsService.save({ desktopNotificationEvents: { fatalError: false } })])
  expect(settingsService.getAll()).toMatchObject({ fontSize: 16, autoFetchIntervalMinutes: 7, desktopNotificationEvents: { appUpdate: false, fatalError: false, forceUnlock: true } })
  await expect(settingsService.save({ featureVisibility: { lfs: 'invalid' } })).rejects.toThrow('Invalid settings')
  expect(settingsService.getAll().featureVisibility.lfs).toBe('auto')
})

test('LG-034 permissions deduplicate by account and never inherit another account’s admin cache', async () => {
  const dir = tmpDir('lg-permissions-'); let current = 'A', requests = 0, fail = false
  const wait = deferred()
  const { permissionService: service } = component('electron/services/PermissionService.ts', {
    electron: { app: { getPath: () => dir } }, './AuthService': { authService: {
      listAccounts: () => ({ currentAccountId: current, accounts: [{ userId: 'A', login: 'a' }, { userId: 'B', login: 'b' }] }), getToken: async id => id,
    } }, './GitService': { gitService: { getRemoteUrl: async () => 'https://github.com/team/repo.git' } },
    '../util/network': { boundedFetch: async () => { requests++; if (fail) throw Error('offline'); await wait.promise; return { ok: true, json: async () => ({ permissions: { admin: true } }) } } },
  }, { URL }).exports
  const a = service.fetchPermission('repo'), b = service.fetchPermission('repo'); await flush(); wait.resolve(); await Promise.all([a, b])
  expect(requests).toBe(1); expect(service.isAdmin('repo')).toBe(true)
  current = 'B'; expect(service.getCachedPermission('repo')).toBeNull(); fail = true
  expect(await service.fetchPermission('repo')).toBe('write'); expect(service.isAdmin('repo')).toBe(false)
  current = 'A'; const data = JSON.parse(fs.readFileSync(path.join(dir, 'permissions.json')))
  Object.values(data.cache).forEach(e => { e.fetchedAt = 0 }); fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify(data))
  expect(await service.fetchPermission('repo')).toBe('write')
})

test('LG-038/040 failed refresh keeps real locks, raw polling preserves overlays and real ownership wins', async () => {
  const real = { id: 'real', path: 'shared', owner: { login: 'owner' } }; let failed = false, prs = [{ number: 1, updatedAt: '', headSha: 'sha' }]
  const { useLockStore: locks } = component('src/stores/lockStore.ts', {
    zustand: require('zustand'), './repoStore': { useRepoStore: store({ repoPath: 'repo' }), repoSessionVersion: () => 1 },
    '@/ipc': { ipc: { listLocks: async () => { if (failed) throw Error('offline'); return [real] }, getRemoteUrl: async () => 'https://github.com/o/r.git',
      githubListPRs: async () => prs, githubPrFiles: async () => ['shared', 'predicted'], unlockFile: async () => { throw Error('unlock rejected') } } },
  }).exports
  await locks.getState().loadLocks('repo'); expect(locks.getState().locks.find(l => l.path === 'shared')).toEqual(real)
  locks.getState().setLocks([real]); expect(locks.getState().locks.map(l => l.path)).toEqual(['shared', 'predicted'])
  failed = true; await locks.getState().loadLocks('repo'); expect(locks.getState().error).toContain('stale'); expect(locks.getState().locks).toHaveLength(2)
  await expect(locks.getState().unlockFile('repo', 'shared')).rejects.toThrow('unlock rejected'); expect(locks.getState().locks).toContainEqual(real)
  failed = false; prs = []; await locks.getState().loadLocks('repo'); expect(locks.getState().locks).toEqual([real])
})

test('LG-029 batch eligibility rejects foreign LFS locks and avoids lock requests for text files', async () => {
  let lists = 0, attrs = '', checks = 0
  const { lockService } = component('electron/services/LockService.ts', {
    '../util/dugite-exec': { execWithStdin: async () => { checks++; return { stdout: attrs } } },
    './AuthService': { authService: { listAccounts: () => ({ currentAccountId: 'me', accounts: [{ userId: 'me', login: 'me' }] }) } },
  }).exports
  lockService.listLocks = async () => { lists++; return [{ id: 'foreign', path: 'asset.uasset', owner: { login: 'other', name: 'Other' } }] }
  await lockService.assertStageAllowed('repo', ['text.txt']); expect(lists).toBe(0)
  attrs = 'asset.uasset\0filter\0lfs\0text.txt\0filter\0unspecified\0'
  await expect(lockService.assertStageAllowed('repo', ['asset.uasset', 'text.txt'])).rejects.toThrow('Other')
  expect(checks).toBe(2); expect(lists).toBe(1)
  const { canStagePath } = component('src/lib/staging.ts').exports
  expect(canStagePath('asset.uasset', [{ path: 'asset.uasset', owner: { login: 'other' } }], 'me')).toBe(false)
})

test('LG-038 lock polling reports failure without inventing removals or unlock notifications', async () => {
  const events = [], notifications = [], original = [{ id: 'lock', path: 'asset', owner: { name: 'Other' } }]
  const { lockService } = component('electron/services/LockService.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (...args) => events.push(args) } }] } },
    '../ipc/channels': { CHANNELS: { EVT_LOCK_CHANGED: 'locks' } }, './AuthService': { authService: { listAccounts: () => ({ accounts: [] }) } },
    './DesktopNotificationService': { desktopNotificationService: { notify: opts => notifications.push(opts) } },
  }, { setInterval: () => 1, clearInterval: noop }).exports
  lockService.listLocks = async () => original; lockService.startPolling('repo'); await flush()
  lockService.listLocks = async () => { throw Error('malformed response') }; await lockService.poll('repo')
  expect(events[0][1]).toMatchObject({ repoPath: 'repo', locks: original, error: expect.stringContaining('malformed') })
  expect(lockService.prevLocks.get('repo')).toEqual(original); expect(notifications).toEqual([]); lockService.stopPolling('repo')
})

test('LG-043/045 forecast skips occupied gates, retains freshness on failed fetch and drops stopped-repo results', async () => {
  const events = []; let busy = true, fetched = 0, pending
  const { forecastService: service } = component('electron/services/ForecastService.ts', {
    '../util/repo-gate': { repoSlotState: () => ({ activeWrite: busy, activeReads: 0, waiting: 0 }), withRepoSlot: async (_, __, fn) => fn() },
    './GitService': { gitService: { fetch: async () => { fetched++; if (pending) return pending.promise; throw Error('private repo unavailable') } } },
    electron: { BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (...args) => events.push(args) } }] } },
    '../ipc/channels': { CHANNELS: { EVT_FORECAST_CONFLICT: 'forecast' } },
  }).exports
  const status = { repoPath: 'A', enabled: true, lastPolledAt: 123, conflicts: [] }; service.status.set('A', status)
  await service.poll('A'); expect(fetched).toBe(0)
  busy = false; await service.poll('A'); expect(status.lastPolledAt).toBe(123); expect(events[0][1].error).toContain('unavailable')
  pending = deferred(); const old = service.poll('A'); service.stop('A'); pending.resolve(); await old
  expect(events).toHaveLength(1); expect(events[0][1].repoPath).toBe('A')
})

test('LG-048 watchers resolve external worktree metadata, preserve tracked generated paths and debounce bursts', async () => {
  const watchers = [], timers = new Map(); let changes = 0, timer = 0
  const { watcherService: service } = component('electron/services/WatcherService.ts', {
    'node:fs': { watch: (root, _, callback) => { watchers.push({ root, callback }); return { on: noop, close: noop } } },
    '../util/dugite-exec': { exec: async args => ({ stdout: args.includes('--absolute-git-dir') ? 'H:/main/.git/worktrees/linked' : args.includes('--git-common-dir') ? 'H:/main/.git' : 'Intermediate/tracked.txt\0' }) }, './LogService': { logService: logger },
  }, { process: { platform: 'win32' }, setTimeout: fn => { timers.set(++timer, fn); return timer }, clearTimeout: id => timers.delete(id) }).exports
  await service.watch('H:/linked', () => changes++)
  expect(watchers.map(w => w.root.replace(/\\/g, '/'))).toEqual(['H:/linked', 'H:/main/.git/worktrees/linked', 'H:/main/.git'])
  watchers[0].callback('change', 'Intermediate/generated.tmp'); expect(timers.size).toBe(0)
  watchers[0].callback('change', 'Intermediate/tracked.txt'); watchers[1].callback('change', 'HEAD'); watchers[2].callback('change', 'packed-refs')
  expect(timers.size).toBe(1); [...timers.values()][0](); expect(changes).toBe(1); service.unwatchAll()
})

test('LG-049 failed closure follow-up remains pending and concurrent retries notify only once', async () => {
  const dir = tmpDir('lg-monitor-'), emitted = [], desktop = []
  let failed = true
  const { notificationService } = component('electron/services/NotificationService.ts', { electron: { app: { getPath: () => dir } } }).exports
  const { prMonitorService: service } = component('electron/services/PRMonitorService.ts', {
    electron: { app: { getPath: () => dir }, BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (_, n) => emitted.push(n) } }] } },
    './NotificationService': { notificationService }, './DesktopNotificationService': { desktopNotificationService: { notify: n => desktop.push(n) } },
    './AuthService': { authService: { getCurrentToken: async () => 'token', listAccounts: () => ({ currentAccountId: '1', accounts: [{ userId: '1', login: 'me' }] }) } },
    './GitHubService': { gitHubService: { getPRStatus: async () => ({ state: 'closed', merged: true, title: 'PR' }) } },
    './GitService': { gitService: { status: async () => { if (failed) throw Error('unknown status'); return [] } } },
    './LockService': { lockService: { listLocks: async () => [{ id: '1', path: 'asset', owner: { login: 'me' } }] } },
  }).exports
  service.recordPR('repo', 12, 'o', 'r', ['asset'], 'PR'); await service.check('repo', { owner: 'o', repo: 'r' })
  const file = path.join(dir, 'prMonitor-' + crypto.createHash('md5').update('repo').digest('hex').slice(0,8) + '.json')
  expect(JSON.parse(fs.readFileSync(file)).trackedPRs['12']).toMatchObject({ state: 'closed-merged', followupPending: true }); expect(emitted).toEqual([])
  failed = false; await Promise.all([service.check('repo', { owner: 'o', repo: 'r' }), service.check('repo', { owner: 'o', repo: 'r' })])
  expect(emitted).toHaveLength(1); expect(desktop).toHaveLength(1); expect(notificationService.list('repo')).toHaveLength(1)
  expect(JSON.parse(fs.readFileSync(file)).trackedPRs['12'].followupPending).toBe(false)
})

test('LG-050/051 blob and worktree identities change while oversized previews report limits before reading', async () => {
  const dir = tmpDir('lg-assets-'), cache = tmpDir('lg-cache-')
  git(dir,'init','-qb','main'); git(dir,'config','user.name','Test'); git(dir,'config','user.email','test@example.com')
  const file = path.join(dir, 'asset.bin'); fs.writeFileSync(file, 'before'); git(dir,'add','.'); git(dir,'commit','-qm','initial')
  const { assetDiffService: service } = component('electron/services/AssetDiffService.ts', {
    os: { homedir: () => cache }, '../util/dugite-exec': require(path.join(DIST,'util/dugite-exec')),
  }, { Buffer, process, setImmediate }).exports
  const head = await service.identity(dir,'asset.bin','HEAD'), working = await service.identity(dir,'asset.bin','WORKING')
  fs.writeFileSync(file, 'after!'); const changed = await service.identity(dir,'asset.bin','WORKING'); expect(changed.key).not.toBe(working.key)
  git(dir,'add','.'); expect((await service.identity(dir,'asset.bin','INDEX')).key).not.toBe(head.key)
  git(dir,'commit','-qm','changed'); expect((await service.identity(dir,'asset.bin','HEAD')).key).not.toBe(head.key)
  const historical = await service.identity(dir,'asset.bin','HEAD~1'); expect(historical.key).toBe(head.key)
  const oversized = path.join(dir,'large.bin'); const fd = fs.openSync(oversized,'w'); fs.ftruncateSync(fd, 256*1024*1024+1); fs.closeSync(fd)
  const result = await service.extractBlob(dir,'large.bin','WORKING',cache,'left')
  expect(result.blobPath).toBeNull(); expect(result.reason).toContain('256 MB')
  const missing = await service.extractBlob(dir,'missing.bin','HEAD',cache,'right'); expect(missing.reason).toContain('Git asset unavailable')
})

test('LG-053 working dependency edits invalidate completed scans and failed assets retry without rescanning good ones', async () => {
  const { DatabaseSync } = require('node:sqlite'), sql = new DatabaseSync(':memory:')
  sql.exec('CREATE TABLE dep_nodes (cache_key TEXT, package_name TEXT, file_path TEXT, asset_class TEXT, hard_refs TEXT, soft_refs TEXT, PRIMARY KEY(cache_key, package_name))')
  const db = { exec: text => sql.exec(text), prepare: text => sql.prepare(text), transaction: fn => (...args) => { sql.exec('BEGIN'); try { const result = fn(...args); sql.exec('COMMIT'); return result } catch(e) { sql.exec('ROLLBACK'); throw e } } }
  const dir = tmpDir('lg-deps-'); fs.writeFileSync(path.join(dir,'good.uasset'), '/Game/Before\0'); fs.writeFileSync(path.join(dir,'retry.uasset'), '/Game/Retry\0')
  let fail = false, opens = 0
  const testFs = { ...fs, promises: { ...fs.promises, open: async (...args) => { opens++; if(fail && args[0].endsWith('retry.uasset')) throw Error('sharing violation'); return fs.promises.open(...args) } } }
  const { dependencyService: service } = component('electron/services/DependencyService.ts', {
    fs: testFs, '../db/database': { getDb: () => db }, '../util/dugite-exec': { execSafe: async () => ({ exitCode: 0, stdout: 'good.uasset\0retry.uasset\0' }) },
  }, { Buffer, setImmediate }).exports
  await service.buildGraph(dir, noop); const first = opens; await service.buildGraph(dir,noop); expect(opens).toBe(first)
  fs.writeFileSync(path.join(dir,'good.uasset'), '/Game/After\0'); await service.buildGraph(dir,noop); expect(opens).toBe(first+1)
  expect(sql.prepare('SELECT hard_refs FROM dep_nodes WHERE file_path = ?').get('good.uasset').hard_refs).toContain('/Game/After')
  fs.writeFileSync(path.join(dir,'retry.uasset'), '/Game/Changed\0'); fail = true; await expect(service.buildGraph(dir,noop)).rejects.toThrow('incomplete')
  expect(sql.prepare('SELECT complete FROM dep_scans').get().complete).toBe(0)
  const beforeRetry = opens; fail = false; await service.buildGraph(dir,noop); expect(opens).toBe(beforeRetry+1)
  expect(sql.prepare('SELECT complete FROM dep_scans').get().complete).toBe(1); sql.close()
})

test('LG-056/063 managed hooks compose with user scripts and validated policy applies local LFS attributes', async () => {
  const dir = tmpDir('lg-policy-'); git(dir,'init','-q'); git(dir,'config','user.name','Test'); git(dir,'config','user.email','test@example.com')
  const { hookService } = require(path.join(DIST,'services/HookService'))
  const userHook = path.join(dir,'.git/hooks/pre-commit'); fs.writeFileSync(userHook,'#!/bin/sh\necho user >> hook-runs\n', { mode: 0o755 })
  const { teamConfigService: service } = component('electron/services/TeamConfigService.ts', {
    './HookService': { hookService }, './GitService': { gitService: require(path.join(DIST,'services/GitService')).gitService },
    './WebhookService': { webhookService: { loadConfig: () => null } },
  }).exports
  await expect(service.apply(dir, { lfsPatterns: ['--bad'], hookIds: [], webhookEvents: {} })).rejects.toThrow('Invalid team policy')
  await service.apply(dir, { lfsPatterns: ['*.uasset'], hookIds: ['file-size-guard','uasset-lfs-check'], webhookEvents: {} })
  expect(fs.readFileSync(path.join(dir,'.gitattributes'),'utf8')).toContain('*.uasset filter=lfs')
  expect(fs.readFileSync(userHook+'.lucid-user','utf8')).toContain('echo user')
  const managed = path.join(dir,'.git/hooks/lucid-git'); fs.writeFileSync(path.join(managed,'file-size-guard'),'#!/bin/sh\necho size >> hook-runs\n'); fs.writeFileSync(path.join(managed,'uasset-lfs-check'),'#!/bin/sh\necho asset >> hook-runs\n')
  fs.writeFileSync(path.join(dir,'file.txt'),'x'); git(dir,'add','.'); git(dir,'commit','-qm','checks')
  expect(fs.readFileSync(path.join(dir,'hook-runs'),'utf8').trim().split('\n')).toEqual(['user','size','asset'])
})

test('LG-057/059 PR reads paginate and deduplicate; merges send reviewed SHA and reject merged:false', async () => {
  let reads = 0, body, merge = false
  const { gitHubService: service } = component('electron/services/GitHubService.ts', {
    './LogService': { logService: logger }, '../util/network': { boundedFetch: async (url, options) => {
      if(options.method === 'PUT') { body = JSON.parse(options.body); return { ok: true, json: async () => ({ merged: merge, message: 'Head changed' }) } }
      reads++; const page = Number(new URL(url).searchParams.get('page'))
      const batch = Array.from({ length: page === 1 ? 100 : 2 }, (_, i) => url.includes('/files?') ? { filename: 'file-'+page+'-'+i } : {
        number:page*100+i,title:'PR',html_url:'',user:{login:'a'},head:{ref:'head',sha:'a'.repeat(40)},base:{ref:'main',sha:'b'.repeat(40)},updated_at:'',created_at:'',draft:false,
      })
      return { ok: true, json: async () => batch }
    } },
  }, { AbortController }).exports
  expect(await service.listPRs('token',{owner:'o',repo:'r'})).toHaveLength(102)
  const a = service.getPRFiles('token',{owner:'o',repo:'r',prNumber:1}), b = service.getPRFiles('token',{owner:'o',repo:'r',prNumber:1})
  expect((await Promise.all([a,b]))[0]).toHaveLength(102); expect(reads).toBe(4)
  await expect(service.mergePR('token',{owner:'o',repo:'r',prNumber:1,expectedSha:'a'.repeat(40)})).rejects.toThrow('Head changed')
  expect(body.sha).toBe('a'.repeat(40)); merge = true; await service.mergePR('token',{owner:'o',repo:'r',prNumber:1,expectedSha:'a'.repeat(40)})
})

test('LG-062/064 settings expose only implemented controls and webhook events', async () => {
  const harness = component('src/components/settings/GeneralSettings.tsx', { '@/ipc': { ipc: { settingsGet: async () => ({ desktopNotificationEvents: {}, featureVisibility: {} }), listTerminals: async () => [] } } })
  harness.render('GeneralSettings'); harness.effects[0](); await flush(); const rendered = JSON.stringify(harness.render('GeneralSettings'))
  expect(rendered).not.toContain('Default clone depth'); expect(rendered).not.toContain('Scheduled cleanup')
  const webhook = component('src/components/settings/WebhookPanel.tsx',{ '@/ipc': { ipc: { webhookLoad: async () => null, notificationList: async () => [] } } })
  webhook.render('WebhookPanel',{repoPath:'repo'}); webhook.effects[0](); await flush(); const controls = JSON.stringify(webhook.render('WebhookPanel',{repoPath:'repo'}))
  expect(controls).toContain('File locked'); expect(controls).toContain('File unlocked'); expect(controls).not.toContain('Push to main')
})

test('LG-067 auto-fetch runs from repository lifecycle, skips busy operations and backs off failed requests', async () => {
  const timers = [], calls = []; let busy = true, tick = 0
  // Obtain effect through the same hook harness (no dashboard component involved).
  const hook = component('src/lib/useAutoFetch.ts', {
    '@/ipc': { ipc: { settingsGet: async () => ({ autoFetchIntervalMinutes: 5 }), fetch: async (...args) => { calls.push(args); throw Error('offline') } } },
    '@/stores/repoStore': { useRepoStore: store({ repoPath:'repo', bumpSyncTick: () => tick++ }) }, '@/stores/operationStore': { useOperationStore: store({ get isRunning() { return busy } }) },
    './fetchState': { getLastFetch: () => 0, markFetchPerformed: noop },
  }, { setInterval: fn => { timers.push(fn); return 1 }, clearInterval: noop })
  hook.render('useAutoFetch','repo'); const stop = hook.effects[0](); await flush(); await timers[0](); expect(calls).toEqual([])
  busy = false; await timers[0](); await timers[0](); expect(calls).toEqual([['repo',true]]); expect(tick).toBe(0); stop()
})

test('LG-074 quota and policy failures retain accurate causes instead of prescribing unrelated repairs', () => {
  const { parseGitError } = component('src/lib/gitErrors.ts').exports
  const quota = parseGitError('Git LFS storage quota exceeded')
  expect(quota.code).toBe('LFS_QUOTA_EXCEEDED'); expect(JSON.stringify(quota.fixes)).not.toMatch(/clean-pack-files|prune|gc/i)
  expect(parseGitError('remote rejected: protected branch hook declined')?.code).not.toBe('PUSH_REJECTED')
  expect(parseGitError('Updates were rejected because the tip of your current branch is behind').code).toBe('PUSH_REJECTED')
})
