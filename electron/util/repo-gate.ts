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

/**
 * Log thresholds. A wait this long is invisible in the UI as anything but
 * sluggishness, so the log says who the operation was queued behind. Mutable
 * only so tests do not have to sleep.
 */
export const gateLogThresholds = { waitMs: 2_000 }

type OperationKind = 'read' | 'write'

interface Waiter {
  kind: OperationKind
  /** Resolves once this waiter's slot has been claimed on its behalf. */
  wake: () => void
  fail: (error: Error) => void
}

/** Who currently holds a slot, for the log line explaining a long wait. */
interface Holder {
  kind: OperationKind
  label: string
  since: number
}

interface RepoGate {
  activeReads: number
  activeWrite: boolean
  waiting: Waiter[]
  holders: Set<Holder>
}

const gates = new Map<string, RepoGate>()
let shuttingDown = false
const gateKey = (repoPath: string): string => path.resolve(repoPath).toLowerCase()

/**
 * The gate slot the current async context already holds, if any.
 *
 * `active` drops when the slot is released. Work an operation started without
 * awaiting — a follow-up check after a pull — inherits this context, and must
 * not keep passing through the gate once the operation that owned it is done.
 */
const heldSlot = new AsyncLocalStorage<{ key: string; active: boolean }>()

function gateFor(key: string): RepoGate {
  let gate = gates.get(key)
  if (!gate) {
    gate = { activeReads: 0, activeWrite: false, waiting: [], holders: new Set() }
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

  while (!shuttingDown && gate.waiting.length > 0) {
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

/** "write git:update-from-main (82s), 3 reads: git:status, git:log; 1 queued ahead" */
function describeHolders(gate: RepoGate): string {
  const now = Date.now()
  const writes = [...gate.holders].filter(h => h.kind === 'write')
    .map(h => `write ${h.label} (${Math.round((now - h.since) / 1000)}s)`)
  const reads = [...gate.holders].filter(h => h.kind === 'read')
  const parts = [...writes]
  if (reads.length) parts.push(`${reads.length} read${reads.length === 1 ? '' : 's'}: ${[...new Set(reads.map(h => h.label))].slice(0, 6).join(', ')}`)
  if (gate.waiting.length) parts.push(`${gate.waiting.length} queued ahead`)
  return parts.length ? parts.join('; ') : 'nothing recorded'
}

/** Wait until a slot has been claimed for this operation. */
function waitForSlot(
  gate: RepoGate,
  kind: OperationKind,
  repoPath: string,
  preemptReads?: (repoPath: string) => void,
  label = 'internal',
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

    const waiter: Waiter = { kind, wake: () => finish(), fail: error => finish(error) }
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
        `A ${kind} (${label}) timed out waiting for the repository slot: ${repoPath}; held by: ${describeHolders(gate)}`,
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
 *
 * `label` names the operation (an IPC channel) in wait and timeout log lines.
 */
export async function withRepoSlot<T>(
  repoPath: string,
  kind: OperationKind,
  fn: () => Promise<T>,
  preemptReads?: (repoPath: string) => void,
  label = 'internal',
): Promise<T> {
  if (shuttingDown) throw new Error('Lucid Git is shutting down. Repository work was cancelled.')
  const key = gateKey(repoPath)
  const held = heldSlot.getStore()
  if (held?.key === key && held.active) return fn()

  const gate = gateFor(key)
  const queuedAt = Date.now()
  let blockedBy: string | null = null
  if (canRun(gate, kind)) claim(gate, kind)
  else {
    blockedBy = describeHolders(gate)
    await waitForSlot(gate, kind, repoPath, preemptReads, label)
  }
  const waitedMs = Date.now() - queuedAt
  if (blockedBy !== null && waitedMs >= gateLogThresholds.waitMs) {
    logService.warn('git.gate', `${label} (${kind}) waited ${(waitedMs / 1000).toFixed(1)}s for ${repoPath}; was queued behind: ${blockedBy}`)
  }
  const holder: Holder = { kind, label, since: Date.now() }
  gate.holders.add(holder)

  const token = { key, active: true }
  try {
    // A slot may have been handed over immediately before shutdown started.
    if (shuttingDown) throw new Error('Lucid Git is shutting down. Repository work was cancelled.')
    return await heldSlot.run(token, fn)
  } finally {
    token.active = false
    gate.holders.delete(holder)
    release(gate, kind)
    pump(key)
  }
}

/** Reject queued work before terminating the processes holding its slots. */
export function shutdownRepoGate(): void {
  shuttingDown = true
  for (const [key, gate] of gates) {
    for (const waiter of gate.waiting.splice(0)) {
      waiter.fail(new Error('Lucid Git is shutting down. Repository work was cancelled.'))
    }
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
