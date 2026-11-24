const { test, expect } = require('@playwright/test')
const { component, store } = require('../renderer-harness')

const first = { id: '1', path: 'Content/First.uasset' }
const second = { id: '2', path: 'Content/Second.uasset' }
const ghost = { id: 'ghost-pr-767-Third', path: 'Content/Third.uasset' }

function setup(ipc) {
  let session = 1
  const repo = { repoPath: 'repo' }
  const { useLockStore: locks } = component('src/stores/lockStore.ts', {
    zustand: require('zustand'),
    './repoStore': { useRepoStore: store(repo), repoSessionVersion: () => session },
    '@/ipc': { ipc },
  }).exports
  return { locks, reopen: () => { session++; locks.getState().clearLocks() } }
}

test('synthetic PR locks never reach the LFS unlock API', async () => {
  const calls = []
  const { locks } = setup({
    unlockFile: async (...args) => { calls.push(args) },
    unlockFiles: async (...args) => { calls.push(args) },
  })
  locks.setState({ locks: [ghost] })
  await locks.getState().unlockFile('repo', 'Content\\Third.uasset')
  await expect(locks.getState().unlockFiles('repo', [{ filePath: ghost.path, lockId: ghost.id }]))
    .resolves.toEqual({ unlocked: [], failed: [] })
  expect(calls).toEqual([])
  expect(locks.getState().locks).toEqual([ghost])
})

test('partial bulk unlock restores only failed paths and preserves synthetic locks', async () => {
  let finish
  const calls = []
  const { locks } = setup({ unlockFiles: (...args) => {
    calls.push(args)
    return new Promise(resolve => { finish = resolve })
  } })
  locks.setState({ locks: [first, second, ghost] })
  const targets = [first, second, ghost].map(lock => ({ filePath: lock.path, lockId: lock.id }))
  const pending = locks.getState().unlockFiles('repo', targets)
  expect(locks.getState().locks).toEqual([ghost])
  expect(calls).toEqual([['repo', targets.slice(0, 2)]])
  finish({ unlocked: [first.path], failed: [{ filePath: 'Content\\Second.uasset', error: 'denied' }] })
  await pending
  expect(locks.getState()).toMatchObject({ locks: [ghost, second], error: '1 file failed to unlock' })
})

test('a rejected bulk unlock preserves a lock that arrived while the request was pending', async () => {
  let rejectUnlock
  const { locks } = setup({ unlockFiles: () => new Promise((_, reject) => { rejectUnlock = reject }) })
  locks.setState({ locks: [first] })
  const pending = locks.getState().unlockFiles('repo', [{ filePath: first.path, lockId: first.id }])
  locks.getState().setLocks([second])
  rejectUnlock(Error('offline'))
  await expect(pending).rejects.toThrow('offline')
  expect(locks.getState()).toMatchObject({ locks: [second, first], error: 'Error: offline' })
})

test('late unlock results are ignored after reopening the same repository', async () => {
  let finish
  const { locks, reopen } = setup({ unlockFiles: () => new Promise(resolve => { finish = resolve }) })
  locks.setState({ locks: [first] })
  const pending = locks.getState().unlockFiles('repo', [{ filePath: first.path, lockId: first.id }])
  reopen()
  locks.getState().setLocks([second])
  finish({ unlocked: [first.path], failed: [], locks: [], refreshError: 'Old refresh failed' })
  await pending
  expect(locks.getState()).toMatchObject({ locks: [second], error: null })
})
