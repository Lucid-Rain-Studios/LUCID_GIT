import { useMemo, useState } from 'react'
import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import { mapInventory } from '../../lib/mapInventory'

export function MapContents({ objects, selected, filter, visible, onSelect }: { objects: UnrealAssetObject[]; selected: string; filter: string; visible: number; onSelect(object: UnrealAssetObject): void }) {
  const inventory = useMemo(() => mapInventory(objects), [objects])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const matches = (object: UnrealAssetObject) => (object.name + ' ' + object.path + ' ' + object.classPath).toLowerCase().includes(filter.toLowerCase())
  const actors = inventory.actors.filter(actor => actor.name.toLowerCase().includes(filter.toLowerCase()) || matches(actor.object) || actor.owned.some(matches))
  let remaining = 1000
  return <section aria-label="Saved map actor inventory">
    <p className="uar-caption">{inventory.actors.length} saved actors · {inventory.unassigned.length} other package objects · {inventory.unresolvedActorReferences} unresolved actor references. Membership comes from saved level references and verified changed external packages; inherited/generated objects are not reconstructed.</p>
    {actors.slice(0, visible).map(actor => {
      const owned = filter && !matches(actor.object) && !actor.name.toLowerCase().includes(filter.toLowerCase()) ? actor.owned.filter(matches) : actor.owned
      const open = expanded.has(actor.object.path) || !!filter
      const shown = open ? owned.slice(0, Math.min(100, remaining)) : []
      remaining -= shown.length
      return <div className="uar-map-actor" key={actor.object.path}>
        <div className="uar-tree-heading"><button className="lg-toolbar-control" disabled={!!filter} title={filter ? 'Clear the filter to collapse groups' : undefined} aria-label={`${open ? 'Collapse' : 'Expand'} ${actor.name}`} aria-expanded={open} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(actor.object.path)) next.delete(actor.object.path); else next.add(actor.object.path); return next })}>{open ? '−' : '+'}</button><button className="uar-row" aria-pressed={selected === actor.object.path} onClick={() => onSelect(actor.object)}><span>{actor.name}<small>{actor.object.classPath.split('.').pop()} · {actor.owned.length} owned exports{actor.object.sourcePackage ? ' · ' + actor.object.sourcePackage : ''}</small></span></button></div>
        {open && <div className="uar-map-owned">{actor.root && <button className="lg-toolbar-control" onClick={() => onSelect(actor.root!)}>Inspect saved root component</button>}{shown.map(object => <button className="uar-row" key={object.path} aria-pressed={selected === object.path} onClick={() => onSelect(object)}><span>{object.name}<small>{object.classPath.split('.').pop()}{object.properties.AttachParent ? ' · saved attachment' : ''}</small></span></button>)}{shown.length < owned.length && <small>{owned.length - shown.length} owned exports omitted from this tree. Use All objects to inspect them.</small>}</div>}
      </div>
    })}
    {!actors.length && <p className="uar-caption">No saved actor membership matches this filter. Use All objects for unresolved or other package exports.</p>}
    {actors.length > visible && <p className="uar-caption">{actors.length - visible} more actors. Increase the object limit below.</p>}
  </section>
}
