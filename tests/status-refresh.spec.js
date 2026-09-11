// `git status` must be allowed to keep the index refresh it just paid for.
//
// After a merge rewrites thousands of files, every one has new stat data, so
// the next status re-hashes all of them — through the Git LFS clean filter,
// for LFS files. Git normally writes the refreshed index so the next status is
// nearly free. `--no-optional-locks` suppresses that write, and with it every
// status repeats the full cost forever.
//
// On a real Unreal repository mid-merge that turned the file list into a 30s
// timeout that repeated identically four times in a row, because nothing could
// ever make the second attempt cheaper than the first.
const { test, expect } = require('@playwright/test')
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')

const { gitService } = require(path.join(DIST, 'services', 'GitService.js'))

const FILES = 1500

/** An LFS repo whose tracked files all have stale stat data, as after a merge. */
function repoWithStaleStatData() {
  const repo = tmpDir('lg-refresh-')
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'lfs', 'install', '--local')
  git(repo, 'lfs', 'track', '*.uasset')
  for (let i = 0; i < FILES; i++) {
    const dir = path.join(repo, 'Content', 'Sub' + (i % 40))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'A' + i + '.uasset'), Buffer.alloc(40000, String(i % 10)))
  }
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo, stdio: 'pipe' })
  return repo
}

/** New mtimes, identical content — exactly what a merge checkout leaves. */
function invalidateStatCache(repo) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repo, stdio: 'pipe', maxBuffer: 1 << 28 })
    .toString().trim().split('\n')
  const now = new Date()
  for (const f of tracked) fs.utimesSync(path.join(repo, f), now, now)
}

test.afterAll(cleanup)

test('a repeated status gets cheaper, because the refresh is persisted', async () => {
  const repo = repoWithStaleStatData()
  invalidateStatCache(repo)

  const first = Date.now()
  await gitService.status(repo)
  const firstMs = Date.now() - first

  const second = Date.now()
  await gitService.status(repo)
  const secondMs = Date.now() - second

  // The first pass has to re-hash everything; the second must not. Measured on
  // 3,000 files: 2662ms then 31ms with the refresh persisted, versus 2641ms
  // then 2658ms with --no-optional-locks suppressing it.
  expect(firstMs).toBeGreaterThan(0)
  expect(secondMs).toBeLessThan(Math.max(firstMs * 0.5, 250))
})

test('status does not pass --no-optional-locks', async () => {
  const repo = repoWithStaleStatData()
  const dugite = require(path.join(__dirname, '..', 'node_modules', 'dugite'))
  const real = dugite.GitProcess.exec.bind(dugite.GitProcess)
  const seen = []
  dugite.GitProcess.exec = (args, ...rest) => {
    if (Array.isArray(args) && args.includes('status')) seen.push(args)
    return real(args, ...rest)
  }
  try {
    await gitService.status(repo)
  } finally {
    dugite.GitProcess.exec = real
  }

  expect(seen.length).toBeGreaterThan(0)
  // Pinned as an argument check as well as a timing one: the timing assertion
  // above would go quietly soft on a fast enough disk.
  for (const args of seen) expect(args).not.toContain('--no-optional-locks')
})
