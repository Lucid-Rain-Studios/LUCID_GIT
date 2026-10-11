import { useMemo } from 'react'
import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import { blendSpaceBounds, blendSpaceModel } from '../../lib/blendSpaceReview'

export function BlendSpacePreview({ objects, allObjects, selected, onSelected, onSelect }: { objects: UnrealAssetObject[]; allObjects: UnrealAssetObject[][]; selected: string; onSelected(key: string): void; onSelect(object: UnrealAssetObject): void }) {
  const models = useMemo(() => allObjects.map(blendSpaceModel), [allObjects])
  const bounds = useMemo(() => blendSpaceBounds(models), [models])
  const model = models[allObjects.indexOf(objects)]
  const active = model?.entries.find(entry => entry.key === selected)
  const percentage = (value: number, axis: number) => {
    const { min, max } = bounds[axis]
    const normalizer = Math.max(1, Math.abs(min), Math.abs(max))
    return min === max ? 50 : 5 + 90 * ((value / normalizer - min / normalizer) / (max / normalizer - min / normalizer))
  }
  return <section aria-label="Saved BlendSpace samples">
    <p className="uar-caption">Authored {model?.dimensions ?? 2}D sample schematic · common scales across revisions. No pose blending, triangulation, input wrapping or animation playback is evaluated. Sample indexes are saved field locations, not stable identities.</p>
    {!model?.object ? <p className="uar-caption">A unique decoded BlendSpace root is unavailable. Inspect Contents for saved objects and native warnings.</p> : <>
      <button className="lg-toolbar-control" onClick={() => onSelect(model.object!)}>Inspect BlendSpace and saved references</button>
      <p className="uar-caption">{model.entries.filter(entry => entry.positioned).length} plotted · {model.entries.filter(entry => !entry.positioned).length} incomplete coordinates · {model.omitted} samples omitted by the 1,000-sample limit.</p>
      {model.axes.slice(0,model.dimensions).map((axis,index) => <p className="uar-caption" key={index}>{axis.label}: saved Min {axis.min ?? 'Unavailable'} · Max {axis.max ?? 'Unavailable'} · displayed {bounds[index].available ? `${bounds[index].min} to ${bounds[index].max}` : 'extent unavailable'}</p>)}
      <div className="uar-map-field uar-blend-field" role="region" aria-label="Authored BlendSpace sample positions">
        {!model.entries.some(entry => entry.positioned) && <p className="uar-empty" role="status">No complete captured sample coordinates. Missing values are not filled in.</p>}
        {model.entries.filter(entry => entry.positioned).map(entry => <button key={entry.key} className="uar-map-dot" aria-pressed={selected === entry.key} aria-label={`Sample ${entry.index + 1}: ${entry.label}, X ${entry.x}${model.dimensions === 2 ? `, Y ${entry.y}` : ''}`} title={`${entry.key}: ${entry.label}`} style={{ left: `${percentage(entry.x!,0)}%`, top: model.dimensions === 1 ? '50%' : `${100-percentage(entry.y!,1)}%` }} onClick={() => { onSelected(entry.key); onSelect(model.object!) }}/>) }
        <span className="uar-map-axis" aria-hidden="true">{model.dimensions === 2 ? `↑ ${model.axes[1].label} · ` : ''}{model.axes[0].label} →</span>
      </div>
      <p className="uar-caption">Select a dot or list row to inspect saved sample fields. Coincident samples remain individually accessible in the list.</p>
      <div className="uar-blend-list">{model.entries.map(entry => <button className="uar-row" key={entry.key} aria-pressed={selected === entry.key} onClick={() => { onSelected(entry.key); onSelect(model.object!) }}><span>Sample {entry.index+1}<small>{entry.label}</small><small>{entry.positioned ? `X ${entry.x}${model.dimensions === 2 ? ` · Y ${entry.y}` : ''}` : 'Incomplete saved coordinates'} · RateScale {typeof entry.fields.RateScale === 'number' || typeof entry.fields.RateScale === 'string' ? String(entry.fields.RateScale) : 'Unavailable'}</small></span></button>)}</div>
      {active && <section className="uar-object-properties" aria-label="Selected saved BlendSpace sample"><strong>{active.key}</strong><pre>{JSON.stringify(active.fields,null,2).slice(0,12000)}</pre>{JSON.stringify(active.fields).length > 12000 && <small>Sample view truncated; full captured values remain in the inspector.</small>}</section>}
    </>}
  </section>
}
