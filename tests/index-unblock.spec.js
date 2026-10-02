const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const { tmpDir, git, cleanup, DIST } = require('./helpers')
const { component, find, store } = require('./renderer-harness')
const { IndexRecoveryService } = require(path.join(DIST, 'services/IndexRecoveryService'))
const runner = require(path.join(DIST, 'util/dugite-exec'))
const flush = () => new Promise(resolve => setImmediate(resolve))
test.afterAll(cleanup)

function repo() {
  const dir = tmpDir('lg-unblock ü-')
  git(dir, 'init', '-qb', 'main'); git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'asset.txt'), 'base')
  git(dir, 'add', '.'); git(dir, '-c', 'core.hooksPath=', 'commit', '-qm', 'base')
  return dir
}
const index = dir => git(dir, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()

test('deliberate lock recovery requires confirmation, verifies its backup and preserves staging, HEAD and working bytes', async () => {
  const dir = repo(), s = new IndexRecoveryService(), file = index(dir), lock = file + '.lock'
  fs.writeFileSync(path.join(dir, 'asset.txt'), 'staged'); git(dir, 'add', '.')
  fs.writeFileSync(path.join(dir, 'asset.txt'), 'working')
  const saved = fs.readFileSync(file), head = git(dir, 'rev-parse', 'HEAD'), bytes = Buffer.from([0, 255, 128, 13, 10])
  fs.writeFileSync(lock, bytes)
  const check = await s.checkBlockers(dir)
  expect(check).toMatchObject({ tasks: [], pendingGitCommands: 0, lock: { size: bytes.length } })
  await expect(s.recoverLock(dir, check.lock.token, false)).rejects.toThrow('Confirm')
  expect(fs.readFileSync(lock)).toEqual(bytes)
  expect((await s.diagnose(dir)).canRepair).toBe(false)
  const result = await s.recoverLock(dir, check.lock.token, true)
  expect(fs.readFileSync(path.join(result.backupPath, 'original-index.lock'))).toEqual(bytes)
  expect(result.blockers.lock).toBeNull()
  expect(fs.existsSync(lock)).toBe(false)
  expect(fs.readFileSync(file)).toEqual(saved)
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(dir, 'show', ':asset.txt').trim()).toBe('staged')
  expect(fs.readFileSync(path.join(dir, 'asset.txt'), 'utf8')).toBe('working')
  expect((await s.diagnose(dir)).issue).toBe('healthy')
})

test('changed locks, locks in another repository and a replacement during backup are never removed', async () => {
  const dir = repo(), other = repo(), s = new IndexRecoveryService(), lock = index(dir) + '.lock', otherLock = index(other) + '.lock'
  fs.writeFileSync(lock, 'reviewed'); fs.writeFileSync(otherLock, 'other writer')
  const check = await s.checkBlockers(dir)
  await expect(s.recoverLock(other, check.lock.token, true)).rejects.toThrow('changed after review')
  expect(fs.readFileSync(otherLock, 'utf8')).toBe('other writer')
  fs.writeFileSync(lock, 'newer writer')
  await expect(s.recoverLock(dir, check.lock.token, true)).rejects.toThrow('changed after review')
  const current = await s.checkBlockers(dir), open = fs.promises.open
  fs.promises.open = async (file, ...args) => {
    const handle = await open(file, ...args)
    if (file.endsWith('original-index.lock')) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { await sync(); fs.unlinkSync(lock); fs.writeFileSync(lock, 'replacement writer') }
    }
    return handle
  }
  try { await expect(s.recoverLock(dir, current.lock.token, true)).rejects.toThrow('changed during backup') }
  finally { fs.promises.open = open }
  expect(fs.readFileSync(lock, 'utf8')).toBe('replacement writer')
})

test('a failed backup preserves the lock, and an already released lock needs no removal', async () => {
  const dir = repo(), s = new IndexRecoveryService(), lock = index(dir) + '.lock'
  fs.writeFileSync(lock, 'writer'); const check = await s.checkBlockers(dir), open = fs.promises.open
  fs.promises.open = async (file, ...args) => {
    if (file.endsWith('original-index.lock')) throw Error('disk full')
    return open(file, ...args)
  }
  try { await expect(s.recoverLock(dir, check.lock.token, true)).rejects.toThrow('disk full') }
  finally { fs.promises.open = open }
  expect(fs.readFileSync(lock, 'utf8')).toBe('writer')
  fs.unlinkSync(lock)
  expect(await s.recoverLock(dir, check.lock.token, true)).toMatchObject({ backupPath: null, blockers: { lock: null } })
})

test('a failed follow-up probe still returns the backup and states that the reviewed lock was removed', async () => {
  const dir = repo(), s = new IndexRecoveryService(), lock = index(dir) + '.lock'
  fs.writeFileSync(lock, 'reviewed writer'); const check = await s.checkBlockers(dir)
  s.checkBlockers = async () => { throw Error('follow-up I/O failure') }
  const result = await s.recoverLock(dir, check.lock.token, true)
  expect(result.blockers.lockError).toContain('lock was removed')
  expect(result.blockers.lockError).toContain('I/O failure')
  expect(fs.existsSync(lock)).toBe(false)
  expect(fs.readFileSync(path.join(result.backupPath, 'original-index.lock'), 'utf8')).toBe('reviewed writer')
})

test('worktree lock recovery targets the linked gitdir and leaves parent locks and indexes intact', async () => {
  const parent = repo(), dir = tmpDir('lg-unblock-worktree-'), s = new IndexRecoveryService()
  git(parent, '-c', 'core.hooksPath=', 'worktree', 'add', '-qb', 'other', dir)
  const parentIndex = fs.readFileSync(index(parent)), parentLock = index(parent) + '.lock', lock = index(dir) + '.lock'
  fs.writeFileSync(parentLock, 'parent writer'); fs.writeFileSync(lock, 'worktree writer')
  const check = await s.checkBlockers(dir)
  expect(path.resolve(check.lock.path)).toBe(path.resolve(lock))
  await s.recoverLock(dir, check.lock.token, true)
  expect(fs.existsSync(lock)).toBe(false)
  expect(fs.readFileSync(parentLock, 'utf8')).toBe('parent writer')
  expect(fs.readFileSync(index(parent))).toEqual(parentIndex)
})

test('uninspectable and nonregular locks remain visible as errors; no recovery token is offered', async () => {
  const dir = repo(), s = new IndexRecoveryService(), lock = index(dir) + '.lock'
  fs.mkdirSync(lock)
  expect(await s.checkBlockers(dir)).toMatchObject({ lock: null, lockError: expect.stringContaining('regular file') })
  await expect(s.recoverLock(dir, 'invented', true)).rejects.toThrow('regular file')
  expect(fs.statSync(lock).isDirectory()).toBe(true)
})

function processRegistry(mocks = {}) {
  return component('electron/util/dugite-exec.ts', {
    dugite: {}, '../services/LogService': { logService: { warn() {} } },
    './git-command': require(path.join(DIST, 'util/git-command')), ...mocks,
  }, { process, __privateExports: ['registerGitProcess'] }).exports
}

test('stopping reviewed tasks waits for exit, kills their Windows tree and leaves new/other-repository tasks running', async () => {
  const api = processRegistry(), dir = tmpDir('lg-process-scope-'), other = tmpDir('lg-process-other-'), children = []
  let descendant
  const start = async (repoPath, tree = false) => {
    const script = tree
      ? "const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(c.pid);setInterval(()=>{},1000)"
      : 'console.log(process.pid);setInterval(()=>{},1000)'
    const child = spawn(process.execPath, ['-e', script], { cwd: repoPath, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(child)
    api.registerGitProcess(child, ['-c', 'http.extraheader=AUTHORIZATION: secret', 'status'], repoPath)
    const pid = await new Promise(resolve => child.stdout.once('data', bytes => resolve(Number(bytes.toString().trim()))))
    if (tree) descendant = pid
    return child
  }
  try {
    const first = await start(dir, process.platform === 'win32'), outside = await start(other)
    const reviewed = api.repoGitTasks(dir)
    expect(JSON.stringify(reviewed)).not.toContain('secret')
    expect(reviewed[0].command).toBe('git status')
    const late = await start(dir)
    expect(await api.stopRepoGitTasks(dir, [{ ...reviewed[0], startedAt: reviewed[0].startedAt - 1 }])).toBe(0)
    expect(await api.stopRepoGitTasks(other, reviewed)).toBe(0)
    expect(await api.stopRepoGitTasks(dir, reviewed)).toBe(1)
    expect(first.exitCode !== null || first.signalCode !== null).toBe(true)
    expect(outside.exitCode).toBeNull(); expect(late.exitCode).toBeNull()
    if (descendant) expect(() => process.kill(descendant, 0)).toThrow()
    expect(api.repoGitTasks(dir).map(task => task.pid)).toEqual([late.pid])
  } finally {
    await Promise.allSettled([api.stopRepoGitTasks(dir, api.repoGitTasks(dir)), api.stopRepoGitTasks(other, api.repoGitTasks(other))])
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill()
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch { /* already exited */ } }
  }
})

test('failed process termination keeps the task registered and reports failure', async () => {
  const api = processRegistry({ 'node:child_process': { execFile: (_file, _args, _opts, done) => done(Error('access denied')) } })
  const child = Object.assign(new EventEmitter(), { pid: 12345678, exitCode: null, signalCode: null,
    kill: () => { throw Error('access denied') } })
  api.registerGitProcess(child, ['checkout', 'main'], 'repo')
  const tasks = api.repoGitTasks('repo')
  expect(tasks[0].readOnly).toBe(false)
  await expect(api.stopRepoGitTasks('repo', tasks)).rejects.toThrow(/access denied|Could not stop/)
  expect(api.repoGitTasks('repo')).toHaveLength(1)
  child.emit('close', 1)
})

test('an interrupted streaming Git write rejects instead of continuing as a successful operation', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })
  const api = component('electron/util/dugite-exec.ts', {
    dugite: { GitProcess: { spawn: () => child } }, '../services/LogService': { logService: { warn() {} } },
    './git-command': require(path.join(DIST, 'util/git-command')),
  }, { process }).exports
  const run = api.execWithProgress(['checkout', 'branch'], 'repo')
  child.emit('close', null)
  await expect(run).rejects.toThrow('interrupted before completing')
})

test('process inspection and cancellation IPC bypass a held repository write slot and carry confirmation', async () => {
  const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
  const { withRepoSlot, repoSlotState } = require(path.join(DIST, 'util/repo-gate'))
  const handlers = new Map(), calls = []
  component('electron/ipc/handlers.ts', {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } }, './channels': { CHANNELS },
    '../services/LogService': { logService: { error() {} } },
    '../services/IndexRecoveryService': { indexRecoveryService: {
      checkBlockers: async repo => { calls.push(['check', repo]); return {} },
      stopTasks: async (...args) => { expect(repoSlotState('ipc-repo').activeWrite).toBe(true); calls.push(args); return 1 },
    } },
  }).exports.registerHandlers()
  let release
  const hold = withRepoSlot('ipc-repo', 'write', () => new Promise(resolve => { release = resolve }))
  const tasks = [{ pid: 10, startedAt: 1 }], event = { sender: { isDestroyed: () => true } }
  try {
    const stop = handlers.get(CHANNELS.GIT_INDEX_STOP_TASKS)(event, 'ipc-repo', tasks, true)
    expect(await Promise.race([stop, new Promise((_, reject) => setTimeout(() => reject(Error('Cancellation queued behind write')), 1000))])).toBe(1)
    await handlers.get(CHANNELS.GIT_INDEX_BLOCKERS)(event, 'ipc-repo')
    expect(calls).toEqual([['ipc-repo', tasks, true], ['check', 'ipc-repo']])
  } finally { release(); await hold }
})

test('diagnosis stays actionable while a Lucid Git task is active; lock removal refuses unfinished commands', async () => {
  const dir = repo(), lock = index(dir) + '.lock'; fs.writeFileSync(lock, 'writer')
  const tasks = [{ pid: 55, startedAt: 1, command: 'git checkout', readOnly: false, ageSeconds: 60 }]
  let pending = 1
  const { IndexRecoveryService: Service } = component('electron/services/IndexRecoveryService.ts', {
    '../util/dugite-exec': { ...runner, repoGitTasks: () => tasks, gitOpActivity: () => ({ inFlight: pending }) },
    '../util/repo-gate': require(path.join(DIST, 'util/repo-gate')),
  }, { Buffer, process }).exports
  const s = new Service()
  expect(await s.diagnose(dir)).toMatchObject({ issue: 'blocked', summary: 'Lucid Git tasks are still in progress' })
  const check = await s.checkBlockers(dir)
  await expect(s.recoverLock(dir, check.lock.token, true)).rejects.toThrow('still running')
  tasks.length = 0
  await expect(s.recoverLock(dir, check.lock.token, true)).rejects.toThrow('still running')
  pending = 0
  expect(fs.readFileSync(lock, 'utf8')).toBe('writer')
  await expect(s.stopTasks(dir, [], false)).rejects.toThrow('Confirm')
})

function ui() {
  const calls = [], repoState = { repoPath: 'repo', bumpSyncTick() {} }, state = {
    confirmation: true, onConfirm: () => {}, diagnosis: { issue: 'healthy', summary: 'Healthy', canRepair: false, canUndo: false },
    blockers: { repoPath: 'repo', tasks: [{ pid: 10, startedAt: 1, command: 'git status', ageSeconds: 60, readOnly: true },
      { pid: 11, startedAt: 2, command: 'git checkout', ageSeconds: 60, readOnly: false }], pendingGitCommands: 2,
      lock: { path: 'repo/.git/index.lock', size: 0, ageSeconds: 60, token: 'reviewed' } },
  }
  const h = component('src/components/tools/IndexRecoveryTool.tsx', {
    '@/ipc': { ipc: {
      checkIndexBlockers: async () => { calls.push('check'); return { ...state.blockers, tasks: [...state.blockers.tasks] } },
      stopIndexTasks: async (_repo, tasks, confirmed) => {
        expect(confirmed).toBe(true); calls.push(tasks.map(task => task.pid)); state.blockers.tasks = state.blockers.tasks.filter(task => !tasks.some(t => t.pid === task.pid))
        state.blockers.pendingGitCommands = state.blockers.tasks.length; return tasks.length
      },
      recoverIndexLock: async (_repo, token, confirmed) => {
        calls.push('remove'); expect(token).toBe('reviewed'); expect(confirmed).toBe(true); state.blockers.lock = null
        return { backupPath: 'backup', summary: 'Lock removed', blockers: state.blockers }
      }, diagnoseIndex: async () => state.diagnosis, showInFolder: async () => calls.push('show'),
    } },
    '@/stores/repoStore': { useRepoStore: store(repoState) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async opts => { calls.push(opts.title); state.onConfirm(); return state.confirmation } }) },
    '@/stores/errorStore': { useErrorStore: store({ current: null }) },
  })
  const props = { repoPath: 'repo', onRefresh() {} }
  const render = () => h.render('IndexRecoveryTool', props)
  const button = label => find(render(), n => n.type === 'ActionBtn' && n.props.children.join('') === label)
  return { calls, state, repoState, h, props, render, button }
}

test('UI stops only selected scope, preserves the lock until explicit confirmation, then displays its backup', async () => {
  const u = ui()
  await u.button('Check tasks and lock').props.onClick()
  await u.button('Stop background tasks').props.onClick()
  expect(u.calls).toContainEqual([10])
  expect(u.button('Back up and remove lock').props.disabled).toBe(true)
  await u.button('Stop listed Git tasks').props.onClick()
  expect(u.calls).toContainEqual([11])
  expect(u.calls).not.toContain('remove')
  find(u.render(), n => n.type === 'input').props.onChange({ target: { checked: true } })
  expect(u.button('Back up and remove lock').props.disabled).toBe(false)
  u.state.confirmation = false
  await u.button('Back up and remove lock').props.onClick(); expect(u.calls).not.toContain('remove')
  u.state.confirmation = true
  await u.button('Back up and remove lock').props.onClick(); expect(u.calls).toContain('remove')
  await u.button('Show lock backup').props.onClick(); await flush(); expect(u.calls).toContain('show')
})

test('confirmation cancel and repository switches prevent task termination and lock removal', async () => {
  const u = ui(); await u.button('Check tasks and lock').props.onClick()
  u.state.confirmation = false
  await u.button('Stop listed Git tasks').props.onClick()
  expect(u.calls.some(Array.isArray)).toBe(false)
  u.state.confirmation = true; u.state.onConfirm = () => { u.repoState.repoPath = 'other' }
  await u.button('Stop listed Git tasks').props.onClick()
  expect(u.calls.some(Array.isArray)).toBe(false)
  const other = ui(); other.state.blockers.tasks = []; other.state.blockers.pendingGitCommands = 0
  await other.button('Check tasks and lock').props.onClick()
  find(other.render(), n => n.type === 'input').props.onChange({ target: { checked: true } })
  other.state.onConfirm = () => { other.repoState.repoPath = 'other' }
  await other.button('Back up and remove lock').props.onClick(); expect(other.calls).not.toContain('remove')
})
