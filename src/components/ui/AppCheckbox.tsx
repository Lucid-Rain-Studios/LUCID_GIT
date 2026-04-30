import React, { useState } from 'react'

interface AppCheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  color?: string
  disabled?: boolean
  size?: number
  showHoverDash?: boolean
  className?: string
  indeterminate?: boolean
}

export function AppCheckbox({
  checked,
  onChange,
  color = '#e8622f',
  disabled = false,
  size = 16,
  showHoverDash = false,
  className,
  indeterminate = false,
}: AppCheckboxProps) {
  const [hover, setHover] = useState(false)

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      disabled={disabled}
      onClick={e => {
        e.stopPropagation()
        if (!disabled) onChange(!checked)
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: 3,
        flexShrink: 0,
        border: `1.5px solid ${checked ? color : hover ? '#2f3a54' : '#252d42'}`,
        background: checked ? `${color}22` : hover ? '#242a3d' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.12s',
        padding: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {checked && !indeterminate && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <polyline points="1.5,5 4,7.5 8.5,2.5" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {indeterminate && (
        <svg width="8" height="2" viewBox="0 0 8 2" fill="none">
          <line x1="0" y1="1" x2="8" y2="1" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
      {!checked && !indeterminate && hover && showHoverDash && (
        <svg width="8" height="2" viewBox="0 0 8 2" fill="none">
          <line x1="0" y1="1" x2="8" y2="1" stroke="#4e5870" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </button>
  )
}
