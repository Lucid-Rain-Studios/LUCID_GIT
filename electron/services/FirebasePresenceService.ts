import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { authService } from './AuthService'
import { readJson, writeJson, isRecord } from '../util/json-store'
import { boundedFetch } from '../util/network'
import type { FirebasePresenceConfig, FirebasePresenceTest, PresenceEntry, PresenceFile } from '../types'

type Identity = { userId: string; login: string; name: string }
type Credential = { uid: string; token: string; expiresAt: number }
type Member = { role: string; login?: string; name?: string }
const CONFIG_FILE = '.lucid-git/firebase-presence.json'

export function validateFirebaseConfig(value: unknown): FirebasePresenceConfig {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' ||
    !['apiKey', 'authDomain', 'projectId', 'databaseURL', 'workspaceId'].every(key => typeof value[key] === 'string')) {
    throw new Error('Enter the Firebase web configuration, database URL and workspace ID.')
  }
  if (Object.keys(value).some(key => !['enabled', 'apiKey', 'authDomain', 'projectId', 'databaseURL', 'workspaceId'].includes(key))) {
    throw new Error('Only public Firebase connection fields are accepted. Do not include private keys or client secrets.')
  }
  const config = value as unknown as FirebasePresenceConfig
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(config.apiKey) || !/^[a-z][a-z0-9-]{4,62}$/.test(config.projectId) ||
    config.authDomain !== `${config.projectId}.firebaseapp.com` || !/^[A-Za-z0-9_-]{1,80}$/.test(config.workspaceId)) {
    throw new Error('Use the Firebase project ID, its default firebaseapp.com auth domain, and a workspace ID containing letters, numbers, hyphens or underscores.')
  }
  let url: URL
  try { url = new URL(config.databaseURL) } catch { throw new Error('Enter a valid Firebase Realtime Database URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' ||
    !/^[a-z0-9-]+(?:\.firebaseio\.com|\.[a-z0-9-]+\.firebasedatabase\.app)$/.test(url.hostname)) {
    throw new Error('Use the HTTPS root URL of a Firebase Realtime Database, without credentials, query parameters or a data path.')
  }
  return { ...config, databaseURL: url.origin }
}

function deviceId(): string {
  const file = path.join(app.getPath('userData'), 'firebase-presence-device.json')
  const saved = readJson(file, (v): v is { id: string } => isRecord(v) && typeof v.id === 'string' && /^[a-f0-9-]{36}$/.test(v.id), { id: '' })
  if (saved.id) return saved.id
  const id = randomUUID()
  writeJson(file, { id })
  return id
}

// REST keeps the presence client small. Missing heartbeats expire after 90 seconds;
// no Git operations, source files, Unreal process details or privileged keys are sent.
export class FirebasePresenceService {
  private credentials = new Map<string, Credential>()
  private authenticating = new Map<string, Promise<Credential>>()
  private queues = new Map<string, { next: (() => Promise<void>) | null; promise: Promise<void> }>()
  private reading = new Map<string, Promise<PresenceFile>>()
  private cachedReads = new Map<string, { expires: number; data: PresenceFile }>()
  private registered = new Set<string>()

  constructor(
    private identity: () => Identity | null = () => {
      const { accounts, currentAccountId } = authService.listAccounts()
      return accounts.find(a => a.userId === currentAccountId) ?? null
    },
    private githubToken: (id: string) => Promise<string | null> = id => authService.getToken(id),
    private request: typeof boundedFetch = boundedFetch,
    private getDeviceId: () => string = deviceId,
  ) {}

  load(repoPath: string): FirebasePresenceConfig | null {
    const file = path.join(repoPath, CONFIG_FILE)
    if (!fs.existsSync(file) && !fs.existsSync(file + '.bak')) return null
    const value = readJson(file, isRecord, {})
    return validateFirebaseConfig(value)
  }

  save(repoPath: string, value: unknown): void {
    writeJson(path.join(repoPath, CONFIG_FILE), validateFirebaseConfig(value))
    this.cachedReads.clear()
  }

  private key(config: FirebasePresenceConfig, identity: Identity): string {
    return JSON.stringify([config.apiKey, config.projectId, config.databaseURL, config.workspaceId, identity.userId])
  }

  private async authenticate(config: FirebasePresenceConfig, identity: Identity): Promise<Credential> {
    const key = this.key(config, identity)
    const cached = this.credentials.get(key)
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached
    const pending = this.authenticating.get(key)
    if (pending) return pending
    const work = (async () => {
      const token = await this.githubToken(identity.userId)
      if (!token) throw new Error('Sign in to GitHub again before connecting Firebase.')
      const response = await this.request(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(config.apiKey)}`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestUri: `https://${config.authDomain}`, returnSecureToken: true,
          postBody: new URLSearchParams({ access_token: token, providerId: 'github.com' }).toString() }),
      }, 8_000)
      if (!response.ok) {
        const failure: unknown = await response.json().catch(() => null)
        const error = isRecord(failure) && isRecord(failure.error) ? failure.error : null
        // Provider messages can contain credentials. Show only a bounded error code.
        const code = typeof error?.message === 'string' ? error.message.match(/^([A-Z][A-Z0-9_]{1,79})(?=\s|:|$)/)?.[1] : undefined
        const guidance: Record<string, string> = {
          OPERATION_NOT_ALLOWED: 'Enable GitHub in Firebase Console → Authentication → Sign-in method, then save its client ID and client secret.',
          CONFIGURATION_NOT_FOUND: 'Initialize Authentication in this Firebase project and enable its GitHub sign-in provider.',
          API_KEY_INVALID: 'Copy the Web API key from this Firebase project’s web app configuration.',
          INVALID_API_KEY: 'Copy the Web API key from this Firebase project’s web app configuration.',
          INVALID_IDP_RESPONSE: 'Sign out of GitHub in Lucid Git and sign in again, then retry. Check the Firebase GitHub provider configuration.',
          PROJECT_NUMBER_MISMATCH: 'Use the API key and GitHub provider configuration belonging to the same Firebase project.',
          USER_DISABLED: 'Enable this user in Firebase Console → Authentication → Users.',
          TOO_MANY_ATTEMPTS_TRY_LATER: 'Wait a few minutes before testing the connection again.',
        }
        throw new Error(`Firebase sign-in failed (${code ?? `HTTP ${response.status}`}). ${guidance[code ?? ''] ?? 'Check the web API key, its API restrictions, and the enabled GitHub sign-in provider.'}`)
      }
      const data: unknown = await response.json()
      if (!isRecord(data) || typeof data.localId !== 'string' || typeof data.idToken !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(data.localId) || !Number.isFinite(Number(data.expiresIn)) || Number(data.expiresIn) <= 0) {
        throw new Error('Firebase returned an invalid authentication response.')
      }
      const credential = { uid: data.localId, token: data.idToken, expiresAt: Date.now() + Number(data.expiresIn) * 1000 }
      this.credentials.set(key, credential)
      return credential
    })().finally(() => this.authenticating.delete(key))
    this.authenticating.set(key, work)
    return work
  }

  private async database(config: FirebasePresenceConfig, credential: Credential, location: string, method = 'GET', value?: unknown): Promise<{ value: unknown; serverNow: number }> {
    const url = `${config.databaseURL}/lucidGit/${config.workspaceId}/${location}.json?auth=${encodeURIComponent(credential.token)}`
    const response = await this.request(url, { method, redirect: 'error', headers: { 'Content-Type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) }, 8_000)
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error(`Firebase denied access. Add Firebase UID ${credential.uid} to this workspace's member list and check its role and database rules.`)
      throw new Error(`Firebase database request failed (${response.status}). Check the database URL and retry.`)
    }
    const body = await response.text()
    if (body.length > 2_000_000) throw new Error('Presence data is too large. Remove obsolete device sessions in Firebase.')
    const serverNow = Date.parse(response.headers.get('date') ?? '')
    return { value: JSON.parse(body), serverNow: Number.isFinite(serverNow) ? serverNow : Date.now() }
  }

  private current(identity: Identity): void {
    if (this.identity()?.userId !== identity.userId) throw new Error('Account changed. Retry with the current account.')
  }

  async test(value: unknown): Promise<FirebasePresenceTest> {
    const config = validateFirebaseConfig(value)
    const identity = this.identity()
    if (!identity) throw new Error('Sign in to GitHub to test Firebase.')
    const credential = await this.authenticate(config, identity)
    this.current(identity)
    const result: FirebasePresenceTest = { uid: credential.uid, canRead: false, canPublish: false, message: '' }
    const probe = `presence/${credential.uid}/test-${randomUUID()}`
    try {
      const own = await this.database(config, credential, `members/${credential.uid}`)
      if (!isRecord(own.value) || own.value.role !== 'admin') throw new Error(`Add Firebase UID ${credential.uid} as an admin under lucidGit/${config.workspaceId}/members in the Firebase console.`)
      await this.database(config, credential, 'members')
      this.current(identity)
      result.canRead = true
      await this.database(config, credential, probe, 'PUT', { status: 'offline', lastSeen: { '.sv': 'timestamp' } })
      await this.database(config, credential, probe, 'DELETE')
      result.canPublish = true
      this.current(identity)
      result.message = 'Connected. Admin read access and own-status publishing verified.'
    } catch (error) {
      result.message = error instanceof Error ? error.message : 'Firebase connection test failed.'
    }
    return result
  }

  private async registerMember(config: FirebasePresenceConfig, credential: Credential, identity: Identity): Promise<void> {
    const key = this.key(config, identity)
    if (this.registered.has(key)) return
    const location = `members/${credential.uid}`
    let own = await this.database(config, credential, location)
    this.current(identity)
    if (own.value === null) {
      try {
        await this.database(config, credential, location, 'PUT', {
          role: 'member', login: identity.login, name: (identity.name || identity.login).slice(0, 100),
        })
        own = { ...own, value: { role: 'member' } }
      } catch (error) {
        // Another device or the console may create the record concurrently.
        // Creation-only rules preserve existing roles, including admin assignments.
        own = await this.database(config, credential, location)
        if (!isRecord(own.value) || !['member', 'admin'].includes(String(own.value.role))) throw error
      }
    }
    this.current(identity)
    if (!isRecord(own.value) || !['member', 'admin'].includes(String(own.value.role))) {
      throw new Error('Firebase membership is disabled for this account. Contact your workspace admin.')
    }
    this.registered.add(key)
  }

  publish(repoPath: string, entry: PresenceEntry): Promise<void> {
    const config = this.load(repoPath)
    if (!config?.enabled) return Promise.resolve()
    const identity = this.identity()
    if (!identity || identity.login !== entry.login) return Promise.resolve()
    const key = this.key(config, identity)
    const job = async () => {
      const credential = await this.authenticate(config, identity)
      this.current(identity)
      await this.registerMember(config, credential, identity)
      await this.database(config, credential, `presence/${credential.uid}/${this.getDeviceId()}`, 'PUT', {
        status: entry.status ?? 'offline', lastSeen: { '.sv': 'timestamp' },
      })
      this.cachedReads.delete(key)
    }
    const pending = this.queues.get(key)
    if (pending) { pending.next = job; return pending.promise }
    // At most one write in flight and one latest state waiting per destination.
    // A slow network cannot build an unbounded heartbeat/retry backlog.
    const queue = { next: job as (() => Promise<void>) | null, promise: Promise.resolve() }
    queue.promise = Promise.resolve().then(async () => {
      let failure: unknown
      while (queue.next) {
        const next = queue.next
        queue.next = null
        try { await next(); failure = undefined } catch (error) { failure = error }
      }
      if (failure) throw failure
    })
    this.queues.set(key, queue)
    void queue.promise.finally(() => { if (this.queues.get(key) === queue) this.queues.delete(key) }).catch(() => {})
    return queue.promise
  }

  async drain(): Promise<void> { await Promise.allSettled([...this.queues.values()].map(queue => queue.promise)) }

  async read(config: FirebasePresenceConfig): Promise<PresenceFile> {
    const identity = this.identity()
    if (!identity) throw new Error('Sign in to GitHub to read Firebase presence.')
    const key = this.key(config, identity)
    const cached = this.cachedReads.get(key)
    if (cached && cached.expires > Date.now()) return cached.data
    const pending = this.reading.get(key)
    if (pending) return pending
    const work = (async () => {
      const credential = await this.authenticate(config, identity)
      this.current(identity)
      const [roster, presence] = await Promise.all([
        this.database(config, credential, 'members'), this.database(config, credential, 'presence'),
      ])
      this.current(identity)
      const members = isRecord(roster.value) ? roster.value : {}
      const ownMember = members[credential.uid]
      if (!isRecord(ownMember) || ownMember.role !== 'admin') throw new Error('Firebase admin membership is required to view this workspace.')
      const sessions = isRecord(presence.value) ? presence.value : {}
      const entries: Record<string, PresenceEntry> = Object.create(null)
      const receivedAt = Date.now()
      for (const [uid, rawMember] of Object.entries(members)) {
        if (!isRecord(rawMember) || !['admin', 'member'].includes(String(rawMember.role))) continue
        const member = rawMember as Member
        const login = typeof member.login === 'string' && member.login ? member.login : uid
        const entry: PresenceEntry = { login, name: typeof member.name === 'string' && member.name ? member.name : login,
          status: 'offline', lastSeen: new Date(0).toISOString(), branch: '', modifiedCount: 0, modifiedFiles: [] }
        const devices = isRecord(sessions[uid]) ? Object.values(sessions[uid]) : []
        for (const device of devices) {
          if (!isRecord(device) || typeof device.lastSeen !== 'number' || !Number.isSafeInteger(device.lastSeen) || device.lastSeen < 0 || device.lastSeen > presence.serverNow + 1_000 ||
            !['active', 'away', 'offline'].includes(String(device.status))) continue
          const age = Math.max(0, presence.serverNow - device.lastSeen)
          const status = age >= 90_000 ? 'offline' : device.status as 'active' | 'away' | 'offline'
          const normalized = new Date(receivedAt - age).toISOString()
          const rank = { active: 0, away: 1, offline: 2 }
          if (rank[status] < rank[entry.status!] || (rank[status] === rank[entry.status!] && normalized > entry.lastSeen)) {
            entry.status = status; entry.lastSeen = normalized
          }
        }
        entries[uid] = entry
      }
      const data: PresenceFile = { version: 1, source: 'firebase', entries }
      this.cachedReads.set(key, { expires: Date.now() + 5_000, data })
      return data
    })().finally(() => this.reading.delete(key))
    this.reading.set(key, work)
    return work
  }
}

export const firebasePresenceService = new FirebasePresenceService()
