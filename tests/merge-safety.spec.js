const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { component, find, store } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const runner = require(path.join(DIST, 'util/dugite-exec'))
const { logService } = require(path.join(DIST, 'services/LogService'))
const safetyPath = path.join(DIST, 'util/merge-safety')
const journal = repo => path.join(git(repo, 'rev-parse', '--absolute-git-dir').trim(), 'lucid-merge-safety.json')
const head = repo => git(repo, 'rev-parse', 'HEAD').trim()
const headTree = repo => git(repo, 'rev-parse', 'HEAD^{tree}').trim()
test.afterAll(cleanup)

function repo(conflict = false, identical = false) {
  const dir = tmpDir('lg-merge-safety-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'base\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
  git(dir, 'branch', 'feature')
  fs.writeFileSync(path.join(dir, conflict || identical ? 'shared.txt' : 'incoming.txt'), 'incoming\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'main work')
  git(dir, 'checkout', '-q', 'feature')
  fs.writeFileSync(path.join(dir, conflict || identical ? 'shared.txt' : 'branch.txt'), identical ? 'incoming\n' : 'branch\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'branch work')
  return dir
}

function unfinished(dir, loseIndex = false) {
  git(dir, 'merge', '--no-commit', '--no-ff', 'main')
  // Deterministic injection of the observed on-disk failure: MERGE_HEAD exists,
  // working files changed, but the merged index was never installed.
  if (loseIndex) git(dir, 'read-tree', 'HEAD')
}

test('incident fixture: Git alone permits an empty merge after the index result is lost', () => {
  const dir = repo(), before = headTree(dir)
  unfinished(dir, true)
  git(dir, 'commit', '--no-edit')
  expect(headTree(dir)).toBe(before)
  expect(git(dir, 'show', '-s', '--format=%P').trim().split(' ')).toHaveLength(2)
  expect(git(dir, 'status', '--short')).toContain('incoming.txt')
})

test('failed index write is persisted, never retried as a merge, and blocks both commit routes after restart', async () => {
  const dir = repo(), originalHead = head(dir), originalExec = runner.exec
  const logs = [], info = logService.info, error = logService.error
  logService.info = (source, message) => logs.push({ source, message })
  logService.error = (source, message) => logs.push({ source, message })
  let attempts = 0
  runner.exec = async (args, cwd) => {
    if (cwd === dir && args.includes('merge') && args.includes('--no-ff')) {
      attempts++
      unfinished(dir, true)
      fs.writeFileSync(path.join(dir, '.git/index.lock'), 'unfinished index')
      throw new Error('git merge failed (exit 1): error: Unable to write index.')
    }
    return originalExec(args, cwd)
  }
  try {
    await expect(gitService.merge(dir, 'main')).rejects.toThrow('Merge completion blocked:')
    expect(attempts).toBe(1)
    expect(fs.existsSync(path.join(dir, '.git/index.lock'))).toBe(true)
    const record = JSON.parse(fs.readFileSync(journal(dir), 'utf8'))
    expect(record).toMatchObject({ head: originalHead, operation: 'merge refs/heads/main' })
    expect(record.failure).toContain('Unable to write index')
    fs.unlinkSync(path.join(dir, '.git/index.lock'))
    // No process-local state: loading the utility again still sees the guard.
    delete require.cache[require.resolve(safetyPath)]
    await expect(require(safetyPath).assertSafeMergeCommit(dir)).rejects.toThrow('Removing index.lock alone')
    await expect(gitService.continueMerge(dir, 'main')).rejects.toThrow('Merge completion blocked:')
    await expect(gitService.commit(dir, 'finish')).rejects.toThrow('Merge completion blocked:')
    // Staging part of the incoming work must not erase a recorded write failure.
    git(dir, 'add', 'incoming.txt')
    await expect(gitService.commit(dir, 'partial')).rejects.toThrow('Merge completion blocked:')
    expect(head(dir)).toBe(originalHead)
    expect((await gitService.mergeInProgress(dir)).blockingReason).toContain('Original failure:')
    const output = logs.map(l => l.message).join('\n')
    expect(output).toContain(record.id)
    expect(output).toContain('"stagedCount":0')
    expect(output).toContain('"indexTree"')
    expect(output).toContain('"incoming"')
    expect(output).toContain('"lock"')
    expect(output).toContain('Commit blocked:')
    runner.exec = originalExec
    await gitService.abortMerge(dir)
    await gitService.merge(dir, 'main')
    expect(git(dir, 'show', 'HEAD:incoming.txt')).toBe('incoming\n')
    expect(git(dir, 'show', 'HEAD:branch.txt')).toBe('branch\n')
    expect(fs.existsSync(journal(dir))).toBe(false)
    expect(logs.some(l => l.message.startsWith('Merge completed:'))).toBe(true)
  } finally { runner.exec = originalExec; logService.info = info; logService.error = error }
})

test('unfinished empty merge without a journal is blocked without changing its files or refs', async () => {
  const dir = repo(), original = head(dir)
  unfinished(dir, true)
  const status = git(dir, 'status', '--porcelain')
  await expect(gitService.continueMerge(dir, 'main')).rejects.toThrow('none of the incoming changes')
  await expect(gitService.commit(dir, 'finish')).rejects.toThrow('none of the incoming changes')
  expect(head(dir)).toBe(original)
  expect(git(dir, 'status', '--porcelain')).toBe(status)
})

for (const method of ['pull', 'updateFromMain']) {
  test(`${method} preserves failed-write evidence even when some incoming files were staged`, async () => {
    const dir = repo(), original = head(dir), progress = runner.execWithProgress
    const service = new gitService.constructor()
    service.getRemoteUrl = async () => 'https://example.invalid/repo.git'
    service.remoteDefaultBranch = async () => ({ name: 'main', ref: 'refs/heads/main' })
    service.pullReconcileArgs = async () => ['--no-rebase']
    runner.execWithProgress = async args => {
      if (args.includes('fetch')) return { stdout: '', stderr: '' }
      unfinished(dir)
      throw new Error('git merge failed (exit 1): Unable to write index.')
    }
    try {
      await expect(service[method](dir)).rejects.toThrow('Merge completion blocked:')
      expect(git(dir, 'diff', '--cached', '--name-only')).toContain('incoming.txt')
      await expect(service.commit(dir, 'finish')).rejects.toThrow('Merge completion blocked:')
      expect(head(dir)).toBe(original)
      expect(JSON.parse(fs.readFileSync(journal(dir), 'utf8')).failure).toContain('Unable to write index')
    } finally { runner.execWithProgress = progress }
  })
}

test('operational error alongside actual conflicts remains blocked after choosing a side', async () => {
  const dir = repo(true), safety = require(safetyPath)
  await expect(safety.guardedMergeOperation(dir, 'mixed failure', async () => {
    try { git(dir, 'merge', 'main') } catch { /* conflicts plus the injected write error */ }
    throw new Error('Automatic merge failed; error: Unable to write index.')
  })).rejects.toThrow('Merge completion blocked:')
  await gitService.resolveMergeConflictText(dir, 'shared.txt', 'theirs')
  await expect(gitService.continueMerge(dir, 'main')).rejects.toThrow('Merge completion blocked:')
})

test('streamed Update from main keeps real binary conflicts resolvable', async () => {
  const dir = repo(true), progress = runner.execWithProgress
  fs.writeFileSync(path.join(dir, 'shared.txt'), Buffer.from('branch\0binary'))
  git(dir, 'commit', '-qam', 'binary branch work')
  const service = new gitService.constructor()
  service.getRemoteUrl = async () => 'https://example.invalid/repo.git'
  service.remoteDefaultBranch = async () => ({ name: 'main', ref: 'refs/heads/main' })
  runner.execWithProgress = async (args, ...rest) => args.includes('fetch')
    ? { stdout: '', stderr: '' } : progress(args, ...rest)
  try {
    await expect(service.updateFromMain(dir)).rejects.toThrow(/cannot merge binary|conflict/i)
    expect(fs.existsSync(journal(dir))).toBe(false)
    expect((await service.mergeInProgress(dir)).blockingReason).toBeUndefined()
    await service.resolveMergeConflictText(dir, 'shared.txt', 'theirs')
    await service.continueMerge(dir, 'main')
    expect(git(dir, 'show', 'HEAD:shared.txt')).toBe('incoming\n')
  } finally { runner.execWithProgress = progress }
})

test('failure before any merge starts does not block ordinary commits', async () => {
  const dir = repo(), safety = require(safetyPath)
  await expect(safety.guardedMergeOperation(dir, 'fetch failure', async () => {
    throw new Error('Unable to write index.')
  })).rejects.toThrow('Unable to write index')
  expect(fs.existsSync(journal(dir))).toBe(false)
  fs.writeFileSync(path.join(dir, 'local.txt'), 'local\n')
  git(dir, 'add', '.')
  await gitService.commit(dir, 'ordinary work')
  expect(git(dir, 'show', 'HEAD:local.txt')).toBe('local\n')
})

test('interrupted running journal and unreadable journal both fail closed', async () => {
  const dir = repo()
  unfinished(dir)
  fs.writeFileSync(journal(dir), JSON.stringify({ id: 'interrupted', head: head(dir), operation: 'pull' }))
  await expect(gitService.continueMerge(dir, 'main')).rejects.toThrow('interrupted')
  fs.writeFileSync(journal(dir), '{partial write')
  await expect(gitService.commit(dir, 'finish')).rejects.toThrow('recovery record could not be read')
})

test('clean merge and genuine conflicts resolved entirely to ours remain valid', async () => {
  const clean = repo()
  unfinished(clean)
  await gitService.continueMerge(clean, 'main')
  expect(git(clean, 'status', '--porcelain')).toBe('')
  const conflict = repo(true), before = headTree(conflict)
  await expect(gitService.merge(conflict, 'main')).rejects.toThrow(/conflict/i)
  expect(fs.existsSync(journal(conflict))).toBe(false)
  await gitService.resolveMergeConflictText(conflict, 'shared.txt', 'ours')
  await gitService.continueMerge(conflict, 'main')
  expect(headTree(conflict)).toBe(before)
  expect(git(conflict, 'show', '-s', '--format=%P').trim().split(' ')).toHaveLength(2)
})

test('genuinely unchanged clean merge is allowed', async () => {
  const dir = repo(false, true), tree = headTree(dir)
  unfinished(dir)
  await gitService.continueMerge(dir, 'main')
  expect(headTree(dir)).toBe(tree)
  expect(git(dir, 'show', '-s', '--format=%P').trim().split(' ')).toHaveLength(2)
})

test('commit retry rechecks the index after lock cleanup', async () => {
  const dir = repo(), original = head(dir), clear = gitService.clearStaleIndexLock
  unfinished(dir)
  fs.writeFileSync(path.join(dir, '.git/index.lock'), 'lock')
  gitService.clearStaleIndexLock = async () => {
    fs.unlinkSync(path.join(dir, '.git/index.lock'))
    git(dir, 'read-tree', 'HEAD')
    return true
  }
  try {
    await expect(gitService.continueMerge(dir, 'main')).rejects.toThrow('none of the incoming changes')
    expect(head(dir)).toBe(original)
  } finally { gitService.clearStaleIndexLock = clear }
})

test('eligible lock recovery still completes a verified merge and explains the retry in logs', async () => {
  const dir = repo(), warnings = [], warn = logService.warn
  unfinished(dir)
  const lock = path.join(dir, '.git/index.lock')
  fs.writeFileSync(lock, 'old lock')
  const old = new Date(Date.now() - 10_000)
  fs.utimesSync(lock, old, old)
  logService.warn = (source, message) => warnings.push({ source, message })
  try {
    await gitService.continueMerge(dir, 'main')
    expect(git(dir, 'show', 'HEAD:incoming.txt')).toBe('incoming\n')
    expect(warnings.some(l => l.message.includes('ageMs=') && l.message.includes('mergeInProgress=true') && l.message.includes('does not validate or rebuild'))).toBe(true)
  } finally { logService.warn = warn }
})

test('recovery journal is private to the linked worktree', async () => {
  const dir = repo(), linked = tmpDir('lg-merge-safety-worktree-')
  git(dir, 'worktree', 'add', '-q', '-b', 'linked', linked, 'feature')
  const safety = require(safetyPath)
  await expect(safety.guardedMergeOperation(linked, 'test merge', async () => {
    unfinished(linked, true)
    throw new Error('Unable to write index.')
  })).rejects.toThrow('Merge completion blocked:')
  expect(fs.existsSync(journal(linked))).toBe(true)
  expect(fs.existsSync(journal(dir))).toBe(false)
  await expect(safety.assertSafeMergeCommit(linked)).rejects.toThrow('Merge completion blocked:')
  await safety.assertSafeMergeCommit(dir)
})

test('recovery dialog explains the failed write, disables completion, and keeps abort available', async () => {
  const reason = 'Merge completion blocked: Unable to write index. Abort this merge and retry.'
  const state = { repoPath: 'repo', currentBranch: 'feature', refreshStatus: async () => {}, bumpSyncTick() {} }
  let aborted = 0
  const view = component('src/components/merge/MergeDialog.tsx', {
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_label, fn) => fn() }) },
    '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: () => ({}) },
    '@/ipc': { ipc: {
      mergeInProgress: async () => ({ kind: 'merge', mergedBranch: 'main', conflicts: [], blockingReason: reason }),
      mergeAbort: async () => { aborted++ },
    } },
  })
  const props = { targetBranch: 'main', onMerged() {}, onClose() {} }
  view.render('MergePreviewDialog', props)
  for (const effect of view.effects) effect()
  await new Promise(resolve => setImmediate(resolve))
  const tree = view.render('MergePreviewDialog', props)
  expect(find(tree, n => n.props?.role === 'alert').props.children).toContain(reason)
  const complete = find(tree, n => n.type === 'button' && JSON.stringify(n.props.children).includes('Complete merge'))
  expect(complete.props.disabled).toBe(true)
  expect(JSON.stringify(tree)).not.toContain('Merge ready to finalize')
  const abort = find(tree, n => n.props?.children?.includes('Abort merge'))
  expect(abort.props.disabled).toBe(false)
  await abort.props.onClick()
  expect(aborted).toBe(1)
})

test('a merge write failure inside the open dialog switches to blocked recovery with Abort available', async () => {
  const reason = 'Merge completion blocked: Unable to write index.'
  let failed = false
  const state = { repoPath: 'repo', currentBranch: 'feature', refreshStatus: async () => {}, bumpSyncTick() {} }
  const view = component('src/components/merge/MergeDialog.tsx', {
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_label, fn) => fn() }) },
    '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: () => ({}) },
    '@/ipc': { ipc: {
      mergeInProgress: async () => failed ? { kind: 'merge', mergedBranch: 'main', conflicts: [], blockingReason: reason } : null,
      mergePreview: async () => [],
      branchDiff: async () => ({ aheadCommits: [{}], behindCommits: [], files: [] }),
      merge: async () => { failed = true; throw new Error(reason) },
    } },
  })
  const props = { targetBranch: 'main', onMerged() {}, onClose() {} }
  view.render('MergePreviewDialog', props)
  for (const effect of view.effects) effect()
  await new Promise(resolve => setImmediate(resolve))
  let tree = view.render('MergePreviewDialog', props)
  const merge = find(tree, n => n.type === 'button' && n.props.onClick?.name === 'doMerge')
  await merge.props.onClick()
  tree = view.render('MergePreviewDialog', props)
  expect(find(tree, n => n.props?.role === 'alert').props.children).toContain(reason)
  expect(find(tree, n => n.type === 'button' && n.props.onClick?.name === 'finalizeMerge').props.disabled).toBe(true)
  expect(find(tree, n => n.props?.children?.includes('Abort merge')).props.disabled).toBe(false)
})
