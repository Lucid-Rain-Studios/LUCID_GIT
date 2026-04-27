import { create } from 'zustand'
import { ipc, Account, DeviceFlowStart, RepoPermission } from '@/ipc'

interface DeviceFlowState {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number       // epoch ms
  interval: number        // seconds to wait between polls
}

interface AuthState {
  accounts: Account[]
  currentAccountId: string | null
  isLoading: boolean
  error: string | null
  deviceFlow: DeviceFlowState | null
  isPolling: boolean

  // Permission tier per repoPath — Phase 20
  repoPermissions: Record<string, RepoPermission>
  permissionFetching: Record<string, boolean>
  permissionErrors: Record<string, boolean>   // true = last fetch failed (fail-open)

  // Admin role preview — lets admins temporarily view the app as another role
  viewAsRole: RepoPermission | null            // null = use real permission

  loadAccounts:    () => Promise<void>
  startDeviceFlow: () => Promise<void>
  pollOnce:        () => Promise<boolean>
  logout:          (userId: string) => Promise<void>
  setCurrentAccount: (userId: string) => void
  clearDeviceFlow: () => void
  clearError:      () => void
  fetchRepoPermission: (repoPath: string) => Promise<void>
  isAdmin: (repoPath: string) => boolean
  setViewAsRole: (role: RepoPermission | null) => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  accounts:           [],
  currentAccountId:   null,
  isLoading:          false,
  error:              null,
  deviceFlow:         null,
  isPolling:          false,
  repoPermissions:    {},
  permissionFetching: {},
  permissionErrors:   {},
  viewAsRole:         null,

  loadAccounts: async () => {
    set({ isLoading: true, error: null })
    try {
      const { accounts, currentAccountId } = await ipc.listAccounts()
      set({ accounts, currentAccountId, isLoading: false })
    } catch (e) {
      set({ error: String(e), isLoading: false })
    }
  },

  startDeviceFlow: async () => {
    set({ isLoading: true, error: null, deviceFlow: null })
    try {
      const flow: DeviceFlowStart = await ipc.startDeviceFlow()
      set({
        isLoading: false,
        deviceFlow: {
          deviceCode:      flow.deviceCode,
          userCode:        flow.userCode,
          verificationUri: flow.verificationUri,
          expiresAt:       Date.now() + flow.expiresIn * 1000,
          interval:        flow.interval,
        },
      })
    } catch (e) {
      set({ error: String(e), isLoading: false })
    }
  },

  // Call once per poll tick. Returns true when auth is complete.
  pollOnce: async () => {
    const { deviceFlow } = get()
    if (!deviceFlow) return false
    set({ isPolling: true })
    try {
      const result = await ipc.pollDeviceFlow(deviceFlow.deviceCode)
      if (result) {
        const { accounts } = await ipc.listAccounts()
        set({
          accounts,
          currentAccountId: result.userId,
          deviceFlow:       null,
          isPolling:        false,
        })
        return true
      }
      set({ isPolling: false })
      return false
    } catch (e) {
      set({ error: String(e), deviceFlow: null, isPolling: false })
      return false
    }
  },

  logout: async (userId) => {
    set({ isLoading: true })
    try {
      await ipc.logout(userId)
      const accounts = get().accounts.filter(a => a.userId !== userId)
      const currentAccountId =
        get().currentAccountId === userId
          ? (accounts[0]?.userId ?? null)
          : get().currentAccountId
      set({ accounts, currentAccountId, isLoading: false })
    } catch (e) {
      set({ error: String(e), isLoading: false })
    }
  },

  setCurrentAccount: (userId) => set({ currentAccountId: userId }),
  clearDeviceFlow:   ()       => set({ deviceFlow: null, error: null }),
  clearError:        ()       => set({ error: null }),
  setViewAsRole:     (role)   => set({ viewAsRole: role }),

  fetchRepoPermission: async (repoPath: string) => {
    if (get().permissionFetching[repoPath]) return
    set(s => ({ permissionFetching: { ...s.permissionFetching, [repoPath]: true } }))
    try {
      const permission = await ipc.fetchRepoPermission(repoPath)
      set(s => ({
        repoPermissions:    { ...s.repoPermissions,    [repoPath]: permission },
        permissionErrors:   { ...s.permissionErrors,   [repoPath]: false },
        permissionFetching: { ...s.permissionFetching, [repoPath]: false },
      }))
    } catch {
      // Fail-open: treat as 'write' and flag as error for UI warning
      set(s => ({
        repoPermissions:    { ...s.repoPermissions,    [repoPath]: 'write' },
        permissionErrors:   { ...s.permissionErrors,   [repoPath]: true },
        permissionFetching: { ...s.permissionFetching, [repoPath]: false },
      }))
    }
  },

  isAdmin: (repoPath: string) => {
    if (get().repoPermissions[repoPath] !== 'admin') return false
    const override = get().viewAsRole
    return override === null || override === 'admin'
  },
}))
