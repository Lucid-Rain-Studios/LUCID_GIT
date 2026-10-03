const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { DIST, git, lfsRepo, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const runner = require(path.join(DIST, 'util/dugite-exec'))
const gate = require(path.join(DIST, 'util/repo-gate'))
const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
const flush = () => new Promise(resolve => setImmediate(resolve))
test.afterAll(cleanup)

test('creating from an older LFS branch restores its bytes without local changes', async () => {
  const repo = lfsRepo(['Hero'])
  const oldBytes = fs.readFileSync(path.join(repo, 'Hero.uasset'))
  git(repo, 'branch', 'older')
  fs.writeFileSync(path.join(repo, 'Hero.uasset'), Buffer.alloc(200000, 'N'))
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'newer asset')
  const steps = []
  await gitService.createBranch(repo, 'review-older', 'older', step => steps.push(step))
  expect(await gitService.currentBranch(repo)).toBe('review-older')
  expect(fs.readFileSync(path.join(repo, 'Hero.uasset'))).toEqual(oldBytes)
  expect(await gitService.status(repo)).toEqual([])
  expect(steps[0].status).toBe('running')
  expect(steps.at(-1).status).toBe('done')
  fs.writeFileSync(path.join(repo, 'Hero.uasset'), 'local edit')
  await gitService.discard(repo, ['Hero.uasset'], false)
  expect(fs.readFileSync(path.join(repo, 'Hero.uasset'))).toEqual(oldBytes)
  expect(await gitService.status(repo)).toEqual([])
})

test('branch creation uses authentication and retries an already-created branch idempotently', async () => {
  const service = new gitService.constructor()
  const realExec = runner.execWithProgress
  const commands = [], authInputs = []
  let created = false, recoveries = 0
  service.refNames = async () => created ? ['new-branch'] : []
  service.authenticatedArgs = async (_repo, args) => {
    authInputs.push(args)
    return ['-c', 'credential.helper=', ...args]
  }
  service.currentBranch = async () => 'original'
  service.recoverForRetry = async () => { recoveries++; return true }
  runner.execWithProgress = async args => {
    commands.push(args)
    if (commands.length === 1) { created = true; throw Error('LFS failed after branch creation') }
  }
  try { await service.createBranch('repo', 'new-branch', 'older', () => {}) }
  finally { runner.execWithProgress = realExec }
  expect(recoveries).toBe(1)
  expect(authInputs).toEqual([
    ['checkout', '-b', 'new-branch', 'older', '--progress'],
    ['checkout', 'new-branch', '--progress'],
  ])
  expect(commands.every(args => args.includes('credential.helper='))).toBe(true)
})

test('post-checkout recovery does not create the same branch again', async () => {
  const service = new gitService.constructor()
  const realExec = runner.exec
  let calls = 0
  service.refNames = async () => []
  service.authenticatedArgs = async (_repo, args) => args
  service.currentBranch = async () => 'new-branch'
  service.recoverForRetry = async () => true
  runner.exec = async () => { calls++; throw Error('LFS lock cache failed after checkout') }
  try { await service.createBranch('repo', 'new-branch', 'older') }
  finally { runner.exec = realExec }
  expect(calls).toBe(1)
})

test('branch creation holds the write slot until checkout finishes, then discard precedes status', async () => {
  const handlers = new Map(), events = [], order = []
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const api = component('electron/ipc/handlers.ts', {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    './channels': { CHANNELS },
    '../util/repo-gate': gate,
    '../util/dugite-exec': { withGitTimeout: fn => fn(), preemptRepoReads() {} },
    '../services/LogService': { logService: { error() {} } },
    '../services/GitService': { gitService: {
      createBranch: async (_repo, _name, _from, progress) => {
        order.push('checkout'); progress({ id: 'checkout', status: 'running' })
        await blocked; order.push('checkout-done')
      },
      status: async () => { order.push('status'); return [] },
      discard: async () => { order.push('discard') },
    } },
  })
  api.exports.registerHandlers()
  const event = { sender: { isDestroyed: () => false, send: (...args) => events.push(args) } }
  const repo = 'C:/branch-switch-gate'
  const creating = handlers.get(CHANNELS.GIT_BRANCH_CREATE)(event, repo, 'new', 'older')
  await flush()
  const reading = handlers.get(CHANNELS.GIT_STATUS)(event, repo)
  const discarding = handlers.get(CHANNELS.GIT_DISCARD)(event, repo, ['Hero.uasset'], false)
  await flush()
  expect(order).toEqual(['checkout'])
  expect(gate.repoSlotState(repo).activeWrite).toBe(true)
  release()
  await Promise.all([creating, reading, discarding])
  expect(order).toEqual(['checkout', 'checkout-done', 'discard', 'status'])
  expect(events[0][0]).toBe(CHANNELS.EVT_OPERATION_PROGRESS)
  expect(gate.repoSlotState(repo)).toEqual({ activeReads: 0, activeWrite: false, waiting: 0 })
})

test('failed branch creation reports error progress and releases the write slot', async () => {
  const handlers = new Map(), events = []
  const api = component('electron/ipc/handlers.ts', {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    './channels': { CHANNELS }, '../util/repo-gate': gate,
    '../services/LogService': { logService: { error() {} } },
    '../services/GitService': { gitService: { createBranch: async () => { throw Error('checkout failed') } } },
  })
  api.exports.registerHandlers()
  const event = { sender: { isDestroyed: () => false, send: (...args) => events.push(args) } }
  const repo = 'C:/branch-switch-failure'
  await expect(handlers.get(CHANNELS.GIT_BRANCH_CREATE)(event, repo, 'new')).rejects.toThrow('checkout failed')
  expect(events.at(-1)[1].status).toBe('error')
  expect(events.at(-1)[1].detail).toContain('checkout failed')
  expect(gate.repoSlotState(repo).activeWrite).toBe(false)
})

test('thumbnail callers never send IPC, including thousands of file/ref requests', async () => {
  let api
  const invocations = []
  component('electron/preload.ts', {
    electron: { contextBridge: { exposeInMainWorld: (_name, value) => { api = value } },
      ipcRenderer: { invoke: (...args) => { invocations.push(args); return Promise.resolve(null) } } },
    './ipc/channels': { CHANNELS },
  })
  const results = await Promise.all(Array.from({ length: 8000 }, (_, i) =>
    api.assetRenderThumbnail('repo', `${i}.uasset`, ['WORKING', 'INDEX', 'HEAD'][i % 3])))
  expect(results.every(result => result === null)).toBe(true)
  expect(invocations).toEqual([])
  await api.assetExtractMetadata('repo', 'Hero.uasset', 'HEAD')
  expect(invocations).toEqual([[CHANNELS.ASSET_EXTRACT_METADATA, 'repo', 'Hero.uasset', 'HEAD']])
})
