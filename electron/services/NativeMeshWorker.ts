import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { ueHeadlessService, type CommandletResult } from './UEHeadlessService'

const IDLE_MS = 30_000
type Session = { key: string; directory: string; controller: AbortController; run: Promise<CommandletResult>; finished?: CommandletResult; jobs: number; bytes: number }
// The commandlet executes only our generated extractor, never repository scripts.
const LOOP = String.raw`
import time, traceback
worker_base = os.path.dirname(__file__)
last_job = time.monotonic()
while time.monotonic() - last_job < 35:
    incoming = os.path.join(worker_base, 'job.json')
    if not os.path.exists(incoming):
        time.sleep(0.025)
        continue
    with open(incoming, encoding='utf-8') as stream:
        job = json.load(stream)
    os.remove(incoming)
    error = None
    try:
        extract(job['directory'])
        unreal.SystemLibrary.collect_garbage()
    except Exception:
        error = traceback.format_exc()[-2048:]
    done = os.path.join(worker_base, job['id'] + '.json')
    with open(done + '.tmp', 'w', encoding='utf-8') as stream:
        json.dump({'error': error}, stream)
    os.replace(done + '.tmp', done)
    last_job = time.monotonic()
`

/** One serial, isolated engine; temporary files only, no persistent geometry cache. */
export class NativeMeshWorker {
  private session?: Session
  private idle?: ReturnType<typeof setTimeout>

  async run(editor: string, key: string, script: string, signal: AbortSignal, prepare: (root: string, id: string) => Promise<string>, inputBytes = 0): Promise<void> {
    if (this.idle) clearTimeout(this.idle)
    // Windows may keep loaded package files open until the engine exits.
    if (this.session && (this.session.key !== key || this.session.finished || this.session.jobs >= 8 || this.session.bytes + inputBytes > 64 * 1024 * 1024)) await this.stop()
    if (signal.aborted) throw new Error('Asset preview cancelled.')
    if (!this.session) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucid-mesh-worker-'))
      try {
        await fs.writeFile(path.join(directory, 'Preview.uproject'), JSON.stringify({ FileVersion: 3, Plugins: [{ Name: 'PythonScriptPlugin', Enabled: true }, { Name: 'GeometryScripting', Enabled: true }] }))
        await fs.writeFile(path.join(directory, 'worker.py'), script + LOOP)
        const controller = new AbortController()
        const run = ueHeadlessService.runCommandlet({ editorBin: editor, projectPath: path.join(directory, 'Preview.uproject'), commandlet: 'pythonscript', params: [`-script=${path.join(directory, 'worker.py')}`, '-nosound', '-stdout', '-FullStdOutLogOutput'], timeoutMs: 1800_000, signal: controller.signal })
        const session: Session = { key, directory, controller, run, jobs: 0, bytes: 0 }
        this.session = session
        void run.then(result => { session.finished = result })
      } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error }
    }
    const session = this.session, id = crypto.randomUUID().replace(/-/g, '')
    const cancel = () => session.controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      if (signal.aborted) throw new Error('Asset preview cancelled.')
      const directory = await prepare(session.directory, id)
      await fs.writeFile(path.join(session.directory, 'job.tmp'), JSON.stringify({ id, directory }))
      await fs.rename(path.join(session.directory, 'job.tmp'), path.join(session.directory, 'job.json'))
      const deadline = Date.now() + 120_000
      const done = path.join(session.directory, id + '.json')
      while (true) {
        if (signal.aborted) throw new Error('Asset preview cancelled.')
        const text = await fs.readFile(done, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null })
        if (text !== null) {
          await fs.rm(done)
          const result = JSON.parse(text)
          if (result.error) throw new Error(String(result.error))
          session.jobs++
          session.bytes += inputBytes
          break
        }
        if (session.finished) throw new Error(session.finished.error ?? 'Native mesh worker exited before completing the export.')
        if (Date.now() > deadline) throw new Error('Native source export timed out after 120 seconds.')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    } catch (error) { await this.stop(); throw error }
    finally { signal.removeEventListener('abort', cancel) }
    this.idle = setTimeout(() => { void this.stop() }, IDLE_MS)
    this.idle.unref()
  }

  async stop() {
    if (this.idle) clearTimeout(this.idle)
    const session = this.session
    this.session = undefined
    if (!session) return
    session.controller.abort()
    await session.run
    await fs.rm(session.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  }
}
