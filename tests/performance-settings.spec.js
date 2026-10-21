const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { tmpDir, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
test.afterAll(cleanup)

const perf = component('electron/util/performance.ts').exports
const { PERFORMANCE_PRESETS: presets, MIN_POLL_SECONDS, detectPreset, normalizePerformance, performanceOf, validPerformanceField } = perf
const split = values => {
  const { autoFetchIntervalMinutes, updateCheckIntervalMinutes, ...performance } = values
  return [performance, { autoFetchIntervalMinutes, updateCheckIntervalMinutes }]
}

test('High is no more demanding than the intervals and caps the app shipped with', () => {
  const high = presets.high
  expect(high.syncPollSeconds).toBeGreaterThanOrEqual(15)
  expect(high.panelPollSeconds).toBeGreaterThanOrEqual(30)
  expect(high.lockPollSeconds).toBeGreaterThanOrEqual(30)
  expect(high.watcherDelayMs).toBeGreaterThanOrEqual(500)
  expect(high.thumbnailWorkers).toBeLessThanOrEqual(3)
  expect(high.mapDots).toBeLessThanOrEqual(1000)
  expect(high.forecastMinutes).toBeGreaterThanOrEqual(5)
  expect(high.autoFetchIntervalMinutes).toBeGreaterThanOrEqual(5)
  expect(high.updateCheckIntervalMinutes).toBeGreaterThanOrEqual(30)
})

test('presets get strictly lighter from High to Low and never poll faster than the floor', () => {
  for (const key of ['syncPollSeconds', 'panelPollSeconds', 'lockPollSeconds', 'watcherDelayMs', 'autoFetchIntervalMinutes', 'updateCheckIntervalMinutes']) {
    expect(presets.low[key]).toBeGreaterThan(presets.medium[key])
    expect(presets.medium[key]).toBeGreaterThan(presets.high[key])
  }
  for (const preset of Object.values(presets)) for (const key of ['syncPollSeconds', 'panelPollSeconds', 'lockPollSeconds']) expect(preset[key]).toBeGreaterThanOrEqual(MIN_POLL_SECONDS)
  expect(presets.low.thumbnailWorkers).toBeLessThanOrEqual(presets.high.thumbnailWorkers)
  expect(Object.keys(presets.medium)).not.toContain('presenceSeconds')
})

test('a preset is recognised until any single setting is changed', () => {
  for (const name of ['low', 'medium', 'high']) expect(detectPreset(...split(presets[name]))).toBe(name)
  const [performance, intervals] = split(presets.medium)
  expect(detectPreset({ ...performance, mapDots: 800 }, intervals)).toBe('custom')
  expect(detectPreset(performance, { ...intervals, autoFetchIntervalMinutes: 3 })).toBe('custom')
})

test('stored performance values are bounded and invalid fields fall back to Medium', () => {
  const medium = performanceOf('medium')
  expect(normalizePerformance(undefined)).toEqual(medium)
  expect(normalizePerformance({ syncPollSeconds: 1, lockPollSeconds: 20, previews: 'bogus', mapDots: 99999, thumbnails: 'history', unknown: true }))
    .toEqual({ ...medium, lockPollSeconds: 20, thumbnails: 'history' })
  expect(validPerformanceField('panelPollSeconds', 14)).toBe(false)
  expect(validPerformanceField('panelPollSeconds', 15)).toBe(true)
  expect(validPerformanceField('refreshOnFocus', 'yes')).toBe(false)
})

function loadSettings(dir) {
  const { settingsService } = component('electron/services/SettingsService.ts', {
    electron: { app: { getPath: () => dir } }, './LogService': { logService: { warn() {} } },
    '../util/performance': perf,
  }).exports
  return { settingsService, file: path.join(dir, 'lucid-git-settings.json') }
}

test('new installs default to Medium and a file from before Performance existed migrates untouched intervals only', async () => {
  const fresh = loadSettings(tmpDir('lg-perf-new-'))
  expect(fresh.settingsService.getAll()).toMatchObject({ autoFetchIntervalMinutes: 10, updateCheckIntervalMinutes: 60, performance: performanceOf('medium') })

  const legacy = loadSettings(tmpDir('lg-perf-legacy-'))
  fs.writeFileSync(legacy.file, JSON.stringify({ autoFetchIntervalMinutes: 5, updateCheckIntervalMinutes: 30, fontSize: 15 }))
  expect(legacy.settingsService.getAll()).toMatchObject({ autoFetchIntervalMinutes: 10, updateCheckIntervalMinutes: 60, fontSize: 15, performance: performanceOf('medium') })

  const chosen = loadSettings(tmpDir('lg-perf-chosen-'))
  fs.writeFileSync(chosen.file, JSON.stringify({ autoFetchIntervalMinutes: 2, updateCheckIntervalMinutes: 30 }))
  expect(chosen.settingsService.getAll()).toMatchObject({ autoFetchIntervalMinutes: 2, updateCheckIntervalMinutes: 60 })

  // Once Performance is stored the values are the user's, whatever they equal.
  fs.writeFileSync(chosen.file, JSON.stringify({ autoFetchIntervalMinutes: 5, performance: performanceOf('high') }))
  expect(chosen.settingsService.getAll()).toMatchObject({ autoFetchIntervalMinutes: 5, performance: performanceOf('high') })
})

test('saving merges partial performance changes and rejects out-of-range values whole', async () => {
  const { settingsService, file } = loadSettings(tmpDir('lg-perf-save-'))
  await settingsService.save({ performance: { mapDots: 200 } })
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).performance).toEqual({ ...performanceOf('medium'), mapDots: 200 })
  await expect(settingsService.save({ performance: { syncPollSeconds: 5 } })).rejects.toThrow('Invalid settings values')
  await expect(settingsService.save({ performance: { previews: 'sometimes' } })).rejects.toThrow('Invalid settings values')
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).performance.mapDots).toBe(200)
})

test('map dots follow the Performance limit and never exceed 1000', () => {
  const { mapVisiblePositions } = component('src/lib/mapReview.ts').exports
  const points = Array.from({ length: 1500 }, (_, i) => ({ object: { path: 'p' + i, name: 'n' + i }, x: i, y: i }))
  const base = { query: '', changedOnly: false, changedPaths: new Set() }
  expect(mapVisiblePositions(points, { ...base, limit: 200 })).toMatchObject({ total: 1500, omitted: 1300 })
  expect(mapVisiblePositions(points, { ...base, limit: 200 }).visible).toHaveLength(200)
  expect(mapVisiblePositions(points, { ...base, limit: 5000 }).visible).toHaveLength(1000)
  expect(mapVisiblePositions(points, base).visible).toHaveLength(1000)
})

