const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { DIST, git, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
const gate = require(path.join(DIST, 'util/repo-gate'))
const runner = require(path.join(DIST, 'util/dugite-exec'))
const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
const flush = () => new Promise(resolve => setImmediate(resolve))
test.afterAll(cleanup)

function mountHandlers(gitService) {
  const handlers = new Map()
  const api = component('electron/ipc/handlers.ts', {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    './channels': { CHANNELS },
    '../util/repo-gate': gate,
    '../util/dugite-exec': { withGitTimeout: fn => fn(), preemptRepoReads() {} },
    '../services/LogService': { logService: { error() {}, warn() {} } },
    '../services/GitService': { gitService },
    '../services/HeatmapService': { heatmapService: { markConflictsResolved() {}, recordConflictEvent() {} } },
  })
  api.exports.registerHandlers()
  return handlers
}

const event = { sender: { isDestroyed: () => false, send() {} } }

test('conflict resolution holds the write slot; status and merge-state reads wait for it', async () => {
  const order = []
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const handlers = mountHandlers({
    resolveMergeConflictText: async () => { order.push('resolve'); await blocked; order.push('resolve-done') },
    status: async () => { order.push('status'); return [] },
    mergeInProgress: async () => { order.push('merge-state'); return null },
    getMergeConflictText: async () => { order.push('conflict-text'); return { ours: '', theirs: '' } },
  })
  const repo = 'C:/merge-resolve-gate'
  const resolving = handlers.get(CHANNELS.GIT_MERGE_RESOLVE_TEXT)(event, repo, 'Map.umap', 'theirs')
  await flush()
  const reads = [
    handlers.get(CHANNELS.GIT_STATUS)(event, repo),
    handlers.get(CHANNELS.GIT_MERGE_IN_PROGRESS)(event, repo),
    handlers.get(CHANNELS.GIT_MERGE_GET_CONFLICT_TEXT)(event, repo, 'Map.umap'),
  ]
  await flush()
  expect(order).toEqual(['resolve'])
  expect(gate.repoSlotState(repo).activeWrite).toBe(true)
  release()
  await Promise.all([resolving, ...reads])
  expect(order.slice(0, 2)).toEqual(['resolve', 'resolve-done'])
  expect(order.slice(2).sort()).toEqual(['conflict-text', 'merge-state', 'status'])
  expect(gate.repoSlotState(repo)).toEqual({ activeReads: 0, activeWrite: false, waiting: 0 })
})

test('merge continue and abort wait for an in-flight status read', async () => {
  for (const channel of [CHANNELS.GIT_MERGE_CONTINUE, CHANNELS.GIT_MERGE_ABORT]) {
    const order = []
    let release
    const blocked = new Promise(resolve => { release = resolve })
    const handlers = mountHandlers({
      status: async () => { order.push('status'); await blocked; order.push('status-done'); return [] },
      continueMerge: async () => { order.push('write') },
      abortMerge: async () => { order.push('write') },
      currentBranch: async () => 'main',
    })
    const repo = `C:/merge-gate-${channel.replace(/\W/g, '-')}`
    const reading = handlers.get(CHANNELS.GIT_STATUS)(event, repo)
    await flush()
    const writing = handlers.get(channel)(event, repo, 'origin/main')
    await flush()
    expect(order).toEqual(['status'])
    release()
    await Promise.all([reading, writing])
    expect(order).toEqual(['status', 'status-done', 'write'])
    expect(gate.repoSlotState(repo)).toEqual({ activeReads: 0, activeWrite: false, waiting: 0 })
  }
})

// Every handler that rewrites the index, working tree or refs. Each must wait
// for an in-flight status read and keep reads out while it runs.
const MUTATIONS = [
  ['GIT_CHERRY_PICK', 'abc'], ['GIT_CHERRY_PICK_CONTINUE'], ['GIT_CHERRY_PICK_ABORT'],
  ['GIT_REVERT', 'abc', false], ['GIT_REBASE_ABORT'], ['GIT_RESTORE_FILE', 'Map.umap', 'abc'],
  ['UNDO_LAST'], ['GIT_STASH_SAVE', 'wip'], ['GIT_STASH_POP', 'stash@{0}'],
  ['GIT_STASH_APPLY', 'stash@{0}'], ['GIT_STASH_DROP', 'stash@{0}'], ['GIT_COMMIT_AMEND', 'msg'],
  ['GIT_APPLY_PATCH', 'patch', true], ['GIT_BRANCH_RENAME', 'a', 'b'], ['GIT_BRANCH_DELETE', 'a', false],
  ['GIT_BRANCH_DELETE_REMOTE', 'origin', 'a'], ['GIT_SET_UPSTREAM', 'a'], ['GIT_SET_CONFIG', 'k', 'v'],
  ['LFS_TRACK', ['*.uasset']], ['LFS_UNTRACK', '*.uasset'], ['CLEANUP_PRUNE_LFS'],
  ['GIT_MERGE_RESOLVE_TEXT', 'Map.umap', 'ours'], ['GIT_MERGE_CONTINUE', 'main'], ['GIT_MERGE_ABORT'],
]

test('every repository mutation waits for an in-flight status and holds the repository exclusively', async () => {
  for (const [name, ...args] of MUTATIONS) {
    const order = []
    let release
    const blocked = new Promise(resolve => { release = resolve })
    const stub = label => new Proxy({}, { get: (_t, method) => async () => {
      if (method === 'status') { order.push('status'); await blocked; order.push('status-done'); return [] }
      if (method === 'peek' || method === 'currentBranch') return null
      order.push(`${label}.${String(method)}`)
      return label === 'undo' && method === 'undo' ? { ok: true } : undefined
    } })
    const handlers = new Map()
    component('electron/ipc/handlers.ts', {
      electron: { ipcMain: { handle: (n, fn) => handlers.set(n, fn) } },
      './channels': { CHANNELS }, '../util/repo-gate': gate,
      '../util/dugite-exec': { withGitTimeout: fn => fn(), preemptRepoReads() {} },
      '../services/LogService': { logService: { error() {}, warn() {} } },
      '../services/GitService': { gitService: stub('git') },
      '../services/UndoService': { undoService: stub('undo') },
      '../services/PermissionService': { permissionService: { getCachedPermission: () => 'admin' } },
      '../services/HeatmapService': { heatmapService: { markConflictsResolved() {}, recordConflictEvent() {} } },
    }).exports.registerHandlers()
    const repo = `C:/gate-${name}`
    const reading = handlers.get(CHANNELS.GIT_STATUS)(event, repo)
    await flush()
    const writing = handlers.get(CHANNELS[name])(event, repo, ...args)
    await flush()
    expect(order, name).toEqual(['status'])
    release()
    await Promise.all([reading, writing])
    expect(order[1], name).toBe('status-done')
    expect(order.length, name).toBeGreaterThan(2)
    expect(gate.repoSlotState(repo), name).toEqual({ activeReads: 0, activeWrite: false, waiting: 0 })
  }
})

test('work left running after a write releases its slot no longer bypasses the gate', async () => {
  // A follow-up started without awaiting inside a write — like the PR check a
  // pull fires — inherits the write's async context and runs after it ends.
  const repo = 'C:/gate-leaked-context'
  let startFollowUp, readState = null
  const resume = new Promise(resolve => { startFollowUp = resolve })
  let reading
  await gate.withRepoSlot(repo, 'write', async () => {
    reading = resume.then(() => gate.withRepoSlot(repo, 'read', async () => gate.repoSlotState(repo)))
      .then(state => { readState = state })
  })
  let releaseWrite
  const writing = gate.withRepoSlot(repo, 'write', () => new Promise(resolve => { releaseWrite = resolve }))
  await flush()
  startFollowUp()
  await flush(); await flush()
  expect(readState).toBeNull()
  releaseWrite()
  await Promise.all([writing, reading])
  expect(readState).toEqual({ activeReads: 1, activeWrite: false, waiting: 0 })
})

test('concurrent fetches share one process and queue behind a running pull', async () => {
  const { gitService } = require(path.join(DIST, 'services/GitService'))
  const service = new gitService.constructor()
  const realProgress = runner.execWithProgress
  const started = []
  let finishPull
  service.getRemoteUrl = async () => 'https://example.invalid/repo.git'
  service.pullReconcileArgs = async () => ['--no-rebase']
  runner.execWithProgress = async args => {
    const sub = args.find(a => a === 'pull' || a === 'fetch')
    started.push(sub)
    if (sub === 'pull') await new Promise(resolve => { finishPull = resolve })
  }
  try {
    const pulling = service.pull('C:/remote-queue')
    await flush(); await flush()
    const fetches = [service.fetch('C:/remote-queue'), service.fetch('C:/remote-queue'), service.fetch('C:/REMOTE-QUEUE')]
    await flush(); await flush()
    expect(started).toEqual(['pull'])
    finishPull()
    await Promise.all([pulling, ...fetches])
    expect(started).toEqual(['pull', 'fetch'])
    await service.fetch('C:/remote-queue')
    expect(started).toEqual(['pull', 'fetch', 'fetch'])
  } finally { runner.execWithProgress = realProgress }
})

test('resolving every conflict of a real merge stages the chosen sides and finalizes', async () => {
  const { gitService } = require(path.join(DIST, 'services/GitService'))
  const repo = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lg-merge-resolve-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'core.autocrlf', 'false')
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(repo, f), 'base\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-qb', 'feature')
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(repo, f), 'feature\n')
  git(repo, 'commit', '-qam', 'feature')
  git(repo, 'checkout', '-q', 'main')
  for (const f of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(repo, f), 'main\n')
  git(repo, 'commit', '-qam', 'main')
  await expect(gitService.merge(repo, 'feature')).rejects.toThrow()
  await gitService.resolveMergeConflictText(repo, 'a.txt', 'ours')
  await gitService.resolveMergeConflictText(repo, 'b.txt', 'theirs')
  await gitService.continueMerge(repo, 'feature')
  expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('main\n')
  expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('feature\n')
  expect(await gitService.mergeInProgress(repo)).toBeNull()
  expect(fs.existsSync(path.join(repo, '.git', 'index.lock'))).toBe(false)
  fs.rmSync(repo, { recursive: true, force: true })
})
