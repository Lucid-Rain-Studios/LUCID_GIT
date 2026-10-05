import { readJson, writeJson, isRecord } from '../util/json-store'
import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import type { AppNotification } from '../types'

const MAX_NOTIFICATIONS = 100

function notifFile(repoPath: string): string {
  const hash = crypto.createHash('md5').update(repoPath).digest('hex').slice(0, 8)
  return path.join(app.getPath('userData'), `notifications-${hash}.json`)
}

function load(repoPath: string): AppNotification[] {
  return readJson(notifFile(repoPath), (value): value is AppNotification[] => Array.isArray(value) && value.every(item => isRecord(item) && typeof item.id === 'number' && typeof item.type === 'string'), [])
}

function save(repoPath: string, notifications: AppNotification[]): void {
  writeJson(notifFile(repoPath), notifications)
}

// Counter that survives the session; prefix with timestamp to avoid collision across restarts
let _counter = 0

class NotificationService {
  clearAll(): void {
    const directory = app.getPath('userData')
    for (const file of fs.readdirSync(directory)) {
      if (/^notifications-[a-f0-9]{8}\.json$/.test(file)) {
        writeJson(path.join(directory, file), [])
      }
    }
  }

  list(repoPath: string): AppNotification[] {
    return load(repoPath)
  }

  push(
    repoPath: string,
    type: string,
    title: string,
    body: string,
    meta?: Record<string, unknown>,
  ): AppNotification {
    const notifications = load(repoPath)
    if (meta?.eventKey) {
      const existing = notifications.find(item => item.meta?.eventKey === meta.eventKey)
      if (existing) return existing
    }
    const n: AppNotification = {
      id:        Date.now() * 1000 + (_counter++ % 1000),
      type,
      title,
      body,
      repoPath,
      createdAt: new Date().toISOString(),
      read:      false,
      meta,
    }
    notifications.unshift(n)
    save(repoPath, notifications.slice(0, MAX_NOTIFICATIONS))
    return n
  }

  markRead(id: number): void {
    // Scan all notification files in userData to find the one containing this id
    const userDataPath = app.getPath('userData')
    let files: string[]
    try {
      files = fs.readdirSync(userDataPath).filter(
        f => f.startsWith('notifications-') && f.endsWith('.json')
      )
    } catch {
      return
    }
    for (const file of files) {
      const filePath = path.join(userDataPath, file)
      try {
        const notifications = readJson(filePath, (value): value is AppNotification[] => Array.isArray(value) && value.every(item => isRecord(item) && typeof item.id === 'number'), [])
        const idx = notifications.findIndex(n => n.id === id)
        if (idx !== -1) {
          notifications[idx] = { ...notifications[idx], read: true }
          writeJson(filePath, notifications)
          return
        }
      } catch {
        // skip corrupt file
      }
    }
  }
}

export const notificationService = new NotificationService()
