const { test, expect } = require('@playwright/test')
const { EventEmitter } = require('events')
const { component } = require('./renderer-harness')
const flush = () => new Promise(resolve => setImmediate(resolve))

function registry({ delayedSpawn = false, killError = false } = {}) {
  const children = [], complete = [], spawn = [], kills = [], warnings = []
  const api = component('electron/util/dugite-exec.ts', {
    dugite: { GitProcess: { exec: (args, repo, opts) => new Promise(resolve => {
      const start = () => {
        const child = Object.assign(new EventEmitter(), { pid: 800000 + children.length, exitCode: null, signalCode: null })
        children.push(child); opts.processCallback(child)
        complete.push(() => { child.exitCode = 1; child.emit('exit', 1); resolve({ stdout: '', stderr: '', exitCode: 1 }) })
      }
      if (delayedSpawn) spawn.push(start); else start()
    }) } },
    './git-command': component('electron/util/git-command.ts').exports,
    'node:child_process': { execFile: (_file, args, options, done) => {
      expect(args).toContain('/T'); expect(options.windowsHide).toBe(true)
      kills.push(done); if (killError) done(Error('access denied'))
    } },
    '../services/LogService': { logService: { warn: (...args) => warnings.push(args) } },
  }, { process: { ...process, platform: 'win32' }, Buffer }).exports
  return { api, children, complete, spawn, kills, warnings }
}

test('shutdown retains tasks until actual exit, blocks all runner variants and deduplicates termination', async () => {
  const f = registry(), run = f.api.execSafe(['status'], 'repo')
  f.api.killGitProcesses([f.children[0].pid])
  expect(f.api.repoGitTasks('repo')).toHaveLength(1)
  const quit = f.api.shutdownGitProcesses()
  expect(f.api.shutdownGitProcesses()).toBe(quit)
  let done = false; quit.then(() => { done = true })
  for (const [method, args] of [['exec', ['status']], ['execSafe', ['status']], ['execWithStdin', ['apply']], ['execWithProgress', ['checkout']], ['execBinary', ['show']]]) {
    await expect(f.api[method](args, 'repo')).rejects.toThrow('shutting down')
  }
  expect(f.kills).toHaveLength(1); expect(done).toBe(false)
  expect(f.warnings.some(([, text]) => text.includes('Terminated'))).toBe(false)
  f.kills[0](null); await flush()
  expect(f.api.repoGitTasks('repo')).toHaveLength(1); expect(done).toBe(false)
  f.complete[0](); await run; await quit
  expect(f.api.repoGitTasks('repo')).toEqual([])
  expect(f.warnings.filter(([source]) => source === 'git.shutdown')).toHaveLength(1)
})

test('shutdown waits for a command still locating Git and stops its late child', async () => {
  const f = registry({ delayedSpawn: true }), run = f.api.execSafe(['status'], 'repo')
  const quit = f.api.shutdownGitProcesses(); let done = false; quit.then(() => { done = true })
  await flush(); expect(done).toBe(false)
  f.spawn[0](); expect(f.kills).toHaveLength(1)
  f.kills[0](null); f.complete[0](); await run; await quit
  expect(f.api.repoGitTasks('repo')).toEqual([])
})

test('failed termination is reported honestly and leaves its task visible', async () => {
  const f = registry({ killError: true }), run = f.api.execSafe(['checkout'], 'repo')
  await expect(f.api.shutdownGitProcesses()).rejects.toThrow('Could not stop')
  expect(f.api.repoGitTasks('repo')).toHaveLength(1)
  expect(f.warnings.some(([, text]) => text.includes('Terminated'))).toBe(false)
  f.complete[0](); await run
})

test('shutdown cancels queued and newly claimed repository work without running callbacks', async () => {
  const gate = component('electron/util/repo-gate.ts', { '../services/LogService': { logService: { warn() {} } } }).exports
  let release, entered = false
  const hold = gate.withRepoSlot('repo', 'read', () => new Promise(resolve => { release = resolve }))
  const queued = gate.withRepoSlot('repo', 'write', async () => { entered = true })
  const rejected = expect(queued).rejects.toThrow('shutting down')
  gate.shutdownRepoGate(); gate.shutdownRepoGate()
  await rejected; release(); await hold
  await expect(gate.withRepoSlot('repo', 'write', async () => { entered = true })).rejects.toThrow('shutting down')
  expect(entered).toBe(false); expect(gate.repoSlotState('repo')).toEqual({ activeReads: 0, activeWrite: false, waiting: 0 })

  const fresh = component('electron/util/repo-gate.ts', { '../services/LogService': { logService: { warn() {} } } }).exports
  let finish
  const running = fresh.withRepoSlot('repo', 'read', () => new Promise(resolve => { finish = resolve }))
  const handedOver = fresh.withRepoSlot('repo', 'write', async () => { entered = true })
  const refused = expect(handedOver).rejects.toThrow('shutting down')
  finish(); queueMicrotask(() => fresh.shutdownRepoGate())
  await running; await refused
  expect(entered).toBe(false)
})
