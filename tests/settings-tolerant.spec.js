const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { tmpDir, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
test.afterAll(cleanup)

function load(dir) {
  const warnings = []
  const { settingsService, sanitizeStoredSettings } = component('electron/services/SettingsService.ts', {
    electron: { app: { getPath: () => dir } },
    './LogService': { logService: { warn: (source, message) => warnings.push({ source, message }) } },
  }).exports
  return { settingsService, sanitizeStoredSettings, warnings, file: path.join(dir, 'lucid-git-settings.json') }
}

test('unknown and invalid entries are dropped while every valid setting is kept', () => {
  const dir = tmpDir('lg-settings-tolerant-')
  const { settingsService, warnings, file } = load(dir)
  fs.writeFileSync(file, JSON.stringify({
    fontSize: 16,
    theme: 'retired-theme',                       // no longer an allowed value
    futureOption: true,                           // written by another version
    autoFetchIntervalMinutes: 'often',            // wrong type
    largeFileWarnMB: -5,                          // out of range
    uiDensity: 'compact',
    desktopNotificationEvents: { appUpdate: false, brandNewEvent: true, fatalError: 'no' },
    featureVisibility: { lfs: 'hide', unreal: 'sometimes', extra: 'show' },
    scheduledCleanup: 'not an object',
  }))
  const settings = settingsService.getAll()
  expect(settings).toMatchObject({
    fontSize: 16, uiDensity: 'compact',
    theme: 'dark', autoFetchIntervalMinutes: 5, largeFileWarnMB: 100,       // defaults for the dropped ones
    desktopNotificationEvents: { appUpdate: false, fatalError: true, forceUnlock: true },
    featureVisibility: { lfs: 'hide', unreal: 'auto' },
    scheduledCleanup: { enabled: false, frequencyDays: 7 },
  })
  expect(settings).not.toHaveProperty('futureOption')
  expect(warnings).toHaveLength(1)
  expect(warnings[0].source).toBe('settings')
  for (const name of ['theme', 'futureOption', 'autoFetchIntervalMinutes', 'largeFileWarnMB', 'scheduledCleanup',
    'desktopNotificationEvents.brandNewEvent', 'desktopNotificationEvents.fatalError', 'featureVisibility.unreal', 'featureVisibility.extra']) {
    expect(warnings[0].message).toContain(name)
  }
  expect(warnings[0].message).not.toContain('fontSize')
})

test('reading never rewrites the file and repeated reads warn once', () => {
  const dir = tmpDir('lg-settings-tolerant-')
  const { settingsService, warnings, file } = load(dir)
  const original = JSON.stringify({ fontSize: 14, futureOption: 1 })
  fs.writeFileSync(file, original)
  settingsService.getAll(); settingsService.getAll(); settingsService.getAll()
  expect(fs.readFileSync(file, 'utf8')).toBe(original)
  expect(warnings).toHaveLength(1)
})

test('a fully valid file produces no warning and a missing file yields defaults', () => {
  const dir = tmpDir('lg-settings-tolerant-')
  const { settingsService, warnings, file } = load(dir)
  expect(settingsService.getAll().theme).toBe('dark')
  fs.writeFileSync(file, JSON.stringify({ theme: 'nord', fontWeight: 600 }))
  expect(settingsService.getAll()).toMatchObject({ theme: 'nord', fontWeight: 600 })
  expect(warnings).toEqual([])
})

test('corrupt JSON is still reported rather than silently replaced by defaults', () => {
  const dir = tmpDir('lg-settings-tolerant-')
  const { settingsService, file } = load(dir)
  fs.writeFileSync(file, '{broken')
  expect(() => settingsService.getAll()).toThrow('preserved for recovery')
  fs.writeFileSync(file, '[1, 2]')
  expect(() => settingsService.getAll()).toThrow('preserved for recovery')
})

test('saving after a tolerant read keeps valid settings and strict patch validation is unchanged', async () => {
  const dir = tmpDir('lg-settings-tolerant-')
  const { settingsService, file } = load(dir)
  fs.writeFileSync(file, JSON.stringify({ fontSize: 15, futureOption: true, theme: 'gone' }))
  await settingsService.save({ uiDensity: 'relaxed' })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(saved).toMatchObject({ fontSize: 15, uiDensity: 'relaxed', theme: 'dark' })
  expect(saved).not.toHaveProperty('futureOption')
  await expect(settingsService.save({ theme: 'gone' })).rejects.toThrow('Invalid settings')
  await expect(settingsService.save({ futureOption: true })).rejects.toThrow('Invalid settings')
  expect(settingsService.getAll().uiDensity).toBe('relaxed')
})
