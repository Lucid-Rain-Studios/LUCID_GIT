import path from 'path'
import { logService } from '../services/LogService'
import { gitActivitySnapshot } from './dugite-exec'

/**
 * Why `git status` runs, and how long each run takes.
 *
 * The slow-command warning only names scans past `gitLogThresholds.slowMs`, so
 * the log can say a status took 20s but not what asked for it, how many ran
 * before it, or whether the rest were fast. Every scan is measured here
 * instead. Slow or failed ones get a line of their own; the rest are folded
 * into one summary per window so a busy repository adds a handful of lines an
 * hour rather than one per refresh.
 *
 * Nothing here touches what a scan returns or when it runs.
 */

/** A scan at least this slow, or queued this long for the repository, is logged on its own. */
const LINE_MS = 1000
const SUMMARY_MS = 5 * 60_000
/** Bounds on a window's memory: durations kept for the percentiles, distinct trigger folders tracked. */
const MAX_SAMPLES = 1000
const MAX_TRIGGER_FOLDERS = 100
/** A watcher fire this recent is the likeliest reason a status was asked for. */
const WATCHER_ATTRIBUTION_MS = 10_000

interface WatcherFire { at: number; file: string; events: number }

interface Window {
  startedAt: number
  scans: number
  failed: number
  slow: number
  bySource: Map<string, number>
  runMs: number[]
  waitMs: number[]
  fires: number
  events: number
  folders: Map<string, number>
}

const lastFire = new Map<string, WatcherFire>()
const windows = new Map<string, Window>()
let flushTimer: ReturnType<typeof setInterval> | null = null

const repoKey = (repoPath: string) => path.resolve(repoPath).toLowerCase()
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

function windowFor(repoPath: string): Window {
  const key = repoKey(repoPath)
  let window = windows.get(key)
  if (!window) {
    window = { startedAt: Date.now(), scans: 0, failed: 0, slow: 0, bySource: new Map(), runMs: [], waitMs: [], fires: 0, events: 0, folders: new Map() }
    windows.set(key, window)
  }
  if (!flushTimer) {
    flushTimer = setInterval(() => flushStatusTelemetry(), SUMMARY_MS)
    // Never a reason to hold the process open on our account.
    flushTimer.unref()
  }
  return window
}

function percentile(sorted: number[], fraction: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

function triggerFolder(file: string): string {
  const folders = file.replace(/\\/g, '/').split('/').slice(0, -1).slice(0, 4)
  return folders.length === 0 ? '(repository root)' : folders.join('/')
}

/** A debounced watcher change was handed to the renderer: the refresh it causes follows within seconds. */
export function noteWatcherFire(repoPath: string, file: string, events: number): void {
  lastFire.set(repoKey(repoPath), { at: Date.now(), file, events })
  const window = windowFor(repoPath)
  window.fires++
  window.events += events
  const folder = triggerFolder(file)
  if (window.folders.has(folder) || window.folders.size < MAX_TRIGGER_FOLDERS) {
    window.folders.set(folder, (window.folders.get(folder) ?? 0) + 1)
  }
}

export interface StatusScan {
  /** The repository slot was granted and the git process is about to start. */
  started(): void
  finish(files: ReadonlyArray<{ indexStatus: string }>): void
  fail(error: unknown): void
}

/** Call when a status is requested, before it queues for the repository. */
export function beginStatusScan(repoPath: string, source: string): StatusScan {
  const calledAt = Date.now()
  let startedAt: number | null = null
  let context = ''
  let done = false

  const describeContext = (): string => {
    const parts: string[] = []
    const fire = lastFire.get(repoKey(repoPath))
    const sinceFire = fire ? calledAt - fire.at : null
    if (fire && sinceFire !== null && sinceFire <= WATCHER_ATTRIBUTION_MS) {
      parts.push(`watcher ${seconds(sinceFire)} before the request (${fire.events} event${fire.events === 1 ? '' : 's'}, first: ${fire.file || 'unspecified'})`)
    } else {
      parts.push(fire ? `no watcher fire in the last ${seconds(WATCHER_ATTRIBUTION_MS)} (last was ${seconds(calledAt - fire.at)} earlier)` : 'no watcher fire this session')
    }
    try {
      const activity = gitActivitySnapshot(repoPath)
      let lastWrite: { command: string; endedAgoMs: number } | null = null
      for (const entry of activity.recent) {
        if (entry.readOnly) continue
        const endedAgoMs = entry.startedAgoMs - (entry.durationMs ?? 0)
        if (!lastWrite || endedAgoMs < lastWrite.endedAgoMs) lastWrite = { command: entry.command, endedAgoMs }
      }
      parts.push(lastWrite ? `last write ${lastWrite.command} ended ${seconds(Math.max(0, lastWrite.endedAgoMs))} ago` : 'no write git command in the last 10 min')
      if (activity.running.length > 0) {
        parts.push(`running: ${activity.running.map(entry => `${entry.command} (${seconds(entry.ageMs)})`).join(', ')}`)
      }
    } catch { /* telemetry must never be the reason a status fails */ }
    return parts.join('; ')
  }

  const settle = (outcome: { ok: true; files: ReadonlyArray<{ indexStatus: string }> } | { ok: false; error: unknown }) => {
    if (done) return
    done = true
    const endedAt = Date.now()
    const waitedMs = (startedAt ?? endedAt) - calledAt
    const ranMs = startedAt === null ? 0 : endedAt - startedAt
    const window = windowFor(repoPath)
    window.scans++
    window.bySource.set(source, (window.bySource.get(source) ?? 0) + 1)
    if (window.runMs.length < MAX_SAMPLES) { window.runMs.push(ranMs); window.waitMs.push(waitedMs) }
    const slow = ranMs >= LINE_MS || waitedMs >= LINE_MS
    if (slow) window.slow++
    if (!outcome.ok) window.failed++
    if (!slow && outcome.ok) return

    const result = outcome.ok
      ? `${outcome.files.length} entries, ${outcome.files.filter(file => file.indexStatus === '?').length} untracked`
      : `failed: ${String((outcome.error as { message?: unknown } | null)?.message ?? outcome.error).split('\n')[0].slice(0, 120)}`
    const message = `${source} scan ran ${seconds(ranMs)}, waited ${seconds(waitedMs)} for the repository in ${repoPath} (${result}); ${context || describeContext()}`
    if (outcome.ok) logService.info('git.status', message)
    else logService.warn('git.status', message)
  }

  return {
    started() { startedAt = Date.now(); context = describeContext() },
    finish(files) { settle({ ok: true, files }) },
    fail(error) { settle({ ok: false, error }) },
  }
}

/** Write the summary for every repository's window, then start the next one. */
export function flushStatusTelemetry(): void {
  const now = Date.now()
  for (const [key, window] of windows) {
    windows.delete(key)
    if (window.scans === 0 && window.fires === 0) continue
    const run = [...window.runMs].sort((a, b) => a - b)
    const wait = [...window.waitMs].sort((a, b) => a - b)
    const sources = [...window.bySource].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(', ')
    const folders = [...window.folders].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([folder, count]) => `${folder} x${count}`).join(', ')
    logService.info('git.status', [
      `${Math.round((now - window.startedAt) / 1000)}s window for ${key}:`,
      `${window.scans} scans (${sources || 'none'})`,
      `run p50 ${seconds(percentile(run, 0.5))} p95 ${seconds(percentile(run, 0.95))} max ${seconds(run[run.length - 1] ?? 0)}`,
      `wait p95 ${seconds(percentile(wait, 0.95))} max ${seconds(wait[wait.length - 1] ?? 0)}`,
      `${window.slow} at or over ${seconds(LINE_MS)}, ${window.failed} failed`,
      `${window.fires} watcher fires from ${window.events} events${folders ? `, busiest: ${folders}` : ''}`,
    ].join(' | '))
  }
}
