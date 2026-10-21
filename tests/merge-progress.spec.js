const { test, expect } = require('@playwright/test')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { tmpDir, git, cleanup, DIST } = require('./helpers')
const { component } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const { execWithProgress } = require(path.join(DIST, 'util/dugite-exec'))

test.afterAll(cleanup)

test('update from main streams actual file counts during a slow divergent merge', async () => {
  test.setTimeout(120000)
  const repo = tmpDir('lg-merge-progress-')
  const filterDir = tmpDir('lg-slow-filter-')
  const filter = path.join(filterDir, 'filter.cjs')
  fs.writeFileSync(filter, "const fs = require('fs'); const data = fs.readFileSync(0); setTimeout(() => process.stdout.write(data), 70)")
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.dat filter=slow\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  git(repo, 'branch', 'feature')
  for (let i = 0; i < 55; i++) fs.writeFileSync(path.join(repo, `${i}.dat`), `incoming ${i}\n`)
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'incoming files')
  git(repo, 'checkout', '-q', 'feature')
  fs.writeFileSync(path.join(repo, 'local.txt'), 'local change\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'local change')
  git(repo, 'config', 'filter.slow.smudge', `"${process.execPath.replace(/\\/g, '/')}" "${filter.replace(/\\/g, '/')}"`)
  git(repo, 'remote', 'add', 'origin', repo)
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  const originalHead = git(repo, 'rev-parse', 'HEAD').trim()
  const baseline = []
  await execWithProgress(['-c', 'merge.verbosity=2', 'merge', '--no-edit', '--progress', 'main'], repo, step => baseline.push(step))
  expect(baseline.filter(s => s.id === 'update-files')).toHaveLength(0)
  git(repo, 'reset', '--hard', originalHead)
  const steps = []
  let finished = false
  await gitService.updateFromMain(repo, step => {
    steps.push({ ...step, beforeFinish: !finished })
  })
  finished = true
  const updates = steps.filter(s => s.id === 'update-files')
  expect(updates.some(s => s.current > 0 && s.current < s.total && s.beforeFinish)).toBe(true)
  expect(new Set(updates.map(s => s.current)).size).toBeGreaterThan(2)
  expect(updates.at(-1).current).toBe(55)
  expect(steps.find(s => s.id === 'stage' && s.label.startsWith('Merging')).total).toBeUndefined()
  expect(git(repo, 'status', '--porcelain')).toBe('')
  expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
  expect(fs.readFileSync(path.join(repo, '54.dat'), 'utf8')).toBe('incoming 54\n')
  expect(fs.readFileSync(path.join(repo, 'local.txt'), 'utf8')).toBe('local change\n')
  expect(git(repo, 'config', '--local', '--get-regexp', '^filter\\.slow\\.')).toContain('smudge')
  expect(git(repo, 'config', '--local', '--list')).not.toContain('merge.verbosity=')
})

test('split progress records retain counts and throttled updates arrive while Git is quiet', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 900001 })
  const steps = []
  const api = component('electron/util/dugite-exec.ts', {
    dugite: { GitProcess: { spawn: () => child } },
    './git-command': component('electron/util/git-command.ts').exports,
    '../services/LogService': { logService: { error() {} } },
  }, { process, Buffer }).exports
  const run = api.execWithProgress(['merge', '--progress', 'main'], 'repo', step => steps.push(step))
  child.stderr.emit('data', Buffer.from('Updating files: 0% (0/1400)\rUpdating fi'))
  child.stderr.emit('data', Buffer.from('les: 12% ('))
  child.stderr.emit('data', Buffer.from('168/1400)\r'))
  await expect.poll(() => steps.at(-1)?.current).toBe(168)
  expect(steps.at(-1).total).toBe(1400)
  child.stdout.emit('data', Buffer.from('Downloading LFS objects: 10% (1/'))
  child.stderr.emit('data', Buffer.from('Updating files: 20% (280/1400)\r'))
  child.stdout.emit('data', Buffer.from('10)\r'))
  expect(steps.at(-1).id).toBe('lfs-down')
  expect(steps.at(-1).total).toBe(10)
  child.stderr.emit('data', Buffer.from('Updating files: 100% (1400/1400), done.'))
  child.emit('close', 0)
  await run
  expect(steps.at(-1)).toMatchObject({ current: 1400, total: 1400, status: 'done' })
  const count = steps.length
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(steps).toHaveLength(count)
})
