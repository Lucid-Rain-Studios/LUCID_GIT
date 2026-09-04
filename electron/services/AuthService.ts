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
// How long a successful scope validation of a non-expiring token is trusted
// before re-checking against the GitHub API. Keeps the lock/PR pollers from
// hitting GET /user on every cycle (which can trip secondary rate limits).
const SCOPE_VALIDATION_TTL_MS = 10 * 60 * 1000
// After an inconclusive validation (GitHub outage / rate limit), wait this
// long before trying to validate again instead of re-fetching on every call.
const INDETERMINATE_RETRY_MS = 60 * 1000
const PROFILE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
const PROFILE_REQUEST_TIMEOUT_MS = 15_000

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


function parseScopes(scopeHeader: string | null): Set<string> {
  if (!scopeHeader) return new Set()
  return new Set(scopeHeader.split(',').map(s => s.trim()).filter(Boolean))
}

function hasRequiredScopes(scopes: Set<string>): boolean {
  return scopes.has('repo')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function profileRetryDelayMs(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1_000
  return PROFILE_RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 250)
}

async function fetchGitHubProfile(accessToken: string): Promise<Response> {
  const maxAttempts = PROFILE_RETRY_DELAYS_MS.length + 1

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROFILE_REQUEST_TIMEOUT_MS)
    let res: Response

    try {
      res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization:          `Bearer ${accessToken}`,
          Accept:                 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent':           'LucidGit',
        },
        signal: controller.signal,
      })
    } catch (error) {
      if (attempt < maxAttempts - 1) {
        const delay = PROFILE_RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 250)
        logService.warn('auth.deviceFlow', `GitHub profile request failed; retrying in ${delay}ms (${attempt + 1}/${maxAttempts})`)
        await sleep(delay)
        continue
      }
      throw new Error(
        `GitHub is temporarily unreachable. Please try signing in again. (${error instanceof Error ? error.message : String(error)})`,
      )
    } finally {
      clearTimeout(timeout)
    }

    const transient = res.status === 429 || res.status >= 500
    if (transient && attempt < maxAttempts - 1) {
      const delay = profileRetryDelayMs(res, attempt)
      logService.warn('auth.deviceFlow', `GitHub profile request returned ${res.status}; retrying in ${delay}ms (${attempt + 1}/${maxAttempts})`)
      await sleep(delay)
      continue
    }

    return res
  }

  throw new Error('GitHub is temporarily unavailable. Please try signing in again.')
}

// Outcome of checking a token against the GitHub API. 'indeterminate' means
// we could not get a definitive answer (network failure, rate limiting, or a
// GitHub outage) — callers must NOT treat that as a revoked token.
type TokenValidity = 'valid' | 'invalid' | 'indeterminate'

interface PendingDeviceToken {
  access_token: string
  refresh_token?: string
  expires_in?: number
  refresh_token_expires_in?: number
}

class AuthService {
  // userId → timestamp of last successful scope validation (in-memory only)
  private scopeValidatedAt = new Map<string, number>()
  // userId → timestamp of last inconclusive validation (cooldown before retry)
  private lastIndeterminateAt = new Map<string, number>()
  // userId → in-flight validation, shared by concurrent getToken calls so a
  // burst of callers (pollers, panel loads) produces one GET /user, not many
  private validationInFlight = new Map<string, Promise<TokenValidity>>()
  // A device code can only be exchanged once. Keep its issued token in memory
  // until profile loading succeeds so a transient /user outage does not force
  // the user through another authorization flow.
  private pendingDeviceTokens = new Map<string, PendingDeviceToken>()

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
    let d = this.pendingDeviceTokens.get(deviceCode)
    if (!d) {
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

      const tokenResponse = await res.json() as Partial<PendingDeviceToken> & {
        error?: string
        error_description?: string
      }

      if (tokenResponse.error) {
        // These two mean "keep waiting"
        if (tokenResponse.error === 'authorization_pending' || tokenResponse.error === 'slow_down') return null
        throw new Error(tokenResponse.error_description ?? tokenResponse.error)
      }

      if (!tokenResponse.access_token) return null
      d = { ...tokenResponse, access_token: tokenResponse.access_token }
      this.pendingDeviceTokens.set(deviceCode, d)
    }

    // ── Fetch user profile ────────────────────────────────────────────────────
    let userRes: Response
    try {
      userRes = await fetchGitHubProfile(d.access_token)
    } catch (error) {
      // Keep the exchanged token and let the renderer's normal poll interval
      // retry profile loading. The device code itself cannot be exchanged again.
      logService.warn('auth.deviceFlow', error instanceof Error ? error.message : String(error))
      return null
    }
    if (!userRes.ok) {
      if (userRes.status === 429 || userRes.status >= 500) {
        logService.warn('auth.deviceFlow', `GitHub profile temporarily unavailable after retries: ${userRes.status} ${userRes.statusText}`)
        return null
      }
      this.pendingDeviceTokens.delete(deviceCode)
      logService.error('auth.deviceFlow', `Failed to fetch GitHub user profile: ${userRes.status} ${userRes.statusText}`)
      if (userRes.status === 401) {
        throw new Error('GitHub rejected the sign-in token. Please start sign-in again.')
      }
      throw new Error(`Failed to fetch GitHub user profile (${userRes.status})`)
    }

    const grantedScopes = parseScopes(userRes.headers.get('x-oauth-scopes'))
    if (!hasRequiredScopes(grantedScopes)) {
      const scopesText = [...grantedScopes].join(', ') || 'none'
      logService.error('auth.deviceFlow', `GitHub token missing required scopes. Granted: ${scopesText}`)
      throw new Error('GitHub token missing required scopes (repo). Please sign in again.')
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

    this.scopeValidatedAt.set(userId, Date.now())
    this.pendingDeviceTokens.delete(deviceCode)

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
    this.scopeValidatedAt.delete(userId)
    this.lastIndeterminateAt.delete(userId)
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
    if (!expiresAt) {
      const lastValidated = this.scopeValidatedAt.get(userId) ?? 0
      if (Date.now() - lastValidated < SCOPE_VALIDATION_TTL_MS) return token

      // During a GitHub outage, don't re-attempt validation on every call —
      // back off and trust the stored token until the cooldown lapses.
      const lastIndeterminate = this.lastIndeterminateAt.get(userId) ?? 0
      if (Date.now() - lastIndeterminate < INDETERMINATE_RETRY_MS) return token

      let inFlight = this.validationInFlight.get(userId)
      if (!inFlight) {
        inFlight = this.validateTokenScopes(token)
          .finally(() => this.validationInFlight.delete(userId))
        this.validationInFlight.set(userId, inFlight)
      }
      const validity = await inFlight

      if (validity === 'invalid') {
        this.scopeValidatedAt.delete(userId)
        logService.warn('auth.token', `GitHub token for userId ${userId} is revoked or missing required scopes`)
        return null
      }
      if (validity === 'valid') {
        this.scopeValidatedAt.set(userId, Date.now())
        this.lastIndeterminateAt.delete(userId)
      } else {
        // 'indeterminate' (network failure, rate limit, GitHub outage): fail
        // open with the stored token — if it is truly bad, the git operation
        // itself will fail with a clear auth error instead of us guessing.
        this.lastIndeterminateAt.set(userId, Date.now())
      }
      return token
    }
    if ((expiresAt - Date.now()) > EXPIRY_SKEW_MS) return token

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


  private async validateTokenScopes(accessToken: string): Promise<TokenValidity> {
    let userRes: Response
    try {
      userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization:          `Bearer ${accessToken}`,
          Accept:                 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
    } catch (error) {
      logService.warn('auth.token', `Token validation skipped — GitHub API unreachable: ${error instanceof Error ? error.message : String(error)}`)
      return 'indeterminate'
    }

    // Only a 401 definitively means the token is revoked. 403 can be a
    // secondary rate limit or org SSO enforcement, and 5xx is a GitHub
    // outage — none of those prove the token itself is bad.
    if (userRes.status === 401) return 'invalid'
    if (!userRes.ok) {
      logService.warn('auth.token', `Token validation inconclusive — GitHub API returned ${userRes.status}`)
      return 'indeterminate'
    }

    const grantedScopes = parseScopes(userRes.headers.get('x-oauth-scopes'))
    return hasRequiredScopes(grantedScopes) ? 'valid' : 'invalid'
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
