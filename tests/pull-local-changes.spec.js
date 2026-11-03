// Regression: on INFERIUS, Pull with an uncommitted tracked change failed every
// time with "Could not save working changes for Undo. Operation stopped: error:
// could not write index". An interrupted Git write had left an empty, hours-old
// .git/index.lock. The pre-pull Undo snapshot (`git stash create`) needed that
// lock and failed before Pull's own stale-lock recovery could run. These tests
// rebuild that state in disposable repositories and drive the real code paths.
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
const runner = require(path.join(DIST, 'util/dugite-exec'))

test.afterAll(cleanup)

const OLD = new Date(Date.now() - 6 * 60 * 60 * 1000)

function service() {
  return require(path.join(DIST, 'services/GitService')).gitService
}

// A clone one commit behind origin/main, with a staged and an unstaged change
// in a file the incoming commit does not touch.
function behindWithLocalChanges() {
  const origin = tmpDir('lg-pull-origin-')
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.name', 'Test')
  git(origin, 'config', 'user.email', 'test@example.com')
  git(origin, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(origin, 'Inferius.uproject'), 'project v1\n')
  fs.writeFileSync(path.join(origin, 'incoming.txt'), 'old\n')
  git(origin, 'add', '.')
  git(origin, '-c', 'core.hooksPath=', 'commit', '-qm', 'initial')
  const repo = tmpDir('lg-pull-clone-')
  git(repo, 'clone', '-q', '-c', 'core.autocrlf=false', origin, '.')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(origin, 'incoming.txt'), 'new\n')
  git(origin, 'add', '.')
  git(origin, '-c', 'core.hooksPath=', 'commit', '-qm', 'teammate change')
  fs.writeFileSync(path.join(repo, 'Inferius.uproject'), 'project staged\n')
  git(repo, 'add', 'Inferius.uproject')
  fs.writeFileSync(path.join(repo, 'Inferius.uproject'), 'project working\n')
  return { origin, repo }
}

function orphanIndexLock(repo) {
  const lock = path.join(repo, '.git/index.lock')
  fs.writeFileSync(lock, '')
  fs.utimesSync(lock, OLD, OLD)
  return lock
}

function expectPulledWithLocalChanges(origin, repo) {
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'HEAD'))
  expect(fs.readFileSync(path.join(repo, 'incoming.txt'), 'utf8')).toBe('new\n')
  expect(git(repo, 'show', ':Inferius.uproject')).toBe('project staged\n')
  expect(fs.readFileSync(path.join(repo, 'Inferius.uproject'), 'utf8')).toBe('project working\n')
  expect(fs.existsSync(path.join(repo, '.git/index.lock'))).toBe(false)
}

function pullHandler(log) {
  const handlers = new Map()
  const real = service()
  const gitService = new Proxy(real, { get: (target, key) => {
    const value = target[key]
    if (typeof value !== 'function') return value
    return (...args) => { log.push(`gitService.${String(key)}`); return value.apply(target, args) }
  } })
  component('electron/ipc/handlers.ts', {
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    './channels': require(path.join(DIST, 'ipc/channels')),
    '../util/repo-gate': require(path.join(DIST, 'util/repo-gate')),
    '../util/dugite-exec': { ...runner, execSafe: (args, ...rest) => { log.push(`git ${args[0]}`); return runner.execSafe(args, ...rest) } },
    '../services/LogService': { logService: { info() {}, warn() {}, error() {} } },
    '../services/GitService': { gitService },
    '../services/PRMonitorService': { prMonitorService: { checkMainMerges: async () => {}, checkNow: async () => {} } },
  }).exports.registerHandlers()
  const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
  return (repo) => handlers.get(CHANNELS.GIT_PULL)({ sender: { isDestroyed: () => false, send() {} } }, repo)
}

test('Pull fast-forwards and keeps staged and unstaged local changes', async () => {
  const { origin, repo } = behindWithLocalChanges()
  await service().pull(repo)
  expectPulledWithLocalChanges(origin, repo)
})

test('Pull with a local change recovers an orphaned index.lock (reported INFERIUS state)', async () => {
  const { origin, repo } = behindWithLocalChanges()
  orphanIndexLock(repo)
  await service().pull(repo)
  expectPulledWithLocalChanges(origin, repo)
})

test('Update from main with a local change recovers an orphaned index.lock', async () => {
  const { origin, repo } = behindWithLocalChanges()
  orphanIndexLock(repo)
  await service().updateFromMain(repo)
  expectPulledWithLocalChanges(origin, repo)
})

test('Pull IPC with a local change and an orphaned index.lock succeeds without a pre-pull snapshot', async () => {
  const { origin, repo } = behindWithLocalChanges()
  orphanIndexLock(repo)
  const log = []
  await pullHandler(log)(repo)
  expectPulledWithLocalChanges(origin, repo)
  // Nothing may touch the index ahead of Pull: no stash snapshot, no Undo.
  expect(log.filter(entry => entry === 'git stash')).toEqual([])
  expect(log.find(entry => entry.startsWith('gitService.'))).toBe('gitService.pull')
  expect(git(repo, 'stash', 'list')).toBe('')
})

test('Pull IPC failure message never mentions Undo', async () => {
  const { repo } = behindWithLocalChanges()
  // An unreachable remote makes Pull fail after the handler starts.
  const log = []
  git(repo, 'remote', 'set-url', 'origin', path.join(repo, 'missing-remote'))
  const error = await pullHandler(log)(repo).then(() => null, e => e)
  expect(error).not.toBeNull()
  expect(String(error)).not.toMatch(/undo/i)
  expect(fs.readFileSync(path.join(repo, 'Inferius.uproject'), 'utf8')).toBe('project working\n')
  expect(git(repo, 'show', ':Inferius.uproject')).toBe('project staged\n')
})

test('Undo IPC channels and checkpoint events are gone', () => {
  const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
  expect(CHANNELS.UNDO_GET).toBeUndefined()
  expect(CHANNELS.UNDO_LAST).toBeUndefined()
  expect(CHANNELS.EVT_UNDO_AVAILABLE).toBeUndefined()
  expect(fs.existsSync(path.join(DIST, 'services/UndoService.js'))).toBe(false)
})
