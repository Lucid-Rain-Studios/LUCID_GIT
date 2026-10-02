const { test, expect } = require('@playwright/test')
const { component, find, store } = require('./renderer-harness')
const { git, tmpDir, cleanup } = require('./helpers')
const fs = require('fs'), path = require('path')
const { execFileSync } = require('child_process')
const crypto = require('crypto')
test.afterAll(cleanup)

test('Tools help opens without Git calls and preserves the selected repository context', () => {
  const h = component('src/components/tools/ToolsPanel.tsx', {
    '@/stores/operationStore': { useOperationStore: store({ run: () => { throw Error('Help must not run Git') } }) },
    '@/stores/repoStore': { useRepoStore: store({ bumpSyncTick: () => {} }) },
  })
  const props = { repoPath: 'C:/project', onRefresh: () => { throw Error('Help must not refresh') } }
  const tree = h.render('ToolsPanel', props)
  find(tree, n => n.props?.tool?.id === 'help').props.onClick()
  const help = find(h.render('ToolsPanel', props), n => n.type === 'IndexRecoveryTool')
  expect(help.props.repoPath).toBe(props.repoPath)
  expect(find(h.render('ToolsPanel', { ...props, repoPath: 'C:/other' }), n => n.type === 'IndexRecoveryTool').props.repoPath).toBe('C:/other')
})

test('Unreadable index errors get manual backup-first guidance rather than lock repair', () => {
  const { parseGitErrorOrGeneric } = component('src/lib/gitErrors.ts').exports
  for (const raw of [
    'fatal: index file corrupt',
    'Error invoking remote method git:fetch: error: index uses  extension, which we do not understand',
    'error: index uses sdir extension, which we do not understand',
    'fatal: C:/repo/.git/index: index file smaller than expected',
    'error: bad index version 99',
    'error: bad index file sha1 signature',
    'fatal: unknown index entry format 0x10000000',
  ]) {
    const error = parseGitErrorOrGeneric(raw)
    expect(error.code).toBe('INDEX_UNREADABLE')
    expect(error.canAutoFix).toBe(false)
    expect(error.description).toContain('Tools → Index Recovery')
    expect(error.fixes.every(f => !f.action && !f.command)).toBe(true)
    expect(error.gitMessage).toBe(raw)
  }
  expect(parseGitErrorOrGeneric('unrelated failure').code).toBe('UNKNOWN')
  for (const raw of [
    "fatal: Unable to create 'C:/repo/.git/index.lock': File exists",
    'fatal: .git/index: index file open failed: Permission denied',
    'fatal: unable to write index: No space left on device',
    'error: index file .git/objects/pack/pack-123.idx is too small',
    'error: bad signature 0x12345678',
    'fatal: bad object HEAD',
  ]) expect(parseGitErrorOrGeneric(raw).code).not.toBe('INDEX_UNREADABLE')
})

function seedRepo(format = 'sha1') {
  const repo = tmpDir('lg-index edge ü-')
  git(repo, 'init', '-q', '--object-format=' + format)
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(repo, 'asset.bin'), Buffer.from([0, 1, 2]))
  git(repo, 'add', 'asset.bin')
  git(repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'base')
  return repo
}
const indexPath = repo => git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index').trim()
const gitError = (repo, ...args) => {
  try { git(repo, ...args) } catch (error) { return error.stderr.toString() }
  throw Error('Expected Git failure')
}

for (const [name, mutate, command] of [
  ['truncated', () => Buffer.from('DIRC'), ['status']],
  ['bad header', data => { data.write('FAIL'); return data }, ['status']],
  ['bad version', data => { data.writeUInt32BE(99, 4); return data }, ['status']],
  ['unknown entry format', data => {
    data[72] |= 0x40 // CE_EXTENDED in the first SHA-1 index entry.
    return Buffer.concat([data.subarray(0, 74), Buffer.from([0x10, 0]), data.subarray(74)])
  }, ['status']],
  ['unknown mandatory extension', data => {
    const extension = Buffer.alloc(8); extension.write('zzzz')
    const content = Buffer.concat([data.subarray(0, -20), extension])
    return Buffer.concat([content, crypto.createHash('sha1').update(content).digest()])
  }, ['status']],
  ['checksum mismatch', data => { data[data.length - 1] ^= 1; return data }, ['fsck', '--no-reflogs']],
]) {
  test(`Real Git ${name} failure is recognized and a rebuild preserves working content`, () => {
    const repo = seedRepo(), index = indexPath(repo)
    const corrupt = mutate(fs.readFileSync(index))
    fs.writeFileSync(index, corrupt)
    const raw = gitError(repo, ...command)
    expect(component('src/lib/gitErrors.ts').exports.parseGitErrorOrGeneric(raw).code).toBe('INDEX_UNREADABLE')
    const edited = Buffer.from([0, 255, 13, 10])
    fs.writeFileSync(path.join(repo, 'asset.bin'), edited)
    const head = git(repo, 'rev-parse', 'HEAD')
    fs.renameSync(index, index + '.backup')
    git(repo, 'reset', '--mixed', 'HEAD')
    expect(fs.readFileSync(index + '.backup')).toEqual(corrupt)
    expect(fs.readFileSync(path.join(repo, 'asset.bin'))).toEqual(edited)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(repo, '--no-optional-locks', 'status', '--porcelain')).toContain(' M asset.bin')
  })
}

test('Linked worktree recovery uses its external index and preserves the main index', () => {
  const repo = seedRepo(), worktree = tmpDir('lg-index worktree ü-')
  git(repo, '-c', 'core.hooksPath=', 'worktree', 'add', '-qb', 'other', worktree, 'HEAD')
  const mainIndex = fs.readFileSync(indexPath(repo)), index = indexPath(worktree)
  expect(index).not.toBe(path.join(worktree, '.git', 'index'))
  const head = git(worktree, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(worktree, 'asset.bin'), 'keep worktree edit')
  fs.writeFileSync(index, 'bad')
  fs.renameSync(index, index + '.backup')
  git(worktree, 'reset', '--mixed', 'HEAD')
  expect(fs.readFileSync(indexPath(repo))).toEqual(mainIndex)
  expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head)
  expect(fs.readFileSync(path.join(worktree, 'asset.bin'), 'utf8')).toBe('keep worktree edit')
})

for (const format of ['sha1', 'sha256']) {
  test(`${format} version-4 index recovery preserves files and unstages changes`, () => {
    const repo = seedRepo(format), index = indexPath(repo)
    git(repo, 'update-index', '--index-version=4')
    expect(fs.readFileSync(index).readUInt32BE(4)).toBe(4)
    fs.writeFileSync(path.join(repo, 'asset.bin'), 'staged version')
    git(repo, 'add', 'asset.bin')
    const saved = fs.readFileSync(index)
    fs.writeFileSync(path.join(repo, 'asset.bin'), 'working version')
    fs.renameSync(index, index + '.backup')
    git(repo, 'reset', '--mixed', 'HEAD')
    expect(fs.readFileSync(path.join(repo, 'asset.bin'), 'utf8')).toBe('working version')
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('')
    expect(fs.readFileSync(index + '.backup')).toEqual(saved)
    const stagedBackup = execFileSync('git', ['show', ':asset.bin'], { cwd: repo, env: { ...process.env, GIT_INDEX_FILE: index + '.backup' } }).toString()
    expect(stagedBackup).toBe('staged version')
  })
}

test('HEAD preflight detects unborn and bare repositories before renaming an index', () => {
  const unborn = tmpDir('lg-index-unborn-')
  git(unborn, 'init', '-q')
  fs.writeFileSync(path.join(unborn, 'new.txt'), 'new work')
  git(unborn, 'add', 'new.txt')
  const index = indexPath(unborn), saved = fs.readFileSync(index)
  expect(gitError(unborn, 'rev-parse', '--verify', 'HEAD^{commit}')).toBeTruthy()
  expect(fs.readFileSync(index)).toEqual(saved)
  const bare = tmpDir('lg-index-bare-')
  git(bare, 'init', '-q', '--bare')
  expect(git(bare, 'rev-parse', '--is-bare-repository').trim()).toBe('true')
})

test('Index lock prevents a rebuild and remains intact with the backup', () => {
  const repo = seedRepo(), index = indexPath(repo)
  fs.writeFileSync(index + '.lock', 'external writer')
  fs.renameSync(index, index + '.backup')
  const saved = fs.readFileSync(index + '.backup')
  expect(gitError(repo, 'reset', '--mixed', 'HEAD')).toContain('File exists')
  expect(fs.readFileSync(index + '.lock', 'utf8')).toBe('external writer')
  expect(fs.readFileSync(index + '.backup')).toEqual(saved)
})

test('Missing split-index data receives specialized guidance without an automatic repair', () => {
  const repo = seedRepo()
  git(repo, 'update-index', '--split-index')
  const index = indexPath(repo), saved = fs.readFileSync(index)
  const shared = fs.readdirSync(path.dirname(index)).find(name => name.startsWith('sharedindex.'))
  expect(shared).toBeTruthy()
  fs.renameSync(path.join(path.dirname(index), shared), path.join(path.dirname(index), shared + '.backup'))
  const raw = gitError(repo, 'status')
  const error = component('src/lib/gitErrors.ts').exports.parseGitErrorOrGeneric(raw)
  expect(error.code).toBe('SHARED_INDEX_UNREADABLE')
  expect(error.canAutoFix).toBe(false)
  expect(error.fixes.every(step => !step.action && !step.command)).toBe(true)
  expect(fs.readFileSync(index)).toEqual(saved)
})

test('Custom index environment resolves separately from the normal repository index', () => {
  const repo = seedRepo(), normal = indexPath(repo)
  const alternate = path.join(repo, 'alternate index ü')
  const saved = fs.readFileSync(normal)
  fs.writeFileSync(alternate, 'bad alternate index')
  const env = { ...process.env, GIT_INDEX_FILE: alternate }
  const resolved = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: repo, env }).toString().trim()
  expect(path.resolve(resolved)).toBe(path.resolve(alternate))
  expect(git(repo, '--no-optional-locks', 'status', '--porcelain')).toContain('??')
  expect(fs.readFileSync(normal)).toEqual(saved)
})

test('Submodule index recovery uses module metadata and preserves the parent index', () => {
  const source = seedRepo(), parent = seedRepo()
  git(parent, '-c', 'protocol.file.allow=always', '-c', 'core.hooksPath=', 'submodule', 'add', source, 'child')
  git(parent, '-c', 'core.hooksPath=', 'commit', '-qam', 'submodule')
  const repo = path.join(parent, 'child'), index = indexPath(repo)
  const parentIndex = fs.readFileSync(indexPath(parent))
  expect(index).not.toBe(path.join(repo, '.git', 'index'))
  fs.writeFileSync(path.join(repo, 'asset.bin'), 'child edit')
  fs.writeFileSync(index, 'bad')
  fs.renameSync(index, index + '.backup')
  git(repo, 'reset', '--mixed', 'HEAD')
  expect(fs.readFileSync(indexPath(parent))).toEqual(parentIndex)
  expect(fs.readFileSync(path.join(repo, 'asset.bin'), 'utf8')).toBe('child edit')
})

test('Documented index rebuild preserves working bytes, untracked files and HEAD', () => {
  const repo = tmpDir('lg-index-help-')
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  const file = path.join(repo, 'asset.bin')
  fs.writeFileSync(file, Buffer.from([0, 1, 2]))
  git(repo, 'add', 'asset.bin')
  git(repo, '-c', 'core.hooksPath=', 'commit', '-qm', 'base')
  const head = git(repo, 'rev-parse', 'HEAD')
  const edited = Buffer.from([0, 255, 10, 13])
  fs.writeFileSync(file, edited)
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'keep me')
  const index = path.resolve(repo, git(repo, 'rev-parse', '--git-path', 'index').trim())
  fs.writeFileSync(index, 'corrupted index')
  expect(() => git(repo, 'status')).toThrow()
  fs.renameSync(index, index + '.backup')
  git(repo, 'reset', '--mixed', 'HEAD')
  expect(fs.readFileSync(file)).toEqual(edited)
  expect(fs.readFileSync(path.join(repo, 'untracked.txt'), 'utf8')).toBe('keep me')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(repo, 'status', '--porcelain')).toContain(' M asset.bin')
  expect(fs.readFileSync(index + '.backup', 'utf8')).toBe('corrupted index')
})
