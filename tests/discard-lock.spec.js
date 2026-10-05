const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { tmpDir, git, cleanup, DIST } = require('./helpers')
const { component } = require('./renderer-harness')
const runner = require(path.join(DIST, 'util/dugite-exec'))
test.afterAll(cleanup)

function fixture(overrides = {}) {
  const repo = tmpDir('lg-discard-lock-')
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'asset.txt'), 'base'); fs.writeFileSync(path.join(repo, 'other.txt'), 'other')
  git(repo, 'add', '.'); git(repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'base')
  fs.writeFileSync(path.join(repo, 'asset.txt'), 'staged'); fs.writeFileSync(path.join(repo, 'other.txt'), 'other staged')
  git(repo, 'add', '.'); fs.writeFileSync(path.join(repo, 'asset.txt'), 'working')
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'keep')
  const lock = git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock').trim()
  const calls = [], warnings = [], progress = []
  const service = component('electron/services/GitService.ts', {
    './AuthService': { authService: { getCurrentToken: async () => 'test-token' } },
    './LogService': { logService: { warn: (...args) => warnings.push(args) } },
    '../util/dugite-exec': { ...runner, ...overrides, exec: async (args, ...rest) => {
      calls.push(args); return (overrides.exec || runner.exec)(args, ...rest)
    } },
  }, { Buffer }).exports.gitService
  service.getRemoteUrl = async () => 'https://github.com/test/repo'
  const discard = () => service.discard(repo, ['asset.txt'], false, step => progress.push(step))
  return { repo, lock, calls, warnings, progress, discard, service }
}

test('discard recovers an old lock once, preserves auth and selected scope, and restores exact committed bytes', async () => {
  const f = fixture(), head = git(f.repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(f.lock, 'orphan'); fs.utimesSync(f.lock, new Date(0), new Date(0))
  await f.discard()
  expect(f.calls).toHaveLength(3)
  expect(f.calls[0]).toEqual(f.calls[1])
  expect(f.calls.every(args => args.some(arg => arg.includes('AUTHORIZATION:')))).toBe(true)
  expect(fs.existsSync(f.lock)).toBe(false)
  expect(fs.readFileSync(path.join(f.repo, 'asset.txt'), 'utf8')).toBe('base')
  expect(git(f.repo, 'show', ':other.txt')).toBe('other staged')
  expect(fs.readFileSync(path.join(f.repo, 'untracked.txt'), 'utf8')).toBe('keep')
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(f.progress.at(-1)).toMatchObject({ status: 'done', current: 1, total: 1 })
})

test('discard retries a transient lock after its owner releases it without automatic deletion', async () => {
  let release
  const f = fixture({ exec: async (...args) => {
    try { return await runner.exec(...args) }
    catch (error) { release = setTimeout(() => fs.unlinkSync(f.lock), 150); throw error }
  } })
  fs.writeFileSync(f.lock, 'transient')
  try { await f.discard() } finally { clearTimeout(release) }
  expect(f.calls).toHaveLength(3); expect(f.warnings).toEqual([])
  expect(fs.readFileSync(path.join(f.repo, 'asset.txt'), 'utf8')).toBe('base')
})

test('active app work blocks lock deletion, retry and false completion', async () => {
  const f = fixture({ gitOpActivity: () => ({ inFlight: 1, ranDuring: () => true }), waitForGitOpsToDrain: async () => false })
  fs.writeFileSync(f.lock, 'active'); fs.utimesSync(f.lock, new Date(0), new Date(0))
  const index = fs.readFileSync(f.lock.slice(0, -5))
  await expect(f.discard()).rejects.toThrow('index.lock')
  expect(f.calls).toHaveLength(1); expect(f.progress.some(step => step.status === 'done')).toBe(false)
  expect(fs.readFileSync(f.lock, 'utf8')).toBe('active')
  expect(fs.readFileSync(f.lock.slice(0, -5))).toEqual(index)
  expect(fs.readFileSync(path.join(f.repo, 'asset.txt'), 'utf8')).toBe('working')
})

test('a second lock error across the two restore passes never triggers another recovery', async () => {
  const f = fixture({ exec: async (args, ...rest) => {
    if (!args.includes('--staged')) fs.writeFileSync(f.lock, 'new writer')
    return runner.exec(args, ...rest)
  } })
  fs.writeFileSync(f.lock, 'orphan'); fs.utimesSync(f.lock, new Date(0), new Date(0))
  await expect(f.discard()).rejects.toThrow('index.lock')
  expect(f.calls).toHaveLength(3); expect(f.warnings).toHaveLength(1)
  expect(fs.readFileSync(f.lock, 'utf8')).toBe('new writer')
  expect(f.progress.some(step => step.status === 'done')).toBe(false)
  expect(fs.readFileSync(path.join(f.repo, 'asset.txt'), 'utf8')).toBe('working')
})

test('unrelated restore errors never inspect or remove an index lock', async () => {
  const f = fixture({ exec: async () => { throw Error('unable to write asset: permission denied') } })
  f.service.clearStaleIndexLock = async () => { throw Error('unexpected recovery') }
  await expect(f.discard()).rejects.toThrow('permission denied')
  expect(f.calls).toHaveLength(1); expect(f.progress.some(step => step.status === 'done')).toBe(false)
})

test('an ordinary discard still performs exactly two restore commands without a recovery probe', async () => {
  const f = fixture()
  f.service.clearStaleIndexLock = async () => { throw Error('unexpected recovery scan') }
  await f.discard()
  expect(f.calls).toHaveLength(2)
  expect(fs.readFileSync(path.join(f.repo, 'asset.txt'), 'utf8')).toBe('base')
})

test('a lock on the working-tree pass retries that pass without repeating the successful unstage', async () => {
  let workingCalls = 0
  const f = fixture({ exec: async (args, ...rest) => {
    if (!args.includes('--staged') && ++workingCalls === 1) {
      fs.writeFileSync(f.lock, 'orphan'); fs.utimesSync(f.lock, new Date(0), new Date(0))
    }
    return runner.exec(args, ...rest)
  } })
  await f.discard()
  expect(f.calls).toHaveLength(3)
  expect(f.calls.filter(args => args.includes('--staged'))).toHaveLength(1)
  expect(f.calls[1]).toEqual(f.calls[2])
  expect(fs.readFileSync(path.join(f.repo, 'asset.txt'), 'utf8')).toBe('base')
})
