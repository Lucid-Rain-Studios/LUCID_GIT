import React, { useEffect, useRef, useState } from 'react'
import { ipc } from '@/ipc'
import { SettingsError } from './SettingsError'
import {
  MIN_POLL_SECONDS, PERFORMANCE_PRESETS, PERFORMANCE_PRESET_ORDER, detectPreset, normalizePerformance,
  type PerformanceIntervals, type PerformancePresetName, type PerformanceSettings as Performance,
} from '../../../electron/util/performance'

const SETTINGS_CHANGED_EVENT = 'lucid-git:settings-changed'

type Values = Performance & PerformanceIntervals

interface Choice { label: string; value: string | number | boolean }
interface SettingRow { key: keyof Values; label: string; hint: string; choices: Choice[] }
interface SettingGroup { title: string; rows: SettingRow[] }

const seconds = (n: number): Choice => ({ label: n >= 120 && n % 60 === 0 ? `Every ${n / 60} min` : `Every ${n} s`, value: n })
const minutes = (n: number): Choice => ({ label: n >= 120 && n % 60 === 0 ? `Every ${n / 60} h` : `Every ${n} min`, value: n })

const GROUPS: SettingGroup[] = [
  { title: 'Previews', rows: [
    { key: 'previews', label: 'Engine previews', hint: 'Unreal 3D scene, mesh export and render viewers. Saved-data views are always available.',
      choices: [{ label: 'Off', value: 'off' }, { label: 'Click to load', value: 'click' }, { label: 'Open automatically', value: 'auto' }] },
    { key: 'thumbnails', label: 'Thumbnails', hint: 'Images embedded in assets, shown in file details and version history.',
      choices: [{ label: 'Off', value: 'off' }, { label: 'Selected file only', value: 'selected' }, { label: 'Selected + last 10 versions', value: 'history' }] },
    { key: 'thumbnailWorkers', label: 'Thumbnail workers', hint: 'Thumbnails prepared at the same time.',
      choices: [{ label: '1', value: 1 }, { label: '2', value: 2 }] },
    { key: 'mapDots', label: 'Map dots shown', hint: 'Fewer dots keep map panning smooth.',
      choices: [200, 500, 800].map(n => ({ label: String(n), value: n })) },
  ] },
  { title: 'Interface', rows: [
    { key: 'animations', label: 'Animated glow', hint: 'Pulsing highlight on the Fetch, Pull and Commit buttons.',
      choices: [{ label: 'Off', value: 'off' }, { label: 'Limited (3 cycles)', value: 'limited' }] },
  ] },
  { title: 'Refresh', rows: [
    { key: 'watcherDelayMs', label: 'File-change delay', hint: 'How long to wait after the last file change before refreshing the changes list.',
      choices: [{ label: '2 s', value: 2000 }, { label: '1 s', value: 1000 }, { label: '750 ms', value: 750 }] },
    { key: 'refreshOnFocus', label: 'Refresh on window focus', hint: 'Catches edits made in Unreal or Explorer while Lucid Git was in the background.',
      choices: [{ label: 'Off', value: false }, { label: 'On', value: true }] },
    { key: 'autoFetchIntervalMinutes', label: 'Auto-fetch', hint: 'Check the remote for new commits.',
      choices: [{ label: 'Disabled', value: 0 }, ...[5, 10, 15, 30].map(minutes)] },
    { key: 'syncPollSeconds', label: 'Ahead / behind check', hint: 'Sidebar commit counters.',
      choices: [20, 30, 60].map(seconds) },
    { key: 'panelPollSeconds', label: 'Pull requests and activity checks', hint: 'GitHub, forecast and activity panels.',
      choices: [45, 60, 120].map(seconds) },
  ] },
  { title: 'Team', rows: [
    { key: 'lockPollSeconds', label: 'Lock polling', hint: 'How soon new locks from teammates appear.',
      choices: [30, 45, 60].map(seconds) },
    { key: 'forecastMinutes', label: 'Conflict forecast', hint: 'Once started, how often it checks for merge conflicts. Manual only checks when started.',
      choices: [{ label: 'Manual only', value: 0 }, ...[5, 10].map(minutes)] },
    { key: 'updateCheckIntervalMinutes', label: 'Update check', hint: 'Look for a new Lucid Git version.',
      choices: [{ label: 'Disabled', value: 0 }, ...[30, 60, 120].map(minutes)] },
  ] },
]

const PRESET_BLURB: Record<PerformancePresetName, string> = {
  low: 'Lightest. Slower to notice remote changes; engine previews and thumbnails stay off.',
  medium: 'Balanced. Recommended for large Unreal repositories.',
  high: 'Most responsive, still no more demanding than the original defaults.',
}

const select = 'bg-lg-bg-primary border border-lg-border rounded px-2 py-1 text-[11px] font-mono text-lg-text-primary focus:outline-none focus:border-lg-accent w-52'

function valuesOf(preset: PerformancePresetName): Values { return { ...PERFORMANCE_PRESETS[preset] } }

/** Merge a stored value that is not one of the listed choices (e.g. a 3-minute auto-fetch) so it still shows. */
function choicesFor(row: SettingRow, current: unknown): Choice[] {
  if (row.choices.some(choice => choice.value === current) || current === undefined) return row.choices
  const label = typeof current === 'number' ? `${current} (custom)` : String(current)
  return [...row.choices, { label, value: current as Choice['value'] }]
}

export function PerformanceSettings() {
  const [values, setValues] = useState<Values>(valuesOf('medium'))
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writes = useRef<Promise<void>>(Promise.resolve())

  const load = () => {
    setError(null)
    return ipc.settingsGet().then(settings => {
      setValues({
        ...normalizePerformance(settings.performance),
        autoFetchIntervalMinutes: settings.autoFetchIntervalMinutes,
        updateCheckIntervalMinutes: settings.updateCheckIntervalMinutes,
      })
      setLoaded(true)
    }).catch(e => setError(`Could not load settings: ${String(e)}`))
  }
  useEffect(() => { void load() }, [])

  const save = (next: Values) => {
    setValues(next)
    setSaved(false)
    const { autoFetchIntervalMinutes, updateCheckIntervalMinutes, ...performance } = next
    // Writes are queued so a quick second change cannot be overtaken by the first.
    writes.current = writes.current
      .then(() => ipc.settingsSave({ performance, autoFetchIntervalMinutes, updateCheckIntervalMinutes }))
      .then(() => { setError(null); setSaved(true); window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT)) })
      .catch(e => { setError(`Could not save settings: ${String(e)}. Change a setting to retry.`) })
  }

  const { autoFetchIntervalMinutes, updateCheckIntervalMinutes, ...performance } = values
  const preset = detectPreset(performance, { autoFetchIntervalMinutes, updateCheckIntervalMinutes })

  return (
    <div>
      {error && <SettingsError error={error} onRetry={load} />}

      <Section title="Preset">
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Performance preset">
          {PERFORMANCE_PRESET_ORDER.map(name => (
            <button
              key={name}
              disabled={!loaded}
              aria-pressed={preset === name}
              onClick={() => save(valuesOf(name))}
              className={'text-left rounded border px-3 py-2 transition-colors ' + (preset === name
                ? 'border-lg-accent bg-lg-bg-elevated'
                : 'border-lg-border bg-lg-bg-primary hover:border-lg-accent')}
            >
              <div className="text-[12px] font-mono text-lg-text-primary capitalize">{name}</div>
              <div className="text-[10px] font-mono text-lg-text-secondary mt-0.5">{PRESET_BLURB[name]}</div>
            </button>
          ))}
        </div>
        <div className="text-[10px] font-mono text-lg-text-secondary" role="status">
          {preset === 'custom' ? 'Custom: you changed individual settings.' : `${preset[0].toUpperCase() + preset.slice(1)} preset applied.`}
          {saved && <span className="ml-2 text-lg-success">✓ Saved</span>}
        </div>
      </Section>

      {GROUPS.map(group => (
        <Section key={group.title} title={group.title}>
          {group.rows.map(row => {
            const current = values[row.key]
            const choices = choicesFor(row, current)
            return (
              <Row key={row.key} label={row.label} hint={row.hint}>
                <select
                  aria-label={row.label}
                  disabled={!loaded}
                  value={String(current)}
                  onChange={e => {
                    const choice = choices.find(item => String(item.value) === e.target.value)
                    if (choice) save({ ...values, [row.key]: choice.value })
                  }}
                  className={select}
                >
                  {choices.map(choice => <option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>)}
                </select>
              </Row>
            )
          })}
        </Section>
      ))}

      <Section title="Always on, in every preset">
        <ul className="text-[10px] font-mono text-lg-text-secondary space-y-1 list-disc pl-4">
          <li>Lock, forecast, ahead/behind and activity checks pause while the window is hidden or minimized.</li>
          <li>No background check can run more often than every {MIN_POLL_SECONDS} seconds.</li>
          <li>A refresh that finds nothing new does not redraw the changes list.</li>
          <li>Teammate presence keeps its one-minute heartbeat: teammates mark a device offline after three missed minutes, so it is not slowed by any preset.</li>
        </ul>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-lg-border">
      <div className="px-3 py-1.5 bg-lg-bg-secondary sticky top-0 z-10">
        <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">{title}</span>
      </div>
      <div className="px-3 py-2.5 space-y-3">{children}</div>
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[11px] font-mono text-lg-text-primary">{label}</div>
        {hint && <div className="text-[10px] font-mono text-lg-text-secondary mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  )
}
