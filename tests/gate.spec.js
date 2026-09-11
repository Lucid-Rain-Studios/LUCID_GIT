// The per-repository gate, and the command classification it rests on.
//
// A gate that miscounts hangs the application permanently, which is a worse
// failure than the contention it exists to prevent. These tests exercise the
// orderings that would cause that.
const { test, expect } = require('@playwright/test')
const path = require('path')
const { DIST, cleanup } = require('./helpers')

const { isReadOnlyCommand } = require(path.join(DIST, 'util', 'git-command.js'))
const { withRepoSlot, repoSlotState } = require(path.join(DIST, 'util', 'repo-gate.js'))

const REPO = 'C:/fake/repo-a'
const OTHER = 'C:/fake/repo-b'

/** A task that blocks until released, recording when it started. */
function gatedTask(log, name) {
  let release
  const released = new Promise(r => { release = r })
  return {
    release,
    run: async () => {
      log.push('start:' + name)
      await released
      log.push('end:' + name)
    },
  }
}

const settle = () => new Promise(r => setTimeout(r, 30))

test.afterAll(cleanup)

// ── Command classification ───────────────────────────────────────────────────

test('lfs subcommands are classified individually, not as a group', () => {
  expect(isReadOnlyCommand(['lfs', 'ls-files'])).toBe(true)
  expect(isReadOnlyCommand(['lfs', 'pull'])).toBe(false)
  expect(isReadOnlyCommand(['lfs', 'checkout'])).toBe(false)
  // `branch` is deliberately absent: --list reads, -m does not.
  expect(isReadOnlyCommand(['branch', '--list'])).toBe(false)
})

// ── The gate ─────────────────────────────────────────────────────────────────

test('reads run concurrently, but only a few at a time', async () => {
  const log = []
  const tasks = Array.from({ length: 6 }, (_, i) => gatedTask(log, 'r' + i))
  const running = tasks.map(t => withRepoSlot(REPO, 'read', t.run))

  await settle()
  // Four in flight, two queued.
  expect(log.filter(l => l.startsWith('start:')).length).toBe(4)
  expect(repoSlotState(REPO).activeReads).toBe(4)

  tasks.forEach(t => t.release())
  await Promise.all(running)
  expect(log.filter(l => l.startsWith('start:')).length).toBe(6)
})

test('a write waits for reads in flight, then holds the repo alone', async () => {
  const log = []
  const read = gatedTask(log, 'read')
  const write = gatedTask(log, 'write')

  const readRun = withRepoSlot(REPO, 'read', read.run)
  await settle()
  const writeRun = withRepoSlot(REPO, 'write', write.run)
  await settle()

  // The write must not have started while a read holds the repository.
  expect(log).toEqual(['start:read'])

  read.release()
  await readRun
  await settle()
  expect(log).toEqual(['start:read', 'end:read', 'start:write'])

  write.release()
  await writeRun
})

test('a queued write is not starved by newly arriving reads', async () => {
  const log = []
  const first = gatedTask(log, 'first-read')
  const write = gatedTask(log, 'write')
  const late = gatedTask(log, 'late-read')

  const firstRun = withRepoSlot(REPO, 'read', first.run)
  await settle()
  const writeRun = withRepoSlot(REPO, 'write', write.run)
  await settle()
  // Arrives while the write is queued: it must go behind it, not ahead.
  const lateRun = withRepoSlot(REPO, 'read', late.run)
  await settle()
  expect(log).toEqual(['start:first-read'])

  first.release()
  await firstRun
  await settle()
  expect(log).toContain('start:write')
  expect(log).not.toContain('start:late-read')

  write.release()
  await writeRun
  await settle()
  late.release()
  await lateRun
  expect(log).toContain('start:late-read')
})

test('an operation holding a slot can nest without deadlocking itself', async () => {
  // A discard is a dozen git commands under one write slot. If nesting waited
  // on the slot it already holds, it would hang forever the first time.
  const result = await withRepoSlot(REPO, 'write', async () => {
    const inner = await withRepoSlot(REPO, 'read', async () => 'inner')
    const deeper = await withRepoSlot(REPO, 'write', async () => 'deeper')
    return inner + '/' + deeper
  })
  expect(result).toBe('inner/deeper')
  expect(repoSlotState(REPO)).toEqual({ activeReads: 0, activeWrite: false, waiting: 0 })
})

test('separate repositories do not block one another', async () => {
  const log = []
  const a = gatedTask(log, 'a')
  const b = gatedTask(log, 'b')

  const runA = withRepoSlot(REPO, 'write', a.run)
  const runB = withRepoSlot(OTHER, 'write', b.run)
  await settle()

  expect(log.sort()).toEqual(['start:a', 'start:b'])
  a.release(); b.release()
  await Promise.all([runA, runB])
})

test('the gate releases its bookkeeping when an operation throws', async () => {
  await expect(
    withRepoSlot(REPO, 'write', async () => { throw new Error('boom') }),
  ).rejects.toThrow('boom')

  // A failed operation must not leave the repository permanently held.
  expect(repoSlotState(REPO)).toEqual({ activeReads: 0, activeWrite: false, waiting: 0 })
  await withRepoSlot(REPO, 'write', async () => 'ok')
})
