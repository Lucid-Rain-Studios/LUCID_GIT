import type { PresenceEntry } from '@/ipc'

export function presenceStatus(entry: PresenceEntry, now = Date.now()): 'active' | 'away' | 'offline' {
  const lastSeen = Date.parse(entry.lastSeen)
  if (!Number.isFinite(lastSeen) || lastSeen > now || now - lastSeen >= 90_000) return 'offline'
  // Legacy entries contain no reliable indication of app activity.
  return entry.status === 'active' || entry.status === 'away' ? entry.status : 'offline'
}
