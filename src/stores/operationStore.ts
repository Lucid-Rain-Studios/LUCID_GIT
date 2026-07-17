import { create } from 'zustand'
import { ipc, OperationStep } from '@/ipc'

interface OperationState {
  isRunning: boolean
  label: string
  steps: OperationStep[]
  latestStep: OperationStep | null
  autoStarted: boolean
  startedAt: number | null
  latestStepAt: number | null
  maxProgress: number
  feedback: { kind: 'success' | 'error'; text: string; details?: string } | null

  start: (label: string) => void
  updateStep: (step: OperationStep) => void
  finish: (error?: unknown) => void
  reset: () => void
  /** Wrap any async fn: sets label while running, clears on done/error. */
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T>
}

// Operations shorter than this are not worth a desktop toast — the user
// almost certainly saw the inline progress and feedback.
const OPERATION_DESKTOP_NOTIFY_MIN_MS = 5_000
let autoFinishTimer: ReturnType<typeof setTimeout> | null = null
let feedbackTimer: ReturnType<typeof setTimeout> | null = null

function weightedProgress(operationLabel: string, step: OperationStep): number | undefined {
  const p = Math.max(0, Math.min(100, step.progress ?? 0))
  const id = step.id
  const label = operationLabel.toLowerCase()
  const isPush = label.includes('push') || label.includes('publish') || id.startsWith('push-') || id === 'lfs-up'
  const isPull = label.includes('pull') || id.startsWith('pull-') || id === 'lfs-down'

  if (isPush) {
    if (id === 'push-prepare') return 3
    if (id === 'push-scan') return 8
    if (id === 'push-connect') return 12
    if (id === 'enumerate') return 12 + p * 0.05
    if (id === 'count') return 17 + p * 0.10
    if (id === 'compress' || id === 'pack') return 27 + p * 0.23
    if (id === 'write') return 50 + p * 0.43
    if (id === 'lfs-up') return 12 + p * 0.81
    if (id === 'remote-count') return 94 + p * 0.02
    if (id === 'remote-zip') return 96 + p * 0.03
    if (id === 'unlock-batch') return 97 + p * 0.03
  }

  if (isPull) {
    if (id === 'pull-checkpoint') return 3
    if (id === 'pull-auth') return 6
    if (id === 'pull-connect') return 12
    if (id === 'receive') return 12 + p * 0.58
    if (id === 'resolve') return 70 + p * 0.15
    if (id === 'lfs-down') return 12 + p * 0.73
    if (id === 'checkout' || id === 'update-files') return 85 + p * 0.14
  }

  return step.overallProgress ?? step.progress
}

function feedbackText(label: string, failed: boolean): string {
  const clean = label.replace(/[.…]+$/, '').trim() || 'Operation'
  return `${clean} ${failed ? 'failed' : 'complete'}`
}

function maybeNotifyOperationComplete(label: string, durationMs: number, error: unknown): void {
  if (durationMs < OPERATION_DESKTOP_NOTIFY_MIN_MS) return
  // Only toast when the user has alt-tabbed away — no point doubling up if
  // they're already looking at the inline progress UI.
  if (typeof document !== 'undefined' && document.hasFocus()) return

  const failed = error !== undefined
  ipc.notifyDesktop({
    event:  'operationComplete',
    title:  failed ? `${label} failed` : `${label} finished`,
    body:   failed
      ? (error instanceof Error ? error.message : String(error)).slice(0, 140)
      : 'Click to return to Lucid Git',
    urgent: failed,
  }).catch(() => {})
}

export const useOperationStore = create<OperationState>((set, get) => ({
  isRunning: false,
  label: '',
  steps: [],
  latestStep: null,
  autoStarted: false,
  startedAt: null,
  latestStepAt: null,
  maxProgress: 0,
  feedback: null,

  start: (label) => {
    if (autoFinishTimer) clearTimeout(autoFinishTimer)
    if (feedbackTimer) clearTimeout(feedbackTimer)
    autoFinishTimer = null
    feedbackTimer = null
    set({ isRunning: true, label, steps: [], latestStep: null, autoStarted: false, startedAt: Date.now(), latestStepAt: null, maxProgress: 0, feedback: null })
  },

  updateStep: (step) => {
    set((state) => {
      const calculated = weightedProgress(state.label, step)
      const overallProgress = calculated === undefined ? undefined : Math.max(state.maxProgress, Math.min(100, calculated))
      const enriched = { ...step, overallProgress }
      return {
      steps: [...state.steps.filter((s) => s.id !== step.id), enriched],
      latestStep: enriched,
      isRunning: true,
      autoStarted: state.autoStarted || !state.isRunning,
      startedAt: state.startedAt ?? Date.now(),
      latestStepAt: Date.now(),
      maxProgress: overallProgress ?? state.maxProgress,
      }
    })
    // Lock actions can originate from lightweight context menus that do not
    // explicitly call operationStore.run(). Let their progress appear anyway,
    // then clear it shortly after the terminal update.
    if ((step.status === 'done' || step.status === 'error') && get().autoStarted) {
      if (autoFinishTimer) clearTimeout(autoFinishTimer)
      autoFinishTimer = setTimeout(() => get().finish(step.status === 'error' ? (step.detail ?? step.label) : undefined), 650)
    }
  },

  finish: (error) => {
    if (autoFinishTimer) clearTimeout(autoFinishTimer)
    if (feedbackTimer) clearTimeout(feedbackTimer)
    autoFinishTimer = null
    const state = get()
    const effectiveError = error ?? (state.latestStep?.status === 'error' ? (state.latestStep.detail ?? state.latestStep.label) : undefined)
    const failed = effectiveError !== undefined
    set({
      isRunning: false, latestStep: null, autoStarted: false, startedAt: null, latestStepAt: null,
      feedback: { kind: failed ? 'error' : 'success', text: feedbackText(state.label, failed), details: failed ? (effectiveError instanceof Error ? effectiveError.message : String(effectiveError)) : undefined },
    })
    feedbackTimer = setTimeout(() => set({ feedback: null }), failed ? 10_000 : 2_000)
  },

  reset: () => set({ isRunning: false, label: '', steps: [], latestStep: null, autoStarted: false, startedAt: null, latestStepAt: null, maxProgress: 0, feedback: null }),

  run: async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    get().start(label)
    const startedAt = Date.now()
    // Pause background auto-fetch (ForecastService) so it doesn't race with
    // the user-driven operation we're about to run. Refcounted in the main
    // process, so nested run() calls remain safe.
    ipc.forecastPause().catch(() => {})
    try {
      const result = await fn()
      maybeNotifyOperationComplete(label, Date.now() - startedAt, undefined)
      get().finish()
      return result
    } catch (err) {
      maybeNotifyOperationComplete(label, Date.now() - startedAt, err)
      get().finish(err)
      throw err
    } finally {
      ipc.forecastResume().catch(() => {})
    }
  },
}))
