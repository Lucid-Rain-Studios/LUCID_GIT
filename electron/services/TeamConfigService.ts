import { readJson, writeJson, isRecord } from '../util/json-store'
import * as fs from 'fs'
import * as path from 'path'
import { gitService } from './GitService'
import { hookService } from './HookService'
import { webhookService } from './WebhookService'

export interface TeamConfig {
  lfsPatterns: string[]
  webhookEvents: Record<string, boolean>
  hookIds: string[]
  largeFileWarnMB?: number
}

const CONFIG_PATH = '.lucid-git/team-config.json'

class TeamConfigService {
  validate(config: TeamConfig): void {
    const hooks = new Set(hookService.builtins().map(hook => hook.id))
    if (!isRecord(config) || !Array.isArray(config.lfsPatterns) || config.lfsPatterns.length > 100 ||
      config.lfsPatterns.some(pattern => typeof pattern !== 'string' || !pattern.trim() || pattern.startsWith('-') || /[\r\n\0]/.test(pattern) || pattern.length > 256) ||
      !Array.isArray(config.hookIds) || config.hookIds.some(id => !hooks.has(id)) ||
      !isRecord(config.webhookEvents) || Object.entries(config.webhookEvents).some(([event, value]) => !['fileLocked', 'fileUnlocked'].includes(event) || typeof value !== 'boolean')) {
      throw new Error('Invalid team policy. Use supported hook IDs, LFS patterns and lock webhook events.')
    }
  }

  async apply(repoPath: string, config: TeamConfig): Promise<void> {
    this.validate(config)
    const webhook = webhookService.loadConfig(repoPath)
    if (Object.keys(config.webhookEvents).length && !webhook) throw new Error('Configure a local webhook URL before applying webhook events.')
    await gitService.lfsTrack(repoPath, [...new Set(config.lfsPatterns)])
    for (const id of new Set(config.hookIds)) hookService.installBuiltin(repoPath, id)
    if (webhook) webhookService.saveConfig(repoPath, { ...webhook, events: { ...webhook.events, ...config.webhookEvents } })
  }
  private configPath(repoPath: string): string {
    return path.join(repoPath, CONFIG_PATH)
  }

  load(repoPath: string): TeamConfig | null {
    const p = this.configPath(repoPath)
    if (!fs.existsSync(p) && !fs.existsSync(p + '.bak')) return null
    return readJson(p, (value): value is TeamConfig => isRecord(value) && Array.isArray(value.lfsPatterns) && value.lfsPatterns.every(item => typeof item === 'string') &&
      Array.isArray(value.hookIds) && value.hookIds.every(item => typeof item === 'string') && isRecord(value.webhookEvents), { lfsPatterns: [], hookIds: [], webhookEvents: {} })
  }

  save(repoPath: string, config: TeamConfig): void {
    this.validate(config)
    const dir = path.dirname(this.configPath(repoPath))
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    writeJson(this.configPath(repoPath), config)
  }
}

export const teamConfigService = new TeamConfigService()
