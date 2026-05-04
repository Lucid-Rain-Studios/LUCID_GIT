import React, { useEffect, useState, useCallback } from 'react'
import { Command } from 'cmdk'
import { ipc } from '@/ipc'
import { useRepoStore } from '@/stores/repoStore'
import { useAuthStore } from '@/stores/authStore'
import { cn } from '@/lib/utils'
import { markFetchPerformed } from '@/lib/fetchState'
import { getTopBarSyncHandlers, getTopBarSyncSnapshot } from '@/lib/topBarSyncBridge'

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onNavigateTab: (tab: string) => void
  onOpenRepo: () => void
  onClone: () => void
  onAddAccount: () => void
}

interface PaletteCommand {
  id: string
  label: string
  group: string
  keywords?: string
  action: () => void
  disabled?: boolean
}

export function CommandPalette({
  open,
  onClose,
  onNavigateTab,
  onOpenRepo,
  onClone,
  onAddAccount,
}: CommandPaletteProps) {
  const { repoPath, refreshStatus, bumpSyncTick } = useRepoStore()
  const { accounts, currentAccountId } = useAuthStore()
  const [syncing, setSyncing] = useState(false)

  const run = useCallback((fn: () => void | Promise<void>) => {
    onClose()
    void fn()
  }, [onClose])

  const doFetch = async () => {
    if (!repoPath) return
    const topBarHandlers = getTopBarSyncHandlers()
    if (getTopBarSyncSnapshot().repoPath === repoPath && topBarHandlers) return void topBarHandlers.fetch()
    setSyncing(true)
    try {
      await ipc.fetch(repoPath)
      markFetchPerformed(repoPath)
      await refreshStatus()
      bumpSyncTick()
    } finally { setSyncing(false) }
  }

  const doPull = async () => {
    if (!repoPath) return
    const topBarHandlers = getTopBarSyncHandlers()
    if (getTopBarSyncSnapshot().repoPath === repoPath && topBarHandlers) return void topBarHandlers.pull()
    try { await ipc.pull(repoPath); await refreshStatus(); bumpSyncTick() } catch {}
  }

  const doPush = async () => {
    if (!repoPath) return
    const topBarHandlers = getTopBarSyncHandlers()
    if (getTopBarSyncSnapshot().repoPath === repoPath && topBarHandlers) return void topBarHandlers.push()
    try { await ipc.push(repoPath); await refreshStatus(); bumpSyncTick() } catch {}
  }

  const commands: PaletteCommand[] = [
    // Navigation
    { id: 'nav-changes',  group: 'Navigate', label: 'Go to Changes',       action: () => run(() => onNavigateTab('changes'))  },
    { id: 'nav-branches', group: 'Navigate', label: 'Go to Branches',      action: () => run(() => onNavigateTab('branches')) },
    { id: 'nav-history',  group: 'Navigate', label: 'Go to History',       action: () => run(() => onNavigateTab('history'))  },
    { id: 'nav-lfs',      group: 'Navigate', label: 'Go to LFS',           action: () => run(() => onNavigateTab('lfs'))      },
    { id: 'nav-hooks',    group: 'Navigate', label: 'Go to Hooks',         action: () => run(() => onNavigateTab('hooks'))    },
    { id: 'nav-unreal',   group: 'Navigate', label: 'Go to Unreal Engine', action: () => run(() => onNavigateTab('unreal'))   },
    { id: 'nav-cleanup',  group: 'Navigate', label: 'Go to Cleanup',       action: () => run(() => onNavigateTab('cleanup'))  },
    { id: 'nav-settings', group: 'Navigate', label: 'Go to Settings',      action: () => run(() => onNavigateTab('settings')) },
    { id: 'nav-stash',    group: 'Navigate', label: 'Go to Stash',         action: () => run(() => onNavigateTab('stash'))    },

    // Repo actions
    {
      id: 'repo-fetch',
      group: 'Repository',
      label: 'Fetch',
      keywords: 'sync remote',
      disabled: !repoPath || syncing,
      action: () => run(doFetch),
    },
    {
      id: 'repo-pull',
      group: 'Repository',
      label: 'Pull',
      keywords: 'sync remote download',
      disabled: !repoPath,
      action: () => run(doPull),
    },
    {
      id: 'repo-push',
      group: 'Repository',
      label: 'Push',
      keywords: 'sync remote upload',
      disabled: !repoPath,
      action: () => run(doPush),
    },
    {
      id: 'repo-refresh',
      group: 'Repository',
      label: 'Refresh status',
      keywords: 'reload',
      disabled: !repoPath,
      action: () => run(() => refreshStatus()),
    },
    {
      id: 'repo-open',
      group: 'Repository',
      label: 'Open repository…',
      action: () => run(onOpenRepo),
    },
    {
      id: 'repo-clone',
      group: 'Repository',
      label: 'Clone repository…',
      action: () => run(onClone),
    },

    // Account
    {
      id: 'account-add',
      group: 'Account',
      label: 'Add GitHub account…',
      action: () => run(onAddAccount),
    },
    ...(accounts.find(a => a.userId === currentAccountId)
      ? [{
          id: 'account-switch',
          group: 'Account',
          label: `Switch account (current: @${accounts.find(a => a.userId === currentAccountId)?.login ?? ''})`,
          action: () => run(onAddAccount),
        }]
      : []),
  ]

  // Close on Escape is handled by cmdk; also close on backdrop click
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Panel */}
      <div className="relative w-full max-w-lg mx-4">
        <Command
          className={cn(
            'rounded-lg border border-lg-border bg-lg-bg-elevated shadow-2xl overflow-hidden',
            'font-mono text-lg-text-primary'
          )}
        >
          <div className="flex items-center border-b border-lg-border px-3">
            <span className="text-lg-text-secondary text-sm mr-2">⌘</span>
            <Command.Input
              autoFocus
              placeholder="Type a command or search…"
              className="flex-1 bg-transparent py-3 text-[13px] outline-none placeholder-lg-text-secondary/50"
            />
          </div>

          <Command.List className="max-h-80 overflow-y-auto py-1.5">
            <Command.Empty className="py-6 text-center text-[11px] text-lg-text-secondary">
              No commands found
            </Command.Empty>

            {(['Navigate', 'Repository', 'Account'] as const).map(group => {
              const items = commands.filter(c => c.group === group && !c.disabled)
              if (items.length === 0) return null
              return (
                <Command.Group
                  key={group}
                  heading={
                    <div className="px-3 py-1 text-[9px] font-mono uppercase tracking-widest text-lg-text-secondary/60">
                      {group}
                    </div>
                  }
                >
                  {items.map(cmd => (
                    <Command.Item
                      key={cmd.id}
                      value={`${cmd.label} ${cmd.keywords ?? ''}`}
                      onSelect={cmd.action}
                      className={cn(
                        'mx-1.5 px-2.5 py-1.5 rounded text-[12px] cursor-pointer',
                        'aria-selected:bg-lg-accent/15 aria-selected:text-lg-accent',
                        'transition-colors'
                      )}
                    >
                      {cmd.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              )
            })}
          </Command.List>

          <div className="border-t border-lg-border px-3 py-1.5 flex items-center gap-3">
            <span className="text-[9px] font-mono text-lg-text-secondary/50">↑↓ navigate</span>
            <span className="text-[9px] font-mono text-lg-text-secondary/50">↵ select</span>
            <span className="text-[9px] font-mono text-lg-text-secondary/50">esc close</span>
          </div>
        </Command>
      </div>
    </div>
  )
}
