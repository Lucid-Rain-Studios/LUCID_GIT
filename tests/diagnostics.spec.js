const { test, expect } = require('@playwright/test')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { DIST, tmpDir, cleanup } = require('./helpers')
const { component } = require('./renderer-harness')
const diagnostics = require(path.join(DIST, 'util/diagnostics'))
const gate = require(path.join(DIST, 'util/repo-gate'))
const { logService } = require(path.join(DIST, 'services/LogService'))
test.afterAll(cleanup)

function capture() {
  const lines = [], originals = { info: logService.info, warn: logService.warn, error: logService.error }
  for (const level of ['info', 'warn', 'error']) logService[level] = (source, message) => lines.push({ level, source, message })
  return { lines, restore: () => Object.assign(logService, originals) }
}
const json = line => JSON.parse(line.message.slice(line.message.indexOf('{')))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('repository location is classified for cloud sync, network shares and drive', () => {
  const plain = diagnostics.classifyRepoPath('C:\\Users\\fiery\\Documents\\GitHub\\LRS_INFERIUS', {})
  expect(plain).toMatchObject({ drive: 'C:', network: false, cloudSync: null })
  expect(diagnostics.classifyRepoPath('C:\\Users\\a\\OneDrive - Studio\\Projects\\Game', {}).cloudSync).toBe('OneDrive - Studio')
  expect(diagnostics.classifyRepoPath('D:\\Dropbox\\Game', {}).cloudSync).toBe('Dropbox')
  expect(diagnostics.classifyRepoPath('\\\\server\\share\\Game', {})).toMatchObject({ network: true, drive: null })
  // A redirected known folder is only visible through the environment.
  expect(diagnostics.classifyRepoPath('C:\\Users\\a\\Documents\\Game', { OneDrive: 'C:\\Users\\a\\Documents' }).cloudSync).toBe('OneDrive')
  expect(diagnostics.classifyRepoPath('C:\\Users\\a\\Games\\Game', { OneDrive: 'C:\\Users\\a\\OneDrive' }).cloudSync).toBeNull()
})

test('process lists are grouped into the categories that explain index and file locks', () => {
  const csv = ['"System","4","Services","0","1,000 K"', '"UnrealEditor.exe","100","Console","1","9 K"', '"UnrealEditor.exe","101","Console","1","9 K"',
    '"MsMpEng.exe","5","Services","0","1 K"', '"OneDrive.exe","6","Console","1","1 K"', '"git.exe","7","Console","1","1 K"', '"git-lfs.exe","8","Console","1","1 K"',
    '"GitHubDesktop.exe","9","Console","1","1 K"', '"notepad.exe","10","Console","1","1 K"'].join('\r\n')
  const names = diagnostics.parseTasklist(csv)
  expect(names).toHaveLength(9)
  expect(diagnostics.categorizeProcesses(names, 1)).toEqual({
    editors: { 'UnrealEditor.exe': 2 }, gitClients: { 'GitHubDesktop.exe': 1 }, syncAndIndexers: { 'OneDrive.exe': 1 },
    antivirus: { 'MsMpEng.exe': 1 }, gitProcessesTotal: 2, lucidGitProcesses: 1,
  })
})

test('failure context is bounded, reports location and disk, and never throws', async () => {
  const dir = tmpDir('lg-diag-')
  const started = Date.now()
  const context = await diagnostics.failureContext(dir)
  expect(Date.now() - started).toBeLessThan(6000)
  expect(context.location).toMatchObject({ network: false, pathLength: dir.length })
  expect(context.disk.freeMB !== undefined || context.disk.error).toBeTruthy()
  expect(context.processes.editors !== undefined || context.processes.unavailable).toBeTruthy()
  // A path that does not exist still yields a context, with the reason for the gap.
  const missing = await diagnostics.failureContext(path.join(dir, 'does', 'not', 'exist'))
  expect(missing.disk.error).toBeTruthy()
})

test('the session environment line records machine, runtime, git and baseline processes', async () => {
  const dir = tmpDir('lg-env-'), log = capture()
  try {
    await diagnostics.logSessionEnvironment({ appVersion: '9.9.9', packaged: true, userDataPath: dir })
    const line = log.lines.find(l => l.source === 'app.environment')
    expect(line.level).toBe('info')
    const env = json(line)
    expect(env).toMatchObject({ app: '9.9.9', packaged: true, platform: process.platform, arch: process.arch })
    expect(env.os).toBeTruthy()
    expect(env.cpus).toBeGreaterThan(0)
    expect(env.memoryMB.total).toBeGreaterThan(0)
    expect(env.git).toMatch(/^git version/)
    expect(env).toHaveProperty('gitLfs')
    expect(env.userDataDisk.freeMB !== undefined || env.userDataDisk.error).toBeTruthy()
    expect(env).toHaveProperty('processes')
  } finally { log.restore() }
})

test('a long wait for the repository is logged with the operation that held it', async () => {
  const log = capture(), repo = tmpDir('lg-gate-'), previous = gate.gateLogThresholds.waitMs
  gate.gateLogThresholds.waitMs = 40
  try {
    let release
    const holding = gate.withRepoSlot(repo, 'write', () => new Promise(resolve => { release = resolve }), undefined, 'git:update-from-main')
    await sleep(10)
    const queued = gate.withRepoSlot(repo, 'read', async () => 'status', undefined, 'git:status')
    await sleep(80)
    release(); await holding
    expect(await queued).toBe('status')
    const waited = log.lines.find(l => l.source === 'git.gate' && l.message.includes('git:status (read) waited'))
    expect(waited.level).toBe('warn')
    expect(waited.message).toContain('write git:update-from-main')
    // A short wait is not worth a line.
    log.lines.length = 0
    await gate.withRepoSlot(repo, 'read', async () => 'quick', undefined, 'git:log')
    expect(log.lines).toEqual([])
  } finally { gate.gateLogThresholds.waitMs = previous; log.restore() }
})

function gitRegistry() {
  const warnings = [], children = [], complete = []
  const api = component('electron/util/dugite-exec.ts', {
    dugite: { GitProcess: { exec: (args, repoPath, opts) => new Promise(resolve => {
      const child = Object.assign(new EventEmitter(), { pid: 600000 + children.length, exitCode: null, signalCode: null })
      children.push(child); opts.processCallback(child)
      complete.push((code = 0) => { child.exitCode = code; child.emit('exit', code, null); resolve({ stdout: '', stderr: '', exitCode: code }) })
    }) } },
    './git-command': component('electron/util/git-command.ts').exports,
    'node:child_process': { execFile: (_file, _args, _options, done) => done(null) },
    '../services/LogService': { logService: { warn: (source, message) => warnings.push({ source, message }), info() {}, error() {} } },
  }, { process: { ...process, platform: 'win32' }, Buffer }).exports
  return { api, warnings, complete }
}

test('slow git commands are logged with their duration and redacted arguments', async () => {
  const f = gitRegistry()
  f.api.gitLogThresholds.slowMs = 20
  f.api.gitLogThresholds.slowNetworkMs = 60_000
  const slow = f.api.execSafe(['-c', 'http.extraheader=AUTHORIZATION: basic SECRETTOKEN', 'status', '--porcelain', '--untracked-files=all'], 'C:/repo')
  const fastFetch = f.api.execSafe(['-c', 'http.extraheader=AUTHORIZATION: basic SECRETTOKEN', 'fetch', 'origin'], 'C:/repo')
  const quick = f.api.execSafe(['rev-parse', 'HEAD'], 'C:/repo')
  f.complete[2](0); await quick
  await sleep(50)
  f.complete[0](0); await slow
  f.complete[1](0); await fastFetch
  const slowLines = f.warnings.filter(w => w.source === 'git.slow')
  // The slow status is logged; the equally long fetch has a longer allowance; the quick command is not.
  expect(slowLines).toHaveLength(1)
  expect(slowLines[0].message).toMatch(/^git status took 0\.\d+s \(read, exit 0\) in C:\/repo: status --porcelain --untracked-files=all$/)
  expect(slowLines[0].message).not.toContain('SECRETTOKEN')
  expect(slowLines[0].message).not.toContain('extraheader')
})

test('a slow command that was cancelled says why', async () => {
  const f = gitRegistry()
  f.api.gitLogThresholds.slowMs = 10
  const run = f.api.execSafe(['status'], 'C:/repo')
  await sleep(30)
  f.api.killGitProcesses([600000], 'deadline exceeded: git:status')
  f.complete[0](1); await run
  expect(f.warnings.find(w => w.source === 'git.slow').message).toContain('cancelled (deadline exceeded: git:status)')
})

function handlerHarness(mocks = {}, logger = null) {
  const handlers = new Map(), slots = [], logs = [], contexts = []
  const { CHANNELS } = require(path.join(DIST, 'ipc/channels'))
  const api = component('electron/ipc/handlers.ts', {
    path: require('path'),
    electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    './channels': { CHANNELS },
    '../util/repo-gate': { withRepoSlot: (repo, mode, fn, _preempt, label) => { slots.push([repo, mode, label]); return fn() } },
    '../util/dugite-exec': { withGitTimeout: fn => fn(), preemptRepoReads() {} },
    '../util/diagnostics': { logFailureContext: (...args) => contexts.push(args) },
    '../services/LogService': { logService: logger ?? {
      info: (source, message) => logs.push({ level: 'info', source, message }),
      warn: (source, message) => logs.push({ level: 'warn', source, message }),
      error: (source, message) => logs.push({ level: 'error', source, message }),
    } },
    '../services/GitService': { gitService: { status: async () => [], resetTo: async () => {}, push: async () => { throw new Error('remote rejected\nsecond line') }, ...mocks } },
    '../services/UndoService': { undoService: { recordCheckpoint: async () => {}, markAvailable() {}, discard() {} } },
  })
  api.exports.registerHandlers()
  return { handlers, slots, logs, contexts, CHANNELS, event: { sender: { isDestroyed: () => false, send() {} } } }
}

test('every write operation leaves a start and finish line with sanitized arguments', async () => {
  const h = handlerHarness()
  await h.handlers.get(h.CHANNELS.GIT_RESET_TO)(h.event, 'C:/repo', 'parent', 'soft', { accessToken: 'SECRETTOKEN' })
  const ops = h.logs.filter(l => l.source === 'op')
  expect(ops.map(l => l.message.split(' ')[0])).toEqual(['Started', 'Finished'])
  expect(ops[0].message).toContain(`${h.CHANNELS.GIT_RESET_TO} in C:/repo`)
  expect(ops[0].message).toContain('"parent","soft"')
  expect(ops[0].message).toContain('[REDACTED]')
  expect(ops[0].message).not.toContain('SECRETTOKEN')
  expect(ops[1].message).toMatch(/^Finished .* in \d+\.\ds$/)
  expect(h.slots).toEqual([['C:/repo', 'write', h.CHANNELS.GIT_RESET_TO]])
  expect(h.contexts).toEqual([])
})

test('a failed write operation is trailed with its duration and triggers failure context', async () => {
  const h = handlerHarness()
  await expect(h.handlers.get(h.CHANNELS.GIT_PUSH)(h.event, 'C:/repo')).rejects.toThrow('remote rejected')
  const failed = h.logs.find(l => l.source === 'op' && l.message.startsWith('Failed'))
  expect(failed.level).toBe('warn')
  expect(failed.message).toMatch(/^Failed git:push after \d+\.\ds \(queued \d+\.\ds\): remote rejected$/)
  expect(h.logs.some(l => l.level === 'error' && l.source === `ipc.${h.CHANNELS.GIT_PUSH}`)).toBe(true)
  expect(h.contexts).toEqual([[`ipc.${h.CHANNELS.GIT_PUSH}`, 'C:/repo', `Context for failed ${h.CHANNELS.GIT_PUSH}`]])
})

test('reads are not trailed, and a throwing logger never changes an operation result', async () => {
  const h = handlerHarness()
  await h.handlers.get(h.CHANNELS.GIT_STATUS)(h.event, 'C:/repo')
  expect(h.logs.filter(l => l.source === 'op')).toEqual([])
  expect(h.slots).toEqual([['C:/repo', 'read', h.CHANNELS.GIT_STATUS]])
  // Break logging; the operation must still complete.
  const broken = handlerHarness({ resetTo: async () => 'done' }, { info() { throw new Error('disk full') }, warn() { throw new Error('disk full') }, error() {} })
  await expect(broken.handlers.get(broken.CHANNELS.GIT_RESET_TO)(broken.event, 'C:/repo', 'parent', 'soft', 'x')).resolves.toBe('done')
})
