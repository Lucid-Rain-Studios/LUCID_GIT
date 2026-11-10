const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { component } = require('./renderer-harness')
const { DIST, git, tmpDir, cleanup, countGitSpawns } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))
test.afterAll(cleanup)
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }

function watcherHarness(platform = 'win32', linked = false) {
  const watchers = [], timers = new Map(); let next = 0, changes = 0, busy = false, index = 'H 100644 abc 0\tIntermediate/tracked.uasset\0'
  const repo = path.resolve('watch-test'), gitDir = linked ? path.resolve('other/.git/worktrees/linked') : path.join(repo, '.git')
  const common = linked ? path.resolve('other/.git') : gitDir
  let heldRead = null, indexReads = 0
  const service = component('electron/services/WatcherService.ts', {
    'node:fs': { watch: (root, _, callback) => { const w = { root, callback, close: () => { w.closed = true }, on() {} }; watchers.push(w); return w } },
    chokidar: { watch: (root, options) => { const w = { root, options, events: {}, close: () => { w.closed = true }, on(event, fn) { w.events[event] = fn; return w } }; watchers.push(w); return w } },
    '../util/dugite-exec': { exec: async args => {
      if (args[0] === 'ls-files') indexReads++
      if (args[0] === 'ls-files' && heldRead) { const held = heldRead; heldRead = null; return held.promise }
      return { stdout: args.includes('--absolute-git-dir') ? gitDir : args.includes('--git-common-dir') ? common : index }
    }, gitOpActivity: () => ({ inFlight: busy ? 1 : 0, ranDuring: () => false }) },
    './LogService': { logService: { warn() {} } }, './PerformanceService': { performanceService: { get: () => ({ watcherDelayMs: 100 }) } },
  }, { process: { platform }, setTimeout: fn => { timers.set(++next, fn); return next }, clearTimeout: id => timers.delete(id) }).exports.watcherService
  return { service, watchers, repo, gitDir, common, busy: value => { busy = value }, stage: () => { index = index.replace('abc', 'def') }, start: () => service.watch(repo, () => changes++),
    indexReads: () => indexReads,
    holdRead: () => { heldRead = deferred(); return heldRead },
    flush: async () => { for (let round = 0; round < 5; round++) { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)) }; return changes },
    emit: (i, file, event = 'change') => platform === 'win32' ? watchers[i].callback(event, file) : watchers[i].events.all(event, path.join(watchers[i].root, file)) }
}

for (const platform of ['win32', 'linux']) test(`${platform} watcher ignores metadata noise but retains asset/ref/index events`, async () => {
  const h = watcherHarness(platform); await h.start()
  expect(h.watchers.map(w => w.root)).toEqual([h.repo, h.gitDir])
  for (let i = 0; i < 100; i++) {
    h.emit(0, '.git'); h.emit(0, '.git/index'); h.emit(1, 'index.lock')
    h.emit(1, 'lfs/locks/local/lockcache.db'); h.emit(1, 'objects/pack/tmp'); h.emit(1, 'refs/heads/main.lock')
  }
  expect(await h.flush()).toBe(0)
  expect(h.indexReads()).toBe(1) // startup only; metadata noise spawned nothing
  h.busy(true)
  for (let i = 0; i < 100; i++) h.emit(1, 'index')
  expect(await h.flush()).toBe(0)
  expect(h.indexReads()).toBe(2) // one debounced check for the entire burst
  // External staging must be detected even while an app Git read is active.
  h.stage(); h.emit(1, 'index'); expect(await h.flush()).toBe(1)
  h.emit(1, 'HEAD'); h.emit(1, 'refs/heads/main'); h.emit(1, 'packed-refs'); expect(await h.flush()).toBe(2)
  h.emit(0, 'Saved/Logs/Editor.log'); expect(await h.flush()).toBe(2)
  h.emit(0, 'Content/Asset.uasset'); h.emit(0, 'Intermediate/tracked.uasset'); expect(await h.flush()).toBe(3)
  h.service.unwatchAll(); expect(h.watchers.every(w => w.closed)).toBe(true)
  h.emit(0, 'Content/late.uasset'); expect(await h.flush()).toBe(3)
})

test('index changes during verification get a fresh follow-up, and failed checks still request refresh', async () => {
  const h = watcherHarness(); await h.start()
  const held = h.holdRead()
  h.emit(1, 'index'); expect(await h.flush()).toBe(0)
  h.stage(); h.emit(1, 'index'); expect(await h.flush()).toBe(0)
  held.resolve({ stdout: 'H 100644 abc 0\tIntermediate/tracked.uasset\0' })
  expect(await h.flush()).toBe(1)
  const failed = h.holdRead()
  h.emit(1, 'index'); await h.flush(); failed.reject(Error('cannot read index'))
  expect(await h.flush()).toBe(2)
  h.service.unwatchAll()
})

test('linked worktrees retain separate metadata, common refs, unknown events and .git replacement notifications', async () => {
  const h = watcherHarness('win32', true); await h.start()
  expect(h.watchers.map(w => w.root)).toEqual([h.repo, h.gitDir, h.common])
  h.emit(1, 'HEAD'); h.emit(2, 'refs/heads/main'); expect(await h.flush()).toBe(1)
  h.emit(0, null); expect(await h.flush()).toBe(2)
  h.emit(0, '.git', 'rename'); expect(await h.flush()).toBe(3)
  h.emit(0, '.git', 'change'); expect(await h.flush()).toBe(4)
  h.service.unwatchAll()
})

test('normal .git directory changes skip refresh but replacement still refreshes', async () => {
  const h = watcherHarness(); await h.start()
  for (let i = 0; i < 25; i++) h.emit(0, '.git', 'change')
  expect(await h.flush()).toBe(0)
  expect(h.indexReads()).toBe(1)
  h.emit(0, '.git', 'rename'); expect(await h.flush()).toBe(1)
  h.service.unwatchAll()
})

function repoFixture() {
  const repo = tmpDir('lg-read-performance-')
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  return repo
}

test('Windows native watcher catches external stage/commit/save without refreshing for LFS cache churn', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows notification regression')
  const repo = repoFixture()
  const service = require(path.join(DIST, 'services/WatcherService')).watcherService
  const performance = require(path.join(DIST, 'services/PerformanceService')).performanceService
  const get = performance.get.bind(performance)
  performance.get = () => ({ ...get(), watcherDelayMs: 30 })
  let changes = 0
  const pause = ms => new Promise(r => setTimeout(r, ms))
  const changed = async previous => {
    const until = Date.now() + 5000
    while (changes === previous && Date.now() < until) await pause(30)
    expect(changes).toBeGreaterThan(previous)
    await pause(150)
  }
  try {
    // Git canonicalizes casing; this must still be treated as a normal .git directory.
    await service.watch(repo.toUpperCase(), () => changes++)
    await pause(400)
    const start = changes
    fs.mkdirSync(path.join(repo, '.git/lfs/tmp'), { recursive: true })
    for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(repo, '.git/lfs/tmp', String(i)), 'cache')
    await pause(400); expect(changes).toBe(start)
    fs.writeFileSync(path.join(repo, 'file.txt'), 'edited'); await changed(start)
    let previous = changes; git(repo, 'add', 'file.txt'); await changed(previous)
    previous = changes; git(repo, 'commit', '-qm', 'external commit'); await changed(previous)
    previous = changes; git(repo, 'update-index', '--assume-unchanged', 'file.txt'); await changed(previous)
    previous = changes
    for (let i = 0; i < 3; i++) await gitService.status(repo)
    await pause(300); expect(changes).toBe(previous)
    previous = changes; fs.writeFileSync(path.join(repo, 'Asset.uasset'), 'Unreal save'); await changed(previous)
  } finally { service.unwatchAll(); performance.get = get }
})

test('one branch-list query returns exact tips for many local/remote branches and updates after a commit', async () => {
  const repo = repoFixture(), original = git(repo, 'rev-parse', 'HEAD').trim()
  for (let i = 0; i < 30; i++) git(repo, 'branch', `branch-${i}`)
  git(repo, 'update-ref', 'refs/remotes/origin/main', original)
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const result = await countGitSpawns(() => gitService.branchList(repo))
  expect(result.spawns).toBe(2) // one for-each-ref + current branch, independent of branch count
  expect(result.value).toHaveLength(32)
  expect(result.value.every(b => b.tipHash === original)).toBe(true)
  fs.writeFileSync(path.join(repo, 'file.txt'), 'new'); git(repo, 'commit', '-qam', 'advance')
  const branches = await gitService.branchList(repo)
  expect(branches.find(b => b.name === 'main').tipHash).toBe(git(repo, 'rev-parse', 'HEAD').trim())
  expect(branches.find(b => b.name === 'branch-0').tipHash).toBe(original)
  const { groupBranchTips, selectedBranchTips } = component('src/lib/branchTips.ts').exports
  expect(groupBranchTips(branches).get(original)).toHaveLength(31)
  expect([...selectedBranchTips(branches, ['main', 'origin/main']).values()]).toEqual(['main', 'origin/main'])
  expect([...groupBranchTips([...branches, branches[0]]).values()].flat()).toHaveLength(32)
})

test('combined sync count reports ahead and behind correctly with a single traversal', async () => {
  const repo = repoFixture()
  git(repo, 'checkout', '-qb', 'incoming'); fs.writeFileSync(path.join(repo, 'incoming.txt'), 'remote'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'remote')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD'); git(repo, 'checkout', '-q', 'main')
  for (let i = 0; i < 2; i++) { fs.writeFileSync(path.join(repo, 'file.txt'), String(i)); git(repo, 'commit', '-qam', 'local') }
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git')
  git(repo, 'branch', '--set-upstream-to=origin/main')
  const result = await countGitSpawns(() => gitService.getSyncStatus(repo))
  expect(result.value).toMatchObject({ ahead: 2, behind: 1, hasPublishedBranch: true })
  expect(result.spawns).toBe(4)
})

test('UI sync callers share only in-flight work, isolate repos and do not reuse failed or completed results', async () => {
  const service = component('electron/services/GitService.ts').exports.gitService
  const pending = [], calls = []
  service.getSyncStatus = repo => { calls.push(repo); const d = deferred(); pending.push(d); return d.promise }
  const a = service.sharedSyncStatus('repo-a'), b = service.sharedSyncStatus('repo-a'), c = service.sharedSyncStatus('repo-b')
  expect(calls).toHaveLength(2)
  pending[0].resolve({ ahead: 1 }); pending[1].resolve({ ahead: 2 })
  const [av, bv, cv] = await Promise.all([a, b, c]); av.ahead = 99
  expect(bv.ahead).toBe(1); expect(cv.ahead).toBe(2)
  const retry = service.sharedSyncStatus('repo-a'); expect(calls).toHaveLength(3)
  pending[2].reject(Error('offline')); await expect(retry).rejects.toThrow('offline')
  const next = service.sharedSyncStatus('repo-a'); expect(calls).toHaveLength(4)
  pending[3].resolve({ ahead: 3 }); await next
})

test('mutation invalidation cannot let an old sync request remove or satisfy the new request', async () => {
  const service = component('electron/services/GitService.ts').exports.gitService
  const requests = []
  service.getSyncStatus = () => { const d = deferred(); requests.push(d); return d.promise }
  const old = service.sharedSyncStatus('repo')
  service.invalidateStatusCache('repo')
  const fresh = service.sharedSyncStatus('repo'); expect(requests).toHaveLength(2)
  requests[0].resolve({ ahead: 0 }); await old
  const shared = service.sharedSyncStatus('repo'); expect(requests).toHaveLength(2)
  requests[1].resolve({ ahead: 1 }); expect(await fresh).toEqual(await shared)
  const beforeFetch = service.sharedSyncStatus('repo')
  await service.withRemote('repo', async () => {})
  const afterFetch = service.sharedSyncStatus('repo'); expect(requests).toHaveLength(4)
  requests[2].resolve({ ahead: 1 }); requests[3].resolve({ ahead: 2 }); await Promise.all([beforeFetch, afterFetch])
  // Safety callers do not use the UI shared method.
  const ui = service.sharedSyncStatus('repo'), safety = service.getSyncStatus('repo')
  expect(requests).toHaveLength(6)
  requests[4].resolve({ ahead: 2 }); requests[5].resolve({ ahead: 3 }); await Promise.all([ui, safety])
})
