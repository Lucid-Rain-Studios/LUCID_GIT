import { DEFAULT_PERFORMANCE, normalizePerformance, type PerformanceSettings } from '../util/performance'

type Listener = (performance: PerformanceSettings) => void

/**
 * The current Performance settings for main-process work. Holds no Electron
 * import so services and tests can use it directly; main.ts feeds it settings
 * changes and the window-visibility probe.
 */
class PerformanceService {
  private current: PerformanceSettings = { ...DEFAULT_PERFORMANCE }
  private probe: () => boolean = () => true
  private listeners = new Set<Listener>()

  get(): PerformanceSettings { return this.current }

  apply(settings: { performance?: unknown }): void {
    this.current = normalizePerformance(settings.performance)
    for (const listener of this.listeners) listener(this.current)
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setActivityProbe(probe: () => boolean): void { this.probe = probe }

  /** False while every window is hidden or minimized; timers that only refresh the display skip those ticks. */
  isActive(): boolean {
    try { return this.probe() } catch { return true }
  }
}

export const performanceService = new PerformanceService()
