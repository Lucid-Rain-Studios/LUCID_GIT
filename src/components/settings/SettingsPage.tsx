import React, { useState } from 'react'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { WebhookPanel } from './WebhookPanel'
import { TeamConfigPanel } from './TeamConfigPanel'
import { useAuthStore } from '@/stores/authStore'

interface SettingsPageProps {
  repoPath: string | null
}

type SettingsTab = 'appearance' | 'general' | 'discord' | 'team'

const ALL_TABS: { id: SettingsTab; label: string; requiresRepo?: boolean; adminOnly?: boolean }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'general',    label: 'General' },
  { id: 'discord',    label: 'Discord',     requiresRepo: true, adminOnly: true },
  { id: 'team',       label: 'Team config', requiresRepo: true, adminOnly: true },
]

export function SettingsPage({ repoPath }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>('appearance')
  const isAdmin = useAuthStore(s => s.isAdmin(repoPath ?? ''))

  const tabs = ALL_TABS.filter(t => !t.requiresRepo || !!repoPath)
  const activeTab = tabs.find(t => t.id === tab) ? tab : 'appearance'
  const activeTabDef = tabs.find(t => t.id === activeTab)
  const showAdminBanner = activeTabDef?.adminOnly && !isAdmin && !!repoPath

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', height: 38,
        paddingLeft: 16, paddingRight: 16, gap: 2,
        borderBottom: '1px solid #252d42', background: '#161a27', flexShrink: 0,
      }}>
        {tabs.map(t => (
          <TabBtn key={t.id} label={t.label} active={activeTab === t.id} onClick={() => setTab(t.id)}
            adminOnly={!!t.adminOnly} isAdmin={isAdmin} />
        ))}
      </div>

      {/* Admin-only read-only banner */}
      {showAdminBanner && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 16px', height: 32, flexShrink: 0,
          background: 'rgba(139,148,176,0.08)', borderBottom: '1px solid #252d42',
          fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, color: '#8b94b0',
        }}>
          <LockIconSm />
          <span>You are viewing as a Collaborator. Repository admin access is required to modify these settings.</span>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', pointerEvents: showAdminBanner ? 'none' : undefined, opacity: showAdminBanner ? 0.5 : 1 }}>
        {activeTab === 'appearance' && <AppearanceSettings />}
        {activeTab === 'general'    && <GeneralSettings />}
        {activeTab === 'discord'    && repoPath && <WebhookPanel repoPath={repoPath} />}
        {activeTab === 'team'       && repoPath && <TeamConfigPanel repoPath={repoPath} />}
      </div>
    </div>
  )
}

function LockIconSm() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
      <rect x="1" y="5.5" width="10" height="6" rx="1.5" stroke="#8b94b0" strokeWidth="1.2" />
      <path d="M3.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5" stroke="#8b94b0" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function TabBtn({ label, active, onClick, adminOnly, isAdmin }: {
  label: string; active: boolean; onClick: () => void; adminOnly?: boolean; isAdmin?: boolean
}) {
  const [hover, setHover] = useState(false)
  const restricted = adminOnly && !isAdmin
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={restricted ? 'Admin access required to modify' : undefined}
      style={{
        height: 26, paddingLeft: 12, paddingRight: 12, borderRadius: 5,
        display: 'flex', alignItems: 'center', gap: 4,
        background: active ? 'rgba(232,98,47,0.18)' : hover ? '#1e2436' : 'transparent',
        border: active ? '1px solid rgba(232,98,47,0.4)' : '1px solid transparent',
        color: active ? '#e8622f' : restricted ? '#4e5870' : hover ? '#dde1f0' : '#8b94b0',
        fontFamily: "'IBM Plex Sans', system-ui", fontSize: 12, fontWeight: active ? 600 : 400,
        cursor: 'pointer', transition: 'all 0.12s',
      }}
    >
      {label}
      {restricted && (
        <svg width="9" height="10" viewBox="0 0 9 10" fill="none">
          <rect x="0.5" y="4" width="8" height="5.5" rx="1" stroke="currentColor" strokeWidth="1" />
          <path d="M2 4V3a2.5 2.5 0 0 1 5 0v1" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
      )}
    </button>
  )
}
