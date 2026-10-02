const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { tmpDir, git, cleanup, DIST } = require('./helpers')
const { component } = require('./renderer-harness')
const { presenceService } = require(path.join(DIST, 'services/PresenceService'))
const { gitService } = require(path.join(DIST, 'services/GitService'))
const runner = require(path.join(DIST, 'util/dugite-exec'))
const { readJson } = require(path.join(DIST, 'util/json-store'))

test.afterAll(cleanup)
const entry = { login: 'alice', name: 'Alice', branch: '', modifiedCount: 0, modifiedFiles: [], lastSeen: new Date().toISOString(), status: 'active' }
function presenceFile() {
  const repo = tmpDir('lg-presence-upgrade-')
  fs.mkdirSync(path.join(repo, '.lucid-git'))
  return { repo, file: path.join(repo, '.lucid-git/presence.json') }
}

test('legacy versionless presence migrates without losing entries or the original backup', () => {
  const { repo, file } = presenceFile()
  const original = JSON.stringify({ entries: { alice: entry } })
  fs.writeFileSync(file, original)
  expect(presenceService.read(repo)).toEqual({ version: 1, entries: { alice: entry } })
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
  presenceService.update(repo, 'bob', { ...entry, login: 'bob' })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(saved.version).toBe(1)
  expect(Object.keys(saved.entries)).toEqual(['alice', 'bob'])
  expect(fs.readFileSync(file + '.bak', 'utf8')).toBe(original)
})

for (const original of ['{broken', '{"version":2,"entries":{}}', '{"version":1,"entries":[]}']) {
  test(`unreadable local presence is preserved once and heartbeat resumes: ${original}`, () => {
    const { repo, file } = presenceFile()
    const backup = '{broken backup'
    fs.writeFileSync(file, original)
    fs.writeFileSync(file + '.bak', backup)
    presenceService.update(repo, 'alice', entry)
    const names = fs.readdirSync(path.dirname(file)).filter(name => name.includes('.invalid-'))
    expect(names).toHaveLength(2)
    expect(fs.readFileSync(path.join(path.dirname(file), names.find(name => name.startsWith('presence.json.invalid-'))), 'utf8')).toBe(original)
    expect(fs.readFileSync(path.join(path.dirname(file), names.find(name => name.startsWith('presence.json.bak.invalid-'))), 'utf8')).toBe(backup)
    expect(presenceService.read(repo).entries.alice).toEqual(entry)
    presenceService.update(repo, 'alice', { ...entry, status: 'away' })
    expect(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.invalid-'))).toEqual(names)
    expect(presenceService.read(repo).entries.alice.status).toBe('away')
  })
}

test('a valid presence backup is preferred over restarting and durable stores still reject corruption', () => {
  const { repo, file } = presenceFile()
  fs.writeFileSync(file, '{broken')
  fs.writeFileSync(file + '.bak', JSON.stringify({ entries: { alice: entry } }))
  presenceService.update(repo, 'bob', { ...entry, login: 'bob' })
  expect(Object.keys(presenceService.read(repo).entries)).toEqual(['alice', 'bob'])
  expect(fs.readdirSync(path.dirname(file)).some(name => name.includes('.invalid-'))).toBe(false)
  const durable = path.join(repo, 'durable.json')
  fs.writeFileSync(durable, '{broken')
  expect(() => readJson(durable, () => true, {})).toThrow('Data was preserved')
  expect(fs.readFileSync(durable, 'utf8')).toBe('{broken')
})

test('presence I/O failures propagate without archiving or resetting data', () => {
  const { repo, file } = presenceFile()
  fs.writeFileSync(file, '{}')
  const read = fs.readFileSync
  fs.readFileSync = (candidate, ...args) => {
    if (candidate === file) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    return read(candidate, ...args)
  }
  try { expect(() => presenceService.update(repo, 'alice', entry)).toThrow('access denied') }
  finally { fs.readFileSync = read }
  expect(fs.readFileSync(file, 'utf8')).toBe('{}')
  expect(fs.readdirSync(path.dirname(file))).toEqual(['presence.json'])
})

function repository() {
  const repo = tmpDir('lg-lock-upgrade-')
  git(repo, 'init', '-qb', 'main')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'base')
  git(repo, 'add', '.')
  git(repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'base')
  return repo
}

test('presence recovery archives and backups stay excluded from Git', () => {
  const repo = repository(), file = path.join(repo, '.lucid-git/presence.json')
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(file, '{broken')
  presenceService.update(repo, 'alice', entry)
  presenceService.update(repo, 'alice', { ...entry, status: 'away' })
  expect(fs.readdirSync(path.dirname(file)).some(name => name.includes('.invalid-'))).toBe(true)
  expect(fs.existsSync(file + '.bak')).toBe(true)
  expect(git(repo, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all')).toBe('')
})

test('Update from main fetches once and retries only the contended merge', async () => {
  const origin = repository(), repo = tmpDir('lg-update-clone-')
  git(repo, 'clone', '-q', origin, '.')
  fs.writeFileSync(path.join(origin, 'file.txt'), 'updated main')
  git(origin, 'add', '.')
  git(origin, '-c', 'core.hooksPath=', 'commit', '-qm', 'update main')
  const calls = []
  const service = component('electron/services/GitService.ts', {
    './AuthService': { authService: { getCurrentToken: async () => null } },
    '../util/dugite-exec': { ...runner, execWithProgress: async (args, ...rest) => {
      const merge = args.includes('merge')
      calls.push(merge ? 'merge' : 'fetch')
      const lock = path.join(repo, '.git/index.lock')
      if (merge && calls.filter(c => c === 'merge').length === 1) {
        fs.writeFileSync(lock, 'transient writer')
        try { return await runner.execWithProgress(args, ...rest) }
        catch (error) { setTimeout(() => fs.unlinkSync(lock), 150); throw error }
      }
      return runner.execWithProgress(args, ...rest)
    } },
  }, { Buffer }).exports.gitService
  await service.updateFromMain(repo)
  expect(calls).toEqual(['fetch', 'merge', 'merge'])
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'HEAD'))
  expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('updated main')
})

test('a transient index lock disappears before the one merge retry; HEAD and working content update', async () => {
  const repo = repository()
  git(repo, 'checkout', '-qb', 'incoming')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'incoming')
  git(repo, 'add', '.')
  git(repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'incoming')
  const target = git(repo, 'rev-parse', 'HEAD').trim()
  git(repo, 'checkout', '-q', 'main')
  const lock = path.join(repo, '.git/index.lock')
  fs.writeFileSync(lock, 'live external writer')
  let calls = 0
  const service = component('electron/services/GitService.ts', {
    '../util/dugite-exec': { ...runner, exec: async (...args) => {
      calls++
      try { return await runner.exec(...args) }
      catch (error) { setTimeout(() => fs.unlinkSync(lock), 150); throw error }
    } },
  }, { Buffer }).exports.gitService
  await service.runWithLfsRecovery(repo, ['merge', '--ff-only', 'incoming'])
  expect(calls).toBe(2)
  expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(target)
  expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('incoming')
})

test('persistent lock is preserved, waiting is bounded and stat permission failures are not absence', async () => {
  const repo = repository(), lock = path.join(repo, '.git/index.lock')
  fs.writeFileSync(lock, 'external writer')
  let probes = 0
  const service = component('electron/services/GitService.ts', {
    '../util/dugite-exec': { ...runner, execSafe: async (...args) => { probes++; return runner.execSafe(...args) } },
  }, { Buffer }).exports.gitService
  const start = Date.now()
  expect(await service.clearStaleIndexLock(repo)).toBe(false)
  expect(Date.now() - start).toBeGreaterThanOrEqual(1900)
  expect(Date.now() - start).toBeLessThan(6000)
  expect(probes).toBe(1)
  expect(fs.readFileSync(lock, 'utf8')).toBe('external writer')
  await expect(gitService.removeIndexLock(repo)).rejects.toThrow('Cannot prove')
  const stat = fs.promises.stat
  fs.promises.stat = async candidate => {
    if (path.resolve(candidate) === lock) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    return stat(candidate)
  }
  try { await expect(gitService.getIndexLockInfo(repo)).rejects.toThrow('access denied') }
  finally { fs.promises.stat = stat }
})

test('lock path resolves linked worktrees and a failed Git probe is not lock absence', async () => {
  const repo = repository(), worktree = tmpDir('lg-lock-worktree-')
  git(repo, '-c', 'core.hooksPath=', 'worktree', 'add', '-qb', 'other', worktree)
  const lock = git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock').trim()
  fs.writeFileSync(lock, 'worktree writer')
  expect((await gitService.getIndexLockInfo(worktree)).path).toBe(lock)
  await expect(gitService.getIndexLockInfo(tmpDir('lg-nonrepo-'))).rejects.toThrow()
  expect(fs.readFileSync(lock, 'utf8')).toBe('worktree writer')
})

test('index lock guidance gives guarded PowerShell recovery and makes no false ownership promise', () => {
  const raw = "error: Unable to create 'C:/repo/.git/index.lock': File exists."
  const error = component('src/lib/gitErrors.ts').exports.parseGitErrorOrGeneric(raw)
  expect(error.code).toBe('INDEX_LOCK')
  expect(error.canAutoFix).toBe(false)
  expect(error.description).toContain('no owner information')
  expect(error.description).not.toContain('clears locks')
  const commands = error.fixes.filter(f => f.command).map(f => f.command)
  expect(commands).toHaveLength(1)
  expect(commands[0]).toContain('--git-path index.lock')
  expect(commands[0]).toContain('$LASTEXITCODE -eq 0')
  expect(commands[0]).toContain('Remove-Item -LiteralPath')
  expect(commands[0]).not.toContain('git rm')
})

test('documented PowerShell recovery removes only the lock and preserves index, HEAD and working bytes', () => {
  test.skip(process.platform !== 'win32', 'PowerShell recovery is for Windows')
  const repo = repository(), lock = path.join(repo, '.git/index.lock')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'keep staged content')
  git(repo, 'add', '.')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'keep working content')
  const index = fs.readFileSync(path.join(repo, '.git/index')), head = git(repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(lock, 'confirmed stopped test writer')
  const error = component('src/lib/gitErrors.ts').exports.parseGitErrorOrGeneric("Unable to create '.git/index.lock': File exists")
  const command = error.fixes.find(f => f.command).command
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: repo, windowsHide: true })
  expect(fs.existsSync(lock)).toBe(false)
  expect(fs.readFileSync(path.join(repo, '.git/index'))).toEqual(index)
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(repo, 'show', ':file.txt').trim()).toBe('keep staged content')
  expect(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8')).toBe('keep working content')
})
