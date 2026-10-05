const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { component, find, store } = require('./renderer-harness')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const logic = component('src/lib/syncButtonLogic.ts').exports
test.afterAll(cleanup)

test('a branch created from origin/main publishes under its own name and changes its upstream', async () => {
  const remote = tmpDir('lg-publish-origin-'), repo = tmpDir('lg-publish-clone-')
  git(remote, 'init', '-q', '--bare'); git(repo, 'init', '-qb', 'main')
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'main')
  const main = git(remote, 'rev-parse', 'main').trim()
  await gitService.createBranch(repo, 'new-feature', 'origin/main')
  let sync = await gitService.getSyncStatus(repo)
  expect(sync).toMatchObject({ hasUpstream: true, hasPublishedBranch: false, remoteBranch: 'origin/main' })
  expect(logic.canPush(false, 10, 0, 'idle', sync.hasPublishedBranch)).toBe(true)
  fs.writeFileSync(path.join(repo, 'file.txt'), 'feature'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'feature')
  const feature = git(repo, 'rev-parse', 'HEAD').trim()
  await gitService.push(repo)
  expect(git(remote, 'rev-parse', 'new-feature').trim()).toBe(feature)
  expect(git(remote, 'rev-parse', 'main').trim()).toBe(main)
  sync = await gitService.getSyncStatus(repo)
  expect(sync).toMatchObject({ hasUpstream: true, hasPublishedBranch: true, remoteBranch: 'origin/new-feature', ahead: 0, behind: 0 })
  expect(logic.pushButtonLabel('idle', sync.hasPublishedBranch)).toBe('Push')
  expect(logic.canPush(true, sync.behind, sync.ahead, 'idle', sync.hasPublishedBranch)).toBe(false)
  expect(logic.canPush(false, 0, 1, 'idle', true)).toBe(true)
  expect(logic.canPush(true, 1, 1, 'idle', true)).toBe(true)
  expect(logic.pushDisabledReason(true, 1, 1, 'idle', true)).toBeNull()
  expect(logic.canPush(true, 0, 1, 'idle', true)).toBe(true)
})

test('navbar and dashboard enable Push for outgoing commits regardless of prior fetch, integration or behind counts', () => {
  const repo = { repoPath: 'repo', currentBranch: 'feature', branches: [], fileStatus: [], recentRepos: [], syncTick: 0 }
  const top = component('src/components/layout/TopBar.tsx', {
    '@/lib/topBarSyncBridge': component('src/lib/topBarSyncBridge.ts').exports,
    '@/lib/syncButtonLogic': logic,
    '@/stores/repoStore': { useRepoStore: store(repo) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [], permissionErrors: {} }) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/errorStore': { useErrorStore: store({ pushRaw() {} }) },
    '@/stores/prStore': { usePRStore: store({ openDialog() {} }) },
    '@/stores/statusToastStore': { useStatusToastStore: store({ show() {} }) },
    '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: () => ({}) },
  })
  top.render('TopBar', {})
  const dashboard = component('src/components/dashboard/DashboardPanel.tsx', { '@/lib/syncButtonLogic': logic }, { __privateExports: ['DailyFlowStrip'] })
  const props = { staged: 0, unstaged: 0, busy: 'idle', hasFetched: false, currentBranch: 'feature', defaultBranch: 'main', updatingFromMain: false, conflictReport: null }
  const states = [
    { hasUpstream: true, hasPublishedBranch: false, ahead: 0, behind: 5 },
    { hasUpstream: true, hasPublishedBranch: true, ahead: 1, behind: 5 },
    { hasUpstream: true, hasPublishedBranch: true, ahead: 1, behind: 0 },
    { hasUpstream: true, hasPublishedBranch: true, ahead: 0, behind: 0 },
  ]
  for (const sync of states) {
    top.slots[0] = sync
    const navbar = find(top.render('TopBar', {}), n => n.type?.name === 'SyncBtn' && /Push/.test(n.props.label))
    const flow = find(dashboard.render('DailyFlowStrip', { ...props, sync }), n => n.type?.name === 'FlowStep' && n.props.step.n === 1)
    const push = flow.props.step.btns[2]
    expect(navbar.props.label).toBe(sync.hasPublishedBranch ? 'Push' : 'Push Branch')
    expect(push.label).toBe(navbar.props.label)
    expect(navbar.props.disabled).toBe(sync.hasPublishedBranch && sync.ahead === 0)
    expect(push.disabled).toBe(navbar.props.disabled)
  }
  for (const busy of ['fetch', 'pull', 'push']) {
    expect(logic.canPush(false, 0, 0, busy, false)).toBe(false)
  }
})

test('published Push needs outgoing commits rather than previous integration; busy states still block it', () => {
  const bridge = component('src/lib/topBarSyncBridge.ts').exports
  expect(logic.canPush(true, 0, 1, 'idle', true, false)).toBe(true)
  expect(logic.pushDisabledReason(true, 0, 1, 'idle', true, false)).toBeNull()
  expect(logic.canPush(false, 5, 1, 'idle', true, false)).toBe(true)
  expect(logic.canPush(true, 0, 0, 'idle', true, true)).toBe(false)
  expect(logic.pushDisabledReason(true, 0, 0, 'idle', true, true)).toBe('Nothing to push')
  for (const busy of ['fetch', 'pull', 'push']) expect(logic.canPush(false, 5, 1, busy, true, false)).toBe(false)
  expect(logic.canPull(true, 0, 'idle', true)).toBe(true)
  bridge.markBranchIntegrated('repo', 'feature')
  expect(bridge.hasBranchIntegrated('repo', 'feature')).toBe(true)
  expect(bridge.hasBranchIntegrated('other-repo', 'feature')).toBe(false)
  expect(bridge.hasBranchIntegrated('repo', 'other')).toBe(false)
  expect(logic.canPush(true, 0, 1, 'idle', true, bridge.hasBranchIntegrated('repo', 'feature'))).toBe(true)
  bridge.markBranchIntegrated('repo', 'feature', false)
  expect(bridge.hasBranchIntegrated('repo', 'feature')).toBe(false)
  expect(logic.canPush(false, 10, 0, 'idle', false, false)).toBe(true)
})
