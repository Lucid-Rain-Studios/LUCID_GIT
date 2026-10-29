// Unlocking a file whose lock outlived the file, and review cancellations in the log.
const { test, expect } = require('@playwright/test')
const { component } = require('./renderer-harness')

const missingFile = 'git lfs failed (exit 2):\nUnable to unlock 59218582: CreateFile E:\\repo\\Content\\Gone.uasset: The system cannot find the file specified.'

function lockServiceWith(unlockResults) {
  const calls = []
  const { lockService } = component('electron/services/LockService.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    '../util/dugite-exec': {
      exec: async args => {
        calls.push(args.join(' '))
        const next = unlockResults.shift()
        if (next) throw new Error(next)
        return {}
      },
      gitAuthArgs: () => [], withGitTimeout: fn => fn(),
    },
    './AuthService': { authService: { getCurrentToken: async () => null, listAccounts: () => ({ accounts: [] }) } },
    './GitService': { gitService: { getRemoteUrl: async () => null, lfsLocksMaintenance: async () => {} } },
    './HeatmapService': { heatmapService: { recordLockEvent: () => {} } },
    './NotificationService': { notificationService: { push: () => ({}) } },
    './WebhookService': { webhookService: { send: async () => {} } },
  }).exports
  lockService.listLocksUnguarded = async () => [{ id: '59218582', path: 'Content/Gone.uasset' }]
  return { lockService, calls }
}

test('a lock that is gone when the post-repair retry runs counts as already unlocked', async () => {
  const { lockService, calls } = lockServiceWith([missingFile, 'git lfs failed (exit 2):\nUnable to unlock 59218582: Lock not found'])
  await lockService.unlockFile('repo', 'Content/Gone.uasset', false, '59218582')
  expect(calls).toHaveLength(2)
  expect(calls.every(call => call.includes('--id=59218582'))).toBe(true)
})

test('any other failure of the post-repair retry still reaches the caller', async () => {
  const { lockService } = lockServiceWith([missingFile, 'git lfs failed (exit 2):\nUnable to unlock 59218582: lock belongs to someone else'])
  await expect(lockService.unlockFile('repo', 'Content/Gone.uasset', false, '59218582')).rejects.toThrow('lock belongs to someone else')
})

test('only superseded review work counts as a cancellation', () => {
  const { isCancellation } = component('electron/cancellation.ts').exports
  expect(isCancellation(new Error('Blueprint review cancelled.'))).toBe(true)
  expect(isCancellation(new Error('Scene review cancelled.'))).toBe(true)
  // What the renderer sees after the IPC round trip.
  expect(isCancellation(new Error("Error invoking remote method 'asset:blueprint-compare': Error: Blueprint review cancelled."))).toBe(true)
  expect(isCancellation(new Error('Timed out waiting for repository read access. Retry after the current operation finishes.'))).toBe(false)
  expect(isCancellation(new Error('Blueprint review cancelled by the build step failing'))).toBe(false)
  expect(isCancellation(undefined)).toBe(false)
})
