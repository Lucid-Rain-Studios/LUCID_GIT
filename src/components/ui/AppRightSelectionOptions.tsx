import React from 'react'

export function AppRightSelectionOptions({
  x,
  y,
  minWidth = 220,
  children,
  menuRef,
}: {
  x: number
  y: number
  minWidth?: number
  children: React.ReactNode
  menuRef?: React.Ref<HTMLDivElement>
}) {
  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: y,
        left: x,
        zIndex: 100,
        background: '#1d2235',
        border: '1px solid #2f3a54',
        borderRadius: 6,
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
        padding: '4px 0',
        minWidth,
      }}
    >
      {children}
    </div>
  )
}

export function AppRightSelectionItem({ label, onClick, disabled, danger, title }: {
  label: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '5px 12px',
        fontFamily: "'IBM Plex Sans', system-ui",
        fontSize: 12,
        background: 'transparent',
        border: 'none',
        color: disabled ? '#4e5870' : danger ? '#e84545' : '#dde1f0',
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = '#242a3d' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{ flex: 1 }}>{label}</span>
    </button>
  )
}

export function AppRightSelectionSeparator() {
  return <div style={{ margin: '4px 0', borderTop: '1px solid #252d42' }} />
}
