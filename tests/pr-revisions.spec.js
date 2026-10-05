const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { component, find, store } = require('./renderer-harness')
const { gitService } = require(path.join(DIST, 'services/GitService'))

function repo(format = 'sha1') {
  const dir = tmpDir('lg-pr-revisions-')
  git(dir, 'init', '-q', '-b', 'main', `--object-format=${format}`)
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'initial')
  return dir
}

function commit(dir, file, content, message) {
  fs.writeFileSync(path.join(dir, file), content)
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', message)
  return git(dir, 'rev-parse', 'HEAD').trim()
}

test.afterAll(cleanup)

for (const format of ['sha1', 'sha256']) {
  test(`LG-059 ${format} PR previews retain reviewed commits after branch tips move`, async () => {
    const dir = repo(format)
    git(dir, 'branch', 'unrelated')
    git(dir, 'checkout', '-qb', 'feature')
    const head = commit(dir, 'feature.txt', 'reviewed\n', 'reviewed feature')
    commit(dir, 'later.txt', 'later\n', 'unreviewed feature')
    git(dir, 'checkout', '-q', 'main')
    const base = commit(dir, 'base.txt', 'base\n', 'reviewed base')
    // Current main conflicts with the PR, but the reviewed base merges cleanly.
    commit(dir, 'feature.txt', 'different\n', 'unreviewed base')
    git(dir, 'checkout', '-q', 'unrelated')
    commit(dir, 'file.txt', 'unrelated\n', 'unrelated checkout')
    fs.writeFileSync(path.join(dir, 'file.txt'), 'staged\n')
    git(dir, 'add', '.')
    fs.writeFileSync(path.join(dir, 'file.txt'), 'working\n')
    const before = {
      head: git(dir, 'rev-parse', 'HEAD'), index: fs.readFileSync(path.join(dir, '.git/index')),
      status: git(dir, 'status', '--porcelain'), working: fs.readFileSync(path.join(dir, 'file.txt')),
    }
    const diff = await gitService.branchDiff(dir, base, head)
    expect(diff.aheadCommits.map(c => c.hash)).toEqual([head])
    expect(diff.behindCommits.map(c => c.hash)).toEqual([base])
    expect(diff.files.map(f => f.path)).toEqual(['feature.txt'])
    expect(await gitService.mergePreview(dir, head, base)).toEqual([])
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(fs.readFileSync(path.join(dir, '.git/index'))).toEqual(before.index)
    expect(git(dir, 'status', '--porcelain')).toBe(before.status)
    expect(fs.readFileSync(path.join(dir, 'file.txt'))).toEqual(before.working)
  })
}

test('LG-059 pinned PR conflict preview uses its explicit base and head', async () => {
  const dir = repo()
  git(dir, 'branch', 'unrelated')
  git(dir, 'checkout', '-qb', 'feature')
  const head = commit(dir, 'file.txt', 'feature\n', 'feature edit')
  git(dir, 'checkout', '-q', 'main')
  const base = commit(dir, 'file.txt', 'base\n', 'base edit')
  git(dir, 'checkout', '-q', 'unrelated')
  git(dir, 'branch', '-D', 'feature')
  const preview = await gitService.mergePreview(dir, head, base)
  expect(preview).toHaveLength(1)
  expect(preview[0]).toMatchObject({ path: 'file.txt', type: 'text',
    ours: { branch: base, lastCommitMessage: 'base edit', sizeBytes: 5 },
    theirs: { branch: head, lastCommitMessage: 'feature edit', sizeBytes: 8 },
  })
  expect(await gitService.mergeInProgress(dir)).toBeNull()
})

test('LG-059 local PR resolution merges the pinned base commit', async () => {
  const dir = repo()
  git(dir, 'branch', 'feature')
  const base = commit(dir, 'base.txt', 'reviewed\n', 'reviewed base')
  commit(dir, 'later.txt', 'unreviewed\n', 'unreviewed base')
  git(dir, 'checkout', '-q', 'feature')
  const head = commit(dir, 'feature.txt', 'feature\n', 'feature')
  await gitService.merge(dir, base)
  expect(git(dir, 'rev-parse', 'HEAD^1').trim()).toBe(head)
  expect(git(dir, 'rev-parse', 'HEAD^2').trim()).toBe(base)
  expect(fs.readFileSync(path.join(dir, 'base.txt'), 'utf8')).toBe('reviewed\n')
  expect(fs.existsSync(path.join(dir, 'later.txt'))).toBe(false)
})

test('LG-059 unavailable/non-commit SHAs reject without substituting a named branch', async () => {
  const dir = repo(), base = git(dir, 'rev-parse', 'HEAD').trim()
  const missing = '1'.repeat(40), blob = git(dir, 'rev-parse', 'HEAD:file.txt').trim()
  git(dir, 'branch', missing)
  for (const invalid of [missing, blob]) {
    await expect(gitService.branchDiff(dir, base, invalid)).rejects.toThrow('Reviewed commit is unavailable locally')
    await expect(gitService.mergePreview(dir, invalid, base)).rejects.toThrow('Reviewed commit is unavailable locally')
    await expect(gitService.mergePreview(dir, base, invalid)).rejects.toThrow('Reviewed commit is unavailable locally')
    await expect(gitService.merge(dir, invalid)).rejects.toThrow('Reviewed commit is unavailable locally')
  }
  expect(git(dir, 'rev-parse', 'HEAD').trim()).toBe(base)
  expect(git(dir, 'status', '--porcelain')).toBe('')
  expect(await gitService.mergeInProgress(dir)).toBeNull()
})

test('LG-020 branch selection still refuses a missing local branch even when origin has it', async () => {
  const dir = repo()
  git(dir, 'update-ref', 'refs/remotes/origin/feature', 'HEAD')
  expect((await gitService.branchDiff(dir, 'main', 'origin/feature')).aheadCommits).toEqual([])
  await expect(gitService.branchDiff(dir, 'main', 'feature')).rejects.toThrow('Branch no longer exists: feature')
  await expect(gitService.mergePreview(dir, 'feature')).rejects.toThrow('Branch no longer exists: feature')
  await expect(gitService.merge(dir, 'feature')).rejects.toThrow('Branch no longer exists: feature')
})

for (const available of [true, false]) {
  test(`LG-059 PR dialog ${available ? 'enables' : 'blocks'} merge after real-Git pinned previews`, async () => {
    const dir = repo(), base = git(dir, 'rev-parse', 'HEAD').trim()
    git(dir, 'checkout', '-qb', 'feature')
    const head = commit(dir, 'feature.txt', 'feature\n', 'reviewed feature')
    git(dir, 'checkout', '-q', 'main')
    const pr = { number: 637, title: 'PR', headBranch: 'feature', baseBranch: 'main',
      headSha: available ? head : '1'.repeat(40), baseSha: base, author: 'me' }
    const previews = [], requests = [], merges = [], noop = () => {}
    const api = {
      fetch: async () => {},
      mergePreview: (...args) => {
        requests.push(['preview', ...args])
        const work = gitService.mergePreview(...args); previews.push(work); return work
      },
      branchDiff: (...args) => {
        requests.push(['diff', ...args])
        const work = gitService.branchDiff(...args); previews.push(work); return work
      },
      githubMergePR: async args => merges.push(args),
    }
    const h = component('src/components/overview/OverviewPanel.tsx', {
      '@/ipc': { ipc: api }, '@/stores/operationStore': { useOperationStore: store({ run: (_, fn) => fn() }) },
      '@/lib/useDialogOverlayDismiss': { useDialogOverlayDismiss: () => ({}) },
      '@/stores/repoStore': { useRepoStore: store({ currentBranch: 'main', refreshStatus: noop,
        bumpSyncTick: noop, bumpHistoryTick: noop, bumpPrTick: noop }) },
      '@/stores/statusToastStore': { useStatusToastStore: store({ show: noop }) },
      '@/stores/errorStore': { useErrorStore: store({ pushRaw: noop }) }, '@/lib/fetchState': { markFetchPerformed: noop },
    }, { __privateExports: ['ResolveDialog'] })
    const props = { pr, ghSlug: 'o/r', repoPath: dir, onClose: noop, onDone: noop }
    const confirm = tree => find(tree, n => n.type === 'button' && n.props.children.flat().join('') === 'Merge PR')
    const flush = () => new Promise(resolve => setImmediate(resolve))
    let tree = h.render('ResolveDialog', props)
    expect(confirm(tree).props.disabled).toBe(true)
    h.effects[0](); await flush()
    h.render('ResolveDialog', props); h.effects[1](); h.effects[2]()
    await Promise.allSettled(previews); await flush()
    tree = h.render('ResolveDialog', props)
    expect(requests).toEqual([['preview', dir, pr.headSha, base], ['diff', dir, base, pr.headSha]])
    expect(confirm(tree).props.disabled).toBe(!available)
    await confirm(tree).props.onClick()
    expect(merges).toEqual(available ? [{ owner: 'o', repo: 'r', prNumber: 637, repoPath: dir, expectedSha: head }] : [])
  })
}
