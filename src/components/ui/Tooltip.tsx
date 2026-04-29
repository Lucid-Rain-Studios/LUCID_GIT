import React, { useState, useRef, useCallback } from 'react'
import ReactDOM from 'react-dom'

interface TooltipProps {
  content: string
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  delay?: number
}

export function Tooltip({ content, children, side = 'top', delay = 500 }: TooltipProps) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const wrapRef = useRef<HTMLSpanElement>(null)

  const show = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect())
    }, delay)
  }, [delay])

  const hide = useCallback(() => {
    clearTimeout(timer.current)
    setRect(null)
  }, [])

  const tipStyle: React.CSSProperties = rect ? {
    position: 'fixed',
    zIndex: 9999,
    background: '#1a2030',
    border: '1px solid #2f3a54',
    borderRadius: 5,
    padding: '4px 9px',
    fontSize: 11,
    lineHeight: 1.4,
    color: '#c4cad8',
    fontFamily: "'IBM Plex Sans', system-ui",
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
    ...(side === 'top'    ? { left: rect.left + rect.width / 2, bottom: window.innerHeight - rect.top + 6, transform: 'translateX(-50%)' } :
        side === 'bottom' ? { left: rect.left + rect.width / 2, top: rect.bottom + 6,                      transform: 'translateX(-50%)' } :
        side === 'right'  ? { left: rect.right + 8,            top: rect.top + rect.height / 2,            transform: 'translateY(-50%)' } :
                            { right: window.innerWidth - rect.left + 8, top: rect.top + rect.height / 2,   transform: 'translateY(-50%)' }),
  } : {}

  return (
    <span ref={wrapRef} onMouseEnter={show} onMouseLeave={hide} style={{ display: 'contents' }}>
      {children}
      {rect && ReactDOM.createPortal(
        <div style={tipStyle}>{content}</div>,
        document.body,
      )}
    </span>
  )
}
