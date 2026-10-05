const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { component, find, store } = require('./renderer-harness')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))

test.afterAll(cleanup)

test('Push fetches unseen remote commits, refuses the push, and succeeds after Pull', async () => {
  const remote = tmpDir('lg-preflight-origin-'), repo = tmpDir('lg-preflight-local-'), teammate = tmpDir('lg-preflight-peer-')
  git(remote, 'init', '-q', '--bare'); git(repo, 'init', '-qb', 'main')
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'main')
  git(teammate, 'clone', '-q', '-b', 'main', remote, '.')
  git(teammate, 'config', 'user.name', 'Peer'); git(teammate, 'config', 'user.email', 'peer@example.com')
  fs.writeFileSync(path.join(repo, 'local.txt'), 'local'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'local')
  fs.writeFileSync(path.join(teammate, 'peer.txt'), 'peer'); git(teammate, 'add', '.'); git(teammate, 'commit', '-qm', 'peer'); git(teammate, 'push', '-q')
  const remoteHead = git(remote, 'rev-parse', 'main').trim(), localHead = git(repo, 'rev-parse', 'HEAD').trim()
  expect(await gitService.getSyncStatus(repo)).toMatchObject({ ahead: 1, behind: 0 })
  const steps = []
  await expect(gitService.push(repo, step => steps.push(step))).rejects.toThrow('PUSH_REQUIRES_PULL:')
  expect(steps.some(step => step.id === 'push-fetch')).toBe(true)
  expect(steps.some(step => step.id === 'push-connect')).toBe(false)
  expect(await gitService.getSyncStatus(repo)).toMatchObject({ ahead: 1, behind: 1 })
  expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(localHead)
  expect(git(remote, 'rev-parse', 'main').trim()).toBe(remoteHead)
  await gitService.pull(repo)
  await gitService.push(repo)
  expect(git(remote, 'rev-parse', 'main').trim()).toBe(git(repo, 'rev-parse', 'HEAD').trim())
  expect(git(remote, 'show', 'main:local.txt')).toBe('local')
  expect(git(remote, 'show', 'main:peer.txt')).toBe('peer')
  expect(await gitService.getSyncStatus(repo)).toMatchObject({ ahead: 0, behind: 0 })
})

test('fetch and sync lookup failures stop Push before any outgoing scan or push command', async () => {
  const calls = []
  const h = component('electron/services/GitService.ts', {
    '../util/dugite-exec': { execSafe: async () => { calls.push('scan'); return { exitCode: 0, stdout: '' } }, execWithProgress: async () => calls.push('push'), gitAuthArgs: () => [] },
    './AuthService': { authService: { getCurrentToken: async () => null } },
  })
  const service = h.exports.gitService
  service.fetch = async () => { calls.push('fetch'); throw Error('fetch offline') }
  service.getSyncStatus = async () => { calls.push('sync'); return { hasPublishedBranch: true, behind: 0 } }
  await expect(service.push('repo')).rejects.toThrow('fetch offline')
  expect(calls).toEqual(['fetch'])
  calls.length = 0
  service.fetch = async () => { calls.push('fetch') }
  service.getSyncStatus = async () => { calls.push('sync'); throw Error('status unavailable') }
  await expect(service.push('repo')).rejects.toThrow('status unavailable')
  expect(calls).toEqual(['fetch', 'sync'])
  calls.length = 0
  service.getSyncStatus = async () => { calls.push('sync'); return { hasPublishedBranch: true, behind: 2 } }
  await expect(service.push('repo')).rejects.toThrow('PUSH_REQUIRES_PULL:')
  expect(calls).toEqual(['fetch', 'sync'])
})

test('sync count errors cannot be mistaken for no incoming updates', async () => {
  for (const result of [{ exitCode: 1, stdout: '', stderr: 'bad ref' }, { exitCode: 0, stdout: 'invalid' }]) {
    const h = component('electron/services/GitService.ts', {
      '../util/dugite-exec': { execSafe: async args => args[0] === 'show-ref' ? { exitCode: 0 } : args[0] === 'rev-parse' ? { exitCode: 0, stdout: 'origin/main' } : result },
    })
    h.exports.gitService.currentBranch = async () => 'main'
    await expect(h.exports.gitService.getSyncStatus('repo')).rejects.toThrow()
  }
})

function topBar(ipc, notices, alerts, fetches) {
  const repo = { repoPath: 'repo', currentBranch: 'feature', branches: [], fileStatus: [], recentRepos: [], syncTick: 0, refreshStatus: async () => {}, bumpSyncTick() {} }
  const h = component('src/components/layout/TopBar.tsx', {
    '@/ipc': { ipc },
    '@/lib/topBarSyncBridge': component('src/lib/topBarSyncBridge.ts').exports,
    '@/lib/syncButtonLogic': component('src/lib/syncButtonLogic.ts').exports,
    '@/lib/fetchState': { markFetchPerformed: repo => fetches.push(repo) },
    '@/stores/repoStore': { useRepoStore: store(repo) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [], permissionErrors: {} }) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/errorStore': { useErrorStore: store({ pushRaw: message => notices.push(message) }) },
    '@/stores/prStore': { usePRStore: store({ openDialog() {} }) },
    '@/stores/statusToastStore': { useStatusToastStore: store({ show: message => notices.push(message) }) },
    '@/stores/dialogStore': { useDialogStore: store({ alert: async opts => alerts.push(opts) }) },
    '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: () => ({}) },
  })
  h.render('TopBar', {})
  h.slots[0] = { hasUpstream: true, hasPublishedBranch: true, ahead: 1, behind: 0 }
  return h
}

test('Push prompts after fetched incoming updates and allows retry without a prior integration flag', async () => {
  const notices = [], alerts = [], fetches = []
  let behind = 1, pushes = 0
  const h = topBar({
    push: async () => { pushes++; if (behind) throw Error('PUSH_REQUIRES_PULL: remote updates') },
    getSyncStatus: async () => ({ hasUpstream: true, hasPublishedBranch: true, ahead: 1, behind }),
  }, notices, alerts, fetches)
  const button = () => find(h.render('TopBar', {}), node => node.type?.name === 'SyncBtn' && node.props.label === 'Push')
  expect(button().props.disabled).toBe(false)
  await button().props.onClick()
  expect(alerts).toHaveLength(1)
  expect(alerts[0].message).toMatch(/Pull.*Update from main.*try Push again/)
  expect(h.slots[0].behind).toBe(1)
  expect(button().props.disabled).toBe(false)
  expect(notices).not.toContain('Push successful.')
  behind = 0
  await button().props.onClick()
  expect(pushes).toBe(2)
  expect(alerts).toHaveLength(1)
  expect(notices).toContain('Push successful.')
  expect(fetches).toEqual(['repo', 'repo'])
})

test('duplicate Push clicks start one operation and fetch failures show no success or integration prompt', async () => {
  const notices = [], alerts = [], fetches = []
  let rejectPush, pushes = 0
  const h = topBar({ push: () => { pushes++; return new Promise((_, reject) => { rejectPush = reject }) } }, notices, alerts, fetches)
  const click = find(h.render('TopBar', {}), node => node.type?.name === 'SyncBtn' && node.props.label === 'Push').props.onClick
  const pending = click()
  await click()
  expect(pushes).toBe(1)
  rejectPush(Error('fetch offline'))
  await pending
  expect(notices).toContain('Push failed.')
  expect(notices).not.toContain('Push successful.')
  expect(alerts).toEqual([])
  expect(fetches).toEqual([])
  expect(h.slots[1]).toBe('idle')
})
