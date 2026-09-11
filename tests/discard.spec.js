// Discard All: correctness, and the cost of verifying its own work.
//
// An unscoped `git status` walks the whole working tree. On a One File Per
// Actor Unreal project that is minutes, and this operation used to run one up
// to eight times — so on a repository that size it could never finish at all.
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

/** Record every `git status` this ran, split by whether it was scoped. */
async function recordStatusCalls(fn) {
  const dugite = require(path.join(__dirname, '..', 'node_modules', 'dugite'))
  const real = dugite.GitProcess.exec.bind(dugite.GitProcess)
  const calls = { full: 0, scoped: 0 }
  dugite.GitProcess.exec = (args, ...rest) => {
    if (Array.isArray(args) && args.includes('status')) {
      if (args.includes('--')) calls.scoped++
      else calls.full++
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

test('discard all walks the whole tree once, and verifies scoped thereafter', async () => {
  const repo = dirtyRepo()
  const calls = await recordStatusCalls(() => gitService.discardAll(repo))

  // One unscoped walk to learn what is dirty. Everything after that asks only
  // about those paths, which is what makes this survivable on a large repo.
  expect(calls.full).toBe(1)
})

test('a discard that has to retry still only walks the whole tree once', async () => {
  const repo = dirtyRepo()
  // Leave a path git cannot restore cleanly so the retry loop engages: a
  // directory standing where a staged file belongs.
  fs.writeFileSync(path.join(repo, 'blocker.txt'), 'x\n')
  git(repo, 'add', 'blocker.txt')
  fs.rmSync(path.join(repo, 'blocker.txt'))
  fs.mkdirSync(path.join(repo, 'blocker.txt'))
  fs.writeFileSync(path.join(repo, 'blocker.txt', 'inside.txt'), 'y\n')

  const calls = await recordStatusCalls(async () => {
    try { await gitService.discardAll(repo) } catch { /* may legitimately fail */ }
  })

  expect(calls.full).toBe(1)
  expect(calls.scoped).toBeGreaterThan(0)
})
