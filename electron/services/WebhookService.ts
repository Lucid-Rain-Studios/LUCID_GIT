import { readJson, writeJson, isRecord } from '../util/json-store'
import { app } from 'electron'
import * as path from 'path'
import * as crypto from 'crypto'
import * as https from 'https'
import * as http from 'http'
import type { WebhookConfig } from '../types'

// ── Discord embed colors per event type ────────────────────────────────────────
const EVENT_COLORS: Record<string, number> = {
  fileLocked:              0xe67e22,   // orange
  fileUnlocked:            0x2ecc71,   // green
  mergeConflictDetected:   0xe74c3c,   // red
  pushToMain:              0x3498db,   // blue
  branchCreated:           0x9b59b6,   // purple
  forceUnlock:             0xe74c3c,   // red
  largeFileWarning:        0xf39c12,   // amber
  fatalError:              0xe74c3c,   // red
  cleanupCompleted:        0x2ecc71,   // green
  branchDeleted:           0xe67e22,   // orange
}

function configFile(repoPath: string): string {
  const hash = crypto.createHash('md5').update(repoPath).digest('hex').slice(0, 8)
  return path.join(app.getPath('userData'), `webhook-${hash}.json`)
}

function isQuietHours(config: WebhookConfig): boolean {
  if (!config.quietHours) return false
  const { start, end } = config.quietHours
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const now     = new Date()
  const nowMins = now.getHours() * 60 + now.getMinutes()
  const startMins = sh * 60 + sm
  const endMins   = eh * 60 + em
  // Handle overnight ranges (e.g. 23:00–07:00)
  if (startMins <= endMins) {
    return nowMins >= startMins && nowMins < endMins
  }
  return nowMins >= startMins || nowMins < endMins
}

function postJson(url: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    let parsed: URL
    try { parsed = new URL(url) } catch { return reject(new Error('Invalid webhook URL')) }
    const lib   = parsed.protocol === 'https:' ? https : http
    const req   = lib.request(url, {
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent':     'LucidGit/1.0',
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve()
      } else {
        reject(new Error(`Webhook HTTP ${res.statusCode}`))
      }
      res.resume()
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Webhook timeout')) })
    req.write(data)
    req.end()
  })
}

class WebhookService {
  loadConfig(repoPath: string): WebhookConfig | null {
    return readJson<WebhookConfig | null>(configFile(repoPath), (value): value is WebhookConfig => isRecord(value) && typeof value.url === 'string' && typeof value.enabled === 'boolean' && isRecord(value.events), null)
  }

  saveConfig(repoPath: string, config: WebhookConfig): void {
    writeJson(configFile(repoPath), config)
  }

  async test(url: string): Promise<boolean> {
    try {
      await postJson(url, {
        embeds: [{
          title:       '✅ Lucid Git — webhook test',
          description: 'Webhook connection is working correctly.',
          color:       0x2ecc71,
          timestamp:   new Date().toISOString(),
          footer:      { text: 'Lucid Git' },
        }],
      })
      return true
    } catch {
      return false
    }
  }

  async send(
    repoPath: string,
    eventType: string,
    title: string,
    description: string,
  ): Promise<void> {
    const config = this.loadConfig(repoPath)
    if (!config || !config.enabled) return
    if (!(config.events as Record<string, boolean>)[eventType]) return
    if (isQuietHours(config)) return

    const color    = EVENT_COLORS[eventType] ?? 0x95a5a6
    const mentions = config.mentionRoles?.map(r => `<@&${r}>`).join(' ') ?? ''

    try {
      await postJson(config.url, {
        content: mentions || undefined,
        embeds: [{
          title,
          description,
          color,
          timestamp: new Date().toISOString(),
          footer:    { text: 'Lucid Git' },
        }],
      })
    } catch (e) {
      // Never throw — webhook failures are non-fatal
      console.error('[WebhookService] send failed:', e)
    }
  }
}

export const webhookService = new WebhookService()
