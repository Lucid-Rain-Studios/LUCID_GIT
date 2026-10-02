const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { DIST, git, tmpDir, cleanup, lfsRepo } = require('./helpers')
const { component, find, store } = require('./renderer-harness')
const runner = require(path.join(DIST, 'util/dugite-exec'))
const { gitService } = require(path.join(DIST, 'services/GitService'))
const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function repo() {
  const dir = tmpDir('lg-medium-')
  git(dir, 'init', '-qb', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'A\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'initial')
  return dir
}
function undo(mockRunner = runner) {
  return component('electron/services/UndoService.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    '../util/dugite-exec': mockRunner, '../ipc/channels': { CHANNELS: {} },
  }).exports.undoService
}
function asset(mockRunner = runner, auth = { getCurrentToken: async () => null }) {
  return component('electron/services/AssetDiffService.ts', {
    fs, path, os: require('os'), crypto: require('crypto'), sharp: () => {},
    '../util/dugite-exec': mockRunner,
    './AuthService': { authService: auth }, './GitService': { gitService },
  }, { Buffer }).exports.assetDiffService
}
test.afterAll(cleanup)

test('LG-001 asset extraction preserves shell characters and exact binary bytes', async () => {
  const dir = repo(), dest = tmpDir('lg-preview-')
  const name = 'audit&marker space ü.png', bytes = Buffer.from([0, 255, 128, 13, 10, 0, 19])
  fs.writeFileSync(path.join(dir, name), bytes)
  git(dir, 'add', '--', name)
  git(dir, 'commit', '-qm', 'binary')
  for (const ref of ['HEAD', 'INDEX']) {
    const result = await asset().extractBlob(dir, name, ref, dest, 'left')
    expect(fs.readFileSync(result.blobPath).equals(bytes)).toBe(true)
  }
})

test('LG-002 token is present only for the exact HTTPS GitHub origin', () => {
  for (const url of [null, 'git@github.com:a/b.git', 'not a URL', 'http://github.com/a/b', 'https://other.test/a/b', 'https://github.com.other.test/a/b', 'https://github.com:444/a/b', 'https://user@github.com/a/b']) {
    expect(runner.gitAuthArgs('private', url).join(' ')).not.toContain('AUTHORIZATION')
  }
  const args = runner.gitAuthArgs('private', 'https://github.com/a/b.git')
  expect(args).toContain('http.https://github.com/.extraheader=AUTHORIZATION: basic ' + Buffer.from('x-access-token:private').toString('base64'))
  expect(args.join(' ')).not.toContain('http.extraheader=')
})

test('LG-003 accepted tradeoff: old locks clear automatically; manual removal stays guarded', async () => {
  const dir = repo(), lock = path.join(dir, '.git/index.lock')
  fs.writeFileSync(lock, 'external writer')
  fs.utimesSync(lock, new Date(0), new Date(0))
  expect(await gitService.clearStaleIndexLock(dir)).toBe(true)
  expect(fs.existsSync(lock)).toBe(false)
  fs.writeFileSync(lock, 'fresh writer')
  await expect(gitService.removeIndexLock(dir)).rejects.toThrow('Cannot prove')
  expect(fs.readFileSync(lock, 'utf8')).toBe('fresh writer')
  fs.unlinkSync(lock)
  expect(await gitService.clearStaleIndexLock(dir)).toBe(true)
})

test('LG-005 Undo refuses a different branch and retains the checkpoint', async () => {
  const dir = repo(), service = undo()
  await service.recordCheckpoint(dir, 'reset', 'Reset')
  git(dir, 'checkout', '-qb', 'other')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'other\n')
  git(dir, 'commit', '-qam', 'other tip')
  const tip = git(dir, 'rev-parse', 'HEAD')
  expect((await service.undo(dir)).ok).toBe(false)
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(tip)
  expect(service.peek(dir)).not.toBeNull()
  git(dir, 'checkout', '-q', 'main')
  expect((await service.undo(dir)).ok).toBe(true)
})

test('LG-005 Undo checks the expected post-operation HEAD on the same branch', async () => {
  const dir = repo(), service = undo(), original = git(dir, 'rev-parse', 'HEAD').trim()
  await service.recordCheckpoint(dir, 'pull', 'Pull')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'pulled\n')
  git(dir, 'commit', '-qam', 'pulled tip')
  await service.markAvailable(dir)
  const expected = git(dir, 'rev-parse', 'HEAD').trim()
  fs.writeFileSync(path.join(dir, 'file.txt'), 'later\n')
  git(dir, 'commit', '-qam', 'later tip')
  const later = git(dir, 'rev-parse', 'HEAD').trim()
  expect((await service.undo(dir)).ok).toBe(false)
  expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(later)
  git(dir, 'reset', '--hard', expected)
  expect((await service.undo(dir)).ok).toBe(true)
  expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(original)
})

test('LG-002 bulk LFS unlock scopes credentials once for the entire batch', async () => {
  const dir = repo(), calls = []
  let remoteReads = 0, tokenReads = 0
  const { lockService } = component('electron/services/LockService.ts', {
    'node:fs': fs, 'node:path': path,
    './AuthService': { authService: { getCurrentToken: async () => { tokenReads++; return 'private' } } },
    './GitService': { gitService: { getRemoteUrl: async () => { remoteReads++; return 'https://github.com/owner/repo.git' } } },
    './HeatmapService': { heatmapService: { recordLockEvent() {} } },
    '../util/dugite-exec': { gitAuthArgs: runner.gitAuthArgs, exec: async args => { calls.push(args) } },
  }).exports
  const result = await lockService.unlockFiles(dir, [{ filePath: 'a', lockId: '1' }, { filePath: 'b', lockId: '2' }])
  expect(result.failed).toEqual([])
  expect(remoteReads).toBe(1)
  expect(tokenReads).toBe(1)
  expect(calls).toHaveLength(2)
  for (const args of calls) expect(args.some(arg => arg.startsWith('http.https://github.com/.extraheader='))).toBe(true)
})

test('LG-006 checkpoint failures stop the operation and failed restore stays recoverable', async () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'file.txt'), 'dirty\n')
  const service = undo({ execSafe: async (args, cwd) => args[0] === 'stash'
    ? { exitCode: 1, stdout: '', stderr: 'snapshot failed' } : runner.execSafe(args, cwd) })
  await expect(service.recordCheckpoint(dir, 'reset', 'Reset')).rejects.toThrow('Could not save')
  expect(service.peek(dir)).toBeNull()
  expect(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8')).toBe('dirty\n')
  const restore = undo({ execSafe: async (args, cwd) => args[0] === 'stash' && args[1] === 'apply'
    ? { exitCode: 1, stdout: '', stderr: 'restore failed' } : runner.execSafe(args, cwd) })
  await restore.recordCheckpoint(dir, 'reset', 'Reset')
  git(dir, 'reset', '--hard', 'HEAD')
  const result = await restore.undo(dir)
  expect(result.ok).toBe(false)
  expect(result.message).toContain('retained for recovery')
  expect(restore.peek(dir)).not.toBeNull()
})

function gate(globals = {}) {
  return component('electron/util/repo-gate.ts', {
    path, 'node:async_hooks': require('node:async_hooks'), '../services/LogService': { logService: { warn() {} } },
  }, globals).exports
}
test('LG-007 queued read ahead of writer drains without deadlock or overlap', async () => {
  const { withRepoSlot, repoSlotState } = gate(), hold = deferred(), events = []
  const first = withRepoSlot('repo', 'write', () => hold.promise)
  const read = withRepoSlot('repo', 'read', async () => { events.push('read'); expect(repoSlotState('repo').activeWrite).toBe(false) })
  const write = withRepoSlot('repo', 'write', async () => { events.push('write'); expect(repoSlotState('repo').activeReads).toBe(0) })
  hold.resolve()
  await Promise.all([first, read, write])
  expect(events).toEqual(['write', 'read'])
  expect(repoSlotState('repo')).toEqual({ activeReads: 0, activeWrite: false, waiting: 0 })
})
test('LG-008 timeout rejects queued work without claiming or releasing another writer slot', async () => {
  const timers = []
  const { withRepoSlot, repoSlotState } = gate({ setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimeout() {} })
  const hold = deferred()
  const first = withRepoSlot('repo', 'write', () => hold.promise)
  let entered = false
  const second = withRepoSlot('repo', 'write', async () => { entered = true })
  const rejection = expect(second).rejects.toThrow('Timed out waiting')
  timers.find(t => t.ms === 60000).fn()
  await rejection
  expect(entered).toBe(false)
  expect(repoSlotState('repo')).toEqual({ activeReads: 0, activeWrite: true, waiting: 0 })
  hold.resolve()
  await first
  await withRepoSlot('repo', 'write', async () => { entered = true })
  expect(entered).toBe(true)
})

test('LG-010 failed tracked restore rejects and never publishes completion', async () => {
  const dir = repo(), events = []
  await expect(gitService.discard(dir, ['missing.txt'], false, step => events.push(step))).rejects.toThrow()
  expect(events.some(step => step.status === 'done')).toBe(false)
})
test('LG-010 untracked deletion failure rejects and FileRow keeps its lock', async () => {
  const dir = repo(), real = fs.promises.unlink
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new')
  fs.promises.unlink = async () => { const e = Error('permission denied'); e.code = 'EACCES'; throw e }
  try { await expect(gitService.discard(dir, ['new.txt'], true)).rejects.toThrow('permission denied') }
  finally { fs.promises.unlink = real }
  let unlocks = 0
  const panel = component('src/components/changes/FileRow.tsx', {
    '@/stores/repoStore': { useRepoStore: store({ fileStatus: [] }) },
    '@/ipc': { ipc: { discard: async () => { throw Error('restore failed') } } },
    '@/stores/forecastStore': { useForecastStore: store({ conflicts: [] }) },
    '@/stores/assetViewerStore': { useAssetViewerStore: store({}) },
    '@/stores/lockStore': { useLockStore: store({ unlockFile: async () => { unlocks++ } }) },
    '@/stores/authStore': { useAuthStore: store({ isAdmin: () => false }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async () => true, alert: async () => {} }) },
  })
  const props = { repoPath: dir, currentUserName: 'me', file: { path: 'file.txt', staged: false, status: 'M' }, lock: { owner: { login: 'me' } }, onRefresh() {} }
  let tree = panel.render('FileRow', props)
  find(tree, n => n.props?.onContextMenu).props.onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 })
  tree = panel.render('FileRow', props)
  await find(tree, n => n.props?.onClick?.name === 'doDiscard').props.onClick()
  expect(unlocks).toBe(0)
})

test('LG-011 an old error cannot repair the newly active repository', async () => {
  const state = { repoPath: 'B', currentBranch: 'main' }, calls = []
  const error = { repoPath: 'A', severity: 'error', causes: [], fixes: [{}] }
  const panel = component('src/components/errors/ErrorPanel.tsx', {
    '@/ipc': { ipc: { rebaseAbort: async repo => calls.push(repo) } },
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/errorStore': { useErrorStore: store({ current: error, history: [], dismiss() {} }) },
  })
  let tree = panel.render('ErrorPanel', {})
  await find(tree, n => n.props?.onDispatch).props.onDispatch({ type: 'abort-rebase' })
  expect(calls).toEqual([])
  state.repoPath = 'A'
  tree = panel.render('ErrorPanel', {})
  await find(tree, n => n.props?.onDispatch).props.onDispatch({ type: 'abort-rebase' })
  expect(calls).toEqual(['A'])
})

test('LG-014 CommitBox invokes normal Git and rejecting commit-msg prevents a commit', async () => {
  const dir = repo(), hooks = path.join(dir, '.git/hooks')
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho run >> pre-runs\n')
  fs.writeFileSync(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho title-rejected >&2\nexit 1\n')
  fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755)
  fs.chmodSync(path.join(hooks, 'commit-msg'), 0o755)
  fs.writeFileSync(path.join(dir, 'file.txt'), 'B\n')
  git(dir, 'add', 'file.txt')
  const tip = git(dir, 'rev-parse', 'HEAD'), calls = [], confirmations = []
  let approved = false
  const state = { repoPath: dir, fileStatus: [{ path: 'file.txt', staged: true }], refreshStatus: async () => {}, bumpSyncTick() {} }
  const panel = component('src/components/changes/CommitBox.tsx', {
    '@/ipc': { ipc: { commit: async (...args) => { calls.push(args); return gitService.commit(...args) }, fetch: async () => {} } },
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/errorStore': { useErrorStore: store({ pushRaw() {} }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async opts => { confirmations.push(opts); return approved } }) },
  })
  let tree = panel.render('CommitBox')
  find(tree, n => n.type === 'input').props.onChange({ target: { value: 'title' } })
  tree = panel.render('CommitBox')
  await find(tree, n => n.props?.onClick?.name === 'handleCommit').props.onClick()
  expect(calls[0]).toEqual([dir, 'title', false])
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(tip)
  expect(fs.readFileSync(path.join(dir, 'pre-runs'), 'utf8').trim().split('\n')).toHaveLength(1)
  tree = panel.render('CommitBox')
  await find(tree, n => n.props?.onClick?.name === 'handleBypass').props.onClick()
  expect(calls).toHaveLength(1)
  expect(confirmations[0].danger).toBe(true)
  approved = true
  await find(tree, n => n.props?.onClick?.name === 'handleBypass').props.onClick()
  expect(calls[1]).toEqual([dir, 'title', true])
  expect(git(dir, 'rev-parse', 'HEAD')).not.toBe(tip)
  expect(fs.readFileSync(path.join(dir, 'pre-runs'), 'utf8').trim().split('\n')).toHaveLength(1)
})

test('LG-015 LFS extraction returns exact bytes through asynchronous smudge', async () => {
  const dir = lfsRepo(['asset'], 200000), dest = tmpDir('lg-smudge-')
  const expected = fs.readFileSync(path.join(dir, 'asset.uasset'))
  const result = await asset().extractBlob(dir, 'asset.uasset', 'HEAD', dest, 'right')
  expect(fs.readFileSync(result.blobPath).equals(expected)).toBe(true)
})
test('LG-015 a stalled binary command yields and its deadline kills the process', async () => {
  const child = new EventEmitter(), timers = [], kills = []
  Object.assign(child, { pid: 9999, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end() {} }), kill: signal => { kills.push(signal); child.emit('close', null) } })
  const binaryRunner = component('electron/util/dugite-exec.ts', {
    dugite: { GitProcess: { spawn: () => child } }, path,
    'node:async_hooks': require('node:async_hooks'), 'node:perf_hooks': require('node:perf_hooks'), 'node:child_process': {},
    '../services/LogService': { logService: { warn() {}, error() {} } },
    './git-command': { isReadOnlyCommand: () => true },
  }, { Buffer, process: { env: {}, platform: 'linux' }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimeout() {} }).exports
  const result = binaryRunner.withGitTimeout(() => binaryRunner.execBinary(['cat-file', '-p', 'HEAD:file'], 'repo'), 30000, 'Asset IPC')
  await flush()
  expect(kills).toEqual([])
  const rejection = expect(result).rejects.toThrow('timed out')
  expect(timers.some(t => t.ms === 120000)).toBe(true)
  timers.find(t => t.ms === 30000).fn()
  await rejection
  expect(kills).toEqual(['SIGKILL'])
})

function repoStore(api) {
  api.isRepo ??= async () => true
  return component('src/stores/repoStore.ts', {
    zustand: require('zustand'), './operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
  }, { window: { lucidGit: api } }).exports
}
test('LG-031 late open, refresh, branches and checkout cannot overwrite the new repository', async () => {
  const pending = []
  let slow = false
  const api = Object.fromEntries(['currentBranch', 'status', 'branchList', 'checkout'].map(method => [method, repo => {
    if (!slow) return Promise.resolve(method === 'currentBranch' ? repo : [repo])
    const d = deferred(); pending.push({ ...d, method, repo }); return d.promise
  }]))
  const { useRepoStore: state } = repoStore(api)
  const finishOld = async () => { for (const d of pending.splice(0)) d.resolve(d.method === 'currentBranch' ? d.repo : [d.repo]); await flush() }
  slow = true
  const openA = state.getState().openRepo('A')
  slow = false
  await state.getState().openRepo('B')
  await finishOld(); await openA
  expect(state.getState()).toMatchObject({ repoPath: 'B', currentBranch: 'B', fileStatus: ['B'], branches: ['B'], isLoading: false })
  slow = true
  const refresh = state.getState().refreshStatus(), branches = state.getState().loadBranches(), checkout = state.getState().checkout('feature')
  slow = false
  await state.getState().openRepo('C')
  await finishOld(); await Promise.all([refresh, branches, checkout])
  expect(state.getState()).toMatchObject({ repoPath: 'C', currentBranch: 'C', fileStatus: ['C'], branches: ['C'], isLoading: false })
  slow = true
  const silent = state.getState().silentRefresh()
  state.getState().clearRepo()
  await finishOld(); await silent
  expect(state.getState()).toMatchObject({ repoPath: null, currentBranch: '', fileStatus: [], isSilentRefreshing: false })
})

test('LG-033 second-account login selects the same persisted and displayed identity', async () => {
  const dir = tmpDir('lg-auth-'), passwords = new Map()
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ accounts: [{ userId: '1', login: 'first' }], currentAccountId: '1' }))
  const { authService } = component('electron/services/AuthService.ts', {
    fs, path, electron: { app: { getPath: () => dir } },
    keytar: { setPassword: async (_, key, value) => passwords.set(key, value), getPassword: async (_, key) => passwords.get(key) },
    './LogService': { logService: { info() {}, warn() {}, error() {} } },
  }, { URLSearchParams, AbortSignal, AbortController, fetch: async url => ({ ok: true, headers: { get: () => 'repo, read:user' }, json: async () => url.includes('/user') ? { id: 2, login: 'second', name: 'Second', avatar_url: '' } : { access_token: 'second-token' } }) }).exports
  await authService.pollDeviceFlow('device')
  expect(authService.listAccounts().currentAccountId).toBe('2')
  expect(await authService.getCurrentToken()).toBe('second-token')
  const { useAuthStore: state } = component('src/stores/authStore.ts', {
    zustand: require('zustand'), '@/ipc': { ipc: { pollDeviceFlow: async () => ({ userId: '2' }), listAccounts: async () => authService.listAccounts() } },
  }).exports
  state.setState({ deviceFlow: { deviceCode: 'device' } })
  expect(await state.getState().pollOnce()).toBe(true)
  expect(state.getState().currentAccountId).toBe('2')
})

test('LG-031 checkout superseding a refresh clears its loading flag and ignores older status', async () => {
  const old = [], api = {
    currentBranch: async () => 'main', status: async () => ['initial'], branchList: async () => ['main'], checkout: async () => {},
  }
  const { useRepoStore: state } = repoStore(api)
  await state.getState().openRepo('A')
  for (const method of ['currentBranch', 'status', 'branchList']) {
    api[method] = () => { const d = deferred(); old.push(d); return d.promise }
  }
  const refresh = state.getState().refreshStatus()
  expect(state.getState().isLoading).toBe(true)
  api.currentBranch = async () => 'feature'
  api.status = async () => ['checked-out']
  api.branchList = async () => ['main', 'feature']
  await state.getState().checkout('feature')
  expect(state.getState()).toMatchObject({ isLoading: false, currentBranch: 'feature', fileStatus: ['checked-out'] })
  for (const d of old) d.resolve(['old'])
  await refresh
  expect(state.getState()).toMatchObject({ isLoading: false, currentBranch: 'feature', fileStatus: ['checked-out'] })
})

test('LG-039 stale lock actions reject before reading active locks or making IPC calls', async () => {
  const calls = [], state = { repoPath: 'B' }
  const { useLockStore: locks } = component('src/stores/lockStore.ts', {
    zustand: require('zustand'), './repoStore': { useRepoStore: store(state), repoSessionVersion: () => 2 },
    '@/ipc': { ipc: {
      lockFile: async (...args) => calls.push(args), unlockFile: async (...args) => calls.push(args), unlockFiles: async (...args) => calls.push(args),
    } },
  }).exports
  const original = [{ id: 'B-lock', path: 'file' }]
  locks.setState({ locks: original, error: 'B error' })
  await expect(locks.getState().lockFile('A', 'file')).rejects.toThrow('Repository changed')
  await expect(locks.getState().unlockFile('A', 'file')).rejects.toThrow('Repository changed')
  await expect(locks.getState().unlockFiles('A', [{ filePath: 'file' }])).rejects.toThrow('Repository changed')
  expect(calls).toEqual([])
  expect(locks.getState()).toMatchObject({ locks: original, error: 'B error' })
})

test('LG-039 switching polling cancels old results and emits repository-tagged locks', async () => {
  const events = [], intervals = []
  const { lockService } = component('electron/services/LockService.ts', {
    'node:fs': fs, 'node:path': path, electron: { BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (...args) => events.push(args) } }] } },
    '../ipc/channels': { CHANNELS: { EVT_LOCK_CHANGED: 'locks' } },
    './AuthService': { authService: { listAccounts: () => ({ accounts: [] }) } },
  }, { setInterval: fn => { intervals.push(fn); return intervals.length }, clearInterval() {} }).exports
  lockService.listLocks = async () => []
  lockService.startPolling('A')
  await flush()
  const old = deferred()
  lockService.listLocks = repo => repo === 'A' ? old.promise : Promise.resolve([])
  const poll = lockService.poll('A')
  lockService.startPolling('B')
  old.resolve([{ path: 'old', owner: { name: 'old' } }])
  await poll
  expect(events).toEqual([])
  expect(lockService.pollTimers.has('A')).toBe(false)
  await lockService.poll('B')
  expect(events).toEqual([['locks', { repoPath: 'B', locks: [] }]])
  lockService.stopPolling('B')
})
test('LG-039 late lock loading cannot replace the active project locks', async () => {
  const old = deferred(), state = { repoPath: 'A' }
  let session = 1
  const { useLockStore: locks } = component('src/stores/lockStore.ts', {
    zustand: require('zustand'), './repoStore': { useRepoStore: store(state), repoSessionVersion: () => session },
    '@/ipc': { ipc: { listLocks: repo => repo === 'A' ? old.promise : Promise.resolve([{ id: 'B', path: 'file' }]), getRemoteUrl: async () => null } },
  }).exports
  const loading = locks.getState().loadLocks('A')
  state.repoPath = 'B'; session++
  locks.getState().clearLocks()
  await locks.getState().loadLocks('B')
  old.resolve([{ id: 'A', path: 'file' }]); await loading
  expect(locks.getState().locks).toEqual([{ id: 'B', path: 'file' }])
})
