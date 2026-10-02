const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const runner = require(path.join(DIST, 'util/dugite-exec'))

function repo() {
  const dir = tmpDir('lg-easy-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'A\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'initial')
  return dir
}
test.afterAll(cleanup)

test('LG-016 staged and unstaged diffs use distinct baselines', async () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'file.txt'), 'B\n')
  git(dir, 'add', '.')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'C\n')
  expect(await gitService.diff(dir, 'file.txt', true)).toMatchObject({ oldContent: 'A\n', newContent: 'B\n' })
  expect(await gitService.diff(dir, 'file.txt', false)).toMatchObject({ oldContent: 'B\n', newContent: 'C\n' })
})

test('LG-020 local and remote branch selections retain their identities', async () => {
  const dir = repo()
  git(dir, 'branch', 'feature')
  git(dir, 'update-ref', 'refs/remotes/origin/feature', 'HEAD')
  git(dir, 'checkout', '-q', 'feature')
  fs.writeFileSync(path.join(dir, 'local.txt'), 'local')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'local feature')
  git(dir, 'checkout', '-q', 'main')
  const local = await gitService.branchDiff(dir, 'main', 'feature')
  const remote = await gitService.branchDiff(dir, 'main', 'origin/feature')
  expect(local.aheadCommits.map(c => c.message)).toContain('local feature')
  expect(remote.aheadCommits).toHaveLength(0)
  await gitService.merge(dir, 'feature')
  expect(fs.existsSync(path.join(dir, 'local.txt'))).toBe(true)
})

test('LG-023 undo restores both index and working tree and keeps failed snapshots', async () => {
  const dir = repo()
  const { undoService } = component('electron/services/UndoService.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    '../util/dugite-exec': runner,
    '../ipc/channels': { CHANNELS: {} },
  }).exports
  fs.writeFileSync(path.join(dir, 'file.txt'), 'B\n')
  git(dir, 'add', '.')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'C\n')
  await undoService.recordCheckpoint(dir, 'reset', 'Reset')
  git(dir, 'reset', '--hard', 'HEAD')
  expect((await undoService.undo(dir)).ok).toBe(true)
  expect(git(dir, 'show', ':file.txt')).toBe('B\n')
  expect(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8')).toBe('C\n')
  await undoService.recordCheckpoint(dir, 'reset', 'Reset')
  const real = runner.execSafe
  runner.execSafe = async (args, cwd) => args[0] === 'stash' && args[1] === 'apply'
    ? { exitCode: 1, stdout: '', stderr: 'index conflict' } : real(args, cwd)
  try {
    const result = await undoService.undo(dir)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('retained for recovery')
    expect(undoService.peek(dir)).not.toBeNull()
  } finally { runner.execSafe = real }
})

test('LG-024 stash all includes untracked files and restores them', async () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new')
  await gitService.stashSave(dir, 'all changes')
  expect(fs.existsSync(path.join(dir, 'new.txt'))).toBe(false)
  await gitService.stashPop(dir, 'stash@{0}')
  expect(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8')).toBe('new')
})

test('LG-021 failing merge hooks run once and retain their real error', async () => {
  const dir = repo()
  git(dir, 'checkout', '-qb', 'feature')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'feature\n')
  git(dir, 'commit', '-qam', 'feature')
  git(dir, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'main\n')
  git(dir, 'commit', '-qam', 'main')
  try { git(dir, 'merge', 'feature') } catch { /* expected conflict */ }
  fs.writeFileSync(path.join(dir, 'file.txt'), 'resolved\n')
  git(dir, 'add', '.')
  const count = path.join(dir, 'hook-count')
  fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho run >> hook-count\necho policy-rejected >&2\nexit 1\n', { mode: 0o755 })
  await expect(gitService.continueMerge(dir, 'feature')).rejects.toThrow('policy-rejected')
  expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(1)
})

test('LG-070 expected HEAD blocks undoing an older or stale commit', async () => {
  const dir = repo(), initial = git(dir, 'rev-parse', 'HEAD').trim()
  fs.writeFileSync(path.join(dir, 'file.txt'), 'second\n')
  git(dir, 'commit', '-qam', 'second')
  const head = git(dir, 'rev-parse', 'HEAD').trim()
  await expect(gitService.resetTo(dir, initial, 'soft', initial)).rejects.toThrow('current HEAD')
  expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(head)
  await gitService.resetTo(dir, initial, 'soft', head)
  expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(initial)
})

test('LG-054 every advertised LFS format takes the binary diff path', async () => {
  const { BINARY_EXTENSIONS } = require(path.join(DIST, 'util/binary-formats'))
  const template = fs.readFileSync(path.join(__dirname, '../electron/services/UnrealService.ts'), 'utf8')
  const extensions = [...template.matchAll(/^\*\.([a-z0-9]+)\s+filter=lfs/gm)].map(m => m[1])
  for (const ext of extensions) {
    expect(BINARY_EXTENSIONS.has(ext), ext).toBe(true)
    expect((await gitService.diff('unused', `asset.${ext}`, false)).isBinary).toBe(true)
  }
})

test('LG-044 forecasts publish an empty result after an overlap clears', async () => {
  const events = [], notifications = []
  let dirty = true
  const forecast = component('electron/services/ForecastService.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: (...args) => events.push(args) } }] } },
    '../ipc/channels': { CHANNELS: { EVT_FORECAST_CONFLICT: 'forecast' } },
    './DesktopNotificationService': { desktopNotificationService: { notify: opts => notifications.push(opts) } },
    '../util/dugite-exec': { execSafe: async args => ({ exitCode: 0, stdout: {
      status: dirty ? ' M asset.uasset\0' : '', 'rev-parse': 'main\n',
      'for-each-ref': 'origin/feature\n', diff: 'asset.uasset\n', log: 'abc\0Test\0change',
    }[args[0]] ?? '' }) },
  }).exports.forecastService
  await forecast.poll('repo')
  dirty = false
  await forecast.poll('repo')
  expect(events.map(e => e[1].length)).toEqual([1, 0])
  expect(notifications).toHaveLength(1)
})
