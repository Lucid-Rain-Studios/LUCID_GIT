// Remote resolution and repair scoping.
//
// Two things here reach past the repository the user is working in: the
// default-branch probe talks to the network, and the LFS recovery edits git
// config. Both were unbounded once, and both are pinned now.
const { test, expect } = require('@playwright/test')
const path = require('path')
const { DIST, git, tmpDir, cleanup, countGitSpawns } = require('./helpers')

const { gitService } = require(path.join(DIST, 'services', 'GitService.js'))

/** A repo with a real (local, bare) origin, so no test touches the internet. */
function repoWithOrigin() {
  const repo = tmpDir('lg-remote-')
  const bare = path.join(tmpDir('lg-origin-'), 'origin.git')
  require('child_process').execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'pipe' })
  git(repo, 'init', '-q', '-b', 'main', '.')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  require('fs').writeFileSync(path.join(repo, 'README.md'), 'hi')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', bare)
  git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  git(repo, 'fetch', '-q', 'origin')
  return repo
}

test.afterAll(cleanup)

test('the default branch is resolved once and then served from cache', async () => {
  const repo = repoWithOrigin()

  const cold = await countGitSpawns(() => Promise.all([
    gitService.defaultBranch(repo), gitService.defaultBranch(repo),
  ]))
  expect(cold.value[0]).toBe('main')
  expect(cold.value[1]).toBe('main')

  const warm = await countGitSpawns(() => gitService.defaultBranch(repo))
  expect(warm.spawns).toBe(0)
  expect(warm.value).toBe('main')
})

test('the remote HEAD probe gives up rather than hanging', async () => {
  const repo = repoWithOrigin()
  const GitServiceClass = gitService.constructor
  const real = GitServiceClass.REMOTE_HEAD_PROBE_MS

  // An unreachable deadline stands in for a stalled connection. The old
  // `git remote show origin` had no deadline at all and simply never returned.
  GitServiceClass.REMOTE_HEAD_PROBE_MS = 1
  const startedAt = Date.now()
  const probed = await gitService.probeRemoteHead(repo)
  const elapsed = Date.now() - startedAt
  GitServiceClass.REMOTE_HEAD_PROBE_MS = real

  expect(probed).toBeNull()
  expect(elapsed).toBeLessThan(5000)
})

test('a repo with no origin/HEAD still resolves, without the network', async () => {
  const repo = repoWithOrigin()
  // Clear the fast path so resolution has to fall past it.
  try { git(repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD') } catch { /* may not exist */ }
  gitService.invalidateRemoteUrl(repo)

  const GitServiceClass = gitService.constructor
  const real = GitServiceClass.REMOTE_HEAD_PROBE_MS
  GitServiceClass.REMOTE_HEAD_PROBE_MS = 1 // force the probe to time out
  const name = await gitService.defaultBranch(repo)
  GitServiceClass.REMOTE_HEAD_PROBE_MS = real

  // The local main/master probe is the safety net under the network call.
  expect(name).toBe('main')
})

test('LFS recovery repairs the repo without touching global git config', async () => {
  const repo = tmpDir('lg-recover-')
  git(repo, 'init', '-q', '.')

  const globalFilters = () => {
    try {
      return require('child_process')
        .execFileSync('git', ['config', '--global', '--get-regexp', '^filter\.lfs\.'], { stdio: 'pipe' })
        .toString()
    } catch {
      return '' // none configured globally
    }
  }
  const before = globalFilters()

  await gitService.recoverLfsAndMergeState(repo)

  // The repair must land in this repository's own config...
  const local = git(repo, 'config', '--local', '--get-regexp', '^filter\.lfs\.')
  expect(local).toContain('filter.lfs.smudge')
  expect(local).toContain('filter.lfs.clean')

  // ...and nowhere else. Without --local this reconfigures Git LFS for every
  // repository the developer owns, and leaves a window with none configured.
  expect(globalFilters()).toBe(before)
})
