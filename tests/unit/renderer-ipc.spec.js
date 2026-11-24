const { test, expect } = require('@playwright/test')
const { component, store } = require('../renderer-harness')

function setup(overrides = {}) {
  const state = { merge: { task: null }, background: { repoPath: null }, pr: { busy: false } }
  const calls = []
  const preload = {
    checkout: async (...args) => { calls.push(['checkout', ...args]) },
    log: async (...args) => { calls.push(['log', ...args]); return ['commit'] },
    githubMergePR: async (...args) => { calls.push(['githubMergePR', ...args]) },
    logRendererEvent: async (...args) => { calls.push(['error', ...args]) },
    ...overrides,
  }
  const diagnostics = component('src/stores/repositoryIssueStore.ts', {
    zustand: require('zustand'),
    '@/lib/gitErrors': component('src/lib/gitErrors.ts').exports,
  }).exports
  const api = component('src/ipc.ts', {
    '@/stores/mergeWindowStore': { useMergeWindowStore: store(state.merge) },
    '@/stores/backgroundRepoTaskStore': { useBackgroundRepoTaskStore: store(state.background) },
    '@/stores/prReviewStore': { usePRReviewStore: store(state.pr) },
    '../electron/cancellation': component('electron/cancellation.ts').exports,
    './lib/blueprintClient': { createBlueprintClient: compare => compare },
    './stores/repositoryIssueStore': diagnostics,
  }, { window: { lucidGit: preload }, Error }).exports
  return { ...api, state, calls, issues: () => diagnostics.useRepositoryIssueStore.getState().repositories }
}

for (const [phase, reason] of [
  ['running', 'A local merge is running'],
  ['attention', 'Review the local merge issue'],
]) {
  test(`local merge phase ${phase} blocks writes from each renderer API while reads remain available`, async () => {
    const { ipc, prTaskIpc, backgroundTaskIpc, state, calls } = setup()
    state.merge.task = { phase }
    for (const api of [ipc, prTaskIpc, backgroundTaskIpc]) {
      await expect(api.checkout('repo', 'feature')).rejects.toThrow(reason)
    }
    await expect(ipc.log('repo')).resolves.toEqual(['commit'])
    expect(calls).toEqual([['log', 'repo']])

    state.merge.task = { phase: 'complete' }
    await ipc.checkout('repo', 'feature')
    expect(calls.at(-1)).toEqual(['checkout', 'repo', 'feature'])
  })
}

test('background writes are repository scoped and only the task owner can write there', async () => {
  const { ipc, prTaskIpc, backgroundTaskIpc, state, calls } = setup()
  state.background.repoPath = 'repo'
  await expect(ipc.checkout('repo', 'feature')).rejects.toThrow('repository operation is running')
  await expect(prTaskIpc.checkout('repo', 'feature')).rejects.toThrow('repository operation is running')
  await expect(ipc.githubMergePR({ repoPath: 'repo', prNumber: 767 })).rejects.toThrow('repository operation is running')
  await ipc.checkout('other', 'feature')
  await backgroundTaskIpc.checkout('repo', 'feature')
  expect(calls).toEqual([['checkout', 'other', 'feature'], ['checkout', 'repo', 'feature']])
})

test('an active PR task blocks competing mutations while its own pinned merge can proceed', async () => {
  const { ipc, prTaskIpc, backgroundTaskIpc, state, calls } = setup()
  const request = { repoPath: 'repo', owner: 'studio', repo: 'project', prNumber: 767, expectedSha: 'a'.repeat(40) }
  state.pr.busy = true
  await expect(ipc.githubMergePR(request)).rejects.toThrow('pull request operation is running')
  await expect(backgroundTaskIpc.checkout('repo', 'feature')).rejects.toThrow('pull request operation is running')
  await prTaskIpc.githubMergePR(request)
  expect(calls).toEqual([['githubMergePR', request]])
})

test('a late diagnostic cannot replace a newer repair result or suppress another repo warning', async () => {
  let finishOldDiagnosis
  const { ipc, issues } = setup({
    diagnoseIndex: repoPath => repoPath === 'repo'
      ? new Promise(resolve => { finishOldDiagnosis = resolve })
      : Promise.resolve({ repoPath, issue: 'missing', summary: 'Index missing' }),
    repairIndex: async repoPath => ({ diagnosis: { repoPath, issue: 'healthy' } }),
  })
  const old = ipc.diagnoseIndex('repo')
  await ipc.repairIndex('repo')
  await ipc.diagnoseIndex('other')
  finishOldDiagnosis({ repoPath: 'repo', issue: 'corrupt', summary: 'Old result' })
  await old
  expect(issues()).toMatchObject({ repo: { index: null }, other: { index: { title: 'Index missing' } } })
})

test('index and lock-cache warnings clear independently after verified checks', async () => {
  const { ipc, issues } = setup({
    diagnoseIndex: async repoPath => ({ repoPath, issue: 'checksum', summary: 'Checksum verification failed' }),
    lfsLocksCheck: async () => ({ hasErrors: true, lockCacheFiles: [{ path: 'lockcache.db', integrity: 'corrupt' }] }),
    lfsLocksRepair: async () => ({ hasErrors: false, lockCacheFiles: [] }),
  })
  await ipc.diagnoseIndex('repo')
  await ipc.lfsLocksCheck('repo')
  expect(issues().repo).toMatchObject({ index: { code: 'INDEX_UNREADABLE' }, 'lock-cache': { code: 'LFS_LOCK_CACHE' } })
  await ipc.lfsLocksRepair('repo')
  expect(issues().repo).toMatchObject({ index: { code: 'INDEX_UNREADABLE' }, 'lock-cache': null })
})

test('IPC logs real failures once and propagates cancelled reviews without logging errors', async () => {
  const cancelled = Error('Blueprint review cancelled.')
  const failed = Error('Permission denied')
  const { ipc, calls } = setup({ log: async repo => { throw repo === 'closed' ? cancelled : failed } })
  await expect(ipc.log('closed')).rejects.toBe(cancelled)
  await expect(ipc.log('repo')).rejects.toBe(failed)
  expect(calls).toEqual([['error', 'renderer.ipc.log', 'IPC call failed: Permission denied', { args: ['repo'], error: failed }]])
})
