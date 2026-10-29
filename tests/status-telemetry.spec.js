// What the status log records about each scan, and that recording it changes nothing else.
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { DIST, git, tmpDir, cleanup } = require('./helpers')

const { logService } = require(path.join(DIST, 'services', 'LogService.js'))
const { gitService } = require(path.join(DIST, 'services', 'GitService.js'))
const { noteWatcherFire, flushStatusTelemetry } = require(path.join(DIST, 'util', 'status-telemetry.js'))

function repoWithChanges() {
  const dir = tmpDir('lg-status-telemetry-')
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'two\n')
  fs.mkdirSync(path.join(dir, 'new'))
  fs.writeFileSync(path.join(dir, 'new', 'a.txt'), 'a\n')
  fs.writeFileSync(path.join(dir, 'new', 'b.txt'), 'b\n')
  return dir
}

const logText = () => logService.getFormattedText()

test.beforeEach(() => logService.init(tmpDir('lg-status-telemetry-log-'), 'test'))
test.afterEach(() => logService.endSession())
test.afterAll(cleanup)

test('status returns the same files and the summary counts each scan by source', async () => {
  const repo = repoWithChanges()
  const files = await gitService.status(repo)
  expect(files.map(file => file.path).sort()).toEqual(['new/a.txt', 'new/b.txt', 'tracked.txt'])
  await gitService.status(repo, 'stage')
  await gitService.status(repo, 'stage')

  flushStatusTelemetry()
  const text = logText()
  expect(text).toMatch(/3 scans \(stage 2, ipc 1\)/)
  expect(text).toMatch(/run p50 .* p95 .* max /)
  expect(text).toMatch(/0 failed/)
  // Fast scans are folded into the summary, not logged one by one.
  expect(text).not.toMatch(/scan ran/)
})

test('a failed scan is logged on its own with its source and the watcher change behind it', async () => {
  const notARepo = tmpDir('lg-status-telemetry-plain-')
  noteWatcherFire(notARepo, 'Content/Maps/Level.umap', 14)

  await expect(gitService.status(notARepo, 'monitor')).rejects.toThrow()

  const text = logText()
  expect(text).toMatch(/WARN\s+git\.status\s+monitor scan ran .* waited .*failed: /)
  expect(text).toMatch(/watcher .* before the request \(14 events, first: Content\/Maps\/Level\.umap\)/)

  flushStatusTelemetry()
  expect(logText()).toMatch(/1 failed/)
  expect(logText()).toMatch(/1 watcher fires from 14 events, busiest: Content\/Maps x1/)
})

test('without a recent watcher fire the log says so rather than guessing a trigger', async () => {
  const notARepo = tmpDir('lg-status-telemetry-plain-')
  await expect(gitService.status(notARepo)).rejects.toThrow()
  expect(logText()).toMatch(/ipc scan ran .*no watcher fire this session/)
})
