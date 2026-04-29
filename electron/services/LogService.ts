import fs from 'fs'
import path from 'path'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

interface LogEntry {
  ts: string
  level: LogLevel
  source: string
  message: string
}

interface LogSession {
  id: string
  startedAt: string
  endedAt?: string
  platform: string
  entries: LogEntry[]
}

interface LogStore {
  sessions: LogSession[]
}

const MAX_SESSIONS = 5
const PAD_TIME     = 12  // "HH:MM:SS.mmm"
const PAD_LEVEL    = 5   // "ERROR"
const PAD_SOURCE   = 20

class LogService {
  private storePath: string | null = null
  private pastSessions: LogSession[] = []
  private current: LogSession | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  init(userDataPath: string): void {
    this.storePath = path.join(userDataPath, 'lucid-git-logs.json')
    this.load()
    this.current = {
      id:        new Date().toISOString(),
      startedAt: new Date().toISOString(),
      platform:  process.platform,
      entries:   [],
    }
    this.add('INFO', 'app', `Session started — Lucid Git  |  pid ${process.pid}  |  node ${process.versions.node}`)
  }

  endSession(): void {
    if (!this.current) return
    this.add('INFO', 'app', 'Session ended')
    this.current.endedAt = new Date().toISOString()
    this.persist(true)
  }

  // ── Logging API ───────────────────────────────────────────────────────────────

  info(source: string, message: string): void  { this.add('INFO',  source, message) }
  warn(source: string, message: string): void   { this.add('WARN',  source, message) }
  error(source: string, message: string): void  { this.add('ERROR', source, message) }

  // ── Persistence ───────────────────────────────────────────────────────────────

  private add(level: LogLevel, source: string, message: string): void {
    if (!this.current) return
    this.current.entries.push({ ts: new Date().toISOString(), level, source, message })
    this.schedulePersist()
  }

  private schedulePersist(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => this.persist(), 2000)
  }

  private persist(sync = false): void {
    if (!this.storePath || !this.current) return
    const all     = [...this.pastSessions, this.current]
    const trimmed = all.slice(-MAX_SESSIONS)
    const json    = JSON.stringify({ sessions: trimmed } as LogStore, null, 2)
    try {
      if (sync) {
        fs.writeFileSync(this.storePath, json, 'utf8')
      } else {
        fs.writeFile(this.storePath, json, 'utf8', () => {})
      }
    } catch { /* ignore — log write failure must never crash the app */ }
  }

  private load(): void {
    if (!this.storePath) return
    try {
      const raw   = fs.readFileSync(this.storePath, 'utf8')
      const store = JSON.parse(raw) as LogStore
      this.pastSessions = (store.sessions ?? []).slice(-MAX_SESSIONS)
    } catch {
      this.pastSessions = []
    }
  }

  // ── Formatted output ──────────────────────────────────────────────────────────

  getFormattedText(): string {
    const all: LogSession[] = [...this.pastSessions]
    if (this.current) all.push(this.current)
    if (all.length === 0) return '(no sessions recorded)'
    return all.map(s => this.formatSession(s)).join('\n\n')
  }

  private formatSession(s: LogSession): string {
    const divider  = '═'.repeat(64)
    const dateStr  = new Date(s.startedAt).toUTCString()
    const endStr   = s.endedAt
      ? `  →  ended ${new Date(s.endedAt).toUTCString()}`
      : '  (current session)'

    const header = [
      divider,
      ` SESSION  ${dateStr}${endStr}`,
      ` Platform: ${s.platform}`,
      divider,
    ].join('\n')

    if (s.entries.length === 0) return header + '\n  (no entries)'

    const indent = ' '.repeat(2 + PAD_TIME + 1 + PAD_LEVEL + 1 + PAD_SOURCE + 1)

    const lines = s.entries.map(e => {
      const d    = new Date(e.ts)
      const time = [
        String(d.getUTCHours()).padStart(2, '0'),
        String(d.getUTCMinutes()).padStart(2, '0'),
        String(d.getUTCSeconds()).padStart(2, '0'),
      ].join(':') + '.' + String(d.getUTCMilliseconds()).padStart(3, '0')

      const level  = e.level.padEnd(PAD_LEVEL)
      const source = e.source.slice(0, PAD_SOURCE).padEnd(PAD_SOURCE)
      const msgLines = e.message.replace(/\r\n/g, '\n').split('\n')
      const first    = `  ${time} ${level} ${source} ${msgLines[0]}`
      const rest     = msgLines.slice(1).filter(Boolean).map(l => `${indent}${l}`)
      return [first, ...rest].join('\n')
    })

    return header + '\n' + lines.join('\n')
  }

  // ── Suggestion engine ─────────────────────────────────────────────────────────

  getSuggestion(): string | null {
    const session = this.current ?? this.pastSessions[this.pastSessions.length - 1]
    if (!session) return null

    const errors = session.entries.filter(e => e.level === 'ERROR')
    if (errors.length === 0) return null

    const combined = errors.map(e => e.message).join('\n')

    if (/authentication failed|EAUTH|Invalid credentials|bad credentials|401|403 Forbidden/i.test(combined))
      return 'Authentication failures detected. Sign out and back in from the account menu. If this repo is in a GitHub organization, authorize the app for SSO at: github.com → Settings → Applications → find Lucid Git → Grant.'

    if (/permission denied.*publickey|publickey.*permission denied|Could not read from remote repository/i.test(combined))
      return 'SSH key authentication is failing. Add your SSH public key to GitHub, or switch the remote to HTTPS:\n  git remote set-url origin https://github.com/org/repo.git'

    if (/no space left|ENOSPC|disk quota exceeded/i.test(combined))
      return 'Disk is full. Run Git GC from Admin → Cleanup to reclaim space from old pack files and LFS cache.'

    if (/lfs.*storage.*exceeded|lfs.*quota|bandwidth.*exceeded|storage quota/i.test(combined))
      return 'GitHub LFS quota exceeded. Prune unreferenced objects via Admin → Cleanup → Prune LFS, or upgrade at: github.com → Settings → Billing → Git LFS Data.'

    if (/rejected.*non-fast-forward|fetch first|Updates were rejected/i.test(combined))
      return 'Push rejected — the remote has newer commits. Pull (with rebase) before pushing again.'

    if (/CONFLICT|Automatic merge failed/i.test(combined))
      return 'Merge conflicts are present. Open the Branches panel and use the conflict resolver to resolve them manually.'

    if (/pack.*corrupt|object.*corrupt|index-pack failed/i.test(combined))
      return 'Git pack-file corruption detected. Run Git GC from Admin → Cleanup. If it persists, re-clone the repository.'

    if (/PERMISSION_DENIED.*Admin|Admin access required/i.test(combined))
      return 'Some operations require Admin role in Lucid Git. Ask your repository admin to grant you elevated permissions.'

    if (/timed? ?out|Could not resolve host|SSL_connect/i.test(combined))
      return 'Network errors detected. Check your internet connection and ensure a firewall or proxy is not blocking GitHub traffic.'

    if (/GH001|exceeds.*file size limit|file is.*larger than/i.test(combined))
      return 'A file exceeds GitHub\'s size limit. Track large files with Git LFS via Admin → LFS.'

    return `${errors.length} error(s) logged this session. Check the [ERROR] lines above for details. Copy this log and paste it into Claude to identify the root cause.`
  }

  // ── File save ─────────────────────────────────────────────────────────────────

  saveToFile(filePath: string): void {
    fs.writeFileSync(filePath, this.getFormattedText(), 'utf8')
  }
}

export const logService = new LogService()
