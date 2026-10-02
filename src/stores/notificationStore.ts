import { create } from 'zustand'
import { ipc, AppNotification } from '@/ipc'

const MAX_NOTIFICATIONS = 100
let clearedBefore = 0

interface NotificationState {
  notifications: AppNotification[]
  unreadCount:   number

  push:        (n: AppNotification) => void
  markRead:    (id: number) => void
  markAllRead: () => void
  clearAll:    () => Promise<void>
  clearing: boolean
  clearError: string | null
  resolveRequest: { repoPath: string; containsLocalChanges: string[]; availableToUnlock: string[] } | null
  requestResolve: (payload: { repoPath: string; containsLocalChanges: string[]; availableToUnlock: string[] }) => void
  clearResolveRequest: () => void
}

// Persist read state to disk so it survives app restart. Fire-and-forget;
// any failure is logged via the wrapped IPC layer.
function persistRead(id: number): void {
  ipc.notificationMarkRead(id).catch(() => {})
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  unreadCount:   0,
  resolveRequest: null,
  clearing: false,
  clearError: null,

  push: (n) => set(state => {
    if (new Date(n.createdAt).getTime() <= clearedBefore) return state
    const notifications = [n, ...state.notifications.filter(item => item.id !== n.id)].slice(0, MAX_NOTIFICATIONS)
    return {
      notifications,
      unreadCount: notifications.filter(item => !item.read).length,
    }
  }),

  markRead: (id) => {
    const target = get().notifications.find(n => n.id === id)
    if (!target || target.read) return
    persistRead(id)
    set(state => {
      const notifications = state.notifications.map(n =>
        n.id === id ? { ...n, read: true } : n
      )
      const unreadCount = notifications.filter(n => !n.read).length
      return { notifications, unreadCount }
    })
  },

  markAllRead: () => {
    const unreadIds = get().notifications.filter(n => !n.read).map(n => n.id)
    unreadIds.forEach(persistRead)
    set(state => ({
      notifications: state.notifications.map(n => ({ ...n, read: true })),
      unreadCount:   0,
    }))
  },

  clearAll: async () => {
    if (get().clearing) return
    const ids = new Set(get().notifications.map(n => n.id))
    const cutoff = Date.now()
    set({ clearing: true, clearError: null })
    try {
      await ipc.notificationClearAll()
      clearedBefore = cutoff
      set(state => {
        const notifications = state.notifications.filter(n => !ids.has(n.id))
        return { notifications, unreadCount: notifications.filter(n => !n.read).length }
      })
    } catch (e) {
      set({ clearError: `Could not clear notifications: ${String(e)}. Try again.` })
    } finally { set({ clearing: false }) }
  },

  requestResolve: (payload) => set({ resolveRequest: payload }),
  clearResolveRequest: () => set({ resolveRequest: null }),
}))
