// Complete user workflows against disposable repositories and local bare remotes.
// Exercise the compiled service; inspect Git objects and bytes, not command mocks.
const { test, expect } = require('@playwright/test')
const fs = require('node:fs')
const path = require('node:path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))

test.afterAll(cleanup)

function write(repo, name, content) {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
  fs.writeFileSync(path.join(repo, name), content)
}
const read = (repo, name) => fs.readFileSync(path.join(repo, name), 'utf8')
const head = repo => git(repo, 'rev-parse', 'HEAD').trim()
const names = (repo, ...args) => git(repo, ...args, '-z').split('\0').filter(Boolean).sort()

function initRepo() {
  const repo = tmpDir('lg-usecase-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Workflow Test')
  git(repo, 'config', 'user.email', 'workflow@example.com')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'core.hooksPath', path.join(repo, '.no-hooks'))
  git(repo, 'config', 'commit.gpgSign', 'false')
  git(repo, 'config', 'merge.gpgSign', 'false')
  git(repo, 'config', 'pull.rebase', 'false')
  return repo
}

function checkpoint(repo, message = 'base') {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', message)
  return head(repo)
}

function seededRepo(files = { 'shared.txt': 'base\n', 'other.txt': 'unchanged\n' }) {
  const repo = initRepo()
  for (const [name, content] of Object.entries(files)) write(repo, name, content)
  checkpoint(repo)
  return repo
}

for (const name of ['Content/Hero [draft].txt', 'Content/éclairage 日本語.txt', '-asset.txt']) {
  test(`partial stage → unstage → restage → commit preserves newer work: ${name}`, async () => {
    const repo = seededRepo({ [name]: 'base\n', 'unselected.txt': 'base\n' })
    write(repo, name, 'staged\n')
    await gitService.stage(repo, [name])
    write(repo, name, 'newer working edit\n')
    write(repo, 'unselected.txt', 'unselected work\n')
    expect(await gitService.diff(repo, name, true)).toMatchObject({ oldContent: 'base\n', newContent: 'staged\n' })
    expect(await gitService.diff(repo, name, false)).toMatchObject({ oldContent: 'staged\n', newContent: 'newer working edit\n' })

    await gitService.unstage(repo, [name])
    expect(names(repo, 'diff', '--cached', '--name-only')).toEqual([])
    expect(read(repo, name)).toBe('newer working edit\n')
    await gitService.stage(repo, [name])
    write(repo, name, 'edit after restaging\n')
    await gitService.commit(repo, 'commit only the reviewed snapshot')
    expect(git(repo, 'show', `HEAD:${name}`)).toBe('newer working edit\n')
    expect(read(repo, name)).toBe('edit after restaging\n')
    expect(git(repo, 'show', 'HEAD:unselected.txt')).toBe('base\n')
    expect(read(repo, 'unselected.txt')).toBe('unselected work\n')
    expect(names(repo, 'diff', '--name-only')).toEqual([name, 'unselected.txt'].sort())
    expect(names(repo, 'diff', '--cached', '--name-only')).toEqual([])
  })
}

test('literal bracket selection never stages or unstages its glob-matching sibling', async () => {
  const selected = 'Hero [AB].txt', sibling = 'Hero A.txt'
  const repo = seededRepo({ [selected]: 'base\n', [sibling]: 'base\n' })
  write(repo, selected, 'selected\n'); write(repo, sibling, 'sibling\n')
  await gitService.stage(repo, [selected])
  expect(names(repo, 'diff', '--cached', '--name-only')).toEqual([selected])
  await gitService.stage(repo, [sibling])
  await gitService.unstage(repo, [selected])
  expect(names(repo, 'diff', '--cached', '--name-only')).toEqual([sibling])
  expect(read(repo, selected)).toBe('selected\n')
  expect(read(repo, sibling)).toBe('sibling\n')
})

test('before the first commit, unstage preserves new files and commit includes only the final selection', async () => {
  const repo = initRepo()
  write(repo, 'Content/New [asset].txt', 'new asset\n')
  write(repo, 'notes.txt', 'personal notes\n')
  await gitService.stage(repo, ['Content/New [asset].txt', 'notes.txt'])
  await gitService.unstage(repo, ['notes.txt'])
  expect(read(repo, 'notes.txt')).toBe('personal notes\n')
  await gitService.commit(repo, 'first selected commit')
  expect(names(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).toEqual(['Content/New [asset].txt'])
  expect(names(repo, 'ls-files', '--others', '--exclude-standard')).toEqual(['notes.txt'])
})

test('selected discard restores a deletion and a modification while preserving other staged and untracked work', async () => {
  const repo = seededRepo({ 'edited.txt': 'base\n', 'deleted.txt': 'keep\n', 'other.txt': 'base\n' })
  const before = head(repo)
  write(repo, 'edited.txt', 'discard me\n')
  fs.unlinkSync(path.join(repo, 'deleted.txt'))
  write(repo, 'other.txt', 'staged work\n')
  await gitService.stage(repo, ['other.txt'])
  write(repo, 'loose.txt', 'untracked work\n')
  await gitService.discard(repo, ['edited.txt', 'deleted.txt'], false)
  expect(read(repo, 'edited.txt')).toBe('base\n')
  expect(read(repo, 'deleted.txt')).toBe('keep\n')
  expect(git(repo, 'show', ':other.txt')).toBe('staged work\n')
  expect(read(repo, 'loose.txt')).toBe('untracked work\n')
  expect(names(repo, 'diff', '--cached', '--name-only')).toEqual(['other.txt'])
  expect(names(repo, 'diff', '--name-only')).toEqual([])
  expect(head(repo)).toBe(before)
})

for (const method of ['stashApply', 'stashPop']) {
  test(`selected stash → ${method} restores edits, deletions and new files without touching sibling work`, async () => {
    const selected = 'Content/Hero [AB].txt', sibling = 'Content/Hero A.txt'
    const repo = seededRepo({ [selected]: 'base\n', [sibling]: 'base\n', 'deleted.txt': 'old\n' })
    const before = head(repo)
    write(repo, selected, 'staged snapshot\n')
    await gitService.stage(repo, [selected])
    write(repo, selected, 'working snapshot\n')
    write(repo, sibling, 'unselected work\n')
    write(repo, 'new 日本語.txt', 'new work\n')
    fs.unlinkSync(path.join(repo, 'deleted.txt'))
    await gitService.stashSave(repo, 'selected user work', [selected, 'deleted.txt', 'new 日本語.txt'])
    expect(read(repo, selected)).toBe('base\n')
    expect(read(repo, 'deleted.txt')).toBe('old\n')
    expect(fs.existsSync(path.join(repo, 'new 日本語.txt'))).toBe(false)
    expect(read(repo, sibling)).toBe('unselected work\n')
    expect(git(repo, 'show', `stash@{0}^2:${selected}`)).toBe('staged snapshot\n')
    expect(git(repo, 'show', `stash@{0}:${selected}`)).toBe('working snapshot\n')
    const saved = git(repo, 'rev-parse', 'refs/stash')

    await gitService[method](repo, 'stash@{0}')
    expect(read(repo, selected)).toBe('working snapshot\n')
    expect(read(repo, sibling)).toBe('unselected work\n')
    expect(read(repo, 'new 日本語.txt')).toBe('new work\n')
    expect(fs.existsSync(path.join(repo, 'deleted.txt'))).toBe(false)
    expect(head(repo)).toBe(before)
    expect(await gitService.stashList(repo)).toHaveLength(method === 'stashApply' ? 1 : 0)
    if (method === 'stashApply') expect(git(repo, 'rev-parse', 'refs/stash')).toBe(saved)
  })
}

// Every conflict starts through the service, including its merge safety journal.
function conflictRepo(kind) {
  const repo = seededRepo()
  git(repo, 'checkout', '-q', '-b', 'feature')
  if (kind === 'add/add') write(repo, 'new asset.txt', 'theirs\n')
  else if (kind === 'modify/delete') fs.unlinkSync(path.join(repo, 'shared.txt'))
  else write(repo, 'shared.txt', 'theirs\n')
  write(repo, 'feature-only.txt', 'feature survives resolution\n')
  const theirs = checkpoint(repo, 'feature')
  git(repo, 'checkout', '-q', 'main')
  const file = kind === 'add/add' ? 'new asset.txt' : 'shared.txt'
  if (kind === 'delete/modify') fs.unlinkSync(path.join(repo, file))
  else write(repo, file, 'ours\n')
  const ours = checkpoint(repo, 'main diverges')
  return { repo, file, ours, theirs }
}

for (const kind of ['content', 'add/add', 'modify/delete', 'delete/modify']) {
  for (const choice of ['ours', 'theirs']) {
    test(`${kind} conflict → choose ${choice} → finalize retains both parents and unrelated incoming files`, async () => {
      const { repo, file, ours, theirs } = conflictRepo(kind)
      await expect(gitService.merge(repo, 'feature')).rejects.toThrow()
      expect(await gitService.mergeInProgress(repo)).toMatchObject({ kind: 'merge', unresolvedFiles: [file] })
      expect(head(repo)).toBe(ours)
      await gitService.resolveMergeConflictText(repo, file, choice)
      expect(git(repo, 'ls-files', '-u')).toBe('')
      await gitService.continueMerge(repo, 'feature')
      expect(await gitService.mergeInProgress(repo)).toBeNull()
      expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').slice(1)).toEqual([ours, theirs])
      if ((kind === 'modify/delete' && choice === 'theirs') || (kind === 'delete/modify' && choice === 'ours')) expect(fs.existsSync(path.join(repo, file))).toBe(false)
      else expect(read(repo, file)).toBe(`${choice}\n`)
      expect(read(repo, 'feature-only.txt')).toBe('feature survives resolution\n')
      expect(await gitService.status(repo)).toEqual([])
    })
  }
}

for (const creating of [false, true]) {
  test(`blocked ${creating ? 'branch creation' : 'checkout'} preserves staged and newer working edits`, async () => {
    const repo = seededRepo()
    git(repo, 'checkout', '-q', '-b', 'feature')
    write(repo, 'shared.txt', 'feature version\n')
    checkpoint(repo, 'feature')
    git(repo, 'checkout', '-q', 'main')
    const before = head(repo)
    write(repo, 'shared.txt', 'staged local work\n')
    await gitService.stage(repo, ['shared.txt'])
    write(repo, 'shared.txt', 'newer local work\n')
    write(repo, 'notes.txt', 'untracked notes\n')
    const operation = creating
      ? gitService.createBranch(repo, 'review/feature', 'feature')
      : gitService.checkout(repo, 'feature')
    await expect(operation).rejects.toThrow(/overwritten|local changes/i)
    expect(await gitService.currentBranch(repo)).toBe('main')
    expect(head(repo)).toBe(before)
    expect(git(repo, 'show', ':shared.txt')).toBe('staged local work\n')
    expect(read(repo, 'shared.txt')).toBe('newer local work\n')
    expect(read(repo, 'notes.txt')).toBe('untracked notes\n')
    expect(await gitService.mergeInProgress(repo)).toBeNull()
  })
}

test('unfinished conflict refuses finalization, then Abort restores the branch and keeps untracked work', async () => {
  const { repo, ours, file } = conflictRepo('content')
  write(repo, 'local-notes.txt', 'keep my notes\n')
  await expect(gitService.merge(repo, 'feature')).rejects.toThrow()
  const index = fs.readFileSync(path.join(repo, '.git', 'index'))
  const markers = read(repo, file)
  await expect(gitService.continueMerge(repo, 'feature')).rejects.toThrow('Resolve all merge conflicts')
  expect(fs.readFileSync(path.join(repo, '.git', 'index'))).toEqual(index)
  expect(read(repo, file)).toBe(markers)
  expect(head(repo)).toBe(ours)
  await gitService.abortMerge(repo)
  expect(await gitService.mergeInProgress(repo)).toBeNull()
  expect(head(repo)).toBe(ours)
  expect(read(repo, file)).toBe('ours\n')
  expect(read(repo, 'local-notes.txt')).toBe('keep my notes\n')
  expect(fs.existsSync(path.join(repo, 'feature-only.txt'))).toBe(false)
  expect(names(repo, 'diff', 'HEAD', '--name-only')).toEqual([])
})

test('conflicting stash Pop retains its checkpoint and resolution never creates an unsolicited commit', async () => {
  const repo = seededRepo()
  write(repo, 'shared.txt', 'stashed work\n')
  await gitService.stashSave(repo, 'recoverable work')
  const saved = git(repo, 'rev-parse', 'refs/stash')
  write(repo, 'shared.txt', 'new committed work\n')
  const before = checkpoint(repo, 'diverge')
  await expect(gitService.stashPop(repo, 'stash@{0}')).rejects.toThrow()
  expect(await gitService.mergeInProgress(repo)).toMatchObject({ kind: 'conflict', mergeHead: null, unresolvedFiles: ['shared.txt'] })
  expect(git(repo, 'rev-parse', 'refs/stash')).toBe(saved)
  await expect(gitService.abortMerge(repo)).rejects.toThrow('There is no merge to abort')
  expect(git(repo, 'ls-files', '-u')).not.toBe('')
  await gitService.resolveMergeConflictText(repo, 'shared.txt', 'theirs')
  await gitService.continueMerge(repo, '')
  expect(head(repo)).toBe(before)
  expect(read(repo, 'shared.txt')).toBe('stashed work\n')
  expect(git(repo, 'show', ':shared.txt')).toBe('stashed work\n')
  expect(await gitService.mergeInProgress(repo)).toBeNull()
  expect(git(repo, 'rev-parse', 'refs/stash')).toBe(saved)
  await gitService.stashDrop(repo, 'stash@{0}')
  expect(await gitService.stashList(repo)).toEqual([])
  expect(read(repo, 'shared.txt')).toBe('stashed work\n')
})

function publishedRepo() {
  const repo = seededRepo()
  const remote = tmpDir('lg-usecase-remote-')
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-qu', 'origin', 'main')
  return { repo, remote }
}

for (const extension of ['uasset', 'umap']) {
  test(`Unreal ${extension}: stash → older branch → original branch → Pop restores binary bytes offline`, async () => {
    const name = `Content/Hero [review].${extension}`
    const repo = initRepo()
    git(repo, 'lfs', 'install', '--local')
    git(repo, 'lfs', 'track', `*.${extension}`)
    const original = Buffer.alloc(200_000, 0x31)
    const committed = Buffer.alloc(200_000, 0x62)
    const working = Buffer.alloc(200_000, 0xe7)
    write(repo, name, original)
    const older = checkpoint(repo, 'older binary')
    write(repo, name, committed)
    const current = checkpoint(repo, 'current binary')
    write(repo, name, working)
    await gitService.stashSave(repo, 'unfinished Unreal work', [name])
    expect(fs.readFileSync(path.join(repo, name))).toEqual(committed)
    const stash = git(repo, 'rev-parse', 'refs/stash')
    await gitService.createBranch(repo, 'review/older', older)
    expect(head(repo)).toBe(older)
    expect(fs.readFileSync(path.join(repo, name))).toEqual(original)
    expect(await gitService.status(repo)).toEqual([])
    expect(git(repo, 'rev-parse', 'refs/stash')).toBe(stash)
    await gitService.checkout(repo, 'main')
    expect(head(repo)).toBe(current)
    expect(fs.readFileSync(path.join(repo, name))).toEqual(committed)
    await gitService.stashPop(repo, 'stash@{0}')
    expect(fs.readFileSync(path.join(repo, name))).toEqual(working)
    expect(head(repo)).toBe(current)
    expect(await gitService.stashList(repo)).toEqual([])
    expect(names(repo, 'diff', '--name-only')).toEqual([name])
    // The repository stores an LFS pointer; the player-facing working file must
    // still contain the full binary, including after the offline branch switch.
    expect(git(repo, 'show', `HEAD:${name}`)).toContain('version https://git-lfs.github.com/spec/v1')
    expect(git(repo, 'remote')).toBe('')
  })
}

test('force-with-lease rejects an unseen teammate commit, then permits an explicitly refreshed retry', async () => {
  const { repo, remote } = publishedRepo()
  const peer = initRepo()
  git(peer, 'remote', 'add', 'origin', remote)
  git(peer, 'fetch', '-q', 'origin')
  git(peer, 'reset', '--hard', 'origin/main')
  write(peer, 'teammate.txt', 'teammate commit\n')
  const remoteHead = checkpoint(peer, 'teammate')
  git(peer, 'push', '-q', 'origin', 'main')
  write(repo, 'local.txt', 'local commit\n')
  const localHead = checkpoint(repo, 'local')
  const staleTrackingHead = git(repo, 'rev-parse', 'origin/main')

  await expect(gitService.push(repo, undefined, true)).rejects.toThrow(/stale info|rejected/i)
  expect(git(remote, 'rev-parse', 'main').trim()).toBe(remoteHead)
  expect(head(repo)).toBe(localHead)
  expect(git(repo, 'rev-parse', 'origin/main')).toBe(staleTrackingHead)
  expect(git(remote, 'show', 'main:teammate.txt')).toBe('teammate commit\n')
  await gitService.fetch(repo)
  await gitService.push(repo, undefined, true)
  expect(git(remote, 'rev-parse', 'main').trim()).toBe(localHead)
  expect(git(remote, 'show', 'main:local.txt')).toBe('local commit\n')
  expect(await gitService.getSyncStatus(repo)).toMatchObject({ ahead: 0, behind: 0 })
})

test('first publication from a stale inherited upstream creates its own branch without overwriting main', async () => {
  const { repo, remote } = publishedRepo()
  await gitService.createBranch(repo, 'art/hero', 'origin/main')
  write(repo, 'hero.txt', 'feature work\n')
  const feature = checkpoint(repo, 'feature')
  // Advance main without updating the feature clone's remote-tracking ref.
  const peer = initRepo()
  git(peer, 'remote', 'add', 'origin', remote)
  git(peer, 'fetch', '-q', 'origin')
  git(peer, 'reset', '--hard', 'origin/main')
  write(peer, 'main-only.txt', 'new main work\n')
  const main = checkpoint(peer, 'advance main')
  git(peer, 'push', '-q', 'origin', 'main')
  expect(await gitService.getSyncStatus(repo)).toMatchObject({ hasPublishedBranch: false, behind: 0 })
  await gitService.push(repo)
  expect(git(remote, 'rev-parse', 'main').trim()).toBe(main)
  expect(git(remote, 'rev-parse', 'art/hero').trim()).toBe(feature)
  expect(git(repo, 'rev-parse', '--abbrev-ref', '@{u}').trim()).toBe('origin/art/hero')
  expect(await gitService.getSyncStatus(repo)).toMatchObject({ hasPublishedBranch: true, ahead: 0, behind: 0 })
})
