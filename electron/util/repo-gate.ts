import path from 'path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { logService } from '../services/LogService'

// ── Per-repository operation gate ────────────────────────────────────────────
//
// Git operations on one repository compete for the same index and the same
// disk, and on a large Unreal project a single background query can hold both
// for minutes. Measured on a real repository: two `git diff --name-only`
// commands from a branch comparison, fourteen minutes old at zero CPU, still
// stat-walking a 200,000-file tree — while the discard the user had actually
// asked for sat behind them and never started.
//
// So: writes take the repository exclusively, reads run a few at a time, and a
// write that has waited long enough stops waiting politely.

/** Reads allowed to run at once on one repository. */
const MAX_CONCURRENT_READS = 4

/**
 * How long a write waits before it pre-empts the reads ahead of it.
 *
 * Reads here are UI queries whose callers already handle failure, and a read
 * that has not finished in this long is not about to. The user's operation
 * matters more than a branch comparison nobody is looking at yet.
 */
const PREEMPT_READS_AFTER_MS = 10_000

/**
 * Hard ceiling on waiting for a slot. Failure never bypasses exclusivity.
 *
 * This is a safety valve, not a tuning knob. A gate that can block forever
 * turns any bookkeeping mistake into a permanently hung application, which is
 * a far worse failure than the contention it exists to prevent. Exceeding it
 * means the gate has a bug; the log line is how we would find out.
 */
const MAX_WAIT_FOR_SLOT_MS = 60_000

type OperationKind = 'read' | 'write'

interface Waiter {
  kind: OperationKind
  /** Resolves once this waiter's slot has been claimed on its behalf. */
  wake: () => void
}

interface RepoGate {
  activeReads: number
  activeWrite: boolean
  waiting: Waiter[]
}

const gates = new Map<string, RepoGate>()
const gateKey = (repoPath: string): string => path.resolve(repoPath).toLowerCase()

/** The gate slot the current async context already holds, if any. */
const heldSlot = new AsyncLocalStorage<{ key: string }>()

function gateFor(key: string): RepoGate {
  let gate = gates.get(key)
  if (!gate) {
    gate = { activeReads: 0, activeWrite: false, waiting: [] }
    gates.set(key, gate)
  }
  return gate
}

function canRun(gate: RepoGate, kind: OperationKind): boolean {
  if (gate.activeWrite) return false
  if (kind === 'write') return gate.activeReads === 0
  // Writer preference: a queued write must not be starved by a stream of
  // reads, which on a busy panel would otherwise arrive indefinitely.
  if (gate.waiting.some(w => w.kind === 'write')) return false
  return gate.activeReads < MAX_CONCURRENT_READS
}

function claim(gate: RepoGate, kind: OperationKind): void {
  if (kind === 'write') gate.activeWrite = true
  else gate.activeReads++
}

function release(gate: RepoGate, kind: OperationKind): void {
  if (kind === 'write') gate.activeWrite = false
  else gate.activeReads = Math.max(0, gate.activeReads - 1)
}

/**
 * Hand slots to the oldest writer first, otherwise to waiting reads.
 *
 * The slot is claimed here, as the waiter is woken, rather than by the waiter
 * once it resumes. Waking only resolves a promise, and its continuation does
 * not run until the microtask queue is drained — so a version that left the
 * claiming until then would evaluate every remaining waiter against a gate
 * that still looked idle, and release a write and the read behind it together.
 */
function pump(key: string): void {
  const gate = gates.get(key)
  if (!gate) return

  while (gate.waiting.length > 0) {
    const writer = gate.waiting.findIndex(w => w.kind === 'write')
    const next = writer === -1 ? 0 : writer
    if (!canRun(gate, gate.waiting[next].kind)) break
    const [waiter] = gate.waiting.splice(next, 1)
    claim(gate, waiter.kind)
    waiter.wake()
  }

  if (gate.activeReads === 0 && !gate.activeWrite && gate.waiting.length === 0) {
    gates.delete(key)
  }
}

/** Wait until a slot has been claimed for this operation. */
function waitForSlot(
  gate: RepoGate,
  kind: OperationKind,
  repoPath: string,
  preemptReads?: (repoPath: string) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let preemptTimer: ReturnType<typeof setTimeout> | null = null
    let valveTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (preemptTimer) clearTimeout(preemptTimer)
      if (valveTimer) clearTimeout(valveTimer)
      if (error) reject(error)
      else resolve()
    }

    const waiter: Waiter = { kind, wake: () => finish() }
    gate.waiting.push(waiter)

    if (kind === 'write' && preemptReads) {
      preemptTimer = setTimeout(() => {
        if (!settled) preemptReads(repoPath)
      }, PREEMPT_READS_AFTER_MS)
    }

    valveTimer = setTimeout(() => {
      if (settled) return
      const at = gate.waiting.indexOf(waiter)
      if (at !== -1) gate.waiting.splice(at, 1)
      logService.warn(
        'git.gate',
        `A ${kind} timed out waiting for the repository slot: ${repoPath}`,
      )
      finish(new Error(`Timed out waiting for repository ${kind} access. Retry after the current operation finishes.`))
      pump(gateKey(repoPath))
    }, MAX_WAIT_FOR_SLOT_MS)
  })
}

/**
 * Run `fn` holding a slot on `repoPath`.
 *
 * Re-entrant by repository: an operation that already holds a slot passes
 * straight through, so a write built from a dozen git commands takes the
 * repository once rather than deadlocking against itself.
 *
 * `preemptReads` is called when a write has waited past the threshold — the
 * caller decides what that means, which keeps process handling out of here.
 */
export async function withRepoSlot<T>(
  repoPath: string,
  kind: OperationKind,
  fn: () => Promise<T>,
  preemptReads?: (repoPath: string) => void,
): Promise<T> {
  const key = gateKey(repoPath)
  if (heldSlot.getStore()?.key === key) return fn()

  const gate = gateFor(key)
  if (canRun(gate, kind)) claim(gate, kind)
  else await waitForSlot(gate, kind, repoPath, preemptReads)

  try {
    return await heldSlot.run({ key }, fn)
  } finally {
    release(gate, kind)
    pump(key)
  }
}

/** Current gate state for a repository. Diagnostics and tests only. */
export function repoSlotState(repoPath: string): { activeReads: number; activeWrite: boolean; waiting: number } {
  const gate = gates.get(gateKey(repoPath))
  return {
    activeReads: gate?.activeReads ?? 0,
    activeWrite: gate?.activeWrite ?? false,
    waiting: gate?.waiting.length ?? 0,
  }
}
