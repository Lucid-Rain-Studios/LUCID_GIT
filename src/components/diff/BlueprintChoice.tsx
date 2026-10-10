import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'

export interface BlueprintChoiceItem { value: string; name: string; detail?: string; color?: string; title?: string; prefix?: string }

export function BlueprintChoice({ id, label, value, items, onChange }: { id: string; label: string; value: string; items: BlueprintChoiceItem[]; onChange(value: string): void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const selected = items.find(item => item.value === value) ?? items[0]
  useEffect(() => {
    if (!open) return
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>('[role=option]')
    buttons?.[Math.max(0, items.findIndex(item => item.value === value))]?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, items, value])
  const row = (item: BlueprintChoiceItem) => <>{item.prefix && <span className="bp-choice-prefix">{item.prefix}</span>}<span className="bp-choice-name">{item.name}</span>{item.detail && <span className="bp-choice-detail" style={{ color: item.color }}>{item.detail}</span>}</>
  const close = () => { setOpen(false); trigger.current?.focus() }
  return <div className="bp-choice" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false) }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === 'Tab') setOpen(false)
  }}>
    <button id={id} ref={trigger} type="button" role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-list`} aria-haspopup="listbox" disabled={!items.length} onClick={() => setOpen(!open)} onKeyDown={event => { if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setOpen(true) } }} title={selected?.title}>
      {selected ? row(selected) : <span>No graph available</span>}<ChevronDown size={14}/>
    </button>
    {open && <div id={`${id}-list`} role="listbox" aria-label={label} className="bp-choice-list" onKeyDown={event => {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=option]'))
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length : -1
      if (next >= 0) { event.preventDefault(); buttons[next]?.focus() }
    }}>
      {items.map(item => <button type="button" role="option" aria-selected={item.value === value} tabIndex={-1} key={item.value} title={item.title ?? item.name} onClick={() => { close(); onChange(item.value) }}>
        {row(item)}<Check size={13} className={item.value === value ? 'bp-choice-check' : 'bp-choice-check hidden'}/>
      </button>)}
    </div>}
  </div>
}
