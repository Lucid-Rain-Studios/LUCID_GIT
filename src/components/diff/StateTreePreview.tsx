import { useMemo, useState } from 'react'
import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import type { AssetObjectChange } from '../../lib/unrealAssetReview'
import { entryClass, stateClass, stateName, stateTreeEntries, stateTreeHierarchy, stateTreeLinks, stateTreeStateIndex } from '../../lib/stateTreeReview'

export function StateTreePreview({ objects, changes, side, onSelect }: { objects: UnrealAssetObject[]; changes: AssetObjectChange[]; side: 'left' | 'right'; onSelect(object: UnrealAssetObject): void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [showEntries, setShowEntries] = useState(true)
  const [focusedRoot, setFocusedRoot] = useState<string | undefined>()
  const states = useMemo(() => objects.filter(stateClass), [objects]), entries = useMemo(() => objects.filter(entryClass), [objects])
  const byOuter = useMemo(() => { const index = new Map<string, UnrealAssetObject[]>(); for (const entry of entries) index.set(entry.outer, [...(index.get(entry.outer) ?? []), entry]); return index }, [entries])
  const parents = useMemo(() => new Set([...states, ...entries].map(object => object.path)), [states, entries])
  const changed = useMemo(() => new Map(changes.filter(change => change[side]).map(change => [change[side]!.path, change.kind])), [changes, side])
  const stateIndex = useMemo(() => stateTreeStateIndex(objects), [objects])
  const omitted = useMemo(() => stateTreeEntries(objects.filter(object => !entryClass(object))).omitted, [objects])
  const { rows, unresolved, omitted: omittedStates } = useMemo(() => stateTreeHierarchy(states, collapsed, focusedRoot), [states, collapsed, focusedRoot])
  const subtreeLinks = useMemo(() => new Map(states.map(state => [state.path, stateTreeLinks(state, objects, stateIndex).find(link => link.label === 'Linked subtree')])), [states, objects, stateIndex])
  const toggle = (path: string) => setCollapsed(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })
  const renderEntry = (entry: UnrealAssetObject, depth: number) => <button className={'uar-tree-state uar-' + (changed.get(entry.path) ?? 'unchanged')} key={entry.path} style={{ marginLeft: Math.min(depth, 6) * 16 }} onClick={() => onSelect(entry)}><span>{entry.name}</span><small>{!entry.decoded ? 'incomplete' : changed.get(entry.path) ?? 'saved entry'}</small></button>
  if (!states.length) return <div className="uar-empty">No decoded editor states in this package. Inspect the serialized objects in Contents.</div>
  return <div className="uar-tree" aria-label="Decoded StateTree children">
    <p className="uar-caption">Saved editor hierarchy · {states.length} states · {entries.length} authored entries. Runtime indexes are not state identities.</p>
    <div className="uar-tree-controls">{focusedRoot && <button className="lg-toolbar-control" onClick={() => setFocusedRoot(undefined)}>Show whole tree</button>}<button className="lg-toolbar-control" onClick={() => setCollapsed(new Set())}>Expand all states</button><button className="lg-toolbar-control" onClick={() => setCollapsed(new Set(states.map(state => state.path)))}>Collapse all states</button><button className="lg-toolbar-control" aria-pressed={showEntries} onClick={() => setShowEntries(value => !value)}>Tasks, transitions and bindings</button></div>
    {focusedRoot && <p className="uar-caption">Focused saved subtree: {states.find(state => state.path === focusedRoot) ? stateName(states.find(state => state.path === focusedRoot)!) : focusedRoot}. Parameter overrides and runtime execution are not expanded.</p>}
    {(unresolved > 0 || omitted > 0 || omittedStates > 0) && <p className="uar-caption">{unresolved} unresolved/cyclic or ambiguous child references · {omittedStates} branches omitted by the 1,000-state preview limit · {omitted} entries omitted by the 5,000 entry limit. Original saved arrays remain in Contents.</p>}
    {!focusedRoot && showEntries && entries.filter(entry => !parents.has(entry.outer)).map(entry => renderEntry(entry, 0))}
    {rows.map(({ state, depth, children }) => <div key={state.path}>
      <div className="uar-tree-heading" style={{ marginLeft: Math.min(depth, 6) * 16 }}>{children && <button className="lg-toolbar-control" aria-label={(collapsed.has(state.path) ? 'Expand ' : 'Collapse ') + stateName(state)} aria-expanded={!collapsed.has(state.path)} onClick={() => toggle(state.path)}>{collapsed.has(state.path) ? '▸' : '▾'}</button>}<button className={'uar-tree-state uar-' + (changed.get(state.path) ?? 'unchanged')} onClick={() => onSelect(state)}><span>{stateName(state)}</span><small>{changed.get(state.path) ?? 'state'}</small></button></div>
      {subtreeLinks.get(state.path) && <div className="uar-object-link" style={{ marginLeft: Math.min(depth + 1, 6) * 16 }}><small>Linked subtree: {subtreeLinks.get(state.path)!.description}</small>{subtreeLinks.get(state.path)!.object && <button className="lg-toolbar-control" onClick={() => { const target = subtreeLinks.get(state.path)!.object!; setFocusedRoot(target.path); setCollapsed(new Set()); onSelect(target) }}>View linked subtree: {stateName(subtreeLinks.get(state.path)!.object!)}</button>}</div>}
      {showEntries && !collapsed.has(state.path) && (byOuter.get(state.path) ?? []).map(entry => <div key={entry.path}>{renderEntry(entry, depth + 1)}{(byOuter.get(entry.path) ?? []).map(condition => renderEntry(condition, depth + 2))}</div>)}
    </div>)}
    <p className="uar-caption">Select an entry for saved type, instance data, target, order or binding paths. Opaque parameter bags/custom payloads and inherited defaults remain unresolved. Compiled/runtime package fields remain available in Contents.</p>
  </div>
}
