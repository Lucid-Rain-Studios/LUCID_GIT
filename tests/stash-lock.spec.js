const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { tmpDir, git, cleanup, DIST } = require('./helpers')
const { component } = require('./renderer-harness')
const runner = require(path.join(DIST, 'util/dugite-exec'))

test.afterAll(cleanup)

function fixture(intercept, overrides = {}) {
  const repo = tmpDir('lg-stash-lock-')
  git(repo, 'init', '-qb', 'main')
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'asset.txt'), 'base')
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other')
  git(repo, 'add', '.'); git(repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'base')
  fs.writeFileSync(path.join(repo, 'asset.txt'), 'staged'); git(repo, 'add', 'asset.txt')
  fs.writeFileSync(path.join(repo, 'asset.txt'), 'working')
  fs.writeFileSync(path.join(repo, 'other.txt'), 'other working')
  fs.writeFileSync(path.join(repo, 'new.txt'), 'untracked')
  let attempts = 0
  const warnings = []
  const invoke = async (method, args, ...rest) => {
    if (args[0] === 'stash' && args[1] === 'push') {
      attempts++
      if (intercept) return intercept({ repo, method, args, rest, attempts })
    }
    return runner[method](args, ...rest)
  }
  const service = component('electron/services/GitService.ts', {
    '../util/repo-gate': require(path.join(DIST, 'util/repo-gate')),
    './LogService': { logService: { warn: (...args) => warnings.push(args) } },
    '../util/dugite-exec': { ...runner, ...overrides,
      exec: (...args) => invoke('exec', ...args),
      execWithStdin: (...args) => invoke('execWithStdin', ...args),
    },
  }, { Buffer }).exports.gitService
  const lock = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock').trim()
  return { repo, service, lock, warnings, attempts: () => attempts }
}

function oldLock(f) {
  fs.writeFileSync(f.lock, 'orphan'); fs.utimesSync(f.lock, new Date(0), new Date(0))
}

for (const selected of [false, true]) {
  test(`stash recovers a real stale index lock once (${selected ? 'selected' : 'all'}) and preserves exact snapshots`, async () => {
    const f = fixture(), head = git(f.repo, 'rev-parse', 'HEAD')
    oldLock(f)
    await f.service.stashSave(f.repo, 'recovered', selected ? ['asset.txt', 'new.txt'] : undefined)
    expect(f.attempts()).toBe(2)
    expect(git(f.repo, 'stash', 'list').trim().split('\n')).toHaveLength(1)
    expect(git(f.repo, 'show', 'stash@{0}:asset.txt')).toBe('working')
    expect(git(f.repo, 'show', 'stash@{0}^2:asset.txt')).toBe('staged')
    expect(git(f.repo, 'show', 'stash@{0}^3:new.txt')).toBe('untracked')
    expect(fs.readFileSync(path.join(f.repo, 'asset.txt'), 'utf8')).toBe('base')
    expect(fs.readFileSync(path.join(f.repo, 'other.txt'), 'utf8')).toBe(selected ? 'other working' : 'other')
    expect(fs.existsSync(path.join(f.repo, 'new.txt'))).toBe(false)
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
  })
}

test('generic index-write error recovers only when a real eligible lock exists', async () => {
  const f = fixture(async ({ method, args, rest, attempts }) => {
    if (attempts === 1) throw Error('error: could not write index')
    return runner[method](args, ...rest)
  })
  oldLock(f)
  await f.service.stashSave(f.repo)
  expect(f.attempts()).toBe(2); expect(f.warnings).toHaveLength(1)
})

test('transient lock disappears during the wait and stash succeeds without deleting it', async () => {
  let release
  const f = fixture(async ({ method, args, rest, attempts }) => {
    if (attempts === 1) release = setTimeout(() => fs.unlinkSync(f.lock), 150)
    return runner[method](args, ...rest)
  })
  fs.writeFileSync(f.lock, 'transient')
  try { await f.service.stashSave(f.repo) } finally { clearTimeout(release) }
  expect(f.attempts()).toBe(2); expect(f.warnings).toEqual([])
})

test('active app work prevents deletion and retry, preserving staged and working bytes', async () => {
  const f = fixture(undefined, {
    gitOpActivity: () => ({ inFlight: 1, ranDuring: () => true }),
    waitForGitOpsToDrain: async () => false,
  })
  oldLock(f)
  const index = fs.readFileSync(f.lock.slice(0, -5))
  await expect(f.service.stashSave(f.repo)).rejects.toThrow(/index/)
  expect(f.attempts()).toBe(1)
  expect(fs.readFileSync(f.lock, 'utf8')).toBe('orphan')
  expect(fs.readFileSync(f.lock.slice(0, -5))).toEqual(index)
  expect(fs.readFileSync(path.join(f.repo, 'asset.txt'), 'utf8')).toBe('working')
})

test('generic failure without a lock does not repair the index or retry', async () => {
  const f = fixture(async () => { throw Error('error: could not write index') })
  f.service.clearStaleIndexLock = async () => { throw Error('unexpected repair') }
  await expect(f.service.stashSave(f.repo)).rejects.toThrow('could not write index')
  expect(f.attempts()).toBe(1)
  expect(git(f.repo, 'show', ':asset.txt')).toBe('staged')
})

test('a saved checkpoint followed by index failure is never stashed twice', async () => {
  const f = fixture(async ({ method, args, rest }) => {
    await runner[method](args, ...rest)
    throw Error('error: could not write index')
  })
  f.service.clearStaleIndexLock = async () => { throw Error('unexpected recovery') }
  await expect(f.service.stashSave(f.repo)).rejects.toThrow('Stash was saved, but cleanup failed')
  expect(f.attempts()).toBe(1)
  expect(git(f.repo, 'stash', 'list').trim().split('\n')).toHaveLength(1)
})

test('a second index failure stops after one retry', async () => {
  const f = fixture(async () => { throw Error('error: could not write index') })
  oldLock(f)
  await expect(f.service.stashSave(f.repo)).rejects.toThrow('could not write index')
  expect(f.attempts()).toBe(2)
  expect(git(f.repo, 'show', ':asset.txt')).toBe('staged')
})

test('successful stash never probes for index recovery', async () => {
  const f = fixture()
  f.service.getIndexLockInfo = async () => { throw Error('unexpected probe') }
  await f.service.stashSave(f.repo)
  expect(f.attempts()).toBe(1)
})

test('recovery preserves an older stash and adds exactly one new checkpoint', async () => {
  const f = fixture()
  git(f.repo, 'stash', 'push', '-u', '-m', 'older')
  const older = git(f.repo, 'rev-parse', 'refs/stash')
  git(f.repo, 'stash', 'apply', '--index')
  oldLock(f)
  await f.service.stashSave(f.repo, 'new')
  expect(f.attempts()).toBe(2)
  expect(git(f.repo, 'stash', 'list').trim().split('\n')).toHaveLength(2)
  expect(git(f.repo, 'rev-parse', 'stash@{1}')).toBe(older)
})

test('a fresh external lock is preserved without retry', async () => {
  const f = fixture(undefined, { gitOpActivity: () => ({ inFlight: 0, ranDuring: () => false }) })
  fs.writeFileSync(f.lock, 'fresh')
  // Keep the external writer's metadata fresh throughout the bounded wait.
  const refresh = setInterval(() => fs.utimesSync(f.lock, new Date(), new Date()), 50)
  try { await expect(f.service.stashSave(f.repo)).rejects.toThrow(/index/) }
  finally { clearInterval(refresh) }
  expect(f.attempts()).toBe(1)
  expect(fs.readFileSync(f.lock, 'utf8')).toBe('fresh')
  expect(git(f.repo, 'show', ':asset.txt')).toBe('staged')
})

test('a stash changed during lock recovery prevents retry', async () => {
  const f = fixture(async () => { throw Error('could not write index') })
  oldLock(f)
  f.service.clearStaleIndexLock = async () => {
    fs.unlinkSync(f.lock)
    git(f.repo, 'stash', 'push', '-u')
    return true
  }
  await expect(f.service.stashSave(f.repo)).rejects.toThrow('stash changed during lock recovery')
  expect(f.attempts()).toBe(1)
  expect(git(f.repo, 'stash', 'list').trim().split('\n')).toHaveLength(1)
})
