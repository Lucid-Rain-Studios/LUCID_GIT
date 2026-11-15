const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { component, find, store } = require('./renderer-harness')
const { DIST, git, tmpDir, cleanup, lfsRepo, countGitSpawns } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))
test.afterAll(cleanup)
const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const file = (name = 'asset.txt') => ({ path: name, indexStatus: ' ', workingStatus: 'M', staged: false })

function repoStore(api = {}) {
  const calls = []
  const methods = Object.fromEntries(['status', 'currentBranch', 'branchList', 'ueDetect'].map(method => [method, async repo => {
    calls.push([method, repo])
    return method in api ? api[method](repo) : method === 'status' ? [file()] : method === 'currentBranch' ? 'main' : []
  }]))
  const { useRepoStore: state } = component('src/stores/repoStore.ts', {
    zustand: require('zustand'), './operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
  }, { window: { lucidGit: methods } }).exports
  state.setState({ repoPath: 'repo', currentBranch: 'main', branches: [{ name: 'main' }] })
  return { state, calls }
}

test('stash refresh reads only status, preserves identical arrays and advances file revisions', async () => {
  const files = [file()], { state, calls } = repoStore({ status: () => files.map(f => ({ ...f })) })
  state.setState({ fileStatus: files })
  await state.getState().refreshWorkingTree('repo')
  expect(calls).toEqual([['status', 'repo']])
  expect(state.getState().fileStatus).toBe(files)
  expect(state.getState()).toMatchObject({ statusTick: 1, historyTick: 0, syncTick: 0, currentBranch: 'main', branches: [{ name: 'main' }] })
})

test('stash refresh redetects changed project descriptors, including removal from dirty status', async () => {
  const { state, calls } = repoStore({ status: () => [] })
  state.setState({ fileStatus: [file('Game/Game.uproject')] })
  await state.getState().refreshWorkingTree('repo')
  expect(calls.map(c => c[0])).toEqual(['status', 'ueDetect'])
})

test('stash refresh redetects a project descriptor renamed to another extension', async () => {
  const { state, calls } = repoStore({ status: () => [{ ...file('Game/backup.txt'), originalPath: 'Game/Game.uproject', indexStatus: 'R' }] })
  await state.getState().refreshWorkingTree('repo')
  expect(calls.map(c => c[0])).toEqual(['status', 'ueDetect'])
})

test('failed status keeps existing files and exposes the refresh error without changing history', async () => {
  const { state } = repoStore({ status: () => { throw Error('status failed') } }), files = [file()]
  state.setState({ fileStatus: files, isLoading: true })
  await state.getState().refreshWorkingTree('repo')
  expect(state.getState().fileStatus).toBe(files)
  expect(state.getState()).toMatchObject({ error: 'Error: status failed', statusTick: 0, syncTick: 0, historyTick: 0, isLoading: false })
})

test('late stash refresh cannot overwrite a newer scan, another repository or a cleared session', async () => {
  const pending = [], { state, calls } = repoStore({ status: () => { const d = deferred(); pending.push(d); return d.promise } })
  const a = state.getState().refreshWorkingTree('repo'), b = state.getState().refreshWorkingTree('repo')
  pending[1].resolve([file('new')]); await b
  pending[0].resolve([file('old')]); await a
  expect(state.getState().fileStatus[0].path).toBe('new')
  const old = state.getState().refreshWorkingTree('repo')
  state.getState().clearRepo(); state.setState({ repoPath: 'other', fileStatus: [file('other')] })
  pending[2].resolve([file('late')]); await old
  await state.getState().refreshWorkingTree('repo')
  expect(calls).toHaveLength(3)
  expect(state.getState().fileStatus[0].path).toBe('other')
})

test('watcher bursts during stash refresh get one fresh follow-up for later external edits', async () => {
  const scan = deferred(); let reads = 0
  const { state, calls } = repoStore({ status: () => ++reads === 1 ? scan.promise : [file('external-save')] })
  const refresh = state.getState().refreshWorkingTree('repo')
  const watchers = Array.from({ length: 20 }, () => state.getState().silentRefresh())
  expect(reads).toBe(1)
  scan.resolve([file('stash-result')]); await Promise.all([refresh, ...watchers])
  expect(reads).toBe(2)
  expect(calls.filter(c => c[0] === 'currentBranch')).toHaveLength(1)
  expect(state.getState().fileStatus[0].path).toBe('external-save')
})

test('queued watcher follow-up cannot scan a repository opened after the stash operation', async () => {
  const scan = deferred(), { state, calls } = repoStore({ status: () => scan.promise })
  const refresh = state.getState().refreshWorkingTree('repo'), watcher = state.getState().silentRefresh()
  state.getState().clearRepo(); state.setState({ repoPath: 'other' })
  scan.resolve([file()]); await Promise.all([refresh, watcher])
  expect(calls).toEqual([['status', 'repo']])
  expect(state.getState().fileStatus).toEqual([])
})

test('watcher follow-up waits for an older background scan instead of losing an external edit', async () => {
  const old = deferred(), scoped = deferred(); let reads = 0
  const { state } = repoStore({ status: () => ++reads === 1 ? old.promise : reads === 2 ? scoped.promise : [file('external')] })
  const background = state.getState().silentRefresh()
  const stash = state.getState().refreshWorkingTree('repo')
  const watchers = Array.from({ length: 10 }, () => state.getState().silentRefresh())
  scoped.resolve([file('stash')]); await stash; await flush()
  expect(reads).toBe(2)
  old.resolve([file('stale')]); await Promise.all([background, ...watchers])
  expect(reads).toBe(3)
  expect(state.getState().fileStatus[0].path).toBe('external')
})

function panel(kind, api = {}, stateOverrides = {}) {
  const calls = [], alerts = [], conflicts = []
  const entry = { ref: 'stash@{0}', index: 0, message: 'saved work', branch: 'main', date: '' }
  const state = { repoPath: 'repo', fileStatus: [], refreshWorkingTree: async repo => { calls.push('status'); return api.refresh?.(repo) },
    bumpSyncTick: () => { throw Error('unnecessary sync refresh') }, ...stateOverrides }
  const ipc = {
    stashList: async repo => { calls.push('list'); return api.list ? api.list(repo) : [entry] },
    ...Object.fromEntries(['Pop', 'Apply', 'Drop', 'Save'].map(action => ['stash' + action, async (...args) => {
      calls.push(action.toLowerCase()); return api.mutate?.(action, ...args)
    }])),
  }
  const h = component(kind === 'changes' ? 'src/components/changes/StashPanel.tsx' : 'src/components/history/HistoryPanel.tsx', {
    '@/lib/branchTips': component('src/lib/branchTips.ts').exports,
    '@/ipc': { ipc }, '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async () => api.confirm !== false, alert: opts => alerts.push(opts) }) },
    '@/stores/conflictStore': { routeConflictToResolver: e => { if (/CONFLICT/.test(String(e))) { conflicts.push(e); return true }; return false } },
  }, { __privateExports: kind === 'history' ? ['StashPanel'] : [] })
  const props = { repoPath: 'repo' }
  const render = () => h.render('StashPanel', props)
  const click = (action, tree = render()) => {
    const node = find(tree, n => kind === 'changes' ? n.props?.label === action : n.props?.title === ({ Pop: 'Apply + drop', Apply: 'Apply (keep stash)', Drop: 'Delete stash' })[action])
    expect(node).toBeTruthy()
    return node.props.onClick()
  }
  return { h, render, click, props, state, calls, alerts, conflicts }
}

for (const kind of ['changes', 'history']) {
  for (const action of ['Pop', 'Apply']) for (const outcome of ['success', 'conflict', 'failure']) {
    test(`${kind} ${action} ${outcome}: refresh list and files concurrently without sync/history reads`, async () => {
      const list = deferred(), status = deferred(); let initial = true
      const entry = { ref: 'stash@{0}', index: 0, message: 'saved work', date: '' }
      const p = panel(kind, { list: () => initial ? [entry] : list.promise, refresh: () => status.promise,
        mutate: () => { if (outcome !== 'success') throw Error(outcome === 'conflict' ? 'CONFLICT (content)' : 'checkout failed after partial write') } })
      p.render(); await p.h.effects[0](); await flush()
      initial = false
      p.calls.length = 0
      const operation = p.click(action)
      await flush()
      expect(p.calls).toEqual([action.toLowerCase(), 'list', 'status'])
      list.resolve([entry]); status.resolve(); await operation
      expect(p.conflicts).toHaveLength(outcome === 'conflict' ? 1 : 0)
      if (kind === 'history') expect(p.alerts).toHaveLength(outcome === 'failure' ? 1 : 0)
      else if (outcome === 'failure') expect(JSON.stringify(p.render())).toContain('checkout failed')
    })
  }

  test(`${kind} Drop reloads only stashes and cancelled Drop does no work`, async () => {
    const p = panel(kind)
    p.render(); await p.h.effects[0](); await flush(); p.calls.length = 0
    await p.click('Drop'); await flush()
    expect(p.calls).toEqual(['drop', 'list'])
    const cancelled = panel(kind, { confirm: false })
    cancelled.render(); await cancelled.h.effects[0](); await flush(); cancelled.calls.length = 0
    await cancelled.click('Drop')
    expect(cancelled.calls).toEqual([])
  })

  test(`${kind} late list responses cannot replace a newer repository's stashes`, async () => {
    const old = deferred(), fresh = [{ ref: 'stash@{0}', index: 0, message: 'new repository stash', date: '' }]
    const p = panel(kind, { list: repo => repo === 'repo' ? old.promise : fresh })
    p.render(); p.h.effects[0]()
    p.props.repoPath = 'other'; p.render(); await p.h.effects[0](); await flush()
    old.resolve([{ ...fresh[0], message: 'old repository stash' }]); await flush()
    const tree = JSON.stringify(p.render())
    expect(tree).toContain('new repository stash'); expect(tree).not.toContain('old repository stash')
  })

  test(`${kind} failed Drop refreshes only the stash list`, async () => {
    const p = panel(kind, { mutate: () => { throw Error('drop failed') } })
    p.render(); await p.h.effects[0](); await flush(); p.calls.length = 0
    await p.click('Drop'); await flush()
    expect(p.calls).toEqual(['drop', 'list'])
  })

  test(`${kind} failed list refresh hides outdated stash actions and does not repeat Apply`, async () => {
    let fail = false
    const p = panel(kind, { list: () => {
      if (fail) throw Error('list unavailable')
      return [{ ref: 'stash@{0}', index: 0, message: 'retained stash', date: '' }]
    } })
    p.render(); await p.h.effects[0](); await flush(); p.calls.length = 0; fail = true
    await p.click('Apply')
    expect(p.calls).toEqual(['apply', 'list', 'status'])
    expect(JSON.stringify(p.render())).not.toContain('retained stash')
    if (kind === 'history') expect(p.alerts[0].title).toBe('Stash refresh failed')
    else {
      expect(JSON.stringify(p.render())).toContain('list unavailable')
      fail = false
      await find(p.render(), n => n.props?.title === 'Retry stash list').props.onClick()
      expect(JSON.stringify(p.render())).toContain('retained stash')
    }
  })
}

for (const outcome of ['success', 'failure']) test(`Stash All ${outcome} refreshes list and files together`, async () => {
  const list = deferred(), status = deferred()
  const p = panel('changes', { list: () => list.promise, refresh: () => status.promise,
    mutate: () => { if (outcome === 'failure') throw Error('saved but cleanup failed') } })
  const button = find(p.render(), n => n.props?.onClick?.name === 'handleSave')
  const operation = button.props.onClick(); await flush()
  expect(p.calls).toEqual(['save', 'list', 'status'])
  list.resolve([]); status.resolve(); await operation
  if (outcome === 'failure') expect(JSON.stringify(p.render())).toContain('saved but cleanup failed')
})

for (const action of ['Pop', 'Apply']) test(`History cancelled ${action} leaves files and stash list alone`, async () => {
  const p = panel('history', { confirm: false })
  p.render(); await p.h.effects[0](); await flush(); p.calls.length = 0
  await p.click(action)
  expect(p.calls).toEqual([])
})

test('selected-file stash uses a scoped status check and preserves unrelated staged/unstaged content', async () => {
  const repo = tmpDir('lg-stash-selected-performance-')
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  for (const name of ['chosen [1].txt', 'other.txt']) fs.writeFileSync(path.join(repo, name), 'base')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  fs.writeFileSync(path.join(repo, 'chosen [1].txt'), 'staged'); git(repo, 'add', 'chosen [1].txt')
  fs.writeFileSync(path.join(repo, 'chosen [1].txt'), 'working')
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other staged'); git(repo, 'add', 'other.txt')
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other working')
  fs.writeFileSync(path.join(repo, 'new ü.txt'), 'untracked')
  const scoped = gitService.statusPaths.bind(gitService), full = gitService.status, queries = []
  gitService.status = () => { throw Error('full scan must not run for selected stash') }
  gitService.statusPaths = (repo, paths) => { queries.push(paths); return scoped(repo, paths) }
  try { await gitService.stashSave(repo, 'selected', ['chosen [1].txt', 'new ü.txt']) }
  finally { gitService.status = full; gitService.statusPaths = scoped }
  expect(queries).toEqual([['chosen [1].txt', 'new ü.txt']])
  expect(git(repo, 'show', 'stash@{0}:chosen [1].txt')).toBe('working')
  expect(git(repo, 'show', 'stash@{0}^2:chosen [1].txt')).toBe('staged')
  expect(git(repo, 'show', 'stash@{0}^3:new ü.txt')).toBe('untracked')
  expect(fs.readFileSync(path.join(repo, 'chosen [1].txt'), 'utf8')).toBe('base')
  expect(fs.readFileSync(path.join(repo, 'other.txt'), 'utf8')).toBe('other working')
  expect(git(repo, 'show', ':other.txt')).toBe('other staged')
})

for (const action of ['Apply', 'Pop', 'Drop']) test(`real LFS stash ${action} uses one Git command and preserves HEAD and expected bytes`, async () => {
  const repo = lfsRepo(['Asset']), working = Buffer.alloc(200_000, 42), untracked = Buffer.from('new work')
  const head = git(repo, 'rev-parse', 'HEAD'), base = fs.readFileSync(path.join(repo, 'Asset.uasset'))
  fs.writeFileSync(path.join(repo, 'Asset.uasset'), working)
  fs.writeFileSync(path.join(repo, 'new.txt'), untracked)
  await gitService.stashSave(repo, 'work')
  const stash = git(repo, 'rev-parse', 'refs/stash')
  const result = await countGitSpawns(() => gitService['stash' + action](repo, 'stash@{0}'))
  expect(result.spawns).toBe(1)
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(fs.readFileSync(path.join(repo, 'Asset.uasset'))).toEqual(action === 'Drop' ? base : working)
  expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(action !== 'Drop')
  if (action !== 'Drop') expect(fs.readFileSync(path.join(repo, 'new.txt'))).toEqual(untracked)
  if (action === 'Apply') expect(git(repo, 'rev-parse', 'refs/stash')).toBe(stash)
  else expect(git(repo, 'stash', 'list')).toBe('')
})
