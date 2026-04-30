import React, { useEffect, useRef, useState } from 'react'
import { useNotificationStore } from '@/stores/notificationStore'
import { useLockStore } from '@/stores/lockStore'
import { ipc, AppNotification } from '@/ipc'

interface NotificationFeedProps {
  onClose: () => void
}

const TYPE_ICON: Record<string, string> = {
  lock:      '🔒',
  unlock:    '🔓',
  error:     '⚠️',
  'pr-merged': '✅',
  'pr-closed': '🚫',
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

export function NotificationFeed({ onClose }: NotificationFeedProps) {
  const { notifications, unreadCount, markRead, markAllRead, clearAll } = useNotificationStore()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute right-0 top-9 z-50 w-96 bg-lg-bg-elevated border border-lg-border rounded-lg shadow-2xl overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-lg-border">
        <span className="text-[10px] font-mono uppercase tracking-widest text-lg-text-secondary">
          Notifications {unreadCount > 0 && `(${unreadCount} unread)`}
        </span>
        <div className="flex gap-2">
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="text-[10px] font-mono text-lg-text-secondary hover:text-lg-accent transition-colors"
            >
              Mark all read
            </button>
          )}
          {notifications.length > 0 && (
            <button
              onClick={clearAll}
              className="text-[10px] font-mono text-lg-text-secondary hover:text-lg-error transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="max-h-[28rem] overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] font-mono text-lg-text-secondary">
            No notifications
          </div>
        ) : (
          notifications.map(n =>
            n.type === 'pr-merged' ? (
              <PRMergedItem key={n.id} notification={n} onRead={() => markRead(n.id)} />
            ) : n.type === 'pr-closed' ? (
              <PRClosedItem key={n.id} notification={n} onRead={() => markRead(n.id)} />
            ) : (
              <NotificationItem key={n.id} notification={n} onRead={() => markRead(n.id)} />
            )
          )
        )}
      </div>
    </div>
  )
}

// ── Standard notification item ────────────────────────────────────────────────

function NotificationItem({
  notification: n,
  onRead,
}: {
  notification: AppNotification
  onRead: () => void
}) {
  return (
    <div
      onClick={onRead}
      title={`${n.title}\n${n.body}`}
      className={`flex items-start gap-2.5 px-3 py-2.5 border-b border-lg-border/50 cursor-pointer transition-colors hover:bg-lg-bg-secondary ${
        n.read ? 'opacity-60' : ''
      }`}
    >
      <span className="text-sm shrink-0 mt-0.5">{TYPE_ICON[n.type] ?? '●'}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-mono text-lg-text-primary font-semibold truncate">{n.title}</div>
        <div className="text-[10px] font-mono text-lg-text-secondary truncate">{n.body}</div>
        <div className="text-[9px] font-mono text-lg-text-secondary/60 mt-0.5">{timeAgo(n.createdAt)}</div>
      </div>
      {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-lg-accent shrink-0 mt-1.5" />}
    </div>
  )
}

// ── PR Merged item — shows locked-file unlock UI ──────────────────────────────

function PRMergedItem({
  notification: n,
  onRead,
}: {
  notification: AppNotification
  onRead: () => void
}) {
  const { unlockFile } = useLockStore()
  const [unlocking, setUnlocking] = useState<Set<string>>(new Set())
  const [unlocked,  setUnlocked]  = useState<Set<string>>(new Set())

  const meta        = n.meta ?? {}
  const prNumber    = meta.prNumber as number | undefined
  const htmlUrl     = meta.htmlUrl  as string | undefined
  const lockedFiles = (meta.lockedFiles as string[] | undefined) ?? []

  const handleUnlock = async (filePath: string) => {
    if (unlocking.has(filePath) || unlocked.has(filePath)) return
    setUnlocking(prev => new Set([...prev, filePath]))
    try {
      await unlockFile(n.repoPath, filePath)
      setUnlocked(prev => new Set([...prev, filePath]))
    } catch {}
    setUnlocking(prev => { const s = new Set(prev); s.delete(filePath); return s })
  }

  const handleUnlockAll = async () => {
    const remaining = lockedFiles.filter(f => !unlocked.has(f))
    await Promise.allSettled(remaining.map(f => handleUnlock(f)))
  }

  const allUnlocked = lockedFiles.length > 0 && lockedFiles.every(f => unlocked.has(f))

  return (
    <div
      className={`border-b border-lg-border/50 transition-colors ${n.read ? 'opacity-70' : ''}`}
      onClick={() => { if (!n.read) onRead() }}
    >
      {/* Header row */}
      <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-1.5">
        <span className="text-sm shrink-0 mt-0.5">✅</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-mono text-lg-text-primary font-semibold">
              {n.title}
            </span>
            {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-lg-accent shrink-0" />}
          </div>
          <div className="text-[9px] font-mono text-lg-text-secondary/60 mt-0.5">
            {timeAgo(n.createdAt)}
            {htmlUrl && (
              <button
                onClick={e => { e.stopPropagation(); ipc.openExternal(htmlUrl) }}
                className="ml-2 text-lg-accent hover:underline"
              >
                View PR #{prNumber}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* File list */}
      {lockedFiles.length > 0 && (
        <div className="px-3 pb-2.5">
          <div className="rounded-md border border-lg-border bg-lg-bg-primary overflow-hidden">
            <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-lg-border/60">
              <span className="text-[9px] font-mono text-lg-text-secondary uppercase tracking-wider">
                {allUnlocked ? 'All unlocked' : `${lockedFiles.length - unlocked.size} locked file${(lockedFiles.length - unlocked.size) !== 1 ? 's' : ''}`}
              </span>
              {!allUnlocked && (
                <button
                  onClick={e => { e.stopPropagation(); handleUnlockAll() }}
                  className="text-[9px] font-mono text-lg-accent hover:text-lg-accent/80 transition-colors"
                >
                  Unlock all
                </button>
              )}
            </div>
            {lockedFiles.map(filePath => {
              const isUnlocked  = unlocked.has(filePath)
              const isUnlocking = unlocking.has(filePath)
              const fileName    = filePath.split(/[/\\]/).pop() ?? filePath
              return (
                <div
                  key={filePath}
                  className="flex items-center gap-2 px-2.5 py-1.5 border-b border-lg-border/40 last:border-b-0"
                  title={filePath}
                >
                  <span className="text-[10px] shrink-0">
                    {isUnlocked ? '🔓' : '🔒'}
                  </span>
                  <span className={`flex-1 text-[10px] font-mono truncate ${isUnlocked ? 'text-lg-text-secondary line-through' : 'text-lg-text-primary'}`}>
                    {fileName}
                  </span>
                  {!isUnlocked && (
                    <button
                      onClick={e => { e.stopPropagation(); handleUnlock(filePath) }}
                      disabled={isUnlocking}
                      className="shrink-0 text-[9px] font-mono px-1.5 py-0.5 rounded border border-lg-accent/40 text-lg-accent hover:bg-lg-accent/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {isUnlocking ? '…' : 'Unlock'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* No locked files */}
      {lockedFiles.length === 0 && (
        <div className="px-3 pb-2.5">
          <span className="text-[10px] font-mono text-lg-text-secondary">{n.body}</span>
        </div>
      )}
    </div>
  )
}

// ── PR Closed (denied) item ───────────────────────────────────────────────────

function PRClosedItem({
  notification: n,
  onRead,
}: {
  notification: AppNotification
  onRead: () => void
}) {
  const meta     = n.meta ?? {}
  const prNumber = meta.prNumber as number | undefined
  const htmlUrl  = meta.htmlUrl  as string | undefined

  return (
    <div
      onClick={onRead}
      className={`flex items-start gap-2.5 px-3 py-2.5 border-b border-lg-border/50 cursor-pointer transition-colors hover:bg-lg-bg-secondary ${
        n.read ? 'opacity-60' : ''
      }`}
    >
      <span className="text-sm shrink-0 mt-0.5">🚫</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-mono text-lg-text-primary font-semibold truncate">{n.title}</span>
          {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-lg-accent shrink-0" />}
        </div>
        <div className="text-[10px] font-mono text-lg-text-secondary truncate mt-0.5">
          Continue working on your branch
        </div>
        <div className="text-[9px] font-mono text-lg-text-secondary/60 mt-0.5 flex items-center gap-2">
          {timeAgo(n.createdAt)}
          {htmlUrl && (
            <button
              onClick={e => { e.stopPropagation(); ipc.openExternal(htmlUrl) }}
              className="text-lg-accent hover:underline"
            >
              View PR #{prNumber}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
