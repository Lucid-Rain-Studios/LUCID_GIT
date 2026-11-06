const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto')
const { git, tmpDir, cleanup, DIST } = require('./helpers')
const { component } = require('./renderer-harness')
const runner = require(path.join(DIST, 'util/dugite-exec'))
const permissionModule = require(path.join(DIST, 'util/unlock-permissions'))
const { lockService } = require(path.join(DIST, 'services/LockService'))
const { gitService } = require(path.join(DIST, 'services/GitService'))
test.afterAll(cleanup)

const writable = (repo, file) => (fs.statSync(path.join(repo, file)).mode & 0o200) !== 0
const bytes = (repo, file) => fs.readFileSync(path.join(repo, file))
const setBytes = (repo, file, content) => {
  const full = path.join(repo, file)
  if (fs.existsSync(full)) fs.chmodSync(full, 0o644)
  fs.writeFileSync(full, content)
}

async function fixture() {
  const repo = tmpDir('discard-permissions-')
  git(repo, 'init', '-qb', 'main'); git(repo, 'config', 'user.name', 'me'); git(repo, 'config', 'user.email', 'me@test.local')
  git(repo, 'config', 'core.autocrlf', 'false'); git(repo, 'lfs', 'install', '--local')
  fs.mkdirSync(path.join(repo, 'nested'))
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.uasset filter=lfs diff=lfs merge=lfs -text lockable\n')
  fs.writeFileSync(path.join(repo, 'nested/.gitattributes'), 'except.uasset -lockable\n')
  const files = ['owned.uasset', 'unlocked.uasset', 'foreign.uasset', 'deleted.uasset', 'space ü [1].uasset', 'space ü 1.uasset', 'nested/except.uasset', 'untouched.uasset']
  const original = new Map(files.map(file => [file, Buffer.from(('committed ' + file + '\n').repeat(50))]))
  for (const [file, content] of original) setBytes(repo, file, content)
  git(repo, 'add', '.'); git(repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'assets')
  const ours = [{ id: 'ours', path: 'owned.uasset', owner: { name: 'me' }, locked_at: new Date().toISOString() }]
  const theirs = [{ id: 'theirs', path: 'foreign.uasset', owner: { name: 'someone else' }, locked_at: new Date().toISOString() }]
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' })
    res.end(JSON.stringify(req.url.endsWith('/locks/verify') ? { ours, theirs } : { locks: [...ours, ...theirs] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const remote = `http://127.0.0.1:${server.address().port}/repo.git`
  git(repo, 'remote', 'add', 'origin', remote)
  try { await runner.exec(['lfs', 'locks', '--verify', '--json'], repo) }
  finally { await new Promise(resolve => server.close(resolve)) }
  // All tests run with the server closed: restoration and permissions must
  // use existing local objects/ownership, never a new server round-trip.
  return { repo, files, original }
}

async function traceRun(repo, action) {
  const trace = path.join(repo, '.git', `trace-${crypto.randomUUID()}.jsonl`)
  const previous = process.env.GIT_TRACE2_EVENT
  process.env.GIT_TRACE2_EVENT = trace
  try { await action() }
  finally {
    if (previous === undefined) delete process.env.GIT_TRACE2_EVENT
    else process.env.GIT_TRACE2_EVENT = previous
  }
  return fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
}

function isolatedService(exec = runner.exec, permissions = permissionModule) {
  const progress = []
  const service = component('electron/services/GitService.ts', {
    './AuthService': { authService: { getCurrentToken: async () => null } },
    './LogService': { logService: { warn() {}, info() {}, error() {} } },
    './LockService': { lockService }, '../util/unlock-permissions': permissions,
    '../util/dugite-exec': { ...runner, exec },
  }, { Buffer }).exports.gitService
  return { service, progress, discard: (repo, paths) => service.discard(repo, paths, false, step => progress.push(step)) }
}

test('selected restore preserves ownership and resolved attributes offline, preserves other staging, and avoids full-tree enumeration', async () => {
  const f = await fixture(), selected = f.files.filter(file => !['untouched.uasset', 'space ü 1.uasset'].includes(file))
  const nativePermissions = new Map()
  for (const file of selected) setBytes(f.repo, file, 'first dirty')
  await runner.exec(['restore', '--staged', '--', ...selected], f.repo)
  await runner.exec(['--literal-pathspecs', 'restore', '--', ...selected], f.repo)
  for (const file of selected) nativePermissions.set(file, writable(f.repo, file))
  expect(nativePermissions.get('owned.uasset')).toBe(true)
  // LFS's native hook treats all local cache entries as owned, even when
  // verify populated it with `theirs`. The scoped repair also consults the
  // cached ownership split and intentionally corrects this unsafe case.
  expect(nativePermissions.get('unlocked.uasset')).toBe(false)
  expect(git(f.repo, 'check-attr', 'lockable', '--', 'nested/except.uasset').trim()).toMatch(/: unset$/)
  for (const file of selected) setBytes(f.repo, file, 'second dirty')
  setBytes(f.repo, 'untouched.uasset', 'staged other'); git(f.repo, 'add', 'untouched.uasset')
  setBytes(f.repo, 'untouched.uasset', 'working other')
  setBytes(f.repo, 'space ü 1.uasset', 'literal sibling keep')
  fs.writeFileSync(path.join(f.repo, 'untracked.txt'), 'keep')
  fs.unlinkSync(path.join(f.repo, 'deleted.uasset'))
  git(f.repo, 'add', 'owned.uasset', 'deleted.uasset')
  const head = git(f.repo, 'rev-parse', 'HEAD'), stagedOther = git(f.repo, 'show', ':untouched.uasset')
  const trace = await traceRun(f.repo, () => gitService.discard(f.repo, selected, false))
  for (const file of selected) {
    expect(bytes(f.repo, file).equals(f.original.get(file))).toBe(true)
    // Native LFS's expanded pattern list also loses the nested -lockable
    // override. check-attr is Git's authoritative per-path resolution.
    const expected = file === 'foreign.uasset' ? false : file === 'nested/except.uasset' ? true : nativePermissions.get(file)
    expect({ file, writable: writable(f.repo, file) }).toEqual({ file, writable: expected })
  }
  expect(bytes(f.repo, 'untouched.uasset').toString()).toBe('working other')
  expect(writable(f.repo, 'untouched.uasset')).toBe(true)
  expect(bytes(f.repo, 'space ü 1.uasset').toString()).toBe('literal sibling keep')
  expect(git(f.repo, 'show', ':untouched.uasset')).toBe(stagedOther)
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(bytes(f.repo, 'untracked.txt').toString()).toBe('keep')
  const commands = trace.filter(event => event.event === 'start').map(event => event.argv)
  expect(commands.filter(args => args.includes('ls-files') && !args.includes('--'))).toEqual([])
  expect(commands.filter(args => args.includes('check-attr'))).toHaveLength(1)
  expect(commands.filter(args => args.includes('locks') && args.includes('--local'))).toHaveLength(1)
})

test('changed attributes and directory selections retain the native hook fallback', async () => {
  const f = await fixture()
  setBytes(f.repo, '.gitattributes', '*.uasset -lockable\n')
  git(f.repo, 'add', '.gitattributes')
  setBytes(f.repo, 'unlocked.uasset', 'dirty')
  const calls = [], s = isolatedService(async (args, ...rest) => { calls.push(args); return runner.exec(args, ...rest) })
  await s.discard(f.repo, ['.gitattributes', 'unlocked.uasset'])
  expect(calls.find(args => args.includes('restore') && !args.includes('--staged'))).not.toContain('lfs.setlockablereadonly=false')
  expect(writable(f.repo, 'unlocked.uasset')).toBe(false)
  calls.length = 0
  setBytes(f.repo, 'nested/except.uasset', 'dirty')
  await s.discard(f.repo, ['nested'])
  expect(calls.find(args => args.includes('restore') && !args.includes('--staged'))).not.toContain('lfs.setlockablereadonly=false')
  expect(bytes(f.repo, 'nested/except.uasset').equals(f.original.get('nested/except.uasset'))).toBe(true)
})

test('read-only opt-outs stay writable and do not read the local lock cache', async () => {
  const f = await fixture()
  for (const env of [false, true]) {
    if (!env) git(f.repo, 'config', 'lfs.setlockablereadonly', 'false')
    else git(f.repo, 'config', '--unset', 'lfs.setlockablereadonly')
    const old = process.env.GIT_LFS_SET_LOCKABLE_READONLY
    if (env) process.env.GIT_LFS_SET_LOCKABLE_READONLY = '0'
    try {
      setBytes(f.repo, 'unlocked.uasset', 'dirty')
      const trace = await traceRun(f.repo, () => gitService.discard(f.repo, ['unlocked.uasset'], false))
      expect(writable(f.repo, 'unlocked.uasset')).toBe(true)
      expect(trace.some(event => event.event === 'start' && event.argv.includes('locks') && event.argv.includes('--local'))).toBe(false)
    } finally {
      if (old === undefined) delete process.env.GIT_LFS_SET_LOCKABLE_READONLY
      else process.env.GIT_LFS_SET_LOCKABLE_READONLY = old
    }
  }
})

test('custom hooks still run and selected attribute policy is read after they finish', async () => {
  const f = await fixture()
  fs.writeFileSync(path.join(f.repo, '.git/hooks/post-checkout'), '#!/bin/sh\necho invoked >> hook-ran.txt\nprintf "unlocked.uasset -lockable\\n" > .git/info/attributes\n')
  setBytes(f.repo, 'unlocked.uasset', 'dirty')
  await gitService.discard(f.repo, ['unlocked.uasset'], false)
  expect(bytes(f.repo, 'hook-ran.txt').toString().trim().split(/\r?\n/)).toHaveLength(2)
  expect(writable(f.repo, 'unlocked.uasset')).toBe(true)
  expect(bytes(f.repo, 'unlocked.uasset').equals(f.original.get('unlocked.uasset'))).toBe(true)
})

test('partially failed restore reconciles written files but never emits success or retries an unrelated failure', async () => {
  const f = await fixture(), s = isolatedService(async (args, ...rest) => {
    const result = await runner.exec(args, ...rest)
    if (args.includes('restore') && !args.includes('--staged')) throw Error('injected failure after writing')
    return result
  })
  setBytes(f.repo, 'unlocked.uasset', 'dirty')
  await expect(s.discard(f.repo, ['unlocked.uasset'])).rejects.toThrow('failure after writing')
  expect(writable(f.repo, 'unlocked.uasset')).toBe(false)
  expect(s.progress.some(step => step.status === 'done')).toBe(false)
  expect(bytes(f.repo, 'unlocked.uasset').equals(f.original.get('unlocked.uasset'))).toBe(true)
})

test('permission failure rejects completion and the cache queue is released for recovery', async () => {
  const f = await fixture(), s = isolatedService(runner.exec, {
    prepareUnlockPermissions: async () => ({ hasLockableFiles: false, apply: async () => { throw Error('chmod denied') } }),
  })
  setBytes(f.repo, 'unlocked.uasset', 'dirty')
  await expect(s.discard(f.repo, ['unlocked.uasset'])).rejects.toThrow('chmod denied')
  expect(s.progress.some(step => step.status === 'done')).toBe(false)
  await gitService.discard(f.repo, ['unlocked.uasset'], false)
  expect(writable(f.repo, 'unlocked.uasset')).toBe(false)
})

test('a stale lock in the working pass recovers once without repeating unstage or skipping permission repair', async () => {
  const f = await fixture(), calls = []
  let injected = false
  const s = isolatedService(async (args, ...rest) => {
    if (args.includes('restore')) calls.push(args)
    if (args.includes('restore') && !args.includes('--staged') && !injected) {
      injected = true
      const lock = path.join(f.repo, '.git/index.lock')
      fs.writeFileSync(lock, 'orphan'); fs.utimesSync(lock, new Date(0), new Date(0))
    }
    return runner.exec(args, ...rest)
  })
  setBytes(f.repo, 'unlocked.uasset', 'dirty')
  await s.discard(f.repo, ['unlocked.uasset'])
  expect(calls).toHaveLength(3)
  expect(calls.filter(args => args.includes('--staged'))).toHaveLength(1)
  expect(writable(f.repo, 'unlocked.uasset')).toBe(false)
  expect(s.progress.at(-1).status).toBe('done')
})

test('corrupt local ownership fails visibly without deleting the cache or publishing completion', async () => {
  const f = await fixture(), s = isolatedService()
  const cache = path.join(f.repo, '.git/lfs/lockcache.db'), original = fs.readFileSync(cache)
  fs.writeFileSync(cache, 'deliberately invalid LFS cache')
  setBytes(f.repo, 'unlocked.uasset', 'dirty')
  await expect(s.discard(f.repo, ['unlocked.uasset'])).rejects.toThrow('Could not reconcile')
  expect(s.progress.some(step => step.status === 'done')).toBe(false)
  expect(fs.readFileSync(cache, 'utf8')).toBe('deliberately invalid LFS cache')
  fs.writeFileSync(cache, original)
  await gitService.discard(f.repo, ['unlocked.uasset'], false)
  expect(writable(f.repo, 'unlocked.uasset')).toBe(false)
})

test('missing LFS content still fails the restore instead of reporting a pointer as success', async () => {
  const f = await fixture(), s = isolatedService()
  const pointer = git(f.repo, 'show', 'HEAD:unlocked.uasset'), oid = /oid sha256:(\w+)/.exec(pointer)[1]
  const object = path.join(f.repo, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid)
  fs.unlinkSync(object)
  git(f.repo, 'config', 'lfs.transfer.maxretries', '0')
  git(f.repo, 'config', 'lfs.dialtimeout', '2')
  setBytes(f.repo, 'unlocked.uasset', 'dirty')
  await expect(s.discard(f.repo, ['unlocked.uasset'])).rejects.toThrow(/smudge|filter|download/i)
  expect(s.progress.some(step => step.status === 'done')).toBe(false)
})

test('a missing local LFS object is downloaded normally before scoped permission repair', async () => {
  const f = await fixture(), file = 'unlocked.uasset', content = f.original.get(file)
  const oid = /oid sha256:(\w+)/.exec(git(f.repo, 'show', 'HEAD:' + file))[1]
  fs.unlinkSync(path.join(f.repo, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid))
  const requests = []
  let base
  const server = http.createServer((req, res) => {
    requests.push(req.method + ' ' + req.url)
    if (req.url.endsWith('/objects/batch')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' })
      res.end(JSON.stringify({ transfer: 'basic', objects: [{ oid, size: content.length, actions: { download: { href: base + '/object' } } }] }))
    } else if (req.url === '/object') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': content.length }); res.end(content)
    } else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  git(f.repo, 'config', 'lfs.url', base + '/lfs')
  try {
    setBytes(f.repo, file, 'dirty')
    await gitService.discard(f.repo, [file], false)
    expect(bytes(f.repo, file).equals(content)).toBe(true)
    expect(writable(f.repo, file)).toBe(false)
    expect(requests).toEqual(['POST /lfs/objects/batch', 'GET /object'])
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('large selections keep path batching, with one attribute query and ownership snapshot for all chunks', async () => {
  const f = await fixture(), selected = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}-${'long-name-'.repeat(9)}.uasset`)
  const original = Buffer.from('a small real LFS asset\n')
  for (const file of selected) setBytes(f.repo, file, original)
  git(f.repo, 'add', ...selected); git(f.repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'many assets')
  for (const file of selected) setBytes(f.repo, file, 'dirty')
  const trace = await traceRun(f.repo, () => gitService.discard(f.repo, selected, false))
  const commands = trace.filter(event => event.event === 'start').map(event => event.argv)
  expect(commands.filter(args => args.includes('restore') && args.includes('--staged')).length).toBeGreaterThan(1)
  expect(commands.filter(args => args.includes('check-attr'))).toHaveLength(1)
  expect(commands.filter(args => args.includes('locks') && args.includes('--local'))).toHaveLength(1)
  for (const file of selected) {
    expect(bytes(f.repo, file).equals(original)).toBe(true)
    expect(writable(f.repo, file)).toBe(false)
  }
})

test('symlink and submodule index entries, config files and missing paths cannot use scoped permission repair', async () => {
  const f = await fixture()
  const oid = (await runner.execWithStdin(['hash-object', '-w', '--stdin'], f.repo, 'owned.uasset')).stdout.trim()
  git(f.repo, 'update-index', '--add', '--cacheinfo', `120000,${oid},link.uasset`)
  git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${git(f.repo, 'rev-parse', 'HEAD').trim()},module`)
  for (const paths of [['link.uasset'], ['module'], ['.lfsconfig'], ['absent.uasset']]) {
    expect(await gitService.canScopeDiscardPermissions(f.repo, paths)).toBe(false)
  }
})

test('cached ownership excludes foreign IDs, keeps newly acquired IDs, and serializes cache readers', async () => {
  let release, started = false, reads = 0
  const svc = component('electron/services/LockService.ts', {
    '../util/dugite-exec': { exec: async args => {
      reads++
      return { stdout: JSON.stringify(args.includes('--local') ? [
        { id: 'foreign', path: 'foreign.uasset' }, { id: 'new-own', path: 'relocked.uasset' },
      ] : { ours: [], theirs: [{ id: 'foreign', path: 'foreign.uasset' }, { id: 'old-foreign', path: 'relocked.uasset' }] }) }
    } },
  }).exports.lockService
  const first = svc.withCachedLockPaths('repo', async read => {
    await new Promise(resolve => { release = resolve })
    return read()
  })
  await new Promise(resolve => setImmediate(resolve))
  const second = svc.withCachedLockPaths('repo', async read => { started = true; return read() })
  await new Promise(resolve => setImmediate(resolve))
  expect(started).toBe(false); expect(reads).toBe(0)
  release()
  expect([...await first]).toEqual(['relocked.uasset'])
  expect([...await second]).toEqual(['relocked.uasset'])
  expect(reads).toBe(4)
})
