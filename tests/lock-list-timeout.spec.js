const { test, expect } = require('@playwright/test')
const { component } = require('./renderer-harness')
const { DIST } = require('./helpers')
const path = require('path')
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function setup(deadline = fn => fn()) {
  let account = 'A'
  const { lockService } = component('electron/services/LockService.ts', {
    './AuthService': { authService: { listAccounts: () => ({ currentAccountId: account }) } },
    '../util/dugite-exec': { withGitTimeout: deadline },
  }).exports
  return { service: lockService, account: value => { account = value } }
}

test('lock listing shares concurrent refreshes and arms its deadline after the LFS queue drains', async () => {
  const deadlines = [], writer = deferred(), network = deferred()
  const { service } = setup((fn, ms, label) => { deadlines.push({ ms, label }); return fn() })
  let requests = 0
  service.listLocksUnguarded = async () => { requests++; await network.promise; return [{ id: 'server' }] }
  const writing = service.withLfsLock('repo', () => writer.promise)
  const first = service.listLocks('repo'), second = service.listLocks('repo')
  await flush()
  expect(deadlines).toEqual([]); expect(requests).toBe(0)
  writer.resolve(); await writing; await flush()
  expect(deadlines).toEqual([{ ms: 30000, label: 'lock:list' }]); expect(requests).toBe(1)
  network.resolve()
  expect(await first).toEqual(await second)
  await service.listLocks('repo')
  expect(requests).toBe(2); expect(service.pendingLists.size).toBe(0)
})

test('failed lock listing rejects all shared callers, retains known locks and permits retry', async () => {
  const network = deferred(), { service } = setup()
  const known = { locks: [{ id: 'known' }], at: 1, accountId: 'A' }
  service.authoritative.set('repo', known)
  service.listLocksUnguarded = async () => { await network.promise; throw Error('lock:list timed out after 30s') }
  const results = Promise.allSettled([service.listLocks('repo'), service.listLocks('repo')])
  network.resolve()
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(service.authoritative.get('repo')).toBe(known)
  expect(service.pendingLists.size).toBe(0)
  service.listLocksUnguarded = async () => [{ id: 'retry' }]
  expect(await service.listLocks('repo')).toEqual([{ id: 'retry' }])
})

test('different repositories and account sessions do not share pending listings', async () => {
  const network = deferred(), { service, account } = setup()
  let requests = 0
  service.listLocksUnguarded = async () => { requests++; await network.promise; return [] }
  const first = service.listLocks('repo'), other = service.listLocks('other')
  account('B'); const changed = service.listLocks('repo')
  await flush(); expect(requests).toBe(2)
  network.resolve(); await Promise.all([first, other, changed])
  expect(requests).toBe(3); expect(service.pendingLists.size).toBe(0)
})

test('a real execution deadline rejects a stalled refresh and releases the LFS queue for retry', async () => {
  const { withGitTimeout } = require(path.join(DIST, 'util/dugite-exec'))
  const { service } = setup((fn, _ms, label) => withGitTimeout(fn, 10, label))
  service.listLocksUnguarded = () => new Promise(() => {})
  const results = await Promise.allSettled([service.listLocks('repo'), service.listLocks('repo')])
  for (const result of results) {
    expect(result.status).toBe('rejected')
    expect(result.reason.message).toContain('lock:list timed out after')
  }
  await flush()
  expect(service.pendingLists.size).toBe(0); expect(service.lfsQueues.size).toBe(0)
  service.listLocksUnguarded = async () => []
  expect(await service.listLocks('repo')).toEqual([])
})
