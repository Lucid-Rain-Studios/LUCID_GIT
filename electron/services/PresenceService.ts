import { readJson, writeJson, isRecord, JsonStoreReadError } from '../util/json-store'
import { randomUUID } from 'node:crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { PresenceEntry, PresenceFile } from '../types'

class PresenceService {
  private filePath(repoPath: string): string {
    return path.join(repoPath, '.lucid-git', 'presence.json')
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
      const suffix = '.invalid-' + randomUUID()
      const saved: string[] = []
      for (const candidate of [file, file + '.bak']) {
        try { fs.renameSync(candidate, candidate + suffix); saved.push(candidate + suffix) }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
      }
      this.ensureIgnored(repoPath)
      console.warn('Restarted local presence; unreadable data preserved at:', ...saved)
      return { version: 1, entries: {} }
    }
  }

  update(repoPath: string, login: string, entry: PresenceEntry): void {
    const dir = path.join(repoPath, '.lucid-git')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    const current = this.read(repoPath)
    current.entries[login] = entry
    writeJson(this.filePath(repoPath), current)

    // Ensure .lucid-git/presence.json is in .gitignore (local ignore)
    this.ensureIgnored(repoPath)
  }

  private ensureIgnored(repoPath: string): void {
    const gitIgnorePath = path.join(repoPath, '.git', 'info', 'exclude')
    try {
      const existing = fs.existsSync(gitIgnorePath) ? fs.readFileSync(gitIgnorePath, 'utf8') : ''
      const entry = '.lucid-git/presence.json*'
      if (!existing.includes(entry)) {
        fs.appendFileSync(gitIgnorePath, `\n${entry}\n`, 'utf8')
      }
    } catch {
      // Non-critical: just skip if we can't write the exclude file
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
        writeJson(this.filePath(repoPath), current)
      }
    } catch { /* ignore */ }
  }
}

export const presenceService = new PresenceService()
