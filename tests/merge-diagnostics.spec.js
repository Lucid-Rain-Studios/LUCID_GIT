const { test, expect } = require('@playwright/test')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const { logService } = require(path.join(DIST, 'services/LogService'))
const safety = require(path.join(DIST, 'util/merge-safety'))
const flush = () => new Promise(resolve => setImmediate(resolve))
test.afterAll(cleanup)

function repo() {
  const dir = tmpDir('lg-merge-diag-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'base\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
  git(dir, 'branch', 'feature')
  fs.writeFileSync(path.join(dir, 'incoming.txt'), 'incoming\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'main work')
  git(dir, 'checkout', '-q', 'feature')
  fs.writeFileSync(path.join(dir, 'branch.txt'), 'branch\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'branch work')
  return dir
}

function capture() {
  const lines = [], originals = { info: logService.info, warn: logService.warn, error: logService.error }
  for (const level of ['info', 'warn', 'error']) logService[level] = (source, message) => lines.push({ level, source, message })
  return { lines, restore: () => Object.assign(logService, originals) }
}

const journalOf = dir => JSON.parse(fs.readFileSync(path.join(git(dir, 'rev-parse', '--absolute-git-dir').trim(), 'lucid-merge-safety.json'), 'utf8'))

async function blockedRepo() {
  const dir = repo()
  await expect(safety.guardedMergeOperation(dir, 'update-from-main', async () => {
    git(dir, 'merge', '--no-commit', '--no-ff', 'main')
    git(dir, 'read-tree', 'HEAD')
    throw new Error('git merge failed (exit 1): error: Unable to write index.')
  })).rejects.toThrow('Merge completion blocked:')
  return dir
}

function registry() {
  const children = [], complete = []
  const api = component('electron/util/dugite-exec.ts', {
    dugite: { GitProcess: { exec: (args, repoPath, opts) => new Promise(resolve => {
      const child = Object.assign(new EventEmitter(), { pid: 700000 + children.length, exitCode: null, signalCode: null })
      children.push(child); opts.processCallback(child)
      complete.push((code = 0) => { child.exitCode = code; child.emit('exit', code, null); resolve({ stdout: '', stderr: '', exitCode: code }) })
    }) } },
    './git-command': component('electron/util/git-command.ts').exports,
    'node:child_process': { execFile: (_file, _args, _options, done) => done(null) },
    '../services/LogService': { logService: { warn() {}, info() {}, error() {} } },
  }, { process: { ...process, platform: 'win32' }, Buffer }).exports
  return { api, children, complete }
}

test('a leftover blocked merge is logged once per journal with its original failure', async () => {
  const dir = await blockedRepo(), log = capture()
  try {
    const record = journalOf(dir)
    expect(record.failedAt).toBeTruthy()
    await gitService.mergeInProgress(dir)
    await flush(); await new Promise(resolve => setTimeout(resolve, 200))
    const found = log.lines.filter(l => l.message.startsWith('Found a leftover blocked merge'))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ level: 'warn', source: 'git.merge-safety' })
    const detail = JSON.parse(found[0].message.slice(found[0].message.indexOf('{')))
    expect(detail).toMatchObject({ repo: dir, journalId: record.id, operation: 'update-from-main', startedAt: record.startedAt, failedAt: record.failedAt, interrupted: false })
    expect(detail.failure).toContain('Unable to write index')
    expect(detail.startedAgoMs).toBeGreaterThanOrEqual(0)
    // The UI polls; repeated polls must not repeat the report.
    await gitService.mergeInProgress(dir); await gitService.mergeInProgress(dir)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(log.lines.filter(l => l.message.startsWith('Found a leftover blocked merge'))).toHaveLength(1)
  } finally { log.restore() }
})

test('starting another operation over a leftover blocked merge is logged every time', async () => {
  const dir = await blockedRepo(), log = capture()
  try {
    for (let i = 0; i < 2; i++) {
      await expect(safety.guardedMergeOperation(dir, 'update-from-main', async () => { throw new Error('must not run') })).rejects.toThrow('Merge completion blocked:')
    }
    const refused = log.lines.filter(l => l.message.startsWith('Refused to start update-from-main a leftover blocked merge'))
    expect(refused).toHaveLength(2)
    expect(refused[0].message).toContain('Unable to write index')
  } finally { log.restore() }
})

test('an interrupted merge without a recorded failure is reported as interrupted', async () => {
  const dir = repo(), log = capture()
  try {
    git(dir, 'merge', '--no-commit', '--no-ff', 'main')
    const head = git(dir, 'rev-parse', 'HEAD').trim()
    fs.writeFileSync(path.join(git(dir, 'rev-parse', '--absolute-git-dir').trim(), 'lucid-merge-safety.json'),
      JSON.stringify({ id: 'crashed', operation: 'pull', startedAt: new Date(Date.now() - 5000).toISOString(), head }))
    await safety.logLeftoverBlockedMerge(dir, 'detected')
    const found = log.lines.find(l => l.message.startsWith('Found a leftover blocked merge'))
    expect(JSON.parse(found.message.slice(found.message.indexOf('{')))).toMatchObject({ journalId: 'crashed', operation: 'pull', interrupted: true, failure: null })
    // An ordinary conflict with no journal is not a leftover failure.
    const plain = repo()
    expect(await safety.logLeftoverBlockedMerge(plain, 'detected')).toBeUndefined()
  } finally { log.restore() }
})

test('the Merge failed log names our own recent and running git commands', async () => {
  const dir = repo(), log = capture()
  try {
    await expect(safety.guardedMergeOperation(dir, 'update-from-main', async () => {
      git(dir, 'merge', '--no-commit', '--no-ff', 'main')
      // Real commands run through the app's runner, as a background refresh would.
      await require(path.join(DIST, 'util/dugite-exec')).execSafe(['status', '--porcelain'], dir)
      throw new Error('git merge failed (exit 1): error: Unable to write index.')
    })).rejects.toThrow('Merge completion blocked:')
    const failed = log.lines.find(l => l.level === 'error' && l.message.startsWith('Merge failed:'))
    const detail = JSON.parse(failed.message.slice(failed.message.indexOf('{')))
    expect(detail.activity.recent.some(c => c.command === 'git status' && c.readOnly === true && c.exitCode === 0)).toBe(true)
    expect(detail.activity).toHaveProperty('running')
    // Arguments never reach the log, so a token in a command line cannot leak.
    expect(failed.message).not.toContain('--porcelain')
  } finally { log.restore() }
})

test('git activity history records exit codes and why a command was cancelled', async () => {
  const f = registry()
  const done = f.api.execSafe(['status'], 'C:/repo'), killed = f.api.execSafe(['status', '--porcelain'], 'C:/repo'), timedOut = f.api.execSafe(['merge', 'x'], 'C:/repo')
  expect(f.api.gitActivitySnapshot('C:/repo').running.map(c => c.command)).toEqual(['git status', 'git status', 'git merge'])
  f.complete[0](0); await done
  f.api.preemptRepoReads('C:/repo')
  f.children[1].exitCode = 1; f.children[1].emit('exit', null, 'SIGKILL'); f.complete[1](1); await killed
  f.api.killGitProcesses([f.children[2].pid], 'deadline exceeded: git:merge')
  f.complete[2](1); await timedOut
  const { running, recent } = f.api.gitActivitySnapshot('C:/repo')
  expect(running).toEqual([])
  const byCommand = recent.map(c => `${c.command}:${c.exitCode}:${c.cancelled ?? ''}`)
  expect(byCommand[0]).toBe('git status:0:')
  expect(recent.filter(c => c.cancelled?.startsWith('preempted so a waiting write')).length).toBeGreaterThan(0)
  expect(recent.some(c => c.cancelled === 'deadline exceeded: git:merge')).toBe(true)
  expect(f.api.gitActivitySnapshot('C:/elsewhere')).toEqual({ running: [], recent: [] })
})

test('Clear keeps a recoverable backup, prunes old ones and refuses to clear when the backup fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-log-backup-'))
  logService.init(dir, 'test')
  logService.error('git.merge-safety', 'Merge failed: precious evidence')
  const backup = await logService.clear()
  expect(backup).toMatch(/lucid-git-logs\.cleared-.*\.json$/)
  expect(path.dirname(backup)).toBe(dir)
  expect(JSON.stringify(JSON.parse(fs.readFileSync(backup, 'utf8')))).toContain('precious evidence')
  expect(logService.getFormattedText()).not.toContain('precious evidence')
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'lucid-git-logs.json'), 'utf8')).sessions[0].entries).toEqual([])

  // Only the newest few backups survive.
  for (let i = 0; i < 4; i++) { logService.info('test', `batch ${i}`); await new Promise(resolve => setTimeout(resolve, 15)); await logService.clear() }
  const backups = fs.readdirSync(dir).filter(name => name.includes('.cleared-'))
  expect(backups).toHaveLength(3)

  // A failed backup must not destroy the logs.
  logService.error('test', 'must survive')
  const write = fs.promises.writeFile, writeHandle = fs.promises.open
  fs.promises.open = async (file, ...rest) => { if (String(file).includes('.cleared-')) throw new Error('disk full'); return writeHandle(file, ...rest) }
  try {
    await expect(logService.clear()).rejects.toThrow('Logs were not cleared because the backup could not be saved')
  } finally { fs.promises.open = writeHandle; fs.promises.writeFile = write }
  expect(logService.getFormattedText()).toContain('must survive')
  logService.endSession()
})

test('Clear with nothing logged writes no backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-log-empty-'))
  logService.init(dir, 'test')
  await logService.clear()           // removes the session-start line
  expect(await logService.clear()).toBeNull()
  expect(fs.readdirSync(dir).filter(name => name.includes('.cleared-'))).toHaveLength(1)
  logService.endSession()
})
