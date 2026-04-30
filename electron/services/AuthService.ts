import keytar from 'keytar'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { Account, DeviceFlowStart } from '../types'
import { logService } from './LogService'

const CLIENT_ID    = 'Ov23licKyg1mhOAj2nRc'
const KEYTAR_SVC   = 'lucid-git'
const SCOPES       = 'repo read:user'
const EXPIRY_SKEW_MS = 5 * 60 * 1000

// ── Tiny JSON store for non-secret account metadata ───────────────────────────

interface AuthData {
  accounts: Account[]
  currentAccountId: string | null
  tokenMetaByUserId?: Record<string, { expiresAt: number | null }>
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'auth.json')
}

function readData(): AuthData {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8')) as AuthData
  } catch {
    return { accounts: [], currentAccountId: null, tokenMetaByUserId: {} }
  }
}

function writeData(data: AuthData): void {
  const p = storePath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8')
}

// ── AuthService ───────────────────────────────────────────────────────────────


function tokenKey(userId: string): string {
  return `github:${userId}`
}

function refreshKey(userId: string): string {
  return `github-refresh:${userId}`
}

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
      refresh_token?: string
      expires_in?: number
      refresh_token_expires_in?: number
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
    await keytar.setPassword(KEYTAR_SVC, tokenKey(userId), d.access_token)
    if (d.refresh_token) {
      await keytar.setPassword(KEYTAR_SVC, refreshKey(userId), d.refresh_token)
    }

    const data = readData()
    data.tokenMetaByUserId ??= {}
    data.tokenMetaByUserId[userId] = {
      expiresAt: d.expires_in ? Date.now() + (d.expires_in * 1000) : null,
    }
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
    await keytar.deletePassword(KEYTAR_SVC, tokenKey(userId))
    await keytar.deletePassword(KEYTAR_SVC, refreshKey(userId))
    const data = readData()
    data.accounts = data.accounts.filter(a => a.userId !== userId)
    if (data.currentAccountId === userId) {
      data.currentAccountId = data.accounts[0]?.userId ?? null
    }
    delete data.tokenMetaByUserId?.[userId]
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
    const data = readData()
    const token = await keytar.getPassword(KEYTAR_SVC, tokenKey(userId))
    if (!token) return null

    const expiresAt = data.tokenMetaByUserId?.[userId]?.expiresAt ?? null
    if (!expiresAt || (expiresAt - Date.now()) > EXPIRY_SKEW_MS) return token

    const refreshToken = await keytar.getPassword(KEYTAR_SVC, refreshKey(userId))
    if (!refreshToken) return token

    const refreshed = await this.refreshAccessToken(refreshToken)
    if (!refreshed) return token

    await keytar.setPassword(KEYTAR_SVC, tokenKey(userId), refreshed.accessToken)
    if (refreshed.refreshToken) {
      await keytar.setPassword(KEYTAR_SVC, refreshKey(userId), refreshed.refreshToken)
    }

    data.tokenMetaByUserId ??= {}
    data.tokenMetaByUserId[userId] = {
      expiresAt: refreshed.expiresIn ? Date.now() + (refreshed.expiresIn * 1000) : null,
    }
    writeData(data)

    logService.info('auth.token', `Refreshed GitHub token for userId: ${userId}`)
    return refreshed.accessToken
  }

  private async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number } | null> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    })

    if (!res.ok) return null

    const d = await res.json() as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      error?: string
    }

    if (!d.access_token || d.error) return null
    return {
      accessToken: d.access_token,
      refreshToken: d.refresh_token,
      expiresIn: d.expires_in,
    }
  }

  async getCurrentToken(): Promise<string | null> {
    const { currentAccountId } = readData()
    if (!currentAccountId) return null
    return this.getToken(currentAccountId)
  }
}

export const authService = new AuthService()
