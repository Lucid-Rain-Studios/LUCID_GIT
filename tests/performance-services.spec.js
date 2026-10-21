const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { component } = require('./renderer-harness')

const { performanceOf } = component('electron/util/performance.ts').exports

function settingState() {
  const state = { perf: { ...performanceOf('medium') }, active: true }
  return { state, performanceService: { get: () => state.perf, isActive: () => state.active, onChange() {} } }
}

test('the file watcher debounce follows the Performance setting', async () => {
  const { state, performanceService } = settingState()
  const delays = [], watchers = []
  let timer = 0
  const { watcherService } = component('electron/services/WatcherService.ts', {
    'node:fs': { watch: (_root, _options, callback) => { watchers.push(callback); return { on() {}, close() {} } } },
    '../util/dugite-exec': { exec: async args => ({ stdout: args.includes('--absolute-git-dir') || args.includes('--git-common-dir') ? 'H:/r/.git' : '' }) },
    './LogService': { logService: { warn() {} } }, './PerformanceService': { performanceService },
  }, { process: { platform: 'win32' }, setTimeout: (_fn, ms) => { delays.push(ms); return ++timer }, clearTimeout() {} }).exports
  await watcherService.watch('H:/r', () => {})
  watchers[0]('change', 'Content/a.uasset')
  state.perf = { ...state.perf, watcherDelayMs: 2000 }
  watchers[0]('change', 'Content/b.uasset')
  expect(delays).toEqual([1000, 2000])
  watcherService.unwatchAll()
})

test('lock polling uses the configured interval, skips hidden windows and reschedules on change', () => {
  const { state, performanceService } = settingState()
  const polls = [], intervals = []
  const { lockService } = component('electron/services/LockService.ts', {
    electron: { BrowserWindow: { getAllWindows: () => [] } }, './PerformanceService': { performanceService },
  }, { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length }, clearInterval() {} }).exports
  lockService.listLocks = async () => []
  lockService.poll = async repo => { polls.push(repo) }
  lockService.startPolling('A')
  expect(intervals[0].ms).toBe(45_000)
  intervals[0].fn()
  expect(polls).toEqual(['A'])
  state.active = false
  intervals[0].fn()
  expect(polls).toEqual(['A'])
  state.perf = { ...state.perf, lockPollSeconds: 60 }
  lockService.reschedulePolling()
  expect(intervals.at(-1).ms).toBe(60_000)
})

test('conflict forecast follows the configured interval and Manual only schedules nothing', () => {
  const { state, performanceService } = settingState()
  const intervals = []
  const { forecastService } = component('electron/services/ForecastService.ts', {
    './GitService': { gitService: {} }, '../util/repo-gate': { withRepoSlot: async (_repo, _mode, fn) => fn(), repoSlotState: () => ({}) },
    electron: { BrowserWindow: { getAllWindows: () => [] } }, '../util/dugite-exec': {}, '../ipc/channels': { CHANNELS: {} },
    './DesktopNotificationService': { desktopNotificationService: {} }, './PerformanceService': { performanceService },
  }, { setInterval: (_fn, ms) => { intervals.push(ms); return intervals.length }, clearInterval() {} }).exports
  forecastService.poll = async () => {}
  forecastService.start('A')
  expect(intervals).toEqual([10 * 60_000])
  state.perf = { ...state.perf, forecastMinutes: 0 }
  forecastService.start('A')
  expect(intervals).toHaveLength(1)
  expect(forecastService.getStatus('A').intervalMinutes).toBe(0)
})

test('thumbnails are skipped entirely when turned off', async () => {
  const state = { perf: { ...performanceOf('medium'), thumbnails: 'off' } }
  const { assetDiffService } = component('electron/services/AssetDiffService.ts', {
    fs, path, os: require('os'), crypto: require('crypto'), sharp: () => {},
    '../util/dugite-exec': {}, './AuthService': { authService: {} }, './GitService': { gitService: {} }, './UEHeadlessService': { ueHeadlessService: {} },
    './PerformanceService': { performanceService: { get: () => state.perf } },
  }, { Buffer }).exports
  let identified = 0
  assetDiffService.identity = async () => { identified++; return null }
  expect(await assetDiffService.renderThumbnail('repo', 'Hero.uasset', 'HEAD')).toBeNull()
  expect(identified).toBe(0)
  state.perf = { ...state.perf, thumbnails: 'selected' }
  expect(await assetDiffService.renderThumbnail('repo', 'Hero.uasset', 'HEAD')).toBeNull()
  expect(identified).toBe(1)
})

test('visible polling skips hidden ticks and catches up when the window returns', () => {
  const listeners = {}
  const document = { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn }, removeEventListener: name => { delete listeners[name] } }
  const intervals = []
  let now = 0
  const { pollWhileVisible } = component('src/lib/visiblePolling.ts', {}, {
    document, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1 }, clearInterval() {},
    Date: { now: () => now },
  }).exports
  let runs = 0
  const stop = pollWhileVisible(() => { runs++ }, 30_000)
  expect(intervals[0].ms).toBe(30_000)
  now = 30_000; intervals[0].fn()
  expect(runs).toBe(1)
  document.hidden = true
  now = 60_000; intervals[0].fn(); now = 90_000; intervals[0].fn()
  expect(runs).toBe(1)
  document.hidden = false; now = 95_000
  listeners.visibilitychange()
  expect(runs).toBe(2)
  listeners.visibilitychange()
  expect(runs).toBe(2)
  stop()
  expect(listeners.visibilitychange).toBeUndefined()
})
