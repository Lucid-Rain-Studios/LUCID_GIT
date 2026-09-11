// Discard All: correctness, and what it costs to get there.
//
// An unscoped `git status` walks the whole working tree. On a One File Per
// Actor Unreal project that was measured at over three minutes and routinely
// did not finish, and this operation used to run one before anything else —
// so a discard could sit for an hour without ever reaching the reset.
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')

const { gitService } = require(path.join(DIST, 'services', 'GitService.js'))

/** A repo with one of each thing Discard All has to reason about. */
function dirtyRepo() {
  const repo = tmpDir('lg-discard-')
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  // Deterministic regardless of the developer's global autocrlf setting.
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\n')
  fs.writeFileSync(path.join(repo, 'also-tracked.txt'), 'original\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'edited\n')      // modified
  fs.writeFileSync(path.join(repo, 'staged-add.txt'), 'new\n')      // staged addition
  git(repo, 'add', 'staged-add.txt')
  fs.writeFileSync(path.join(repo, 'never-staged.txt'), 'mine\n')   // untracked, untouched
  return repo
}

/** A repo left mid-merge by a conflict git could not resolve on its own. */
function conflictedRepo() {
  const repo = tmpDir('lg-conflict-')
  git(repo, 'init', '-q', '-b', 'main', '.')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')

  git(repo, 'checkout', '-q', '-b', 'feature')
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'feature\n')
  fs.writeFileSync(path.join(repo, 'only-on-feature.txt'), 'f\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'feature')

  git(repo, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'main\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'main change')

  try {
    git(repo, 'merge', '--no-edit', 'feature')
  } catch {
    // Expected: this is the state under test.
  }
  return repo
}

/** Classify every `git status` this ran, by how much of the tree it walks. */
async function recordStatusCalls(fn) {
  const dugite = require(path.join(__dirname, '..', 'node_modules', 'dugite'))
  const real = dugite.GitProcess.exec.bind(dugite.GitProcess)
  const calls = { fullWalk: 0, trackedOnly: 0, scoped: 0 }
  dugite.GitProcess.exec = (args, ...rest) => {
    if (Array.isArray(args) && args.includes('status')) {
      if (args.includes('--')) calls.scoped++
      else if (args.includes('--untracked-files=no')) calls.trackedOnly++
      else calls.fullWalk++   // -uall over the whole tree: the three-minute one
    }
    return real(args, ...rest)
  }
  try {
    await fn()
    return calls
  } finally {
    dugite.GitProcess.exec = real
  }
}

test.afterAll(cleanup)

test('discard all clears tracked edits and staged additions', async () => {
  const repo = dirtyRepo()
  await gitService.discardAll(repo)

  expect(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8')).toBe('original\n')
  expect(fs.existsSync(path.join(repo, 'staged-add.txt'))).toBe(false)
  expect(git(repo, 'status', '--porcelain').trim()).toBe('?? never-staged.txt')
})

test('discard all leaves untracked files that were never staged', async () => {
  const repo = dirtyRepo()
  await gitService.discardAll(repo)

  // The button is offered on this basis; deleting them would be a surprise.
  expect(fs.existsSync(path.join(repo, 'never-staged.txt'))).toBe(true)
  expect(fs.readFileSync(path.join(repo, 'never-staged.txt'), 'utf8')).toBe('mine\n')
})

test('a clean discard never walks the working tree at all', async () => {
  const repo = dirtyRepo()
  const calls = await recordStatusCalls(() => gitService.discardAll(repo))

  // Everything it needs comes from the index. The walk this replaced ran
  // before the reset, which is why a discard could hang without starting.
  expect(calls.fullWalk).toBe(0)
  expect(calls.trackedOnly).toBe(0)
  expect(calls.scoped).toBe(0)
})

test('a conflicted merge is aborted, not unpicked file by file', async () => {
  const repo = conflictedRepo()
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true)

  const calls = await recordStatusCalls(() => gitService.discardAll(repo))

  // The merge is gone and the branch is back at its committed state.
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
  expect(git(repo, 'status', '--porcelain').trim()).toBe('')
  expect(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('main\n')
  // Files the merge was bringing in must not survive it.
  expect(fs.existsSync(path.join(repo, 'only-on-feature.txt'))).toBe(false)
  expect(calls.fullWalk).toBe(0)
})

test('a repo with no commits yet still discards its staged files', async () => {
  const repo = tmpDir('lg-nohead-')
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, 'staged.txt'), 'x\n')
  git(repo, 'add', '-A')
  fs.writeFileSync(path.join(repo, 'loose.txt'), 'y\n')

  // No HEAD means no tree to reset to, so the index is emptied instead and
  // every entry in it is by definition an addition to remove.
  await gitService.discardAll(repo)

  expect(fs.existsSync(path.join(repo, 'staged.txt'))).toBe(false)
  expect(fs.existsSync(path.join(repo, 'loose.txt'))).toBe(true)
})
