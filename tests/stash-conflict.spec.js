// Conflicts that are not merges.
//
// `git stash apply` merges the stashed changes into the working tree and can
// conflict exactly as a branch merge does — the same unmerged stages, the same
// per-file resolution — but it writes no MERGE_HEAD. Detection keyed off
// MERGE_HEAD alone left the resolver shut and handed the user a raw
// "CONFLICT (content)" dump with nowhere to go.
const { test, expect } = require('@playwright/test')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')

const { gitService } = require(path.join(DIST, 'services', 'GitService.js'))

/** A repo whose stash cannot be applied cleanly. */
function repoWithStashConflict() {
  const repo = tmpDir('lg-stash-')
  git(repo, 'init', '-q', '-b', 'main', '.')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'base')

  // Stash one edit, commit a different one over the same line, then bring the
  // stash back: the two cannot be reconciled.
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'from the stash\n')
  git(repo, 'stash', 'push', '-m', 'wip')
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'from the commit\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'diverge')

  try {
    git(repo, 'stash', 'apply', 'stash@{0}')
  } catch {
    // Expected: this is the state under test.
  }
  return repo
}

test.afterAll(cleanup)

test('a stash-apply conflict is reported, despite there being no MERGE_HEAD', async () => {
  const repo = repoWithStashConflict()
  expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
  expect(git(repo, 'ls-files', '-u').trim()).not.toBe('')

  const state = await gitService.mergeInProgress(repo)

  expect(state).not.toBeNull()
  expect(state.kind).toBe('conflict')
  expect(state.mergeHead).toBeNull()
  expect(state.unresolvedFiles).toContain('shared.txt')
})

test('a real merge is still reported as a merge', async () => {
  const repo = tmpDir('lg-realmerge-')
  git(repo, 'init', '-q', '-b', 'main', '.')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-q', '-b', 'feature')
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'feature\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'feature')
  git(repo, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'main\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'main')
  try { git(repo, 'merge', '--no-edit', 'feature') } catch { /* conflicts */ }

  const state = await gitService.mergeInProgress(repo)
  expect(state.kind).toBe('merge')
  expect(state.mergeHead).not.toBeNull()
  expect(state.mergedBranch).toBe('feature')
})

test('a clean repo reports nothing', async () => {
  const repo = tmpDir('lg-clean-')
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init')

  expect(await gitService.mergeInProgress(repo)).toBeNull()
})

test('resolving a stash conflict stages the chosen side and commits nothing', async () => {
  const repo = repoWithStashConflict()
  const headBefore = git(repo, 'rev-parse', 'HEAD').trim()

  await gitService.resolveMergeConflictText(repo, 'shared.txt', 'theirs')
  await gitService.continueMerge(repo, 'the incoming changes')

  // The stashed side won, and it is staged rather than committed: applying a
  // stash produces uncommitted work, and turning it into a commit here would
  // be a surprise the user never asked for.
  expect(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('from the stash\n')
  expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(headBefore)
  expect(git(repo, 'ls-files', '-u').trim()).toBe('')
  expect(git(repo, 'status', '--porcelain').trim()).toBe('M  shared.txt')
})

test('aborting explains itself when there is no merge to abort', async () => {
  const repo = repoWithStashConflict()
  await expect(gitService.abortMerge(repo)).rejects.toThrow(/no merge to abort/i)

  // And the conflicts are left intact rather than half-undone.
  expect(git(repo, 'ls-files', '-u').trim()).not.toBe('')
})
