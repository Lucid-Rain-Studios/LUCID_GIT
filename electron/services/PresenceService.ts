import { readJson, writeJson, isRecord, JsonStoreReadError } from '../util/json-store'
import { randomUUID } from 'node:crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { PresenceEntry, PresenceFile } from '../types'

class PresenceService {
  private filePath(repoPath: string): string {
    return path.join(repoPath, '.lucid-git', 'lucid-presence.json')
  }

  read(repoPath: string): PresenceFile {
    const file = this.filePath(repoPath)
    try {
      // Older releases accepted an entries object without a version marker.
      // Normalize it in memory; the next atomic write retains the old backup.
      const current = readJson(file, (value): value is PresenceFile => isRecord(value)
        && (value.version === undefined || value.version === 1) && isRecord(value.entries), { version: 1, entries: {} })
      return { ...current, version: 1 }
    } catch (error) {
      if (!(error instanceof JsonStoreReadError) || !error.corrupt) throw error
      // Local activity is ephemeral. Preserve both unreadable candidates before
      // starting a fresh heartbeat; do not reset durable stores or I/O failures.
      this.ensureIgnored(repoPath)
      const suffix = '.invalid-' + randomUUID()
      const saved: string[] = []
      for (const candidate of [file, file + '.bak']) {
        try { fs.renameSync(candidate, candidate + suffix); saved.push(candidate + suffix) }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
      }
      console.warn('Restarted local presence; unreadable data preserved at:', ...saved)
      return { version: 1, entries: {} }
    }
  }

  update(repoPath: string, login: string, entry: PresenceEntry): void {
    // Install the shared rule before creating any local activity or backups.
    // If it cannot be saved, do not publish an unprotected activity file.
    this.ensureIgnored(repoPath)
    const dir = path.join(repoPath, '.lucid-git')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const current = this.read(repoPath)
    current.entries[login] = entry
    writeJson(this.filePath(repoPath), current)
  }

  private ensureIgnored(repoPath: string): void {
    const gitIgnorePath = path.join(repoPath, '.gitignore')
    const existing = fs.existsSync(gitIgnorePath) ? fs.readFileSync(gitIgnorePath, 'utf8') : ''
    const entry = '/.lucid-git/lucid-presence.json*'
    const lines = existing.split(/\r?\n/)
    // A later negation can override an earlier rule; keep ours last.
    if (lines.filter(line => line.trim() && !line.trim().startsWith('#')).at(-1) !== entry) {
      fs.appendFileSync(gitIgnorePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${entry}\n`, 'utf8')
    }
  }

  removeStale(repoPath: string, maxAgeMs = 30 * 60 * 1000): void {
    try {
      const current = this.read(repoPath)
      const now = Date.now()
      let changed = false
      for (const [login, entry] of Object.entries(current.entries)) {
        if (now - new Date(entry.lastSeen).getTime() > maxAgeMs) {
          delete current.entries[login]
          changed = true
        }
      }
      if (changed) {
        this.ensureIgnored(repoPath)
        writeJson(this.filePath(repoPath), current)
      }
    } catch { /* ignore */ }
  }
}

export const presenceService = new PresenceService()
