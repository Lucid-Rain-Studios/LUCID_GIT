const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { component, find, store } = require('./renderer-harness')
const { DIST, git, tmpDir, cleanup, lfsRepo } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))
test.afterAll(cleanup)

test('scoped safety status finds staged, unstaged, deleted, renamed and literal paths without unrelated files', async () => {
  const repo = tmpDir('lg-scoped-status-')
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  const names = ['staged', 'unstaged', 'deleted', 'old-name', 'literal[1]', 'literal1', 'clean']
  for (const name of names) fs.writeFileSync(path.join(repo, name), name)
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  fs.writeFileSync(path.join(repo, 'staged'), 'staged edit'); git(repo, 'add', 'staged')
  fs.writeFileSync(path.join(repo, 'unstaged'), 'unstaged edit')
  fs.unlinkSync(path.join(repo, 'deleted')); git(repo, 'mv', 'old-name', 'new-name')
  fs.writeFileSync(path.join(repo, 'literal1'), 'unrelated edit')
  fs.writeFileSync(path.join(repo, 'untracked'), 'new')
  expect(await gitService.statusPaths(repo, ['clean', 'literal[1]'])).toEqual([])
  const dirty = files => new Set(files.flatMap(f => [f.path, f.originalPath].filter(Boolean)))
  for (const name of ['staged', 'unstaged', 'deleted', 'old-name', 'new-name', 'untracked']) {
    expect(dirty(await gitService.statusPaths(repo, [name])).has(name)).toBe(true)
  }
  fs.writeFileSync(path.join(repo, 'literal[1]'), 'literal edit')
  expect((await gitService.statusPaths(repo, ['literal[1]'])).map(f => f.path)).toEqual(['literal[1]'])
  expect(await gitService.statusPaths('does-not-exist', [])).toEqual([])
  await expect(gitService.statusPaths('does-not-exist', ['asset'])).rejects.toThrow()
})

test('scoped status batches long path lists, deduplicates paths and rejects partial failures', async () => {
  const calls = []; let fail = false
  const service = component('electron/services/GitService.ts', {
    '../util/repo-gate': { withRepoSlot: (_, mode, fn) => { expect(mode).toBe('read'); return fn() } },
    '../util/dugite-exec': { execSafe: async args => {
      calls.push(args)
      return fail && calls.length === 2 ? { exitCode: 1, stderr: 'failed check' }
        : { exitCode: 0, stdout: args.slice(args.indexOf('--') + 1).map(p => ` M ${p}\0`).join('') }
    } },
  }).exports.gitService
  const paths = Array.from({ length: 500 }, (_, i) => `long-folder-name/${i}/asset.uasset`)
  expect(await service.statusPaths('repo', [...paths, paths[0]])).toHaveLength(paths.length)
  expect(calls.length).toBeGreaterThan(1)
  expect(calls.every(args => args[0] === '--literal-pathspecs' && args.join(' ').length < 7200)).toBe(true)
  calls.length = 0; fail = true
  await expect(service.statusPaths('repo', paths)).rejects.toThrow('failed check')
})

test('scoped status preserves real LFS edits, detects both index and working changes, and fails closed on filter errors', async () => {
  const repo = lfsRepo(['Clean', 'Staged', 'Unstaged', 'Both', 'Deleted', 'Renamed'])
  const edits = new Map()
  const edit = (name, byte) => {
    const bytes = Buffer.alloc(200_000, byte)
    fs.writeFileSync(path.join(repo, name + '.uasset'), bytes)
    edits.set(name + '.uasset', bytes)
  }
  edit('Staged', 1); edit('Both', 2)
  git(repo, 'add', 'Staged.uasset', 'Both.uasset')
  edit('Unstaged', 3); edit('Both', 4)
  fs.unlinkSync(path.join(repo, 'Deleted.uasset'))
  git(repo, 'mv', 'Renamed.uasset', 'Moved.uasset')
  const head = git(repo, 'rev-parse', 'HEAD'), index = git(repo, 'diff', '--cached', '--binary')
  const full = await gitService.status(repo, 'lfs-safety-test')
  const selected = await gitService.statusPaths(repo, ['Clean', 'Staged', 'Unstaged', 'Both', 'Deleted', 'Renamed', 'Moved'].map(n => n + '.uasset'))
  expect(selected).toEqual(full)
  expect(selected.find(f => f.path === 'Both.uasset')).toMatchObject({ indexStatus: 'M', workingStatus: 'M' })
  expect(await gitService.statusPaths(repo, ['Clean.uasset'])).toEqual([])
  // A required LFS clean-filter failure must never look like a clean file eligible for unlock.
  git(repo, 'config', 'filter.lfs.process', 'false')
  edit('Unstaged', 5)
  await expect(gitService.statusPaths(repo, ['Unstaged.uasset'])).rejects.toThrow()
  for (const [name, bytes] of edits) expect(fs.readFileSync(path.join(repo, name)).equals(bytes)).toBe(true)
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(repo, 'diff', '--cached', '--binary')).toBe(index)
})

test('post-push checks only owned outgoing locks and retains all locks if status fails', async () => {
  const handlers = new Map(), targets = [], queries = [], notices = []
  let fail = false
  const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
  component('electron/ipc/handlers.ts', {
    electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } }, './channels': { CHANNELS },
    '../util/repo-gate': { withRepoSlot: (_, __, fn) => fn() },
    '../services/GitService': { gitService: {
      invalidateStatusCache() {}, push: async () => ({ branch: 'main', filesAhead: ['clean', 'dirty', 'renamed', 'foreign'] }), defaultBranch: async () => 'main',
      statusPaths: async (_, paths) => { queries.push(paths); if (fail) throw Error('scan failed'); return [{ path: 'dirty' }, { path: 'new-name', originalPath: 'renamed' }] },
    } },
    '../services/AuthService': { authService: { listAccounts: () => ({ currentAccountId: '1', accounts: [{ userId: '1', login: 'me' }] }) } },
    '../services/LockService': { lockService: {
      listLocks: async () => ['clean', 'dirty', 'renamed', 'foreign', 'unpublished'].map(p => ({ id: p, path: p, owner: { login: p === 'foreign' ? 'other' : 'me' } })),
      unlockFiles: async (_, files) => { targets.push(...files); return { failed: [] } },
    } },
    '../services/LogService': { logService: { error() {} } },
    '../services/NotificationService': { notificationService: { push: (_, type) => { notices.push(type); return { type } } } },
  }).exports.registerHandlers()
  const event = { sender: { isDestroyed: () => false, send() {} } }
  await handlers.get(CHANNELS.GIT_PUSH)(event, 'repo')
  expect(queries).toEqual([['clean', 'dirty', 'renamed']])
  expect(targets).toEqual([{ filePath: 'clean', lockId: 'clean' }])
  targets.length = 0; fail = true
  await handlers.get(CHANNELS.GIT_PUSH)(event, 'repo')
  expect(targets).toEqual([]); expect(notices).toEqual(['locks-retained'])
})

for (const operation of ['Fetch', 'Pull']) test(`${operation} refreshes only the required Git state once`, async () => {
  const calls = [], synced = []
  const repo = { repoPath: 'repo', currentBranch: 'main', branches: [], fileStatus: [], recentRepos: [], syncTick: 0,
    refreshStatus: async () => calls.push('status'), loadBranches: async () => calls.push('branches'), bumpSyncTick: () => calls.push('tick') }
  const h = component('src/components/layout/TopBar.tsx', {
    '@/ipc': { ipc: { fetch: async () => calls.push('fetch'), pull: async () => calls.push('pull'), mergeInProgress: async () => null, getSyncStatus: async () => { calls.push('sync'); return {} } } },
    '@/lib/fetchState': { markFetchPerformed() {} },
    '@/lib/topBarSyncBridge': { hasBranchIntegrated: () => false, markBranchIntegrated() {} },
    '@/lib/syncButtonLogic': component('src/lib/syncButtonLogic.ts').exports,
    '@/stores/repoStore': { useRepoStore: store(repo) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [], permissionErrors: {} }) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/errorStore': { useErrorStore: store({ pushRaw: e => { throw Error(e) } }) },
    '@/stores/prStore': { usePRStore: store({ openDialog() {} }) },
    '@/stores/statusToastStore': { useStatusToastStore: store({ show() {} }) },
  })
  const tree = h.render('TopBar', { onSynced: repo => synced.push(repo) })
  const button = find(tree, n => typeof n.props?.onFetch === 'function' && typeof n.props?.onPull === 'function')
  const click = () => button.props[operation === 'Fetch' ? 'onFetch' : 'onPull']()
  expect(button).toBeTruthy(); await click()
  expect(calls).toEqual([operation.toLowerCase(), 'sync', operation === 'Fetch' ? 'branches' : 'status', 'tick'])
  expect(synced).toEqual(['repo'])
  repo.repoPath = 'other'
  calls.length = 0; synced.length = 0
  await click()
  expect(calls).toEqual([operation.toLowerCase()]); expect(synced).toEqual([])
})

test('tree preserves row order, counts and collapse behavior for nested and duplicate paths', () => {
  const { buildTree, flattenTree } = component('src/components/changes/FileTree.tsx', { '@/lib/staging': component('src/lib/staging.ts').exports }, { __privateExports: ['buildTree', 'flattenTree'] }).exports
  const files = ['z/a/one', 'root', 'z/b/two', 'a\\nested\\three', 'z/a/one'].map((path, i) => ({ path, staged: i === 4 }))
  const tree = buildTree(files)
  const rows = flattenTree(tree, 0, new Set(['z/a']))
  expect(rows.map(r => r.type === 'folder' ? [r.fullPath, r.count, r.depth, r.collapsed] : [r.file.path, r.depth])).toEqual([
    ['z', 3, 0, false], ['z/a', 2, 1, true], ['z/b', 1, 1, false], ['z/b/two', 2],
    ['a', 1, 0, false], ['a/nested', 1, 1, false], ['a\\nested\\three', 2], ['root', 0],
  ])
  expect(flattenTree(tree, 0, new Set()).filter(r => r.type === 'file').map(r => r.file)).toEqual([files[0], files[4], files[2], files[3], files[1]])
})

test('sync completion refreshes locks without scheduling another full status scan', () => {
  const scans = [], locks = []
  const repo = { repoPath: 'repo', recentRepos: [], refreshStatus: () => scans.push('status') }
  const h = component('src/components/layout/AppShell.tsx', {
    '@/stores/repoStore': { useRepoStore: store(repo) }, '@/stores/authStore': { useAuthStore: store({ accounts: [], currentAccountId: null, isAdmin: () => false }) },
    '@/stores/operationStore': { useOperationStore: store({}) }, '@/stores/conflictStore': { useConflictStore: store({}) },
    '@/stores/lockStore': { useLockStore: store({ loadLocks: path => locks.push(path) }) },
    '@/stores/notificationStore': { useNotificationStore: store({ notifications: [] }) }, '@/stores/statusToastStore': { useStatusToastStore: store({}) },
    '@/stores/forecastStore': { useForecastStore: store({ conflicts: [] }) }, '@/lib/useAutoFetch': { useAutoFetch() {} },
  })
  const top = find(h.render('AppShell'), n => n.type === 'TopBar')
  top.props.onSynced('repo'); top.props.onSynced('old-repo')
  expect(scans).toEqual([]); expect(locks).toEqual(['repo'])
})

test('indexed staging guard matches existing ownership rules and reads each lock only once', () => {
  const { createStageGuard, canStagePath } = component('src/lib/staging.ts').exports
  let reads = 0
  const locks = Array.from({ length: 1000 }, (_, i) => ({ get path() { reads++; return `folder/${i}` }, owner: { login: i % 2 ? 'other' : 'me' } }))
  const guard = createStageGuard(locks, 'me')
  for (let i = 0; i < 1000; i++) expect(guard(`folder\\${i}`)).toBe(i % 2 === 0)
  expect(reads).toBe(1000)
  const duplicates = [{ path: 'a/b', owner: { login: 'other' } }, { path: 'a\\b', owner: { login: 'me' } }]
  for (const login of [null, 'me', 'other']) for (const file of ['a/b', 'a\\b', 'free']) {
    expect(createStageGuard(duplicates, login)(file)).toBe(canStagePath(file, duplicates, login))
  }
})
