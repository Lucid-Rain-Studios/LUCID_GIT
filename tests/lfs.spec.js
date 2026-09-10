// Git LFS behaviour: caching, de-duplication, and the pointer repair.
//
// The repair is the one that must never be got wrong. It rewrites files in the
// working tree, so a mistake in what it considers "damaged" destroys work that
// was never committed.
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const {
  DIST, git, tmpDir, cleanup, lfsRepo, breakToPointer, sizeOf, countGitSpawns,
} = require('./helpers')

const { gitService } = require(path.join(DIST, 'services', 'GitService.js'))

test.afterAll(cleanup)

test('concurrent callers share one scan, and a warm cache spawns nothing', async () => {
  const repo = lfsRepo(['Hero'])

  const first = await countGitSpawns(() => Promise.all([
    gitService.lfsStatus(repo), gitService.lfsStatus(repo), gitService.lfsStatus(repo),
  ]))
  const [a, b, c] = first.value
  // One scan, not three: the panels all ask for this on repo open.
  expect(a).toBe(b)
  expect(b).toBe(c)
  expect(first.spawns).toBeLessThanOrEqual(3)

  const warm = await countGitSpawns(() => gitService.lfsStatus(repo))
  expect(warm.spawns).toBe(0)
})

test('a failed scan is remembered briefly, and force retries it', async () => {
  const repo = lfsRepo(['Hero'])
  gitService.invalidateLfsCache(repo)

  const GitServiceClass = gitService.constructor
  const realBudget = GitServiceClass.LFS_SCAN_BUDGET_MS
  GitServiceClass.LFS_SCAN_BUDGET_MS = -1

  let firstError = ''
  try { await gitService.lfsStatus(repo) } catch (e) { firstError = e.message }
  expect(firstError).toContain('took too long')

  // The remembered failure answers instantly instead of restarting the scan —
  // without it, every re-render started the whole thing again.
  const cached = await countGitSpawns(async () => {
    try { await gitService.lfsStatus(repo) } catch (e) { return e.message }
  })
  expect(cached.spawns).toBe(0)
  expect(cached.value).toBe(firstError)

  // An explicit Refresh must not be answered from that memory.
  GitServiceClass.LFS_SCAN_BUDGET_MS = realBudget
  const forced = await countGitSpawns(() => gitService.lfsStatus(repo, true))
  expect(forced.spawns).toBeGreaterThan(0)
  expect(forced.value.tracked).toContain('*.uasset')
})

test('the scan budget stays inside the handler deadline but does not undercut it', () => {
  // A budget shorter than the 30s read deadline by more than a moment fails
  // scans that used to succeed. This pins the relationship, not the number.
  const budget = gitService.constructor.LFS_SCAN_BUDGET_MS
  expect(budget).toBeLessThan(30_000)
  expect(budget).toBeGreaterThanOrEqual(25_000)
})

test('restore repairs pointer stubs from the local cache, offline', async () => {
  const repo = lfsRepo(['Hero', 'Level', 'Prop'])
  breakToPointer(repo, 'Hero')
  breakToPointer(repo, 'Level')
  expect(sizeOf(repo, 'Hero')).toBeLessThan(1024)

  const steps = []
  const result = await gitService.lfsRestore(repo, false, s => steps.push(s.label))

  expect(result).toEqual({ restored: 2, remaining: 0, remainingBytes: 0 })
  expect(sizeOf(repo, 'Hero')).toBe(200_000)
  expect(sizeOf(repo, 'Level')).toBe(200_000)
  expect(sizeOf(repo, 'Prop')).toBe(200_000)
  // Everything was cached, so nothing should have reached for the network.
  expect(steps.some(l => /Download/i.test(l))).toBe(false)
})

test('restore never rewrites a file the user actually edited', async () => {
  const repo = lfsRepo(['Edited', 'Broken'])
  const myWork = Buffer.from('UNCOMMITTED WORK '.repeat(4000))
  fs.writeFileSync(path.join(repo, 'Edited.uasset'), myWork)
  breakToPointer(repo, 'Broken')

  // Both are "-" in `git lfs ls-files`: neither working copy is the tracked
  // object. Only one of them is damage.
  const marks = git(repo, 'lfs', 'ls-files')
  expect(marks).toContain('- Edited.uasset')
  expect(marks).toContain('- Broken.uasset')

  const result = await gitService.lfsRestore(repo, false)

  expect(fs.readFileSync(path.join(repo, 'Edited.uasset')).equals(myWork)).toBe(true)
  expect(sizeOf(repo, 'Broken')).toBe(200_000)
  // The edit must not be counted as outstanding, or the panel raises a false
  // alarm and the download gate opens for no reason.
  expect(result).toEqual({ restored: 1, remaining: 0, remainingBytes: 0 })
})

test('restore prices the download and does not start it unasked', async () => {
  // A clone whose smudge was skipped: pointers on disk, objects never cached.
  // This is the state a failed fetch leaves, and `git status` calls it clean.
  const source = lfsRepo(['Hero', 'Level'])
  const bare = path.join(tmpDir('lg-remote-'), 'origin.git')
  require('child_process').execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' })
  git(source, 'remote', 'add', 'origin', bare)
  git(source, 'push', '-q', 'origin', 'HEAD:refs/heads/main')

  const clone = path.join(tmpDir('lg-clone-'), 'work')
  require('child_process').execFileSync('git', ['clone', '-q', bare, clone],
    { stdio: 'pipe', env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } })
  git(clone, 'lfs', 'install', '--local')

  expect(git(clone, 'status', '--porcelain').trim()).toBe('')
  expect(sizeOf(clone, 'Hero')).toBeLessThan(1024)

  const declined = []
  const preview = await gitService.lfsRestore(clone, false, s => declined.push(s.label))
  expect(preview.remaining).toBe(2)
  expect(preview.remainingBytes).toBe(400_000)
  expect(declined.some(l => /Download/i.test(l))).toBe(false)
  expect(sizeOf(clone, 'Hero')).toBeLessThan(1024)

  const accepted = []
  const done = await gitService.lfsRestore(clone, true, s => accepted.push(s.label))
  expect(done).toEqual({ restored: 2, remaining: 0, remainingBytes: 0 })
  expect(sizeOf(clone, 'Hero')).toBe(200_000)
  expect(accepted.some(l => /Download/i.test(l))).toBe(true)
})
