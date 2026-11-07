// Real local remotes and LFS filters, plus the actual TopBar callback wired to
// GitService. No GitHub access or developer repository mutation is needed.
const { test, expect } = require('@playwright/test')
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { DIST, git, tmpDir, lfsRepo, cleanup } = require('./helpers')
const { component, find, store } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))
test.afterAll(cleanup)

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function write(repo, file, label) {
  const bytes = file.endsWith('.uasset') ? Buffer.alloc(32_768, label.charCodeAt(0)) : Buffer.from(label + '\n')
  fs.writeFileSync(path.join(repo, file), bytes)
  return digest(bytes)
}
function optionalRef(repo, ref) {
  try { return git(repo, 'rev-parse', '--verify', ref).trim() } catch { return null }
}
function snapshot(repo) {
  const files = git(repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)
  return {
    head: git(repo, 'rev-parse', 'HEAD'), index: git(repo, 'write-tree'),
    status: git(repo, 'status', '--porcelain=v1', '-z'), stash: optionalRef(repo, 'refs/stash'),
    files: Object.fromEntries([...new Set(files)].sort().map(file => [file,
      fs.existsSync(path.join(repo, file)) ? digest(fs.readFileSync(path.join(repo, file))) : null])),
  }
}
function fixture({ divergent = true, overlap = false, file = 'Asset.uasset', state = 'staged' } = {}) {
  const repo = lfsRepo(['Asset'], 32_768), remote = tmpDir('lg-pull-matrix-remote-')
  git(repo, 'branch', '-M', 'main')
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'pull.rebase', 'false')
  git(repo, 'config', 'pull.ff', 'true')
  git(repo, 'config', 'merge.ff', 'true')
  write(repo, 'notes.txt', 'base'); write(repo, 'remote.txt', 'base')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base text')
  git(remote, 'init', '-q', '--bare')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-qu', 'origin', 'main')
  git(repo, 'checkout', '-qb', 'incoming')
  write(repo, overlap ? file : 'remote.txt', 'remote')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'incoming work')
  git(repo, 'push', '-q', 'origin', 'incoming:main')
  git(repo, 'checkout', '-q', 'main')
  if (divergent) {
    write(repo, 'local.txt', 'local'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'local history')
  }
  if (state === 'delete') git(repo, 'rm', '-q', '--', file)
  else if (state === 'rename') git(repo, 'mv', file, 'Renamed asset [1].uasset')
  else if (state !== 'clean') {
    write(repo, file, 'staged')
    if (state !== 'unstaged') git(repo, 'add', '--', file)
    if (state === 'mixed') write(repo, file, 'working')
  }
  return { repo, remote, file }
}

for (const file of ['Asset.uasset', 'notes.txt']) {
  for (const divergent of [false, true]) for (const overlap of [false, true]) {
    for (const state of ['staged', 'unstaged', 'mixed']) {
      test(`${file}: ${divergent ? 'divergent' : 'fast-forward'}, ${overlap ? 'overlap' : 'unrelated'}, ${state}`, async () => {
        const { repo } = fixture({ file, divergent, overlap, state })
        const before = snapshot(repo)
        await gitService.fetch(repo)
        const blocked = overlap || (divergent && state !== 'unstaged')
        const paths = await gitService.mergeOverlapFiles(repo, '@{u}')
        expect(paths).toEqual(blocked ? [file] : [])
        expect(snapshot(repo)).toEqual(before)
        if (!blocked) {
          await gitService.pull(repo)
          const after = snapshot(repo)
          expect(after.files[file]).toBe(before.files[file])
          expect(after.status).toBe(before.status)
          expect(after.stash).toBe(before.stash)
          expect(git(repo, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')).toBe('')
          expect(optionalRef(repo, 'MERGE_HEAD')).toBeNull()
        }
      })
    }
  }
}

for (const state of ['delete', 'rename']) test(`divergent preflight protects staged LFS ${state}`, async () => {
  const { repo } = fixture({ state })
  const before = snapshot(repo)
  expect(await gitService.mergeOverlapFiles(repo, '@{u}')).toEqual([state === 'rename' ? 'Renamed asset [1].uasset' : 'Asset.uasset'])
  expect(snapshot(repo)).toEqual(before)
})

test('a clean divergent repository merges without a stash prompt', async () => {
  const { repo } = fixture({ state: 'clean' })
  expect(await gitService.mergeOverlapFiles(repo, '@{u}')).toEqual([])
  await gitService.pull(repo)
  expect(await gitService.status(repo)).toEqual([])
  expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3)
})

// Same renderer callback as the real button, backed by the real Git service.
function pullButton(repoPath, fileStatus, confirm, overrides = {}) {
  const prompts = [], errors = [], calls = [], notices = []
  const state = { repoPath, currentBranch: 'main', branches: [], fileStatus, recentRepos: [], syncTick: 0,
    refreshStatus: async () => { state.fileStatus = await gitService.status(repoPath) }, bumpSyncTick() {} }
  const api = {
    mergeInProgress: async () => null,
    fetch: async repo => { calls.push('fetch'); return gitService.fetch(repo) },
    mergeOverlapFiles: (...args) => gitService.mergeOverlapFiles(...args),
    stashSave: async (...args) => { calls.push('stash'); return gitService.stashSave(...args) },
    pull: async repo => { calls.push('pull'); return gitService.pull(repo) },
    getSyncStatus: repo => gitService.getSyncStatus(repo), ...overrides,
  }
  const h = component('src/components/layout/TopBar.tsx', {
    '@/ipc': { ipc: api }, '@/lib/fetchState': { markFetchPerformed() {} },
    '@/lib/topBarSyncBridge': { hasBranchIntegrated: () => false, markBranchIntegrated() {} },
    '@/lib/syncButtonLogic': component('src/lib/syncButtonLogic.ts').exports,
    '@/stores/repoStore': { useRepoStore: store(state) },
    '@/stores/authStore': { useAuthStore: store({ accounts: [], permissionErrors: {} }) },
    '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
    '@/stores/errorStore': { useErrorStore: store({ pushRaw: e => errors.push(e) }) },
    '@/stores/prStore': { usePRStore: store({ openDialog() {} }) },
    '@/stores/statusToastStore': { useStatusToastStore: store({ show: n => notices.push(n) }) },
    '@/stores/dialogStore': { useDialogStore: store({ confirm: async p => { prompts.push(p); return confirm } }) },
  })
  const button = find(h.render('TopBar', {}), n => typeof n.props?.onPull === 'function')
  return { click: () => button.props.onPull(), calls, prompts, errors, notices }
}

test('real UI-to-service Cancel leaves LFS bytes, index, HEAD and existing stash untouched', async () => {
  const { repo } = fixture({ state: 'mixed' })
  const before = snapshot(repo)
  const ui = pullButton(repo, await gitService.status(repo), false)
  await ui.click()
  expect(ui.prompts).toHaveLength(1); expect(ui.calls).toEqual(['fetch']); expect(ui.errors).toEqual([])
  expect(snapshot(repo)).toEqual(before)
})

test('real UI-to-service Stash & Pull preserves both LFS edit versions and untracked work in the stash', async () => {
  const { repo } = fixture({ state: 'mixed' })
  write(repo, 'untracked.txt', 'untracked')
  const before = snapshot(repo)
  const stagedPointer = git(repo, 'show', ':Asset.uasset')
  const ui = pullButton(repo, await gitService.status(repo), true)
  await ui.click()
  expect(ui.prompts).toHaveLength(1); expect(ui.calls).toEqual(['fetch', 'stash', 'pull']); expect(ui.errors).toEqual([])
  expect(await gitService.status(repo)).toEqual([])
  expect(git(repo, 'show', 'stash@{0}^2:Asset.uasset')).toBe(stagedPointer)
  expect(git(repo, 'show', 'stash@{0}^3:untracked.txt')).toBe('untracked\n')
  const stashRef = optionalRef(repo, 'refs/stash')
  // Test the application's Apply path; it restores bytes but intentionally
  // does not promise to restore staging (plain git stash apply, no --index).
  await gitService.stashApply(repo, 'stash@{0}')
  expect(digest(fs.readFileSync(path.join(repo, 'Asset.uasset')))).toBe(before.files['Asset.uasset'])
  expect(digest(fs.readFileSync(path.join(repo, 'untracked.txt')))).toBe(before.files['untracked.txt'])
  expect(optionalRef(repo, 'refs/stash')).toBe(stashRef)
})

test('failed stash stops the actual Pull callback before Git pull and preserves all local state', async () => {
  const { repo } = fixture()
  const before = snapshot(repo)
  const ui = pullButton(repo, await gitService.status(repo), true, { stashSave: async () => { throw Error('injected stash failure') } })
  await ui.click()
  expect(ui.calls).toEqual(['fetch']); expect(ui.errors.join(' ')).toContain('injected stash failure')
  expect(snapshot(repo)).toEqual(before)
  expect(ui.notices.some(n => n.startsWith('Pull successful'))).toBe(false)
})

test('failed pull after a successful stash keeps the recoverable LFS work and existing stash', async () => {
  const { repo } = fixture({ state: 'mixed' })
  // Keep a prior stash as well as the new automatic one.
  git(repo, 'stash', 'push', '-qm', 'prior stash'); git(repo, 'stash', 'apply', '--index')
  const prior = optionalRef(repo, 'refs/stash'), before = snapshot(repo)
  const ui = pullButton(repo, await gitService.status(repo), true, { pull: async () => { throw Error('injected network failure') } })
  await ui.click()
  expect(ui.errors.join(' ')).toContain('injected network failure')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(before.head)
  expect(git(repo, 'rev-parse', 'stash@{1}').trim()).toBe(prior)
  expect(ui.notices.some(n => n.startsWith('Pull successful'))).toBe(false)
  await gitService.stashApply(repo, 'stash@{0}')
  expect(digest(fs.readFileSync(path.join(repo, 'Asset.uasset')))).toBe(before.files['Asset.uasset'])
})

test('incoming overlap introduced after preflight cannot overwrite local LFS edits', async () => {
  const { repo, remote } = fixture({ divergent: false, state: 'unstaged' })
  const before = snapshot(repo)
  expect(await gitService.mergeOverlapFiles(repo, '@{u}')).toEqual([])
  // Advance origin from a separate temporary clone after the safe preflight.
  const peer = tmpDir('lg-pull-matrix-peer-')
  git(peer, 'clone', '-q', '-b', 'main', remote, '.')
  git(peer, 'config', 'user.name', 'Test'); git(peer, 'config', 'user.email', 'test@example.com')
  write(peer, 'Asset.uasset', 'raced'); git(peer, 'add', '.'); git(peer, 'commit', '-qm', 'late incoming edit'); git(peer, 'push', '-q')
  await expect(gitService.pull(repo)).rejects.toThrow()
  expect(snapshot(repo)).toEqual(before)
})

test('untracked LFS asset colliding with an incoming addition is caught before Pull', async () => {
  const file = 'New asset [1].uasset'
  const { repo } = fixture({ file, state: 'unstaged', overlap: true })
  const before = snapshot(repo)
  expect(await gitService.mergeOverlapFiles(repo, '@{u}')).toEqual([file])
  const ui = pullButton(repo, await gitService.status(repo), false)
  await ui.click()
  expect(ui.calls).toEqual(['fetch']); expect(ui.prompts).toHaveLength(1)
  expect(snapshot(repo)).toEqual(before)
})

test('conflicting stash Apply fails visibly and retains the original LFS work for recovery', async () => {
  const { repo } = fixture({ overlap: true })
  const localPointer = git(repo, 'show', ':Asset.uasset')
  const ui = pullButton(repo, await gitService.status(repo), true)
  await ui.click()
  expect(ui.errors).toEqual([]); expect(ui.calls).toEqual(['fetch', 'stash', 'pull'])
  const stash = optionalRef(repo, 'refs/stash'), head = optionalRef(repo, 'HEAD')
  await expect(gitService.stashApply(repo, 'stash@{0}')).rejects.toThrow()
  expect(optionalRef(repo, 'refs/stash')).toBe(stash)
  expect(optionalRef(repo, 'HEAD')).toBe(head)
  expect(git(repo, 'show', 'stash@{0}:Asset.uasset')).toBe(localPointer)
  expect(git(repo, 'ls-files', '--unmerged')).toContain('Asset.uasset')
})

test('large staged LFS group survives repeated concurrent preflights without changing content or index', async () => {
  const { repo } = fixture({ state: 'clean' })
  const folder = 'Group é [1]'
  fs.mkdirSync(path.join(repo, folder))
  const paths = Array.from({ length: 200 }, (_, i) => `${folder}/asset ${i}.uasset`)
  for (const file of paths) write(repo, file, 'group')
  git(repo, 'add', '--', folder)
  const before = snapshot(repo)
  for (let round = 0; round < 3; round++) {
    const results = await Promise.all(Array.from({ length: 4 }, () => gitService.mergeOverlapFiles(repo, '@{u}')))
    for (const result of results) expect([...result].sort()).toEqual([...paths].sort())
    expect(snapshot(repo)).toEqual(before)
  }
})
