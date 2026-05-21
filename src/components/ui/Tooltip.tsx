import React, { useState, useRef, useCallback, useEffect } from 'react'
import ReactDOM from 'react-dom'

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  delay?: number
  asSvgGroup?: boolean
}

export function Tooltip({ content, children, side = 'top', delay = 500, asSvgGroup = false }: TooltipProps) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const wrapRef = useRef<SVGGElement | HTMLSpanElement>(null)

  const show = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!wrapRef.current) return
      const wrapper = wrapRef.current as Element
      const wrapperRect = wrapper.getBoundingClientRect()
      const childRect = wrapper.firstElementChild?.getBoundingClientRect()
      setRect(
        wrapperRect.width > 0 || wrapperRect.height > 0
          ? wrapperRect
          : childRect ?? wrapperRect
      )
    }, delay)
  }, [delay])

  const hide = useCallback(() => {
    clearTimeout(timer.current)
    setRect(null)
  }, [])

  useEffect(() => {
    return () => { clearTimeout(timer.current) }
  }, [])

  // Safety net against a stranded tooltip. `onMouseLeave` can be missed when
  // the hovered node is swapped out by a re-render, the panel scrolls, or the
  // window loses focus — leaving the tooltip stuck on screen. While it is
  // visible, dismiss it as soon as the pointer moves off the wrapper, the
  // page scrolls, or the window blurs.
  useEffect(() => {
    if (!rect) return
    const onMove = (e: MouseEvent) => {
      const el = wrapRef.current as Element | null
      const target = e.target as Node | null
      if (el && target && el.contains(target)) return
      hide()
    }
    document.addEventListener('mousemove', onMove, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [rect, hide])

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
    fontFamily: 'var(--lg-font-ui)',
    whiteSpace: typeof content === 'string' ? 'nowrap' : 'normal',
    pointerEvents: 'none',
    boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
    ...(side === 'top'    ? { left: rect.left + rect.width / 2, bottom: window.innerHeight - rect.top + 6, transform: 'translateX(-50%)' } :
        side === 'bottom' ? { left: rect.left + rect.width / 2, top: rect.bottom + 6,                      transform: 'translateX(-50%)' } :
        side === 'right'  ? { left: rect.right + 8,             top: rect.top + rect.height / 2,           transform: 'translateY(-50%)' } :
                            { right: window.innerWidth - rect.left + 8, top: rect.top + rect.height / 2,   transform: 'translateY(-50%)' }),
  } : {}

  const portal = rect ? ReactDOM.createPortal(
    <div style={tipStyle}>{content}</div>,
    document.body,
  ) : null

  if (asSvgGroup) {
    return (
      <g ref={wrapRef as React.Ref<SVGGElement>} onMouseEnter={show} onMouseLeave={hide}>
        {children}
        {portal}
      </g>
    )
  }

  return (
    <span ref={wrapRef as React.Ref<HTMLSpanElement>} onMouseEnter={show} onMouseLeave={hide} style={{ display: 'contents' }}>
      {children}
      {portal}
    </span>
  )
}
