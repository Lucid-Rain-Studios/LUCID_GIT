/**
 * Performance presets shared by the main process, the renderer and the settings
 * validator. Pure data and functions: nothing here may import Electron or React.
 *
 * Presence heartbeats are not a preset setting: teammates mark a device offline
 * after 180 seconds without one, so a slower heartbeat would look like a logout.
 *
 * High is deliberately no more demanding than the intervals the app shipped
 * with, so no preset can run hotter than the old behaviour.
 */

export type PreviewMode = 'off' | 'click' | 'auto'
export type ThumbnailMode = 'off' | 'selected' | 'history'
export type AnimationMode = 'off' | 'limited'
export type PerformancePresetName = 'low' | 'medium' | 'high'

export interface PerformanceSettings {
  /** Unreal 3D / mesh export viewers: never, only after a click, or opened automatically. */
  previews: PreviewMode
  /** Thumbnails: none, the selected file, or the selected file and its recent versions. */
  thumbnails: ThumbnailMode
  thumbnailWorkers: number
  mapDots: number
  animations: AnimationMode
  watcherDelayMs: number
  refreshOnFocus: boolean
  syncPollSeconds: number
  panelPollSeconds: number
  lockPollSeconds: number
  /** Conflict forecast interval; 0 polls once when started and then only on request. */
  forecastMinutes: number
}

/** Fields that live beside the performance object because other screens already edit them. */
export interface PerformanceIntervals {
  autoFetchIntervalMinutes: number
  updateCheckIntervalMinutes: number
}

export const MIN_POLL_SECONDS = 15
export const HISTORY_THUMBNAIL_VERSIONS = 10

export const PERFORMANCE_PRESETS: Record<PerformancePresetName, PerformanceSettings & PerformanceIntervals> = {
  low: {
    previews: 'off', thumbnails: 'off', thumbnailWorkers: 1, mapDots: 200, animations: 'off',
    watcherDelayMs: 2000, refreshOnFocus: false, syncPollSeconds: 60, panelPollSeconds: 120,
    lockPollSeconds: 60, forecastMinutes: 0,
    autoFetchIntervalMinutes: 15, updateCheckIntervalMinutes: 120,
  },
  medium: {
    previews: 'click', thumbnails: 'selected', thumbnailWorkers: 1, mapDots: 500, animations: 'limited',
    watcherDelayMs: 1000, refreshOnFocus: true, syncPollSeconds: 30, panelPollSeconds: 60,
    lockPollSeconds: 45, forecastMinutes: 10,
    autoFetchIntervalMinutes: 10, updateCheckIntervalMinutes: 60,
  },
  high: {
    previews: 'auto', thumbnails: 'history', thumbnailWorkers: 2, mapDots: 800, animations: 'limited',
    watcherDelayMs: 750, refreshOnFocus: true, syncPollSeconds: 20, panelPollSeconds: 45,
    lockPollSeconds: 30, forecastMinutes: 5,
    autoFetchIntervalMinutes: 5, updateCheckIntervalMinutes: 30,
  },
}

export const PERFORMANCE_PRESET_ORDER: PerformancePresetName[] = ['low', 'medium', 'high']

export function performanceOf(preset: PerformancePresetName): PerformanceSettings {
  const { previews, thumbnails, thumbnailWorkers, mapDots, animations, watcherDelayMs, refreshOnFocus, syncPollSeconds, panelPollSeconds, lockPollSeconds, forecastMinutes } = PERFORMANCE_PRESETS[preset]
  return { previews, thumbnails, thumbnailWorkers, mapDots, animations, watcherDelayMs, refreshOnFocus, syncPollSeconds, panelPollSeconds, lockPollSeconds, forecastMinutes }
}

export const DEFAULT_PERFORMANCE: PerformanceSettings = performanceOf('medium')

const OPTIONS: Partial<Record<keyof PerformanceSettings, readonly string[]>> = {
  previews: ['off', 'click', 'auto'],
  thumbnails: ['off', 'selected', 'history'],
  animations: ['off', 'limited'],
}

const RANGES: Partial<Record<keyof PerformanceSettings, [number, number]>> = {
  thumbnailWorkers: [1, 3],
  mapDots: [50, 1000],
  watcherDelayMs: [250, 10_000],
  syncPollSeconds: [MIN_POLL_SECONDS, 3600],
  panelPollSeconds: [MIN_POLL_SECONDS, 3600],
  lockPollSeconds: [MIN_POLL_SECONDS, 3600],
  forecastMinutes: [0, 240],
}

/** One stored performance field is acceptable; anything else is ignored rather than trusted. */
export function validPerformanceField(field: string, value: unknown): boolean {
  if (!(field in DEFAULT_PERFORMANCE)) return false
  const key = field as keyof PerformanceSettings
  const options = OPTIONS[key]
  if (options) return typeof value === 'string' && options.includes(value)
  const range = RANGES[key]
  if (range) return typeof value === 'number' && Number.isInteger(value) && value >= range[0] && value <= range[1]
  return typeof value === typeof DEFAULT_PERFORMANCE[key]
}

/** Fill missing or invalid fields from Medium, so callers always get a complete, bounded object. */
export function normalizePerformance(value: unknown): PerformanceSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const result: Record<string, unknown> = { ...DEFAULT_PERFORMANCE }
  for (const [field, item] of Object.entries(source)) if (validPerformanceField(field, item)) result[field] = item
  return result as unknown as PerformanceSettings
}

/** Preset whose every value matches, or 'custom' once any single setting has been changed. */
export function detectPreset(performance: PerformanceSettings, intervals: PerformanceIntervals): PerformancePresetName | 'custom' {
  const current: Record<string, unknown> = { ...performance, ...intervals }
  for (const name of PERFORMANCE_PRESET_ORDER) {
    const preset = PERFORMANCE_PRESETS[name] as unknown as Record<string, unknown>
    if (Object.keys(preset).every(key => preset[key] === current[key])) return name
  }
  return 'custom'
}
