import * as fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** A serial JSON-lines reader. The service owns the two-worker/queue limits. */
export class BlueprintReaderWorker {
  busy = false
  private child?: ChildProcessWithoutNullStreams
  private idle?: ReturnType<typeof setTimeout>
  private jobs = 0
  private pending?: { id: string; resolve(text: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  private failure?: Error

  async read(helper: string, file: string, packagesOnly: boolean): Promise<string> {
    if (this.busy) throw new Error('Blueprint reader is busy.')
    this.busy = true
    if (this.idle) clearTimeout(this.idle)
    try {
      if (this.jobs >= 32) this.stop()
      if (!this.child) {
        const exe = path.join(helper, process.platform === 'win32' ? 'BlueprintExtractor.exe' : 'BlueprintExtractor')
        const dll = path.join(helper, 'BlueprintExtractor.dll')
        const bundled = await fs.access(exe).then(() => true, () => false)
        if (!bundled && !await fs.access(dll).then(() => true, () => false)) throw new Error('Blueprint reader is not installed. Build the Blueprint tools and restart the app.')
        this.start(bundled ? exe : 'dotnet', [...(bundled ? [] : [dll]), '--worker'])
      }
      const child = this.child!
      return await new Promise<string>((resolve, reject) => {
        const id = crypto.randomUUID()
        const timer = setTimeout(() => this.fail(new Error('Blueprint extraction failed or exceeded the 25 second limit.')), 25_000)
        this.pending = { id, resolve, reject, timer }
        child.stdin.write(JSON.stringify({ id, file, packagesOnly }) + '\n', error => { if (error) this.fail(error) })
      })
    } finally {
      this.busy = false
      if (this.child) {
        this.idle = setTimeout(() => this.stop(), 30_000)
        this.idle.unref()
      }
    }
  }

  private start(executable: string, args: string[]) {
    const child = spawn(executable, args, { stdio: 'pipe', windowsHide: true })
    this.child = child; this.jobs = 0; this.failure = undefined
    const decoder = new StringDecoder('utf8')
    let text = '', bytes = 0, stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      bytes += chunk.length
      if (bytes > 32 * 1024 * 1024) { this.fail(new Error('Blueprint reader response exceeds 32 MB.')); return }
      text += decoder.write(chunk)
      const newline = text.indexOf('\n')
      if (newline < 0) return
      const pending = this.pending
      try {
        if (!pending || text.slice(newline + 1).trim()) throw new Error('Unexpected Blueprint worker response.')
        const reply = JSON.parse(text.slice(0, newline))
        if (reply.id !== pending.id) throw new Error('Blueprint worker response identity mismatch.')
        text = ''; bytes = 0
        clearTimeout(pending.timer); this.pending = undefined; this.jobs++
        if (reply.error) pending.reject(new Error(String(reply.error)))
        else pending.resolve(JSON.stringify(reply.document))
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096) })
    child.stdin.on('error', error => { if (this.child === child) this.fail(error) })
    child.on('error', error => { if (this.child === child) this.failure = error })
    child.on('close', () => {
      if (this.child !== child) return
      this.child = undefined
      const pending = this.pending; this.pending = undefined
      if (pending) { clearTimeout(pending.timer); pending.reject(this.failure ?? new Error(stderr.trim() || 'Blueprint reader exited before completing the request. Rebuild the Blueprint tools if the helper is outdated.')) }
    })
  }

  private fail(error: Error) { this.failure = error; this.child?.kill() }

  stop() {
    if (this.idle) clearTimeout(this.idle)
    this.fail(new Error('Blueprint reader is shutting down.'))
    // A replacement can start immediately only when the previous job has ended.
    if (!this.pending) { this.child = undefined; this.jobs = 0 }
  }
}
