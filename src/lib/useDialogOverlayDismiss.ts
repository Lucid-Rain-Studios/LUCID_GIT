import { useEffect, useRef } from 'react'
import type { MouseEvent } from 'react'

// Returns mouse handlers for a dialog overlay that close the dialog only when
// the user both presses and releases the mouse on the overlay itself. This
// prevents accidental closes when a drag (e.g. text selection inside an input)
// starts inside the dialog and ends outside, or vice versa.
const dialogs: HTMLElement[] = []
const inertOwners = new Map<HTMLElement, { count: number; previous: boolean }>()
export const isModalOpen = () => dialogs.length > 0

export function useDialogOverlayDismiss(onDismiss: () => void, enabled = true, label = 'Dialog') {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef({ onDismiss, enabled })
  latest.current = { onDismiss, enabled }
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const previous = document.activeElement as HTMLElement | null
    const isolated: HTMLElement[] = []
    for (let child: HTMLElement = root; child.parentElement; child = child.parentElement) {
      for (const sibling of Array.from(child.parentElement.children)) {
        if (sibling === child || !(sibling instanceof HTMLElement)) continue
        const owner = inertOwners.get(sibling) ?? { count: 0, previous: sibling.inert }
        owner.count++; inertOwners.set(sibling, owner); sibling.inert = true; isolated.push(sibling)
      }
    }
    dialogs.push(root)
    const controls = () => Array.from(root.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]'))
      .filter(el => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length > 0)
    const focusFirst = () => {
      const safe = root.querySelector<HTMLElement>('[data-dialog-cancel], input, textarea')
      ;(safe && controls().includes(safe) ? safe : controls()[0] ?? root).focus()
    }
    const timer = setTimeout(focusFirst, 0)
    const keydown = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== root) return
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation()
        if (latest.current.enabled) latest.current.onDismiss()
      } else if (event.key === 'Tab') {
        const items = controls(), index = items.indexOf(document.activeElement as HTMLElement)
        event.preventDefault(); event.stopImmediatePropagation()
        if (!items.length) root.focus()
        else items[index < 0 ? (event.shiftKey ? items.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus()
      }
    }
    const focusin = (event: FocusEvent) => {
      if (dialogs.at(-1) === root && !root.contains(event.target as Node)) focusFirst()
    }
    window.addEventListener('keydown', keydown, true); document.addEventListener('focusin', focusin)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', keydown, true); document.removeEventListener('focusin', focusin)
      dialogs.splice(dialogs.indexOf(root), 1)
      for (const element of isolated) {
        const owner = inertOwners.get(element)!
        if (--owner.count === 0) { element.inert = owner.previous; inertOwners.delete(element) }
      }
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus()
    }
  }, [])
  const downOnOverlay = useRef(false)
  return {
    ref, role: 'dialog' as const, 'aria-modal': true as const, 'aria-label': label, tabIndex: -1,
    onMouseDown: (e: MouseEvent<HTMLElement>) => {
      downOnOverlay.current = enabled && e.target === e.currentTarget
    },
    onMouseUp: (e: MouseEvent<HTMLElement>) => {
      const wasOnOverlay = downOnOverlay.current
      downOnOverlay.current = false
      if (enabled && wasOnOverlay && e.target === e.currentTarget) onDismiss()
    },
  }
}
