import keytar from 'keytar'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { Account, DeviceFlowStart } from '../types'
import { logService } from './LogService'

const CLIENT_ID    = 'Ov23licKyg1mhOAj2nRc'
const KEYTAR_SVC   = 'lucid-git'
const SCOPES       = 'repo read:user'

// ── Tiny JSON store for non-secret account metadata ───────────────────────────

interface AuthData {
  accounts: Account[]
  currentAccountId: string | null
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'auth.json')
}

function readData(): AuthData {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8')) as AuthData
  } catch {
    return { accounts: [], currentAccountId: null }
  }
}

function writeData(data: AuthData): void {
  const p = storePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
}

// ── AuthService ───────────────────────────────────────────────────────────────

class AuthService {
  async startDeviceFlow(): Promise<DeviceFlowStart> {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES }).toString(),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub device/code request failed: ${res.status} — ${body}`)
    }

    const d = await res.json() as {
      device_code: string
      user_code: string
      verification_uri: string
      expires_in: number
      interval: number
    }

    return {
      deviceCode:      d.device_code,
      userCode:        d.user_code,
      verificationUri: d.verification_uri,
      expiresIn:       d.expires_in,
      interval:        d.interval,
    }
  }

  // Returns null while pending; throws on expired/denied; returns account on success.
  async pollDeviceFlow(deviceCode: string): Promise<{ token: string; userId: string } | null> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id:   CLIENT_ID,
        device_code: deviceCode,
        grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub token poll failed: ${res.status} — ${body}`)
    }

    const d = await res.json() as {
      access_token?: string
      error?: string
      error_description?: string
    }

    if (d.error) {
      // These two mean "keep waiting"
      if (d.error === 'authorization_pending' || d.error === 'slow_down') return null
      throw new Error(d.error_description ?? d.error)
    }

    if (!d.access_token) return null

    // ── Fetch user profile ────────────────────────────────────────────────────
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization:          `Bearer ${d.access_token}`,
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!userRes.ok) {
      logService.error('auth.deviceFlow', `Failed to fetch GitHub user profile: ${userRes.status} ${userRes.statusText}`)
      throw new Error('Failed to fetch GitHub user profile')
    }

    const u = await userRes.json() as {
      id: number; login: string; name: string | null; avatar_url: string
    }

    const userId = String(u.id)

    // ── Persist token + metadata ──────────────────────────────────────────────
    await keytar.setPassword(KEYTAR_SVC, `github:${userId}`, d.access_token)

    const data = readData()
    const meta: Account = {
      userId,
      login:     u.login,
      name:      u.name ?? u.login,
      avatarUrl: u.avatar_url,
    }
    const idx = data.accounts.findIndex(a => a.userId === userId)
    if (idx >= 0) data.accounts[idx] = meta
    else data.accounts.push(meta)
    if (!data.currentAccountId) data.currentAccountId = userId
    writeData(data)

    logService.info('auth.deviceFlow', `Authenticated successfully as ${u.login} (userId: ${userId})`)
    return { token: d.access_token, userId }
  }

  listAccounts(): { accounts: Account[]; currentAccountId: string | null } {
    const data = readData()
    return { accounts: data.accounts, currentAccountId: data.currentAccountId }
  }

  async logout(userId: string): Promise<void> {
    logService.info('auth', `Logging out userId: ${userId}`)
    await keytar.deletePassword(KEYTAR_SVC, `github:${userId}`)
    const data = readData()
    data.accounts = data.accounts.filter(a => a.userId !== userId)
    if (data.currentAccountId === userId) {
      data.currentAccountId = data.accounts[0]?.userId ?? null
    }
    writeData(data)
  }

  async setCurrentAccount(userId: string): Promise<void> {
    const data = readData()
    if (data.accounts.some(a => a.userId === userId)) {
      data.currentAccountId = userId
      writeData(data)
    }
  }

  async getToken(userId: string): Promise<string | null> {
    return keytar.getPassword(KEYTAR_SVC, `github:${userId}`)
  }

  async getCurrentToken(): Promise<string | null> {
    const { currentAccountId } = readData()
    if (!currentAccountId) return null
    return this.getToken(currentAccountId)
  }
}

export const authService = new AuthService()
