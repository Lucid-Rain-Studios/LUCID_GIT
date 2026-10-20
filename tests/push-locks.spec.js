const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const { component, find, store } = require('./renderer-harness')
test.afterAll(cleanup)

function repoFixture() {
  const remote = tmpDir('lg-lock-origin-'), repo = tmpDir('lg-lock-push-')
  git(remote, 'init', '-q', '--bare', '--initial-branch=main')
  git(repo, 'init', '-qb', 'main')
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'asset.uasset'), 'base')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'main')
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  git(repo, 'checkout', '-qb', 'topic')
  fs.writeFileSync(path.join(repo, 'asset.uasset'), 'recovery')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'recover')
  return { repo, remote }
}

test('first-publication checks find outgoing locked paths and do not swallow Git failures', async () => {
  const { repo } = repoFixture()
  expect(await gitService.aheadFilePaths(repo)).toEqual(['asset.uasset'])
  expect(await gitService.pushLockCheck(repo)).toMatchObject({ branch: 'topic', targetBranch: 'topic', files: ['asset.uasset'], overrideReason: null })
  git(repo, 'branch', '--set-upstream-to=origin/main')
  expect(await gitService.aheadFilePaths(repo)).toEqual(['asset.uasset'])
  // A touched file remains relevant even if a later outgoing commit restores it.
  fs.writeFileSync(path.join(repo, 'asset.uasset'), 'base'); git(repo, 'commit', '-qam', 'restore')
  expect(await gitService.aheadFilePaths(repo)).toEqual(['asset.uasset'])
  await expect(gitService.aheadFilePaths(path.join(repo, 'missing'))).rejects.toThrow()
})

test('override publishes once with URL-specific verification disabled and keeps config, hooks and default branch intact', async () => {
  const { repo, remote } = repoFixture()
  const urlKey = 'lfs.https://example.com/assets.git/info/lfs.locksverify'
  git(repo, 'config', 'lfs.url', 'https://example.com/assets.git/info/lfs')
  git(repo, 'config', 'lfs.locksverify', 'true'); git(repo, 'config', urlKey, 'true')
  const hook = '#!/bin/sh\n' +
    `if [ "$(git config --get '${urlKey}')" != "false" ]; then\n` +
    ' echo "Unable to push locked files: asset.uasset - Peer"\n echo "Cannot update locked files." >&2\n exit 1\nfi\n' +
    'test "$(git config --get lfs.locksverify)" = "false" || exit 2\n'
  fs.writeFileSync(path.join(repo, '.git/hooks/pre-push'), hook)
  const defaultHead = git(remote, 'rev-parse', 'main')
  await expect(gitService.push(repo)).rejects.toThrow('asset.uasset - Peer')
  const check = await gitService.pushLockCheck(repo)
  await gitService.push(repo, undefined, false, check)
  expect(git(remote, 'rev-parse', 'topic')).toBe(git(repo, 'rev-parse', 'HEAD'))
  expect(git(remote, 'rev-parse', 'main')).toBe(defaultHead)
  expect(git(repo, 'config', '--get', urlKey).trim()).toBe('true')
  expect(git(repo, 'config', '--get', 'lfs.locksverify').trim()).toBe('true')
  expect(fs.readFileSync(path.join(repo, '.git/hooks/pre-push'), 'utf8')).toBe(hook)
  fs.writeFileSync(path.join(repo, 'asset.uasset'), 'next'); git(repo, 'commit', '-qam', 'next')
  await expect(gitService.push(repo)).rejects.toThrow('Cannot update locked files')
})

test('backend refuses default destinations, stale consent, force combinations and uncertain default branches', async () => {
  const { repo, remote } = repoFixture()
  const check = await gitService.pushLockCheck(repo)
  fs.writeFileSync(path.join(repo, 'asset.uasset'), 'next'); git(repo, 'commit', '-qam', 'next')
  await expect(gitService.push(repo, undefined, false, check)).rejects.toThrow('changed')
  await expect(gitService.push(repo, undefined, true, check)).rejects.toThrow('force push')
  git(repo, 'checkout', '-q', 'main')
  const mainCheck = await gitService.pushLockCheck(repo)
  expect(mainCheck.overrideReason).toContain('default branch')
  await expect(gitService.push(repo, undefined, false, mainCheck)).rejects.toThrow('default branch')
  git(repo, 'checkout', '-q', 'topic'); git(repo, 'push', '-q', 'origin', 'topic')
  git(repo, 'branch', '--set-upstream-to=origin/main')
  expect((await gitService.pushLockCheck(repo)).overrideReason).toContain('default branch')
  git(repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/missing')
  expect((await gitService.pushLockCheck(repo)).overrideReason).toContain('determine the default')
})

function dialogFixture(options = {}) {
  const check = { branch: 'topic', head: 'abc', remoteUrl: 'url', targetBranch: 'topic', files: ['asset.uasset'], overrideReason: null, ...options.check }
  const calls = []
  const lock = { id: '1', path: 'asset.uasset', owner: { login: 'peer', name: 'Peer' }, lockedAt: new Date().toISOString() }
  const repo = { repoPath: 'repo', refreshStatus: async () => {} }
  const h = component('src/components/locks/PushBlockedByLocksDialog.tsx', {
    '@/ipc': { ipc: { pushLockCheck: async () => { if (options.fail) throw Error('offline'); return check }, listLocks: async () => options.locks || [lock], push: async (...args) => { calls.push(args); if (options.push) await options.push() } } },
    '@/stores/repoStore': { useRepoStore: store(repo) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [{ userId: 'me', login: 'me' }], currentAccountId: 'me' }) },
    '@/stores/operationStore': { useOperationStore: store({ run: async (_, fn) => fn() }) },
    '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: () => ({}) },
  })
  const props = { errorMessage: 'Cannot update locked files.', onClose: () => calls.push('close'), onPushed: () => calls.push('pushed') }
  const render = () => h.render('PushBlockedByLocksDialog', props)
  const label = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(label).join('') : node ? label(node.props?.children) : ''
  const button = (tree, text) => find(tree, n => typeof n.props?.onClick === 'function' && label(n) === text)
  return { h, calls, render, label, button, repo }
}

async function settle(h) { await h.effects[0](); await new Promise(resolve => setTimeout(resolve, 0)) }

test('dialog reports failures, default protection, own locks and ghost overlays truthfully', async () => {
  const failed = dialogFixture({ fail: true }); failed.render(); await settle(failed.h)
  const errorTree = failed.render()
  expect(failed.label(errorTree)).toContain('Couldn’t determine blocking locks')
  expect(failed.button(errorTree, 'Retry push').props.disabled).toBe(true)
  expect(failed.button(errorTree, 'Push anyway…')).toBeNull()
  const protectedDialog = dialogFixture({ check: { overrideReason: 'Default branch protected' } })
  protectedDialog.render(); await settle(protectedDialog.h)
  expect(protectedDialog.label(protectedDialog.render())).toContain('Default branch protected')
  expect(protectedDialog.button(protectedDialog.render(), 'Push anyway…')).toBeNull()
  const own = { id: 'own', path: 'asset.uasset', owner: { login: 'ME', name: 'Me' } }
  const ghost = { id: 'ghost-pr-1-asset.uasset', path: 'asset.uasset', owner: { login: 'ghost' } }
  const clean = dialogFixture({ locks: [own, ghost] }); clean.render(); await settle(clean.h)
  expect(clean.label(clean.render())).toContain('No overlapping locks found')
  expect(clean.label(clean.render())).toContain('Your locks on 1 outgoing file')
})

test('override requires explicit confirmation, keeps normal retry separate and suppresses duplicate submissions', async () => {
  let finish
  const d = dialogFixture({ push: () => new Promise(resolve => { finish = resolve }) })
  d.render(); await settle(d.h)
  let tree = d.render()
  expect(d.label(tree)).toContain('Locked by Peer')
  d.button(tree, 'Push anyway…').props.onClick()
  expect(d.calls).toEqual([])
  tree = d.render()
  const confirm = d.button(tree, 'Publish branch with locks retained')
  const pending = confirm.props.onClick(); await confirm.props.onClick()
  expect(d.calls).toEqual([['repo', false, { branch: 'topic', head: 'abc', remoteUrl: 'url', targetBranch: 'topic' }]])
  expect(d.button(d.render(), 'Cancel').props.disabled).toBe(true)
  finish(); await pending
  expect(d.calls).toContain('pushed')
  const retry = dialogFixture(); retry.render(); await settle(retry.h)
  await retry.button(retry.render(), 'Retry push').props.onClick()
  expect(retry.calls[0]).toEqual(['repo'])
})

 test('override IPC retains every lock even if pushed paths are returned', async () => {
  const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
  const handlers = new Map(), calls = []
  const override = { branch: 'topic', head: 'abc', remoteUrl: 'url', targetBranch: 'topic' }
  component('electron/ipc/handlers.ts', {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } }, './channels': { CHANNELS },
    '../util/repo-gate': { withRepoSlot: (_, __, fn) => fn() },
    '../services/GitService': { gitService: { push: async (...args) => { calls.push(args); return { branch: 'topic', filesAhead: ['asset.uasset'] } } } },
    '../services/LockService': { lockService: { listLocks: () => { throw Error('must retain locks') }, unlockFiles: () => { throw Error('must not unlock') } } },
  }).exports.registerHandlers()
  await handlers.get(CHANNELS.GIT_PUSH)({ sender: { isDestroyed: () => false, send() {} } }, 'repo', false, override)
  expect(calls[0][3]).toEqual(override)
})

test('first publication after a merge excludes files merely inherited from fetched main', async () => {
  const { repo } = repoFixture()
  git(repo, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(repo, 'teammate.uasset'), 'incoming')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'incoming'); git(repo, 'push', '-q')
  git(repo, 'checkout', '-q', 'topic'); git(repo, 'merge', '--no-edit', 'origin/main')
  expect(await gitService.aheadFilePaths(repo)).toEqual(['asset.uasset'])
})
