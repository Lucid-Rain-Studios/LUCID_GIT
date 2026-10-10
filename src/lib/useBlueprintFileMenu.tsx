import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BlueprintFileAction } from '@/components/shared/BlueprintFileAction'
import { AppRightSelectionOptions } from '@/components/ui/AppRightSelectionOptions'

// Lightweight file-row menu for surfaces without an existing file menu.
// No asset reads occur until the user chooses the action.
export function useBlueprintFileMenu(repoPath: string, extra?: (close: () => void) => React.ReactNode) {
  const [target, setTarget] = useState<{ x: number; y: number; path: string } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const origin = useRef<HTMLElement | null>(null)
  const close = useCallback(() => { setTarget(null); origin.current?.focus() }, [])
  useEffect(() => {
    if (!target) return
    const outside = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setTarget(null) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', key)
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key) }
  }, [target, close])
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !target) return
    element.style.left = `${Math.max(0, Math.min(target.x, window.innerWidth - element.offsetWidth))}px`
    element.style.top = `${Math.max(0, Math.min(target.y, window.innerHeight - element.offsetHeight))}px`
  }, [target])
  return {
    onContextMenu: (event: React.MouseEvent, filePath: string) => {
      if (!/\.uasset$/i.test(filePath)) return
      origin.current = event.currentTarget as HTMLElement
      event.preventDefault(); event.stopPropagation(); setTarget({ x: event.clientX, y: event.clientY, path: filePath })
    },
    menu: target ? createPortal(<AppRightSelectionOptions x={target.x} y={target.y} menuRef={ref}><BlueprintFileAction repoPath={repoPath} filePath={target.path} onClose={close} />{extra?.(close)}</AppRightSelectionOptions>, document.body) : null,
  }
}
