import type { PresenceEntry } from '../types'

type Identity = { login: string; name: string }

// Main-process heartbeat: never depends on which renderer panel is mounted.
export class PresenceSession {
  private session: { repoPath: string; identity: Identity } | null = null
  private locked = false

  constructor(
    private identity: () => Identity | null,
    private idleState: () => string,
    private publish: (repoPath: string, login: string, entry: PresenceEntry) => void,
  ) {}

  start(repoPath: string): void {
    const identity = this.identity()
    if (!identity) throw new Error('Sign in to publish presence')
    this.stop()
    this.session = { repoPath, identity }
    this.tick()
  }

  setLocked(locked: boolean): void { this.locked = locked }

  private write(status: 'active' | 'away' | 'offline'): void {
    if (!this.session) return
    const { repoPath, identity } = this.session
    this.publish(repoPath, identity.login, {
      ...identity, status, lastSeen: new Date().toISOString(),
      branch: '', modifiedCount: 0, modifiedFiles: [],
    })
  }

  tick(): void {
    if (!this.session) return
    if (this.identity()?.login !== this.session.identity.login) { this.stop(); return }
    const idle = this.idleState()
    this.write(this.locked || idle === 'idle' || idle === 'locked' || idle === 'unknown' ? 'away' : 'active')
  }

  stop(): void {
    this.write('offline')
    this.session = null
  }
}
