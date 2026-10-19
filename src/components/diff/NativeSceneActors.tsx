import { useMemo, useState } from 'react'
import type { NativeSceneReview } from '../../../electron/blueprintTypes'
import { nativeActorChanges, type NativeActor } from '../../lib/nativeSceneReview'

const names = { unchanged: 'Unchanged', moved: 'Moved', rotated: 'Rotated', scaled: 'Scaled', renamed: 'Label changed', repathed: 'Object path changed', modified: 'Modified', replaced: 'Actor recreated', added: 'Added', removed: 'Removed', unknown: 'Unconfirmed' }
const coordinates = (values: readonly number[]) => values.map(value => Number(value.toFixed(4))).join(', ')

export function NativeSceneActors({ scenes, side, paths, labels, onSelect, selectedPath }: { scenes: Array<NativeSceneReview | undefined>; side: 'left' | 'right'; paths?: readonly string[]; selectedPath?: string; labels: {left:string;right:string}; onSelect(actor: NativeActor): void }) {
  const [query, setQuery] = useState(''), [changedOnly, setChangedOnly] = useState(false), [generated, setGenerated] = useState(false), [selected, setSelected] = useState('')
  const actors = scenes[side === 'left' ? 0 : 1]?.actors
  const active = scenes[side === 'left' ? 0 : 1]
  const comparison = useMemo(() => nativeActorChanges(scenes,paths), [scenes, paths?.[0], paths?.[1]]) // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => { const text = query.trim().toLowerCase(); return (actors ?? []).filter(actor => {
    if (!generated && actor.saved !== true) return false
    if (!(actor.name + ' ' + actor.path + ' ' + (actor.sourcePath ?? '') + ' ' + (actor.instancePath ?? '') + ' ' + (actor.instanceLabel ?? '')).toLowerCase().includes(text)) return false
    const kind = comparison.changes.get(actor.path)?.kind
    return !changedOnly || !comparison.comparable || actor.saved === true && kind !== 'unchanged'
  }) }, [actors, generated, query, changedOnly, comparison])
  const saved = useMemo(() => actors?.filter(actor => actor.saved === true).length ?? 0, [actors])
  if (!actors?.length) return null
  return <details className="uar-native-actors"><summary>Reconstructed actors ({saved} saved · {actors.length - saved} engine-generated)</summary>
    <p className="uar-caption">Engine-evaluated world locations in centimeters, Z up. Comparisons match unique saved actor GUIDs, with exact-path fallback when GUIDs are unavailable.</p>
    {active?.actorInventory && <details><summary className={active.actorInventoryComplete ? 'uar-added' : 'uar-warning'}>Actor inventory {active.actorInventoryComplete ? 'verified' : 'unverified'}: {active.actorInventory.matched} / {active.actorInventory.expected} captured actor exports loaded</summary>{active.actorInventory.diagnostics.map((message,index) => <p className="uar-warning" key={index}>{message}</p>)}{active.actorInventory.missing.map(path => <p className="uar-warning" key={path}>Missing: {path}</p>)}{active.actorInventory.expected - active.actorInventory.matched > active.actorInventory.missing.length && <p className="uar-caption">Further missing actor paths omitted.</p>}</details>}
    <div className="uar-map-tools"><input className="uar-native-search" aria-label="Filter native actors" placeholder="Search actor names or paths" value={query} onChange={event => setQuery(event.target.value)}/><button className="lg-toolbar-control" disabled={!comparison.comparable} aria-pressed={changedOnly && comparison.comparable} onClick={() => setChangedOnly(value => !value)}>Changed actors only</button><button className="lg-toolbar-control" aria-pressed={generated} onClick={() => setGenerated(value => !value)}>Include engine-generated</button></div>
    {!comparison.comparable && <p className="uar-caption">Actor comparison requires both captures with the same engine version.</p>}
    {comparison.comparable && !comparison.presenceComplete && <p className="uar-warning">Matched placement changes are available. Unmatched actors have unconfirmed presence because coverage or package identity is incomplete.</p>}
    <p className="uar-caption">{Math.min(1000,results.length)} of {results.length} matching actors{results.length > 1000 ? ' · refine the search to see omitted actors' : ''}</p>
    {results.slice(0,1000).map((actor,index) => {
      const change = actor.saved === true ? comparison.changes.get(actor.path) : undefined
      const modified = change && ['moved','rotated','scaled','renamed','repathed','modified','replaced'].includes(change.kind)
      return <button className="uar-row" key={actor.path + ':' + index} aria-pressed={(selectedPath ?? selected) === actor.path} onClick={() => {setSelected(actor.path);onSelect(actor)}}><span>{actor.name}<small>{actor.path} · {actor.saved === true ? 'saved' : 'engine-generated'}</small>
        {actor.instancePath && <small>Instance: {actor.instanceLabel ?? actor.instancePath}<br/>Source: {actor.sourcePath}</small>}
        <small className={change?.kind === 'added' ? 'uar-added' : change?.kind === 'removed' ? 'uar-removed' : modified ? 'uar-modified' : 'uar-unknown'}>{change ? names[change.kind] : 'Engine-generated'}{change?.reason ? ' · ' + change.reason : ''}</small>
        {change?.identity && <small>Matched by {change.identity === 'guid' ? 'saved actor GUID' : 'exact object path'}</small>}
        {change?.pathChanged && change.before && change.after && <small>Path: {change.before.path} → {change.after.path}</small>}
        {change?.rotationDegrees !== undefined && <small>World rotation changed {Number(change.rotationDegrees.toFixed(4))}°</small>}
        {change?.scaleChanged && change.before?.scale && change.after?.scale && <small>World scale: {coordinates(change.before.scale)} → {coordinates(change.after.scale)}</small>}
        {modified && change.before && change.after && <small>{labels.left}: {coordinates(change.before.location)} cm → {labels.right}: {coordinates(change.after.location)} cm{change.delta && ' · Δ ' + coordinates(change.delta) + ' cm'}{change.before.name !== change.after.name && ' · ' + change.before.name + ' → ' + change.after.name}</small>}
      </span><small>{coordinates(actor.location)} cm</small></button>
    })}
    {!results.length && <p className="uar-caption">No captured actors match these filters.</p>}
  </details>
}
