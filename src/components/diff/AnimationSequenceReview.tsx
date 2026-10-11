import { useMemo } from 'react'
import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import { animationMetadata, animationTimeline } from '../../lib/animationTimeline'

export function AnimationSequenceContents({ objects, selected, filter, onSelect }: { objects: UnrealAssetObject[]; selected: string; filter: string; onSelect(object: UnrealAssetObject): void }) {
  const metadata = useMemo(() => animationMetadata(objects), [objects])
  return <section aria-label="Saved animation metadata"><p className="uar-caption">Saved duration, skeleton references, authored tracks/sample axes and import/compression settings. Compressed poses, curves and omitted defaults remain unresolved.</p>
    {metadata.filter(item => (item.object.name + ' ' + item.fields.map(([name]) => name).join(' ')).toLowerCase().includes(filter.toLowerCase())).slice(0,250).map(({ object, fields }) => <button className="uar-row" key={object.path} aria-pressed={selected === object.path} onClick={() => onSelect(object)}><span>{object.name}<small>{object.classPath}</small>{fields.map(([name, value]) => <small key={name}>{name}: {object.opaqueProperties?.includes(name) ? 'raw field · not interpreted' : Array.isArray(value) ? `${value.length} saved entries` : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'saved structure · inspect'}</small>)}{!fields.length && <small>No supported tagged metadata</small>}{object.opaqueBytes > 0 && <small>{object.opaqueBytes.toLocaleString()} native bytes · not interpreted</small>}</span></button>)}
  </section>
}

export function AnimationSequencePreview({ objects, allObjects, onSelect, selected, onSelected }: { objects: UnrealAssetObject[]; allObjects: UnrealAssetObject[][]; onSelect(object: UnrealAssetObject): void; selected: string; onSelected(key: string): void }) {
  const sides = useMemo(() => allObjects.map(animationTimeline), [allObjects])
  const model = sides[allObjects.indexOf(objects)]
  const extent = Math.max(.001, ...sides.flatMap(side => [side.length ?? 0, ...side.entries.map(entry => entry.end ?? entry.start ?? 0)]))
  const active = model?.entries.find(entry => entry.key === selected)
  return <section aria-label="Saved animation timing" className="uar-animation-timing">
    <p className="uar-caption">Authored timing schematic · seconds · same scale for both revisions. No poses are played and notifies are not executed. Segment ranges use saved trim, play rate and loop count; dependency/global rate scales and linked adjustments are unresolved. Notify ranges show saved anchors/duration, not actual runtime triggers.</p>
    <p className="uar-caption">Saved SequenceLength: {model?.length === undefined ? 'Unavailable' : `${model.length.toFixed(3)} s`} · displayed extent: {extent.toFixed(3)} s · {model?.omitted ?? 0} entries omitted by the 1,000-entry limit.</p>
    {model?.object ? <>
      <button className="lg-toolbar-control" onClick={() => onSelect(model.object!)}>Inspect animation and saved references</button>
      {model.entries.map(entry => <div className="uar-timing-row" key={entry.key}>
        <button className="uar-row" aria-pressed={selected === entry.key} onClick={() => { onSelected(entry.key); onSelect(entry.object) }}><span>{entry.kind}: {entry.label}<small>{entry.key}</small><small>{entry.start === undefined ? entry.reason : `${entry.start.toFixed(3)} s${entry.end === undefined ? entry.kind === 'Section' ? ' · saved anchor' : ' · saved duration unavailable' : ` → ${entry.end.toFixed(3)} s`}`}</small></span></button>
        {entry.start !== undefined && <div className="uar-timing-track" aria-hidden="true"><span style={{ left: `${entry.start / extent * 100}%`, width: entry.end === undefined || entry.end === entry.start ? '3px' : `${(entry.end - entry.start) / extent * 100}%` }}/></div>}
      </div>)}
      {!model.entries.length && <p className="uar-caption">No supported authored timing entries were decoded. This does not establish absence of animation, notifies or curves.</p>}
      {active && <details open><summary>Selected saved timing fields: {active.label}</summary><pre>{JSON.stringify(active.fields, null, 2).slice(0, 12000)}</pre><small>Saved fields are shown up to 12,000 characters; the package inspector retains the captured property data.</small></details>}
    </> : <p className="uar-empty">No unique saved sequence/montage export is available. Inspect All objects for incomplete data.</p>}
  </section>
}
