import { useMemo } from 'react'
import type { UnrealAssetObject } from '../../../electron/blueprintTypes'
import { meshMetadata } from '../../lib/meshMetadata'

export function MeshContents({ objects, selected, filter, visible, onSelect }: { objects: UnrealAssetObject[]; selected: string; filter: string; visible: number; onSelect(object: UnrealAssetObject): void }) {
  const metadata = useMemo(() => meshMetadata(objects), [objects])
  const rows = metadata.filter(item => (item.object.name + ' ' + item.object.classPath + ' ' + item.fields.map(([name]) => name).join(' ')).toLowerCase().includes(filter.toLowerCase()))
  return <section aria-label="Saved mesh metadata">
    <p className="uar-caption">Material slots, collision, import/build settings and LOD descriptors appear only when serialized and decoded. Render triangle counts, skeleton/skin data and omitted defaults remain unavailable.</p>
    {rows.slice(0, visible).map(({ object, fields }) => <button className="uar-row" key={object.path} aria-pressed={selected === object.path} onClick={() => onSelect(object)}><span>{object.name}<small>{object.classPath.split('.').pop()}</small>{!object.decoded && <small>Incomplete export · native metadata is unresolved</small>}{object.opaqueBytes > 0 && <small>{object.opaqueBytes.toLocaleString()} native bytes · not interpreted</small>}{!fields.length && <small>No supported tagged metadata · inspect native-payload warnings</small>}{fields.slice(0, 16).map(([name, value]) => <small key={name}>{name}: {object.opaqueProperties?.includes(name) ? 'raw field · not interpreted' : Array.isArray(value) ? `${value.length} saved entries` : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'saved structure · inspect'}</small>)}{fields.length > 16 && <small>{fields.length - 16} more saved fields in the inspector</small>}</span></button>)}
    {!rows.length && <p className="uar-caption">No decoded mesh metadata matches. All objects retains the package inventory and native-payload warnings.</p>}
  </section>
}
