const { test, expect } = require('@playwright/test')
const { component, store } = require('../renderer-harness')

function setup(fetch = async () => {}) {
  let now = 120000
  const settings = { autoFetchIntervalMinutes: 1 }
  const document = { hidden: false }
  const operation = { isRunning: false }
  const fetchedAt = new Map()
  const calls = []
  const timers = new Set()
  const listeners = new Map()
  const repo = { repoPath: 'repo', bumpSyncTick: () => calls.push(['refresh', repo.repoPath]) }
  const hook = component('src/lib/useAutoFetch.ts', {
    '@/ipc': { ipc: {
      settingsGet: async () => settings,
      fetch: (...args) => { calls.push(['fetch', ...args]); return fetch(...args) },
    } },
    '@/stores/repoStore': { useRepoStore: store(repo) },
    '@/stores/operationStore': { useOperationStore: store(operation) },
    './fetchState': {
      getLastFetch: repoPath => fetchedAt.get(repoPath),
      markFetchPerformed: repoPath => fetchedAt.set(repoPath, now),
    },
  }, {
    Date: { now: () => now }, document,
    window: {
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: (event, fn) => { if (listeners.get(event) === fn) listeners.delete(event) },
    },
    setInterval: fn => { timers.add(fn); return fn },
    clearInterval: fn => timers.delete(fn),
  })
  const start = async () => {
    hook.render('useAutoFetch', repo.repoPath)
    const cleanup = hook.effects[0]()
    await Promise.resolve()
    return cleanup
  }
  return { start, repo, operation, document, settings, fetchedAt, calls, timers, listeners,
    tick: () => [...timers][0](), advance: ms => { now += ms } }
}

test('background fetch waits for configured interval and skips hidden or busy windows', async () => {
  const app = setup()
  await app.start()
  app.fetchedAt.set('repo', 119999)
  await app.tick()
  app.advance(60000)
  app.document.hidden = true
  await app.tick()
  app.document.hidden = false
  app.operation.isRunning = true
  await app.tick()
  expect(app.calls).toEqual([])

  app.operation.isRunning = false
  await app.tick()
  await app.tick()
  expect(app.calls).toEqual([['fetch', 'repo', true], ['refresh', 'repo']])
  expect(app.fetchedAt.get('repo')).toBe(180000)
})

test('a failed background fetch waits a full interval before retrying', async () => {
  const app = setup(async () => { throw Error('offline') })
  await app.start()
  await app.tick()
  app.advance(59999)
  await app.tick()
  expect(app.calls).toEqual([['fetch', 'repo', true]])
  expect(app.fetchedAt.has('repo')).toBe(false)

  app.advance(1)
  await app.tick()
  expect(app.calls).toEqual([['fetch', 'repo', true], ['fetch', 'repo', true]])
})

test('switching repositories during fetch prevents overlap and stale refreshes', async () => {
  let finish
  const app = setup(repo => repo === 'repo' ? new Promise(resolve => { finish = resolve }) : Promise.resolve())
  const stop = await app.start()
  const pending = app.tick()
  stop()
  expect(app.timers.size).toBe(0)
  expect(app.listeners.size).toBe(0)

  app.repo.repoPath = 'other'
  await app.start()
  await app.tick()
  expect(app.calls).toEqual([['fetch', 'repo', true]])
  finish()
  await pending
  await app.tick()
  expect(app.calls).toEqual([['fetch', 'repo', true], ['fetch', 'other', true], ['refresh', 'other']])
  expect([...app.fetchedAt.keys()]).toEqual(['repo', 'other'])
})

test('changing auto-fetch settings takes effect without remounting the hook', async () => {
  const app = setup()
  app.settings.autoFetchIntervalMinutes = 0
  await app.start()
  await app.tick()
  expect(app.calls).toEqual([])

  app.settings.autoFetchIntervalMinutes = 1
  await app.listeners.get('lucid-git:settings-changed')()
  await app.tick()
  expect(app.calls).toEqual([['fetch', 'repo', true], ['refresh', 'repo']])
})
