// The main process must stay responsive while it works.
//
// A blocked event loop is this app's worst failure mode: no IPC reply is
// delivered, no git process exit is observed, and every armed deadline expires
// unheard and then fires in a burst that reads as a fleet of unrelated
// timeouts. Each test here pins one place that used to block.
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const { DIST, tmpDir, cleanup, measureLoopTicks } = require('./helpers')

const { withTimeout } = require(path.join(DIST, 'util', 'dugite-exec.js'))
const { logService } = require(path.join(DIST, 'services', 'LogService.js'))

test.afterAll(cleanup)

test('a timeout reports the time that actually elapsed, not its nominal deadline', async () => {
  let message = ''
  try {
    await withTimeout(new Promise(() => {}), 300, 'read:example')
  } catch (error) {
    message = error.message
  }
  expect(message).toContain('read:example timed out after 0.3s')
  // No overshoot to report when the loop was free.
  expect(message).not.toContain('deadline fired')
})

test('a timeout names the stall when the loop held its timer past the deadline', async () => {
  const pending = withTimeout(new Promise(() => {}), 300, 'git:current-branch')
  const until = Date.now() + 2000
  while (Date.now() < until) { /* block the loop, as a long synchronous scan does */ }

  let message = ''
  try { await pending } catch (error) { message = error.message }

  // The whole point: a `git rev-parse` cannot take 2s, and the message has to
  // say so rather than parroting the 0.3s it was set to.
  expect(message).toContain('git:current-branch timed out after 2')
  expect(message).toContain('deadline fired')
  expect(message).toContain('event loop was blocked')
})

test('the event-loop monitor records a stall and survives being restarted', async () => {
  logService.init(tmpDir('lg-log-'))
  logService.startEventLoopMonitor()
  logService.startEventLoopMonitor() // idempotent: must not start a second timer

  const until = Date.now() + 2000
  while (Date.now() < until) { /* block */ }
  await new Promise(resolve => setTimeout(resolve, 700))

  expect(logService.worstEventLoopLagMs()).toBeGreaterThan(1000)
  const logged = logService.getFormattedText()
  expect(logged).toContain('perf.event-loop')
  expect(logged).toContain('Main process event loop blocked')

  logService.stopEventLoopMonitor()
  logService.stopEventLoopMonitor() // also idempotent
})

test('deleting a large batch of files leaves the loop time to run', async () => {
  const dir = tmpDir('lg-bulk-')
  const files = []
  for (let i = 0; i < 1500; i++) {
    const f = path.join(dir, 'Content_Hero_Mesh_' + i + '.uasset')
    fs.writeFileSync(f, Buffer.alloc(4096))
    files.push(f)
  }

  // The shape the discard path uses: sequential, but awaiting async fs.
  const { ticks, elapsed } = await measureLoopTicks(async () => {
    for (const f of files) {
      try { await fs.promises.unlink(f) } catch { /* ignore */ }
    }
  })

  // The sync form this replaced scored exactly zero ticks over the same work.
  expect(elapsed).toBeGreaterThan(20)
  expect(ticks).toBeGreaterThan(0)
})

test('rm retries on a locked file without pinning the thread', async () => {
  const dir = tmpDir('lg-lock-')
  const target = path.join(dir, 'locked.uasset')
  fs.writeFileSync(target, 'x')

  // Hold it with FileShare::None, the way the Unreal editor holds an asset.
  const { spawn } = require('child_process')
  const psPath = target.split(path.sep).join(path.sep + path.sep)
  const holder = process.platform === 'win32'
    ? spawn('powershell', ['-NoProfile', '-Command',
        "$s=[System.IO.File]::Open('" + psPath + "','Open','ReadWrite','None'); Start-Sleep -Seconds 10; $s.Close()"])
    : null
  test.skip(holder === null, 'exclusive-lock behaviour is Windows-specific')

  await new Promise(resolve => setTimeout(resolve, 1500))
  const { ticks } = await measureLoopTicks(async () => {
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch { /* EBUSY is the expected outcome; the point is what it costs */ }
  })
  holder.kill()

  // The sync form spent the entire retry sequence with the loop frozen.
  expect(ticks).toBeGreaterThan(0)
})
