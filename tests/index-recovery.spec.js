const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { IndexRecoveryService } = require(path.join(DIST, 'services/IndexRecoveryService'))
const runner = require(path.join(DIST, 'util/dugite-exec'))
const { component, find, store } = require('./renderer-harness')
test.afterAll(cleanup)

function repo(format = 'sha1') {
  const dir = tmpDir('lg-recovery ü-')
  git(dir, 'init', '-q', '--object-format=' + format)
  git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'asset.bin'), Buffer.from([0, 1, 2]))
  git(dir, 'add', '.'); git(dir, '-c', 'core.hooksPath=', 'commit', '-qm', 'base')
  return dir
}
const index = dir => git(dir, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()
const repair = async (s, dir) => { const d = await s.diagnose(dir); expect(d.canRepair).toBe(true); return s.repair(dir, d.token) }

for (const format of ['sha1', 'sha256']) test(`${format} automatic repair and restart-persistent Undo preserve working bytes and exact original index`, async () => {
  const dir = repo(format), s = new IndexRecoveryService(), file = index(dir)
  const head = git(dir, 'rev-parse', 'HEAD')
  const edit = Buffer.from([255, 0, 3]); fs.writeFileSync(path.join(dir, 'asset.bin'), edit)
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'keep')
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'ignored keep'); fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt')
  fs.writeFileSync(file, 'corrupt bytes')
  const before = fs.readFileSync(file)
  const diagnosis = await s.diagnose(dir)
  expect(diagnosis).toMatchObject({ issue: 'corrupt', canRepair: true })
  expect(fs.readFileSync(file)).toEqual(before)
  const result = await s.repair(dir, diagnosis.token)
  expect(fs.readFileSync(path.join(result.backupPath, 'original-index'))).toEqual(before)
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
  expect(fs.readFileSync(path.join(dir, 'asset.bin'))).toEqual(edit)
  expect(fs.readFileSync(path.join(dir, 'untracked.txt'), 'utf8')).toBe('keep')
  expect(fs.readFileSync(path.join(dir, 'ignored.txt'), 'utf8')).toBe('ignored keep')
  git(dir, 'status', '--porcelain') // Stat refresh must not invalidate Undo.
  const restarted = new IndexRecoveryService()
  expect(await restarted.diagnose(dir)).toMatchObject({ issue: 'healthy', canUndo: true, backupId: result.backupId })
  await restarted.undo(dir, result.backupId)
  expect(fs.readFileSync(file)).toEqual(before)
  expect(fs.existsSync(file + '.lock')).toBe(false)
  expect((await restarted.diagnose(dir)).canUndo).toBe(false)
})

test('Checksum-only repair preserves staged-only content and flags', async () => {
  const dir = repo(), s = new IndexRecoveryService(), file = index(dir)
  fs.writeFileSync(path.join(dir, 'asset.bin'), 'staged only'); git(dir, 'add', '.')
  fs.writeFileSync(path.join(dir, 'asset.bin'), 'working edit')
  git(dir, 'update-index', '--assume-unchanged', 'asset.bin')
  const damaged = fs.readFileSync(file); damaged[damaged.length - 1] ^= 1; fs.writeFileSync(file, damaged)
  expect((await s.diagnose(dir)).issue).toBe('checksum')
  const result = await repair(s, dir)
  expect(git(dir, 'show', ':asset.bin')).toBe('staged only')
  expect(git(dir, 'ls-files', '-v')).toContain('h asset.bin')
  expect(fs.readFileSync(path.join(dir, 'asset.bin'), 'utf8')).toBe('working edit')
  await s.undo(dir, result.backupId)
  expect(fs.readFileSync(file)).toEqual(damaged)
})

test('Healthy indexes cannot be repaired, stale diagnoses and existing locks never mutate the index', async () => {
  const dir = repo(), s = new IndexRecoveryService(), file = index(dir)
  expect(await s.diagnose(dir)).toMatchObject({ issue: 'healthy', canRepair: false })
  await expect(s.repair(dir, 'bad')).rejects.toThrow()
  fs.writeFileSync(file, 'bad'); const d = await s.diagnose(dir)
  fs.writeFileSync(file, 'newer bad')
  await expect(s.repair(dir, d.token)).rejects.toThrow(/Diagnose again/)
  fs.writeFileSync(file + '.lock', 'external writer')
  expect(await s.diagnose(dir)).toMatchObject({ issue: 'blocked', canRepair: false })
  await expect(s.repair(dir, d.token)).rejects.toThrow()
  expect(fs.readFileSync(file + '.lock', 'utf8')).toBe('external writer')
  expect(fs.readFileSync(file, 'utf8')).toBe('newer bad')
})

test('Checksum repair refuses missing staged objects even when the cache tree looks valid', async () => {
  const dir = repo(), s = new IndexRecoveryService(), file = index(dir)
  const bytes = fs.readFileSync(file)
  bytes.fill(1, 52, 72) // First SHA-1 entry points to a nonexistent blob.
  fs.writeFileSync(file, bytes)
  const d = await s.diagnose(dir)
  if (d.canRepair) await expect(s.repair(dir, d.token)).rejects.toThrow(/missing or invalid staged objects/)
  else expect(d.issue).toBe('blocked')
  expect(fs.readFileSync(file)).toEqual(bytes)
  expect(fs.existsSync(file + '.lock')).toBe(false)
})

for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) test(`Active ${marker} prevents automatic recovery`, async () => {
  const dir = repo(), file = index(dir), s = new IndexRecoveryService()
  fs.writeFileSync(file, 'bad')
  const markerPath = path.join(path.dirname(file), marker)
  if (marker.includes('rebase') || marker === 'sequencer') fs.mkdirSync(markerPath)
  else fs.writeFileSync(markerPath, git(dir, 'rev-parse', 'HEAD'))
  const d = await s.diagnose(dir)
  expect(d).toMatchObject({ issue: 'blocked', canRepair: false })
  expect(d.detail).toContain(marker)
  expect(fs.readFileSync(file, 'utf8')).toBe('bad')
})

test('New repositories get a reversible empty-index repair; sparse and broken HEAD states are blocked', async () => {
  const s = new IndexRecoveryService(), dir = tmpDir('lg-unborn-auto-')
  git(dir, 'init', '-q'); fs.writeFileSync(path.join(dir, 'new.txt'), 'keep')
  fs.writeFileSync(index(dir), 'bad')
  const r = await repair(s, dir)
  expect(git(dir, 'status', '--porcelain')).toContain('?? new.txt')
  await s.undo(dir, r.backupId)
  const sparse = repo(); git(sparse, 'config', 'core.sparseCheckout', 'true')
  expect((await s.diagnose(sparse)).detail).toContain('Sparse')
  const broken = repo(); git(broken, 'update-ref', 'HEAD', 'HEAD')
  const object = git(broken, 'rev-parse', 'HEAD').trim()
  fs.unlinkSync(path.join(path.dirname(index(broken)), 'objects', object.slice(0, 2), object.slice(2)))
  expect(await s.diagnose(broken)).toMatchObject({ issue: 'blocked', canRepair: false })
})

test('Missing shared-index repair saves sidecars and Undo preserves original split data', async () => {
  const dir = repo(), file = index(dir), s = new IndexRecoveryService()
  git(dir, 'update-index', '--split-index')
  const saved = fs.readFileSync(file)
  const sidecar = fs.readdirSync(path.dirname(file)).find(n => /^sharedindex\./.test(n))
  fs.renameSync(path.join(path.dirname(file), sidecar), path.join(path.dirname(file), sidecar + '.lost'))
  const r = await repair(s, dir)
  expect(git(dir, 'status', '--porcelain')).toBe('')
  await s.undo(dir, r.backupId)
  expect(fs.readFileSync(file)).toEqual(saved)
})

test('Undo refuses new staging and HEAD changes rather than replacing teammates newer state', async () => {
  const dir = repo(), file = index(dir), s = new IndexRecoveryService()
  fs.writeFileSync(file, 'bad'); const r = await repair(s, dir)
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new staging'); git(dir, 'add', '.')
  const newer = fs.readFileSync(file)
  await expect(s.undo(dir, r.backupId)).rejects.toThrow(/changed/)
  expect(fs.readFileSync(file)).toEqual(newer)
  git(dir, '-c', 'core.hooksPath=', 'commit', '-qm', 'new commit')
  expect((await s.diagnose(dir)).canUndo).toBe(false)
  await expect(s.undo(dir, r.backupId)).rejects.toThrow()
})

test('Candidate failure leaves the original index intact and removes only the tools lock', async () => {
  const dir = repo(), file = index(dir), s = new IndexRecoveryService()
  fs.writeFileSync(file, 'bad'); const d = await s.diagnose(dir)
  const real = runner.execSafe
  runner.execSafe = async (args, ...rest) => args.includes('read-tree') ? { exitCode: 128, stdout: '', stderr: 'injected candidate failure' } : real(args, ...rest)
  try { await expect(s.repair(dir, d.token)).rejects.toThrow('candidate failure') }
  finally { runner.execSafe = real }
  expect(fs.readFileSync(file, 'utf8')).toBe('bad')
  expect(fs.existsSync(file + '.lock')).toBe(false)
})

test('Verification failure restores the original index automatically', async () => {
  const dir = repo(), file = index(dir), s = new IndexRecoveryService()
  fs.writeFileSync(file, 'bad'); const d = await s.diagnose(dir)
  const real = runner.execSafe
  runner.execSafe = async (args, root, env) => args.includes('status') && !env?.GIT_INDEX_FILE && fs.readFileSync(file, 'utf8') !== 'bad'
    ? { exitCode: 128, stdout: '', stderr: 'injected verification failure' } : real(args, root, env)
  try { await expect(s.repair(dir, d.token)).rejects.toThrow('verification failure') }
  finally { runner.execSafe = real }
  expect(fs.readFileSync(file, 'utf8')).toBe('bad')
  expect(fs.existsSync(file + '.lock')).toBe(false)
})

test('Automatic worktree recovery and Undo never touch the parent index', async () => {
  const parent = repo(), dir = tmpDir('lg-auto-worktree-'), s = new IndexRecoveryService()
  git(parent, '-c', 'core.hooksPath=', 'worktree', 'add', '-qb', 'other', dir, 'HEAD')
  const parentIndex = fs.readFileSync(index(parent)), file = index(dir)
  fs.writeFileSync(file, 'bad'); fs.writeFileSync(path.join(dir, 'asset.bin'), 'edit')
  const r = await repair(s, dir)
  expect(fs.readFileSync(index(parent))).toEqual(parentIndex)
  await s.undo(dir, r.backupId)
  expect(fs.readFileSync(index(parent))).toEqual(parentIndex)
  expect(fs.readFileSync(file, 'utf8')).toBe('bad')
})

test('Crash-window journal permits Undo after installation, and damaged backups cannot be restored', async () => {
  const dir = repo(), s = new IndexRecoveryService(), file = index(dir)
  fs.writeFileSync(file, 'bad'); const r = await repair(s, dir)
  const journalPath = path.join(r.backupPath, 'journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')); journal.phase = 'prepared'
  fs.writeFileSync(journalPath, JSON.stringify(journal))
  expect((await new IndexRecoveryService().diagnose(dir)).canUndo).toBe(true)
  fs.writeFileSync(path.join(r.backupPath, 'original-index'), 'damaged backup')
  const saved = fs.readFileSync(file)
  await expect(s.undo(dir, r.backupId)).rejects.toThrow(/missing or damaged/)
  expect(fs.readFileSync(file)).toEqual(saved)
})

test('A corrupt submodule does not make the healthy parent eligible for rebuilding', async () => {
  const source = repo(), parent = repo(), s = new IndexRecoveryService()
  git(parent, '-c', 'protocol.file.allow=always', '-c', 'core.hooksPath=', 'submodule', 'add', source, 'child')
  git(parent, '-c', 'core.hooksPath=', 'commit', '-qam', 'module')
  const child = path.join(parent, 'child'), saved = fs.readFileSync(index(parent))
  fs.writeFileSync(index(child), 'bad')
  expect(await s.diagnose(parent)).toMatchObject({ issue: 'healthy', canRepair: false })
  const r = await repair(s, child)
  expect(fs.readFileSync(index(parent))).toEqual(saved)
  await s.undo(child, r.backupId)
  expect(fs.readFileSync(index(child), 'utf8')).toBe('bad')
})

test('Overlapping repairs serialize and only one replaces the diagnosed index', async () => {
  const dir = repo(), s = new IndexRecoveryService()
  fs.writeFileSync(index(dir), 'bad'); const d = await s.diagnose(dir)
  const results = await Promise.allSettled([s.repair(dir, d.token), s.repair(dir, d.token)])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  expect((await s.diagnose(dir)).issue).toBe('healthy')
})

test('Recovery UI diagnoses, confirms repair, offers Undo and rejects a repository switch during confirmation', async () => {
  const calls = [], repoState = { repoPath: 'repo', bumpSyncTick: () => {} }
  let allow = true
  const d = { repoPath: 'repo', issue: 'corrupt', summary: 'Corrupt', detail: 'rebuild', canRepair: true, token: 'token', canUndo: true, backupId: 'backup' }
  const h = component('src/components/tools/IndexRecoveryTool.tsx', {
    '@/ipc': { ipc: { diagnoseIndex: async () => { calls.push('diagnose'); return d }, repairIndex: async () => { calls.push('repair'); return { backupId: 'backup', summary: 'fixed', diagnosis: d } }, undoIndexRepair: async () => calls.push('undo') } },
    '@/stores/repoStore': { useRepoStore: store(repoState) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async () => allow }) },
    '@/stores/errorStore': { useErrorStore: store({ current: null }) },
  })
  const props = { repoPath: 'repo', onRefresh: () => {} }
  const button = label => find(h.render('IndexRecoveryTool', props), n => n.type === 'ActionBtn' && n.props.children.join('') === label)
  expect(button('Back up and repair').props.disabled).toBe(true)
  await button('Diagnose').props.onClick()
  expect(button('Back up and repair').props.disabled).toBe(false)
  await button('Back up and repair').props.onClick()
  expect(calls).toEqual(['diagnose', 'repair'])
  allow = false; await button('Undo repair').props.onClick(); expect(calls).not.toContain('undo')
  allow = true; await button('Undo repair').props.onClick(); expect(calls).toContain('undo')
  repoState.repoPath = 'other'; await button('Back up and repair').props.onClick()
  expect(calls.filter(c => c === 'repair')).toHaveLength(1)
})
