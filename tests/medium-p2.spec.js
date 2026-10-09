const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { component, find, store } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const runner = require(path.join(DIST, 'util/dugite-exec'))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const flush = () => new Promise(r => setImmediate(r))
test.afterAll(cleanup)

function repo() {
  const dir = tmpDir('lg-p2-')
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'initial')
  return dir
}

test('LG-018/019 root, merge, rename and whitespace paths retain exact identities', async () => {
  const dir = repo()
  expect(await gitService.commitFiles(dir, 'HEAD')).toEqual([{ status: 'A', path: 'file.txt' }])
  git(dir, 'checkout', '-qb', 'feature')
  const name = ' leading é [asset].txt'
  fs.writeFileSync(path.join(dir, name), 'branch\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'feature')
  git(dir, 'checkout', '-q', 'main'); git(dir, 'merge', '--no-ff', '-qm', 'merge', 'feature')
  expect(await gitService.commitFiles(dir, 'HEAD')).toEqual([{ status: 'A', path: name }])
  const { parseNameStatus, parseNumstat } = require(path.join(DIST, 'util/git-paths'))
  expect(parseNameStatus('R100\0 old\tname\n\0 new\tname\n\0M\0 spaced \0')).toEqual([
    { status: 'R', path: ' new\tname\n', oldPath: ' old\tname\n' }, { status: 'M', path: ' spaced ' },
  ])
  expect(parseNumstat('2\t3\t\0old\n\0new\t \0')).toEqual([{ path: 'new\t ', additions: 2, deletions: 3 }])
})

test('LG-025 selected stash saves one checkpoint beyond Windows argv limits and preserves other edits', async () => {
  const dir = repo(), paths = []
  for (let i = 0; i < 380; i++) { const name = 'selected-' + String(i).padStart(4, '0') + '-'.repeat(80) + '.txt'; paths.push(name); fs.writeFileSync(path.join(dir, name), 'before\n') }
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'many files')
  for (const name of paths) fs.writeFileSync(path.join(dir, name), 'after\n')
  fs.writeFileSync(path.join(dir, 'selected-added.txt'), 'staged addition\n'); git(dir, 'add', 'selected-added.txt'); paths.push('selected-added.txt')
  fs.writeFileSync(path.join(dir, 'selected-untracked.txt'), 'untracked addition\n'); paths.push('selected-untracked.txt')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'keep\n')
  await gitService.stashSave(dir, 'selected', paths)
  expect(fs.readFileSync(path.join(dir, paths[379]), 'utf8')).toBe('before\n')
  expect(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8')).toBe('keep\n')
  expect(fs.existsSync(path.join(dir, 'selected-added.txt'))).toBe(false)
  expect(fs.existsSync(path.join(dir, 'selected-untracked.txt'))).toBe(false)
  expect((await gitService.stashShowFiles(dir, 'stash@{0}')).map(f => f.path).sort()).toEqual(paths.sort())
})

test('LG-026 backend rejects amend of pushed HEAD even after the UI check', async () => {
  const dir = repo(), remote = tmpDir('lg-p2-remote-')
  git(remote, 'init', '--bare', '-q'); git(dir, 'remote', 'add', 'origin', remote); git(dir, 'push', '-qu', 'origin', 'main')
  expect(await gitService.isHeadPushed(dir)).toBe(true)
  const before = git(dir, 'rev-parse', 'HEAD')
  await expect(gitService.commitAmend(dir, 'rewritten')).rejects.toThrow('already pushed')
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(before)
  fs.writeFileSync(path.join(dir, 'file.txt'), 'local'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'local')
  expect(await gitService.isHeadPushed(dir)).toBe(false)
  await gitService.commitAmend(dir, 'amended local')
  expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('amended local')
})

test('LG-030 invalid opens preserve active repo and refresh failures preserve data with a visible error', async () => {
  const api = { ueDetect: async () => null, isRepo: async p => p !== 'invalid', status: async () => ['dirty'], currentBranch: async () => 'main', branchList: async () => ['main'], checkout: async () => {} }
  const { useRepoStore: state } = component('src/stores/repoStore.ts', { zustand: require('zustand'), './operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) } }, { window: { lucidGit: api } }).exports
  await state.getState().openRepo('valid'); await state.getState().openRepo('invalid')
  expect(state.getState()).toMatchObject({ repoPath: 'valid', fileStatus: ['dirty'], isLoading: false })
  expect(state.getState().error).toContain('not a Git')
  api.status = async () => { throw new Error('status timeout') }
  await state.getState().refreshStatus()
  expect(state.getState().fileStatus).toEqual(['dirty']); expect(state.getState().error).toContain('status timeout')
  await state.getState().checkout('feature')
  expect(state.getState().fileStatus).toEqual(['dirty']); expect(state.getState().error).toContain('status timeout')
})

test('LG-059/071 failed Git comparisons and history reject rather than reporting empty results', async () => {
  const dir = repo()
  await expect(gitService.log(dir, { refs: ['missing-ref'] })).rejects.toThrow()
  await expect(gitService.branchDiff(dir, 'main', 'missing-ref')).rejects.toThrow()
  const empty = tmpDir('lg-empty-'); git(empty, 'init', '-q', '-b', 'main')
  expect(await gitService.log(empty)).toEqual([])
  expect((await gitService.log(dir)).length).toBe(1)
})

test('LG-035 network deadlines cover response bodies and abort hung requests', async () => {
  const timers = []; let signal
  const { boundedFetch } = component('electron/util/network.ts', {}, { AbortController, fetch: async (_, options) => { signal = options.signal; return { json: () => new Promise(() => {}) } }, setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t }, clearTimeout() {} }).exports
  const response = await boundedFetch('https://example.test')
  const body = response.json(), check = expect(body).rejects.toThrow('timed out')
  timers.at(-1).fn(); await check; expect(signal.aborted).toBe(true)
})

function auth(fetch, passwords = new Map()) {
  const dir = tmpDir('lg-p2-auth-')
  return component('electron/services/AuthService.ts', {
    fs, path, electron: { app: { getPath: () => dir } }, keytar: {
      getPassword: async (_, key) => passwords.get(key), setPassword: async (_, key, value) => passwords.set(key, value), deletePassword: async (_, key) => passwords.delete(key),
    }, './LogService': { logService: { info() {}, warn() {}, error() {} } },
  }, { URLSearchParams, AbortController, fetch }).exports.authService
}

test('LG-036 polls deduplicate and slow_down increases the backend backoff', async () => {
  const wait = deferred(); let requests = 0
  const service = auth(async () => { requests++; return wait.promise })
  const a = service.pollDeviceFlow('code'), b = service.pollDeviceFlow('code')
  wait.resolve({ ok: true, json: async () => ({ error: 'slow_down' }) }); await Promise.all([a, b])
  expect(requests).toBe(1); expect(service.pollTiming.get('code').interval).toBe(10000)
  await service.pollDeviceFlow('code'); expect(requests).toBe(1)
})

test('LG-037 cancellation during profile loading does not persist or select credentials', async () => {
  const profile = deferred(), passwords = new Map()
  const service = auth(async url => url.includes('/user') ? profile.promise : { ok: true, json: async () => ({ access_token: 'new' }) }, passwords)
  const pending = service.pollDeviceFlow('code'); await flush(); service.cancelDeviceFlow('code')
  profile.resolve({ ok: true, headers: { get: () => 'repo' }, json: async () => ({ id: 2, login: 'second' }) })
  expect(await pending).toBeNull(); expect(passwords.size).toBe(0); expect(service.listAccounts().accounts).toEqual([])
})

test('LG-037 cancellation during credential writes rolls back only this attempt and keeps existing accounts', async () => {
  const dir = tmpDir('lg-auth-cancel-'), passwords = new Map([['github:1','existing'],['github:2','prior']])
  let service, cancelled = false
  service = component('electron/services/AuthService.ts', {
    electron: { app: { getPath: () => dir } }, './LogService': { logService: { info() {}, warn() {}, error() {} } },
    keytar: { getPassword: async (_,key) => passwords.get(key), deletePassword: async (_,key) => passwords.delete(key),
      setPassword: async (_,key,value) => { passwords.set(key,value); if (!cancelled) { cancelled = true; service.cancelDeviceFlow('code') } } },
  }, { URLSearchParams, AbortController, fetch: async url => ({ ok:true, headers:{get:()=> 'repo'}, json:async()=>url.includes('/user') ? {id:2,login:'second'} : {access_token:'new',refresh_token:'refresh'} }) }).exports.authService
  expect(await service.pollDeviceFlow('code')).toBeNull(); expect(passwords).toEqual(new Map([['github:1','existing'],['github:2','prior']]))
  expect(service.listAccounts().currentAccountId).toBeNull()
})

test('LG-017 partially staged MM file appears independently in both sections', () => {
  const file = { path: 'file.txt', staged: true, indexStatus: 'M', workingStatus: 'M' }
  const harness = component('src/components/changes/FileTree.tsx', {
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) }, '@/stores/dialogStore': { useDialogStore: store({}) }, '@/stores/authStore': { useAuthStore: store({ accounts: [], currentAccountId: null }) }, '@/stores/lockStore': { useLockStore: store({}) },
    '@/stores/repoStore': { useRepoStore: store({ error: null }) },
  })
  const tree = harness.render('FileTree', { files: [file], repoPath: 'repo', locks: [], currentUserName: null, onRefresh() {} })
  const rows = []; const walk = node => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(walk); if (node.type === 'FileRow') rows.push(node.props.file); walk(node.props?.children) }; walk(tree)
  expect(rows.map(r => r.staged)).toEqual([true, false])
})

test('LG-077 release build checks renderer types before emitting the main process', () => {
  const pkg = require('../package.json')
  expect(pkg.scripts.build.split(' && ')[0]).toBe('tsc --noEmit')
})
