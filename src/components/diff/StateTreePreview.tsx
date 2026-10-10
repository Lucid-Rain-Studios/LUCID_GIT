import { useMemo, useState } from 'react'
import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import type { AssetObjectChange } from '../../lib/unrealAssetReview'
import { entryClass, stateClass, stateName, stateTreeEntries } from '../../lib/stateTreeReview'

export function StateTreePreview({ objects, changes, side, onSelect }: { objects: UnrealAssetObject[]; changes: AssetObjectChange[]; side: 'left' | 'right'; onSelect(object: UnrealAssetObject): void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [showEntries, setShowEntries] = useState(true)
  const states = objects.filter(stateClass), entries = objects.filter(entryClass)
  const byOuter = new Map<string, UnrealAssetObject[]>()
  for (const entry of entries) byOuter.set(entry.outer, [...(byOuter.get(entry.outer) ?? []), entry])
  const parents = new Set([...states, ...entries].map(object => object.path))
  const changed = new Map(changes.filter(change => change[side]).map(change => [change[side]!.path, change.kind]))
  const { rows, unresolved } = useMemo(() => {
    const byPath = new Map(states.map(state => [state.path, state]))
    const children = new Map(states.map(state => [state.path, Object.values(state.properties.Children && typeof state.properties.Children === 'object' ? state.properties.Children : {}).filter((child): child is string => typeof child === 'string')]))
    const nested = new Set([...children.values()].flat()), visited = new Set<string>()
    const rows: Array<{ state: UnrealAssetObject; depth: number; children: boolean }> = []
    let unresolved = 0
    const walk = (state: UnrealAssetObject, depth: number) => {
      if (visited.has(state.path) || depth > 32) { unresolved++; return }
      visited.add(state.path)
      const next = children.get(state.path) ?? []
      rows.push({ state, depth, children: next.length > 0 })
      if (collapsed.has(state.path)) return
      for (const path of next) { const child = byPath.get(path); if (child) walk(child, depth + 1); else unresolved++ }
    }
    states.filter(state => !nested.has(state.path)).forEach(state => walk(state, 0))
    // Cycles/disconnected editor states remain inspectable. Collapsed descendants
    // are deliberately hidden rather than appended as disconnected roots.
    const reachable = new Set<string>()
    const pending = states.filter(state => !nested.has(state.path)).map(state => state.path)
    while (pending.length) { const path = pending.pop()!; if (reachable.has(path)) continue; reachable.add(path); pending.push(...(children.get(path) ?? [])) }
    states.filter(state => !reachable.has(state.path) && !visited.has(state.path)).forEach(state => walk(state, 0))
    return { rows, unresolved }
  }, [states, collapsed])
  const toggle = (path: string) => setCollapsed(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })
  const renderEntry = (entry: UnrealAssetObject, depth: number) => <button className={'uar-tree-state uar-' + (changed.get(entry.path) ?? 'unchanged')} key={entry.path} style={{ marginLeft: Math.min(depth, 6) * 16 }} onClick={() => onSelect(entry)}><span>{entry.name}</span><small>{!entry.decoded ? 'incomplete' : changed.get(entry.path) ?? 'saved entry'}</small></button>
  if (!states.length) return <div className="uar-empty">No decoded editor states in this package. Inspect the serialized objects in Contents.</div>
  const original = objects.filter(object => !entryClass(object))
  const omitted = stateTreeEntries(original).omitted
  return <div className="uar-tree" aria-label="Decoded StateTree children">
    <p className="uar-caption">Saved editor hierarchy · {states.length} states · {entries.length} authored entries. Runtime indexes are not state identities.</p>
    <div className="uar-tree-controls"><button className="lg-toolbar-control" onClick={() => setCollapsed(new Set())}>Expand all states</button><button className="lg-toolbar-control" onClick={() => setCollapsed(new Set(states.map(state => state.path)))}>Collapse all states</button><button className="lg-toolbar-control" aria-pressed={showEntries} onClick={() => setShowEntries(value => !value)}>Tasks, transitions and bindings</button></div>
    {(unresolved > 0 || omitted > 0) && <p className="uar-caption">{unresolved} unresolved/cyclic child references · {omitted} entries omitted by the 5,000 entry limit. Original saved arrays remain in Contents.</p>}
    {showEntries && entries.filter(entry => !parents.has(entry.outer)).map(entry => renderEntry(entry, 0))}
    {rows.map(({ state, depth, children }) => <div key={state.path}>
      <div className="uar-tree-heading" style={{ marginLeft: Math.min(depth, 6) * 16 }}>{children && <button className="lg-toolbar-control" aria-label={(collapsed.has(state.path) ? 'Expand ' : 'Collapse ') + stateName(state)} aria-expanded={!collapsed.has(state.path)} onClick={() => toggle(state.path)}>{collapsed.has(state.path) ? '▸' : '▾'}</button>}<button className={'uar-tree-state uar-' + (changed.get(state.path) ?? 'unchanged')} onClick={() => onSelect(state)}><span>{stateName(state)}</span><small>{changed.get(state.path) ?? 'state'}</small></button></div>
      {showEntries && !collapsed.has(state.path) && (byOuter.get(state.path) ?? []).map(entry => <div key={entry.path}>{renderEntry(entry, depth + 1)}{(byOuter.get(entry.path) ?? []).map(condition => renderEntry(condition, depth + 2))}</div>)}
    </div>)}
    <p className="uar-caption">Select an entry for saved type, instance data, target, order or binding paths. Opaque parameter bags/custom payloads and inherited defaults remain unresolved. Compiled/runtime package fields remain available in Contents.</p>
  </div>
}
