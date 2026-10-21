import { readJson, writeJsonAsync, isRecord } from '../util/json-store'
import * as path from 'path'
import { app } from 'electron'
import { logService } from './LogService'
import type { AppSettings, DesktopNotificationEvents, FeatureVisibilitySettings } from '../types'

export type { AppSettings } from '../types'

export const FEATURE_VISIBILITY_DEFAULTS: FeatureVisibilitySettings = {
  unreal: 'auto',
  lfs:    'auto',
}

export const DESKTOP_NOTIFICATION_DEFAULTS: DesktopNotificationEvents = {
  // Tier 1 — high signal
  appUpdate:         true,
  prResolved:        true,
  forceUnlock:       true,
  operationComplete: true,
  fatalError:        true,
  // Tier 2 — opt-in
  conflictForecast:  false,
  lockOnDirtyFile:   false,
}

const DEFAULTS: AppSettings = {
  autoFetchIntervalMinutes: 5,
  updateCheckIntervalMinutes: 30,
  defaultCloneDepth: 50,
  largeFileWarnMB: 100,
  scheduledCleanup: {
    enabled: false,
    frequencyDays: 7,
    includeGc: true,
    includePruneLfs: true,
  },
  fontFamily: 'system-ui',
  fontSize: 13,
  uiDensity: 'normal',
  theme: 'dark',
  codeFontFamily: 'Menlo',
  fontWeight: 500,
  borderRadius: 'default',
  defaultBranchName: 'main',
  desktopNotificationEvents: { ...DESKTOP_NOTIFICATION_DEFAULTS },
  featureVisibility: { ...FEATURE_VISIBILITY_DEFAULTS },
  preferredTerminal: 'auto',
}

type SettingsListener = (settings: AppSettings) => void

/** One field of a nested settings object (featureVisibility, desktopNotificationEvents, scheduledCleanup). */
function validNestedField(key: string, field: string, setting: unknown): boolean {
  const expected = DEFAULTS[key as keyof AppSettings]
  if (!isRecord(expected) || !(field in expected)) return false
  return key === 'featureVisibility'
    ? ['auto', 'show', 'hide'].includes(String(setting))
    : typeof setting === typeof (expected as Record<string, unknown>)[field]
}

function validSetting(key: string, item: unknown): boolean {
  const expected = DEFAULTS[key as keyof AppSettings]
  if (expected === undefined) return false
  if (isRecord(expected)) return isRecord(item) && Object.entries(item).every(([field, setting]) => validNestedField(key, field, setting))
  if (typeof item !== typeof expected || (typeof item === 'number' && (!Number.isFinite(item) || item < 0))) return false
  if (key === 'theme') return ['dark', 'darker', 'midnight', 'dracula', 'nord', 'catppuccin', 'tokyo-night', 'ocean', 'forest', 'rose-pine', 'monokai'].includes(String(item))
  if (key === 'uiDensity') return ['compact', 'normal', 'relaxed'].includes(String(item))
  return true
}

/** Strict check for values being saved: a bad patch is rejected whole. */
function validSettings(value: unknown): value is Partial<AppSettings> {
  return isRecord(value) && Object.entries(value).every(([key, item]) => validSetting(key, item))
}

/**
 * Keep every valid stored setting and drop only what is unknown or invalid
 * (a key from another version, a retired theme, a wrong type). One bad entry
 * must not make the whole file, and with it the app's settings, unreadable.
 */
export function sanitizeStoredSettings(value: Record<string, unknown>): { settings: Partial<AppSettings>; dropped: string[] } {
  const settings: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (validSetting(key, item)) { settings[key] = item; continue }
    const expected = DEFAULTS[key as keyof AppSettings]
    if (isRecord(expected) && isRecord(item)) {
      const kept: Record<string, unknown> = {}
      for (const [field, setting] of Object.entries(item)) {
        if (validNestedField(key, field, setting)) kept[field] = setting
        else dropped.push(`${key}.${field}`)
      }
      settings[key] = kept
    } else dropped.push(key)
  }
  return { settings: settings as Partial<AppSettings>, dropped }
}

const reportedDrops = new Set<string>()

class SettingsService {
  private listeners = new Set<SettingsListener>()

  private filePath(): string {
    return path.join(app.getPath('userData'), 'lucid-git-settings.json')
  }

  getAll(): AppSettings {
    const raw = readJson(this.filePath(), isRecord, {})
    const { settings: stored, dropped } = sanitizeStoredSettings(raw)
    // getAll runs often; report each distinct set of ignored entries once.
    const signature = dropped.join('\0')
    if (dropped.length && !reportedDrops.has(signature)) {
      reportedDrops.add(signature)
      logService.warn('settings', `Ignored ${dropped.length} unknown or invalid stored setting(s) in ${path.basename(this.filePath())}: ${dropped.join(', ')}. All other settings were kept; the file itself was not modified.`)
    }
    return { ...DEFAULTS, ...stored,
      desktopNotificationEvents: { ...DESKTOP_NOTIFICATION_DEFAULTS, ...stored.desktopNotificationEvents },
      featureVisibility: { ...FEATURE_VISIBILITY_DEFAULTS, ...stored.featureVisibility },
    }
  }

  private writes: Promise<void> = Promise.resolve()

  save(patch: Partial<AppSettings>): Promise<void> {
    if (!validSettings(patch)) return Promise.reject(new Error('Invalid settings values'))
    const pending = this.writes.then(() => this.savePatch(patch))
    this.writes = pending.catch(() => {})
    return pending
  }

  private async savePatch(patch: Partial<AppSettings>): Promise<void> {
    const current = this.getAll()
    const settings = { ...current, ...patch }
    const normalized: AppSettings = {
      ...DEFAULTS,
      ...settings,
      defaultBranchName: (settings.defaultBranchName ?? 'main').trim() || 'main',
      preferredTerminal: settings.preferredTerminal ?? 'auto',
      desktopNotificationEvents: {
        ...DESKTOP_NOTIFICATION_DEFAULTS,
        ...current.desktopNotificationEvents,
        ...(patch.desktopNotificationEvents ?? {}),
      },
      featureVisibility: {
        ...FEATURE_VISIBILITY_DEFAULTS,
        ...current.featureVisibility,
        ...(patch.featureVisibility ?? {}),
      },
    }
    await writeJsonAsync(this.filePath(), normalized)
    for (const listener of this.listeners) listener(normalized)
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export const settingsService = new SettingsService()
