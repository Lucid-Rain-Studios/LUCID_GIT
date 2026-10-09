const { test, expect } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { component, find, store } = require('./renderer-harness')
const { tmpDir, cleanup, git, DIST } = require('./helpers')
const runner = require(path.join(DIST, 'util/dugite-exec'))
const flush = () => new Promise(resolve => setImmediate(resolve))
function service(runnerMock, remote = 'https://github.com/owner/repo.git', maintenance = async () => {}) {
  const events = [], heat = []
  let tokens = 0, remotes = 0
  const { lockService } = component('electron/services/LockService.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (...args) => events.push(args) } }] } },
    '../ipc/channels': { CHANNELS: { EVT_LOCK_CHANGED: 'locks' } },
    './AuthService': { authService: { getCurrentToken: async () => { tokens++; return null }, listAccounts: () => ({ currentAccountId: 'me' }) } },
    './GitService': { gitService: { getRemoteUrl: async () => { remotes++; return remote }, lfsLocksMaintenance: maintenance } },
    './HeatmapService': { heatmapService: { recordLockEvent: event => heat.push(event) } },
    '../util/dugite-exec': runnerMock,
  }).exports
  return { lockService, events, heat, reads: () => ({ tokens, remotes }) }
}
const targets = n => Array.from({ length: n }, (_, i) => ({ filePath: `file-${i}.txt`, lockId: String(i) }))
test.afterAll(cleanup)

test('40 unlocks use four isolated workers, report every outcome, and reconcile only once', async () => {
  let active = 0, peak = 0, refreshes = 0, released = false
  const storages = new Set(), steps = [], pending = []
  const svc = service({
    gitAuthArgs: () => [], withGitTimeout: fn => fn(),
    execWithStdin: async (args, repo, stdin, env) => {
      expect(env.GIT_OPTIONAL_LOCKS).toBe('0')
      const storage = args.find(arg => arg.startsWith('lfs.storage=')).slice(12)
      expect(fs.existsSync(storage)).toBe(true); storages.add(storage)
      active++; peak = Math.max(peak, active)
      if (!released) await new Promise(resolve => pending.push(resolve))
      await flush(); active--
      if (args.includes('--id=7')) throw Error('ownership changed')
      return { stdout: '' }
    },
    exec: async args => {
      expect(active).toBe(0); expect(args).toContain('--verify'); refreshes++
      return { stdout: JSON.stringify({ ours: [{ id: '7', path: 'file-7.txt', owner: { name: 'me' } }], theirs: [] }) }
    },
  })
  const running = svc.lockService.unlockFiles(tmpDir('unlock-unit-'), targets(40), '', '', step => steps.push(step))
  for (let i = 0; i < 100 && pending.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(pending).toHaveLength(4); expect(refreshes).toBe(0)
  released = true; pending.forEach(resolve => resolve())
  const result = await running
  expect(peak).toBe(4); expect(storages.size).toBe(4); expect(refreshes).toBe(1)
  expect(result.unlocked).toHaveLength(39)
  expect(result.failed).toEqual([{ filePath: 'file-7.txt', error: 'Error: ownership changed' }])
  expect(result.locks.map(lock => lock.id)).toEqual(['7'])
  expect(svc.reads()).toEqual({ tokens: 1, remotes: 1 })
  expect(steps.filter(step => step.id.startsWith('unlock-batch-file-') && step.status === 'running')).toHaveLength(40)
  expect(steps.filter(step => step.id.startsWith('unlock-batch-file-') && step.status !== 'running')).toHaveLength(40)
  expect(steps.at(-1).status).toBe('error')
  for (const storage of storages) expect(fs.existsSync(storage)).toBe(false)
})

test('refresh failure preserves successful unlock results and reports stale state', async () => {
  const svc = service({ gitAuthArgs: () => [], withGitTimeout: fn => fn(),
    execWithStdin: async () => {}, exec: async () => { throw Error('offline') } })
  const result = await svc.lockService.unlockFiles(tmpDir('unlock-offline-'), targets(2))
  expect(result.unlocked).toHaveLength(2); expect(result.failed).toEqual([])
  expect(result.refreshError).toContain('offline')
  expect(svc.events.at(-1)[1].error).toContain('stale')
})

test('damaged shared cache is repaired once after workers drain, with no retry loop', async () => {
  let active = 0, repairs = 0, refreshes = 0
  const svc = service({ gitAuthArgs: () => [], withGitTimeout: fn => fn(),
    execWithStdin: async () => { active++; await flush(); active-- },
    exec: async () => { refreshes++; throw Error('Unable to create lock system: corrupt cache') },
  }, undefined, async () => { expect(active).toBe(0); repairs++ })
  const result = await svc.lockService.unlockFiles(tmpDir('unlock-corrupt-'), targets(6))
  expect(result.unlocked).toHaveLength(6); expect(result.failed).toEqual([])
  expect(repairs).toBe(1); expect(refreshes).toBe(2); expect(result.refreshError).toContain('corrupt cache')
})

test('real Git LFS unlocks 40 locks concurrently without corrupting cache or changing assets', async () => {
  const dir = tmpDir('unlock-real-'), items = targets(40)
  git(dir, 'init', '-qb', 'main'); git(dir, 'config', 'user.name', 'me'); git(dir, 'config', 'user.email', 'me@test.local')
  git(dir, 'config', 'lfs.repositoryformatversion', '0')
  for (const item of items.slice(0, -1)) fs.writeFileSync(path.join(dir, item.filePath), item.filePath)
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'files')
  const locks = new Map(items.map(item => [item.lockId, { id: item.lockId, path: item.filePath, owner: { name: 'me' }, locked_at: new Date().toISOString() }]))
  let active = 0, peak = 0, verifies = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let data, status = 200
    if (url.pathname.endsWith('/locks/verify')) { verifies++; data = { ours: [...locks.values()], theirs: [] } }
    else if (url.pathname.endsWith('/unlock')) {
      const id = url.pathname.split('/').at(-2), lock = locks.get(id)
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 150))
      active--; locks.delete(id); data = { lock }
    } else if (url.pathname.endsWith('/locks')) {
      const id = url.searchParams.get('id'); data = { locks: [...locks.values()].filter(lock => !id || lock.id === id) }
    } else { status = 404; data = { message: 'unknown path' } }
    res.writeHead(status, { 'Content-Type': 'application/vnd.git-lfs+json' }); res.end(JSON.stringify(data))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const remote = `http://127.0.0.1:${server.address().port}/repo.git`
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'config', 'lfs.url', remote + '/info/lfs')
  const svc = service(runner, remote)
  try {
    await runner.exec(['lfs', 'locks', '--verify', '--json'], dir)
    verifies = 0
    const result = await svc.lockService.unlockFiles(dir, items)
    expect(result.failed).toEqual([]); expect(result.refreshError).toBeUndefined()
    expect(result.unlocked).toHaveLength(40); expect(result.locks).toEqual([])
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4); expect(verifies).toBe(1)
    expect(JSON.parse((await runner.exec(['lfs', 'locks', '--local', '--json'], dir)).stdout)).toEqual([])
    expect(git(dir, 'status', '--porcelain')).toBe('')
    for (const item of items.slice(0, -1)) expect(fs.readFileSync(path.join(dir, item.filePath), 'utf8')).toBe(item.filePath)
    expect(fs.existsSync(path.join(dir, items.at(-1).filePath))).toBe(false)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('Locked Files keeps live progress, all failures and completed results visible', async () => {
  const locks = targets(3).map(target => ({ id: target.lockId, path: target.filePath, owner: { login: 'me', name: 'me' }, lockedAt: new Date().toISOString() }))
  let resolve, fail = false
  const op = { steps: [], start() { this.steps = [] }, finish() {} }
  const state = { locks, loadLocks() {}, unlockFiles: () => fail ? Promise.reject(Error('offline')) : new Promise(r => { resolve = r }) }
  const c = component('src/components/locks/LockedFilesPanel.tsx', {
    '@/stores/lockStore': { useLockStore: store(state) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [{ userId: 'me', login: 'me' }], currentAccountId: 'me', isAdmin: () => false }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async () => true, alert: async () => {} }) },
    '@/stores/operationStore': { useOperationStore: store(op) },
  })
  const render = () => c.render('LockedFilesPanel', { repoPath: 'repo' })
  const text = tree => JSON.stringify(tree)
  const running = find(render(), node => node.props?.children?.includes('Unlock All')).props.onClick()
  await flush()
  expect(text(render())).toContain('Queued')
  op.steps = [{ id: 'unlock-batch-file-0', status: 'done' }, { id: 'unlock-batch-file-1', status: 'running' }]
  expect(text(render())).toContain('Unlocking')
  resolve({ unlocked: ['file-0.txt'], failed: [{ filePath: 'file-1.txt', error: 'changed owner' }, { filePath: 'file-2.txt', error: 'denied' }] })
  await running
  expect(text(render())).toContain('changed owner'); expect(text(render())).toContain('denied')
  expect(text(render())).toContain('Unlocked')
  expect(text(c.render('LockedFilesPanel', { repoPath: 'other' }))).not.toContain('changed owner')
  fail = true
  await find(render(), node => node.props?.children?.includes('Unlock All')).props.onClick()
  expect(text(render())).toContain('offline'); expect(text(render())).not.toContain('Queued')
})
