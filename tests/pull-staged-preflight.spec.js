const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { DIST, git, lfsRepo, cleanup } = require('./helpers')
const { component, find, store } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))
test.afterAll(cleanup)

function fixture(diverged, staged = true) {
  const repo = lfsRepo(['Asset'])
  const branch = git(repo, 'branch', '--show-current').trim()
  git(repo, 'checkout', '-qb', 'incoming')
  fs.writeFileSync(path.join(repo, 'remote.txt'), 'remote')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'remote work')
  git(repo, 'checkout', '-q', branch)
  if (diverged) {
    fs.writeFileSync(path.join(repo, 'local.txt'), 'local')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'local work')
  }
  const bytes = Buffer.alloc(200_000, 42)
  fs.writeFileSync(path.join(repo, 'Asset.uasset'), bytes)
  if (staged) git(repo, 'add', 'Asset.uasset')
  return { repo, bytes }
}

test('divergent merge preflight catches unrelated staged LFS edits; stash/merge/restore preserves them', async () => {
  const { repo, bytes } = fixture(true)
  const head = git(repo, 'rev-parse', 'HEAD'), index = git(repo, 'write-tree')
  expect(await gitService.mergeOverlapFiles(repo, 'incoming')).toEqual(['Asset.uasset'])
  expect(() => git(repo, 'merge', '--no-edit', 'incoming')).toThrow(/would be overwritten/)
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(repo, 'write-tree')).toBe(index)
  expect(fs.readFileSync(path.join(repo, 'Asset.uasset')).equals(bytes)).toBe(true)
  git(repo, 'stash', 'push', '-qm', 'test safety')
  git(repo, 'merge', '--no-edit', 'incoming')
  git(repo, 'stash', 'apply', '--index')
  expect(fs.readFileSync(path.join(repo, 'Asset.uasset')).equals(bytes)).toBe(true)
  expect((await gitService.status(repo)).find(f => f.path === 'Asset.uasset')).toMatchObject({ staged: true })
})

for (const [diverged, staged] of [[false, true], [true, false]]) test(`unrelated LFS changes remain allowed: diverged=${diverged}, staged=${staged}`, async () => {
  const { repo, bytes } = fixture(diverged, staged)
  expect(await gitService.mergeOverlapFiles(repo, 'incoming')).toEqual([])
  git(repo, 'merge', '--no-edit', 'incoming')
  expect(fs.readFileSync(path.join(repo, 'Asset.uasset')).equals(bytes)).toBe(true)
  expect((await gitService.status(repo)).find(f => f.path === 'Asset.uasset').staged).toBe(staged)
})

test('preflight lookup failures are errors rather than permission to merge', async () => {
  const { repo } = fixture(true)
  await expect(gitService.mergeOverlapFiles(repo, 'missing-ref')).rejects.toThrow()
  const original = gitService.status
  gitService.status = async () => { throw Error('status unavailable') }
  try { await expect(gitService.mergeOverlapFiles(repo, 'incoming')).rejects.toThrow('status unavailable') }
  finally { gitService.status = original }
})

for (const response of ['cancel', 'stash', 'error']) test(`Pull preflight ${response} preserves the confirmation boundary`, async () => {
  const calls = [], prompts = [], errors = []
  const repo = { repoPath: 'repo', currentBranch: 'main', branches: [], fileStatus: [{ path: 'Asset.uasset', staged: true }], recentRepos: [], syncTick: 0,
    refreshStatus: async () => {}, bumpSyncTick() {} }
  const h = component('src/components/layout/TopBar.tsx', {
    '@/ipc': { ipc: { mergeInProgress: async () => null, fetch: async () => calls.push('fetch'),
      mergeOverlapFiles: async () => { if (response === 'error') throw Error('preflight failed'); return ['Asset.uasset'] },
      stashSave: async () => calls.push('stash'), pull: async () => calls.push('pull'), getSyncStatus: async () => ({}) } },
    '@/lib/fetchState': { markFetchPerformed() {} },
    '@/lib/topBarSyncBridge': { hasBranchIntegrated: () => false, markBranchIntegrated() {} },
    '@/lib/syncButtonLogic': component('src/lib/syncButtonLogic.ts').exports,
    '@/stores/repoStore': { useRepoStore: store(repo) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [], permissionErrors: {} }) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/errorStore': { useErrorStore: store({ pushRaw: e => errors.push(e) }) },
    '@/stores/prStore': { usePRStore: store({ openDialog() {} }) },
    '@/stores/statusToastStore': { useStatusToastStore: store({ show() {} }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async p => { prompts.push(p); return response === 'stash' } }) },
  })
  const tree = h.render('TopBar', {})
  await find(tree, n => typeof n.props?.onPull === 'function').props.onPull()
  expect(calls).toEqual(response === 'stash' ? ['fetch', 'stash', 'pull'] : ['fetch'])
  expect(prompts).toHaveLength(response === 'error' ? 0 : 1)
  if (prompts.length) expect(prompts[0].message).toContain('Staged changes')
  expect(errors.length).toBe(response === 'error' ? 1 : 0)
})
