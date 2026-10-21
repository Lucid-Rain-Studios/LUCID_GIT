const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { component, find, store } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const { indexRecoveryService } = require(path.join(DIST, 'services/IndexRecoveryService'))
const runner = require(path.join(DIST, 'util/dugite-exec'))
const { isMergeWriteFailure } = require(path.join(DIST, 'util/merge-safety'))
const journal = repo => path.join(git(repo, 'rev-parse', '--absolute-git-dir').trim(), 'lucid-merge-safety.json')
const mergeHead = repo => path.join(git(repo, 'rev-parse', '--absolute-git-dir').trim(), 'MERGE_HEAD')
test.afterAll(cleanup)

function repo(extraIncoming = {}) {
  const dir = tmpDir('lg-merge-retry-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'base\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
  git(dir, 'branch', 'feature')
  fs.writeFileSync(path.join(dir, 'incoming.txt'), 'incoming\n')
  for (const [name, content] of Object.entries(extraIncoming)) fs.writeFileSync(path.join(dir, name), content)
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'main work')
  git(dir, 'checkout', '-q', 'feature')
  fs.writeFileSync(path.join(dir, 'branch.txt'), 'branch\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'branch work')
  return dir
}

function service(dir) {
  const s = new gitService.constructor()
  s.getRemoteUrl = async () => 'https://example.invalid/repo.git'
  s.remoteDefaultBranch = async () => ({ name: 'main', ref: 'refs/heads/main' })
  return s
}

const pointer = size => `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(63)}${size}\nsize ${size}\n`

test('isMergeWriteFailure matches write failures but not generic fatal or permission errors', () => {
  for (const text of [
    'error: Unable to write index.',
    'fatal: Unable to create \'C:/r/.git/index.lock\': File exists.',
    'error: external filter \'git-lfs filter-process\' failed: smudge filter lfs failed',
    'error: could not write to index: Permission denied',
    'write error: No space left on device',
  ]) expect(isMergeWriteFailure(text), text).toBe(true)
  for (const text of [
    'fatal: bad object refs/heads/missing',
    'fatal: unable to access \'https://x/\': Permission denied (publickey)',
    'Automatic merge failed; fix conflicts and then commit the result.',
    'fatal: refusing to merge unrelated histories',
  ]) expect(isMergeWriteFailure(text), text).toBe(false)
})

// Runs Update from main with the first merge failing the way the incident did:
// MERGE_HEAD present, incoming files written to the worktree, merged index lost.
async function failedUpdate(dir, s, progress, onFirstMerge = () => {}) {
  let merges = 0
  runner.execWithProgress = async (args, ...rest) => {
    if (args.includes('fetch')) return { stdout: '', stderr: '' }
    if (args.includes('merge') && ++merges === 1) {
      git(dir, 'merge', '--no-commit', '--no-ff', 'main')
      git(dir, 'read-tree', 'HEAD')
      onFirstMerge()
      throw new Error('git merge failed (exit 1): error: Unable to write index.')
    }
    return progress(args, ...rest)
  }
  await expect(s.updateFromMain(dir)).rejects.toThrow('Merge completion blocked:')
  return () => merges
}

test('a blocked Update from main can be aborted for retry, and the retry then succeeds', async () => {
  // shared.txt is modified (not added) upstream, so the failed merge leaves both
  // an untracked and a modified-looking incoming file behind.
  const dir = repo({ 'shared.txt': 'main version\n' }), s = service(dir), progress = runner.execWithProgress
  try {
    const merges = await failedUpdate(dir, s, progress)
    expect(fs.existsSync(mergeHead(dir))).toBe(true)
    expect(git(dir, 'status', '--porcelain')).toContain('incoming.txt')
    const state = await s.mergeInProgress(dir)
    expect(state.blockingReason).toContain('Unable to write index')
    expect(state.retryOperation).toBe('update-from-main')
    await s.abortMergeForRetry(dir)
    expect(fs.existsSync(mergeHead(dir))).toBe(false)
    expect(fs.existsSync(journal(dir))).toBe(false)
    expect(git(dir, 'status', '--porcelain')).toBe('')
    await s.updateFromMain(dir)
    expect(merges()).toBe(2)
    expect(git(dir, 'show', 'HEAD:incoming.txt')).toBe('incoming\n')
    expect(git(dir, 'show', 'HEAD:shared.txt')).toBe('main version\n')
    expect(git(dir, 'show', 'HEAD:branch.txt')).toBe('branch\n')
    expect(git(dir, 'status', '--porcelain')).toBe('')
  } finally { runner.execWithProgress = progress }
})

test('abort-for-retry never discards a file the user changed after the failed merge', async () => {
  const dir = repo({ 'shared.txt': 'main version\n' }), s = service(dir), progress = runner.execWithProgress
  try {
    await failedUpdate(dir, s, progress)
    fs.writeFileSync(path.join(dir, 'incoming.txt'), 'my own edit\n')
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'my own edit too\n')
    await s.abortMergeForRetry(dir)
    expect(fs.readFileSync(path.join(dir, 'incoming.txt'), 'utf8')).toBe('my own edit\n')
    expect(fs.readFileSync(path.join(dir, 'shared.txt'), 'utf8')).toBe('my own edit too\n')
    // The normal overlap check still protects those edits from the retry.
    await expect(s.updateFromMain(dir)).rejects.toThrow('local changes would be overwritten')
    expect(fs.readFileSync(path.join(dir, 'incoming.txt'), 'utf8')).toBe('my own edit\n')
  } finally { runner.execWithProgress = progress }
})

test('abort-for-retry refuses merges that did not come from Update from main', async () => {
  const dir = repo()
  git(dir, 'merge', '--no-commit', '--no-ff', 'main')
  const head = git(dir, 'rev-parse', 'HEAD').trim()
  // No journal at all.
  await expect(gitService.abortMergeForRetry(dir)).rejects.toThrow('Only a failed Update from main')
  // A journal from another operation.
  fs.writeFileSync(journal(dir), JSON.stringify({ id: 'x', operation: 'pull', head, failure: 'Unable to write index.' }))
  expect((await gitService.mergeInProgress(dir)).retryOperation).toBeUndefined()
  await expect(gitService.abortMergeForRetry(dir)).rejects.toThrow('Only a failed Update from main')
  expect(fs.existsSync(mergeHead(dir))).toBe(true)
})

test('a failed abort caused by an index write error explains what to do and keeps the guard', async () => {
  const dir = repo(), safe = runner.execSafe
  git(dir, 'merge', '--no-commit', '--no-ff', 'main')
  const head = git(dir, 'rev-parse', 'HEAD').trim()
  fs.writeFileSync(journal(dir), JSON.stringify({ id: 'x', operation: 'update-from-main', head, failure: 'Unable to write index.' }))
  runner.execSafe = async (args, ...rest) => args[0] === 'merge' && args[1] === '--abort'
    ? { exitCode: 128, stdout: '', stderr: 'error: Unable to write index.' } : safe(args, ...rest)
  try {
    await expect(gitService.abortMerge(dir)).rejects.toThrow(/could not write the index.*Check tasks and lock/s)
    expect(fs.existsSync(mergeHead(dir))).toBe(true)
    expect(fs.existsSync(journal(dir))).toBe(true)
  } finally { runner.execSafe = safe }
  await gitService.abortMerge(dir)
  expect(fs.existsSync(journal(dir))).toBe(false)
})

test('Update from main downloads only incoming LFS objects before merging', async () => {
  const dir = repo({
    'big.uasset': pointer(11), 'odd,name.uasset': pointer(22), 'plain.txt': 'not lfs\n',
  }), s = service(dir), progress = runner.execWithProgress, calls = []
  runner.execWithProgress = async (args, ...rest) => {
    if (args.includes('fetch') && !args.includes('lfs')) return { stdout: '', stderr: '' }
    if (args.includes('lfs')) { calls.push(args.slice(args.indexOf('lfs'))); return { stdout: '', stderr: '' } }
    calls.push(['merge'])
    return progress(args, ...rest)
  }
  try {
    await s.updateFromMain(dir)
    expect(calls).toEqual([['lfs', 'fetch', '--include=big.uasset', 'origin', 'refs/heads/main'], ['merge']])
    expect(git(dir, 'show', 'HEAD:incoming.txt')).toBe('incoming\n')
  } finally { runner.execWithProgress = progress }
})

test('a failed LFS prefetch never blocks the merge', async () => {
  const dir = repo({ 'big.uasset': pointer(11) }), s = service(dir), progress = runner.execWithProgress
  runner.execWithProgress = async (args, ...rest) => {
    if (args.includes('lfs')) throw new Error('network down')
    if (args.includes('fetch')) return { stdout: '', stderr: '' }
    return progress(args, ...rest)
  }
  try {
    await s.updateFromMain(dir)
    expect(git(dir, 'show', 'HEAD:big.uasset')).toContain('git-lfs')
  } finally { runner.execWithProgress = progress }
})

test('index recovery reports an unfinished merge so the UI can offer Abort', async () => {
  const dir = repo()
  git(dir, 'merge', '--no-commit', '--no-ff', 'main')
  const blocked = await indexRecoveryService.diagnose(dir)
  expect(blocked).toMatchObject({ issue: 'blocked', blockedByMerge: true })
  expect(blocked.detail).toContain('MERGE_HEAD')
  await gitService.abortMerge(dir)
  const after = await indexRecoveryService.diagnose(dir)
  expect(after.issue).toBe('healthy')
  expect(after.blockedByMerge).toBeUndefined()
})

function mergeDialog(ipc) {
  const state = { repoPath: 'repo', currentBranch: 'feature', refreshStatus: async () => {}, bumpSyncTick() {} }
  const view = component('src/components/merge/MergeDialog.tsx', {
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_label, fn) => fn() }) },
    '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: () => ({}) },
    '@/ipc': { ipc },
  })
  const closed = []
  const props = { targetBranch: 'main', onMerged() { closed.push('merged') }, onClose() { closed.push('closed') } }
  return { view, props, closed }
}

async function open({ view, props }) {
  view.render('MergePreviewDialog', props)
  for (const effect of view.effects) effect()
  await new Promise(resolve => setImmediate(resolve))
  return view.render('MergePreviewDialog', props)
}

test('merge dialog offers one-click Abort & retry only for a blocked Update from main', async () => {
  const reason = 'Merge completion blocked: Unable to write index.'
  const calls = []
  const update = mergeDialog({
    mergeInProgress: async () => ({ kind: 'merge', mergedBranch: 'main', conflicts: [], blockingReason: reason, retryOperation: 'update-from-main' }),
    mergeAbortRetryUpdate: async () => { calls.push('retry') },
  })
  const tree = await open(update)
  const retry = find(tree, n => n.type === 'button' && n.props.onClick?.name === 'abortAndRetryUpdate')
  expect(retry.props.disabled).toBe(false)
  await retry.props.onClick()
  expect(calls).toEqual(['retry'])
  expect(update.closed).toEqual(['merged', 'closed'])

  const other = mergeDialog({ mergeInProgress: async () => ({ kind: 'merge', mergedBranch: 'main', conflicts: [], blockingReason: reason }) })
  expect(JSON.stringify(await open(other))).not.toContain('Abort & retry update')
})

test('merge dialog stays open with the new recovery message when the retry fails again', async () => {
  const first = 'Merge completion blocked: first failure.'
  const second = 'Merge completion blocked: second failure.'
  let retried = false
  const d = mergeDialog({
    mergeInProgress: async () => ({ kind: 'merge', mergedBranch: 'main', conflicts: [], retryOperation: 'update-from-main', blockingReason: retried ? second : first }),
    mergeAbortRetryUpdate: async () => { retried = true; throw new Error(second) },
  })
  let tree = await open(d)
  await find(tree, n => n.type === 'button' && n.props.onClick?.name === 'abortAndRetryUpdate').props.onClick()
  tree = d.view.render('MergePreviewDialog', d.props)
  expect(find(tree, n => n.props?.role === 'alert').props.children).toContain(second)
  expect(d.closed).toEqual([])
  expect(find(tree, n => n.type === 'button' && n.props.onClick?.name === 'finalizeMerge').props.disabled).toBe(true)
})

test('index recovery panel offers Abort merge when a merge blocks recovery, then re-diagnoses', async () => {
  const calls = []
  let aborted = false
  const blocked = { repoPath: 'repo', issue: 'blocked', summary: 'Recovery stopped safely', detail: 'An operation is in progress (MERGE_HEAD).', canRepair: false, token: '', canUndo: false, blockedByMerge: true }
  const healthy = { ...blocked, issue: 'healthy', blockedByMerge: undefined }
  const h = component('src/components/tools/IndexRecoveryTool.tsx', {
    '@/ipc': { ipc: {
      diagnoseIndex: async () => { calls.push('diagnose'); return aborted ? healthy : blocked },
      mergeAbort: async () => { calls.push('abort'); aborted = true },
    } },
    '@/stores/repoStore': { useRepoStore: store({ repoPath: 'repo', bumpSyncTick() {} }) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async () => true }) },
    '@/stores/errorStore': { useErrorStore: store({ current: null }) },
  })
  const props = { repoPath: 'repo', onRefresh() {} }
  const button = label => find(h.render('IndexRecoveryTool', props), n => n.type === 'ActionBtn' && n.props.children.join('') === label)
  expect(button('Abort merge')).toBeNull()
  await button('Diagnose').props.onClick()
  await button('Abort merge').props.onClick()
  expect(calls).toEqual(['diagnose', 'abort', 'diagnose'])
  expect(button('Abort merge')).toBeNull()
})
