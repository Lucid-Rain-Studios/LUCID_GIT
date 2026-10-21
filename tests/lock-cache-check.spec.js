const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { tmpDir, git, cleanup, DIST } = require('./helpers')
const { component, find } = require('./renderer-harness')
const runner = require(path.join(DIST, 'util/dugite-exec'))

test.afterAll(cleanup)

function service(overrides = {}) {
  return component('electron/services/GitService.ts', {
    os: require('node:os'),
    './AuthService': { authService: { getCurrentToken: async () => null } },
    '../util/dugite-exec': { ...runner, ...overrides },
  }, { Buffer }).exports.gitService
}

async function fixture(count = 1) {
  const repo = tmpDir('lg-lock-check-')
  git(repo, 'init', '-qb', 'main')
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'untouched')
  git(repo, 'add', '.'); git(repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'base')
  const lock = { id: '1', path: 'keep.txt', owner: { name: 'Test' }, locked_at: '2026-10-21T00:00:00Z' }
  const locks = Array.from({ length: count }, (_, i) => ({ ...lock, id: String(i + 1), path: i === 0 ? lock.path : `Content/Assets/Fixture_${i}.uasset` }))
  let requests = 0
  const server = http.createServer((req, res) => {
    requests++
    res.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' })
    res.end(JSON.stringify(req.url.includes('/verify') ? { ours: locks, theirs: [] } : { locks }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const remote = `http://127.0.0.1:${server.address().port}/repo.git`
  git(repo, 'remote', 'add', 'origin', remote); git(repo, 'config', 'lfs.url', remote + '/info/lfs')
  await runner.exec(['lfs', 'locks', '--verify', '--json'], repo)
  return { repo, cache: path.join(repo, '.git/lfs/lockcache.db'), requests: () => requests,
    close: () => new Promise(resolve => server.close(resolve)) }
}

test('native gob cache is healthy, inspected offline, and byte-identical after checking', async () => {
  const f = await fixture(), svc = service(), snapshots = []
  const native = runner.execSafe
  const checking = service({ execSafe: async (args, ...rest) => {
    if (args.includes('--local')) snapshots.push(args[1].slice('lfs.storage='.length))
    return native(args, ...rest)
  } })
  try {
    const original = fs.readFileSync(f.cache), requests = f.requests()
    expect(original.subarray(0, 16).toString()).not.toBe('SQLite format 3\0')
    expect(await checking.inspectLfsLockCacheFile(f.repo, f.cache)).toMatchObject({ integrity: 'ok', exists: true, sizeBytes: original.length })
    expect(f.requests()).toBe(requests)
    expect(fs.readFileSync(f.cache)).toEqual(original)
    expect(snapshots).toHaveLength(1); expect(fs.existsSync(snapshots[0])).toBe(false)
    const result = await svc.lfsLocksMaintenance(f.repo, false)
    expect(result).toMatchObject({ hasErrors: false, verifyExitCode: 0, lockCount: 1 })
    expect(result.lockCacheFiles[0].integrity).toBe('ok')
    svc.runLfsLocksCheck = async () => ({ stdout: '', stderr: 'network unavailable', exitCode: 1, usedVerify: true })
    const offline = await svc.lfsLocksMaintenance(f.repo, false)
    expect(offline.hasErrors).toBe(true)
    expect(offline.lockCacheFiles[0].integrity).toBe('ok')
    expect(offline.verifyError).toBe('network unavailable')
    expect(git(f.repo, 'status', '--porcelain')).toBe('')
    expect(fs.readFileSync(path.join(f.repo, 'keep.txt'), 'utf8')).toBe('untouched')
  } finally { await f.close() }
})

test('real Git LFS rejects random bytes and truncated version/map; repair becomes healthy', async () => {
  const f = await fixture(), svc = service()
  try {
    const original = fs.readFileSync(f.cache)
    for (const damaged of [Buffer.alloc(31 * 1024, 0xff), Buffer.from('broken'), original.subarray(0, 1), original.subarray(0, original.length - 20)]) {
      fs.writeFileSync(f.cache, damaged)
      const checked = await svc.inspectLfsLockCacheFile(f.repo, f.cache)
      expect(checked.integrity, checked.error).toBe('corrupt')
      expect(checked.error).toMatch(/gob:|EOF/)
      expect(checked.error).not.toContain('lucid-lock-check-')
      expect(fs.readFileSync(f.cache)).toEqual(damaged)
    }
    const result = await svc.lfsLocksMaintenance(f.repo, false)
    expect(result.hasErrors).toBe(true); expect(result.lockCacheFiles[0].integrity).toBe('corrupt')
    const repaired = await svc.lfsLocksMaintenance(f.repo, true)
    expect(repaired.deletedLockCacheFiles).toEqual([f.cache])
    expect(repaired.hasErrors).toBe(false); expect(repaired.lockCacheFiles[0].integrity).toBe('ok')
    expect((await svc.lfsLocksMaintenance(f.repo, false)).hasErrors).toBe(false)
  } finally { await f.close() }
})

test('missing/empty files and tool failures are distinct from corruption, with cleanup', async () => {
  const f = await fixture(), snapshots = []
  try {
    const svc = service({ execSafe: async (args, ...rest) => {
      if (!args.includes('--local')) return runner.execSafe(args, ...rest)
      snapshots.push(args[1].slice('lfs.storage='.length))
      return { stdout: '', stderr: 'permission denied', exitCode: 1 }
    } })
    expect(await svc.inspectLfsLockCacheFile(f.repo, f.cache)).toMatchObject({ integrity: 'unknown', error: 'permission denied', exists: true })
    const result = await svc.lfsLocksMaintenance(f.repo, false)
    expect(result.hasErrors).toBe(true); expect(result.summary).toContain('could not be checked')
    expect(snapshots.every(dir => !fs.existsSync(dir))).toBe(true)
    fs.writeFileSync(f.cache, '')
    expect((await svc.inspectLfsLockCacheFile(f.repo, f.cache)).integrity).toBe('empty')
    expect((await svc.lfsLocksMaintenance(f.repo, false)).hasErrors).toBe(false)
    fs.unlinkSync(f.cache)
    expect(await svc.inspectLfsLockCacheFile(f.repo, f.cache)).toMatchObject({ integrity: 'missing', exists: false })
  } finally { await f.close() }
})

test('renderer displays corrupt and unknown statuses with the actual diagnostic', async () => {
  for (const [integrity, error] of [['corrupt', 'problem reading updated key/value data: unexpected EOF'], ['unknown', 'permission denied']]) {
    const result = { lockCacheFiles: [{ path: 'G:/repo/.git/lfs/lockcache.db', sizeBytes: 31000, integrity, error }], deletedLockCacheFiles: [], hasErrors: true, summary: 'Cache needs attention.', verifyError: '', lockCount: 1 }
    const h = component('src/components/locks/LockedFilesPanel.tsx', {
      '@/ipc': { ipc: { lfsLocksCheck: async () => result } },
      '@/stores/operationStore': { useOperationStore: () => ({ run: (_, fn) => fn() }) },
      '@/stores/dialogStore': { useDialogStore: () => ({}) },
    }, { __privateExports: ['LfsMaintenanceSection'] })
    let tree = h.render('LfsMaintenanceSection', { repoPath: 'G:/repo' })
    await find(tree, n => n.props?.children?.includes('Check Locks')).props.onClick()
    tree = h.render('LfsMaintenanceSection', { repoPath: 'G:/repo' })
    expect(find(tree, n => n.type === 'span' && n.props.children?.includes(integrity))).toBeTruthy()
    expect(find(tree, n => n.type === 'pre' && n.props.children?.includes(error))).toBeTruthy()
    expect(find(tree, n => n.type === 'span' && n.props.children?.includes(integrity)).props.style.color).toBe(integrity === 'corrupt' ? '#e84545' : '#f5a832')
  }
})

test('changed cache and failed decoder execution remain unknown; temporary copies are removed', async () => {
  const f = await fixture(), snapshots = []
  try {
    const original = fs.readFileSync(f.cache)
    const svc = service({ execSafe: async args => {
      snapshots.push(args[1].slice('lfs.storage='.length))
      fs.writeFileSync(f.cache, Buffer.concat([original, Buffer.from('changed')]))
      return { stdout: '', stderr: 'problem checking version of key/value data: unexpected EOF', exitCode: 2 }
    } })
    expect(await svc.inspectLfsLockCacheFile(f.repo, f.cache)).toMatchObject({ integrity: 'unknown', error: expect.stringContaining('changed while') })
    const failed = service({ execSafe: async args => {
      snapshots.push(args[1].slice('lfs.storage='.length)); throw Error('decoder timed out')
    } })
    expect(await failed.inspectLfsLockCacheFile(f.repo, f.cache)).toMatchObject({ integrity: 'unknown', error: expect.stringContaining('timed out') })
    // A metadata read failure must not masquerade as a missing file.
    const h = component('electron/services/GitService.ts', {
      fs: { ...fs, promises: { ...fs.promises, stat: async () => { throw Object.assign(Error('access denied'), { code: 'EACCES' }) } } },
    }).exports.gitService
    expect(await h.inspectLfsLockCacheFile(f.repo, f.cache)).toMatchObject({ integrity: 'unknown', exists: true, error: expect.stringContaining('access denied') })
    expect(snapshots.every(dir => !fs.existsSync(dir))).toBe(true)
  } finally { await f.close() }
})

test('large healthy and nested damaged caches are classified independently with one decoder at a time', async () => {
  const f = await fixture(500)
  let active = 0, peak = 0, decodes = 0
  try {
    expect(fs.statSync(f.cache).size).toBeGreaterThan(31 * 1024)
    const nested = path.join(path.dirname(f.cache), 'old-endpoint', 'lockcache.db')
    fs.mkdirSync(path.dirname(nested)); fs.writeFileSync(nested, 'damaged')
    const svc = service({ execSafe: async (args, ...rest) => {
      if (!args.includes('--local')) return runner.execSafe(args, ...rest)
      active++; peak = Math.max(peak, active); decodes++
      try { return await runner.execSafe(args, ...rest) } finally { active-- }
    } })
    const checked = await svc.lfsLocksMaintenance(f.repo, false)
    expect(checked.hasErrors).toBe(true); expect(checked.lockCount).toBe(500)
    expect(checked.lockCacheFiles.find(file => file.path === f.cache).integrity).toBe('ok')
    expect(checked.lockCacheFiles.find(file => file.path === nested).integrity).toBe('corrupt')
    expect(peak).toBe(1); expect(decodes).toBe(2)
  } finally { await f.close() }
})
