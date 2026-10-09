import type { BlueprintGraph, BlueprintNode } from '@/ipc'

export type NodeChange = 'added' | 'removed' | 'modified' | 'moved'
export interface GraphChange { id: string; kind: NodeChange; title: string; left?: BlueprintNode; right?: BlueprintNode }
export interface GraphPair { key: string; name: string; left?: BlueprintGraph; right?: BlueprintGraph; matchedByName: boolean }

export function pairGraphs(left: BlueprintGraph[], right: BlueprintGraph[]): GraphPair[] {
  const unused = new Set(right)
  const pairs: GraphPair[] = left.map(l => {
    const byId = l.id && right.find(r => unused.has(r) && r.id === l.id)
    const candidates = right.filter(r => unused.has(r) && r.name === l.name)
    const r = byId || (candidates.length === 1 && left.filter(g => g.name === l.name).length === 1 ? candidates[0] : undefined)
    if (r) unused.delete(r)
    return { key: l.id || l.path, name: l.name === r?.name || !r ? l.name : `${l.name} → ${r.name}`, left: l, right: r, matchedByName: !!r && !byId }
  })
  for (const r of unused) pairs.push({ key: 'added:' + (r.id || r.path), name: r.name, left: undefined, right: r, matchedByName: false })
  return pairs
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => JSON.stringify(key) + ':' + canonical(v)).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
function semantic(node: BlueprintNode) {
  const properties = Object.fromEntries(Object.entries(node.properties).filter(([key]) => !['NodePosX', 'NodePosY', 'NodeWidth', 'NodeHeight', 'NodeGuid', 'NodeComment'].includes(key)))
  const pins = node.pins.map(pin => {
    const { links, ...rest } = pin
    return { ...rest, tooltip: undefined, links: links.map(link => ({ node: link.node, pin: link.pin })).sort((a, b) => canonical(a).localeCompare(canonical(b))) }
  }).sort((a, b) => a.id.localeCompare(b.id))
  return canonical({ class: node.classPath, comment: node.comment, properties, pins })
}
export function graphChanges(pair: GraphPair): GraphChange[] {
  const result: GraphChange[] = [], right = new Map(pair.right?.nodes.map(n => [n.id, n]) ?? [])
  for (const l of pair.left?.nodes ?? []) {
    if (!l.id) continue
    const r = l.id ? right.get(l.id) : undefined
    if (r) right.delete(l.id)
    if (!r) result.push({ id: l.id || l.name, kind: 'removed', title: l.title, left: l })
    else if (!l.complete || !r.complete) continue // Unknown pin data is not a diff.
    else if (semantic(l) !== semantic(r)) result.push({ id: l.id, kind: 'modified', title: r.title, left: l, right: r })
    else if (l.x !== r.x || l.y !== r.y || l.width !== r.width || l.height !== r.height) result.push({ id: l.id, kind: 'moved', title: r.title, left: l, right: r })
  }
  for (const r of right.values()) if (r.id) result.push({ id: r.id, kind: 'added', title: r.title, right: r })
  return result
}
const quote = (value: string) => JSON.stringify(value).replace(/\\n/g, '\\n').replace(/\\r/g, '')
function unreal(value: unknown): string {
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (value && typeof value === 'object') return '(' + Object.entries(value).map(([key, v]) => `${key}=${unreal(v)}`).join(',') + ')'
  return String(value ?? '')
}
export function graphText(graph: BlueprintGraph): string {
  return graph.nodes.map(n => {
    const lines = [`Begin Object Class=${n.classPath} Name=${quote(n.name)}`, `NodePosX=${n.x}`, `NodePosY=${n.y}`, `NodeGuid=${n.id}`, 'AdvancedPinDisplay=Shown']
    for (const [key, value] of Object.entries(n.properties)) {
      if (['NodePosX','NodePosY','NodeGuid','AdvancedPinDisplay'].includes(key)) continue
      // Unreal gates its compiler banner on this flag; Klee only checks severity.
      // Keep inactive saved metadata in the inspector, but out of the canvas.
      if ((key === 'ErrorType' || key === 'ErrorMsg') && n.properties.bHasCompilerMessage !== true) continue
      lines.push(`${key}=${unreal(value)}`)
    }
    for (const p of n.pins) {
      const category = p.type.category === 'real' ? p.type.subcategory || 'double' : p.type.category
      const fields = [`PinId=${p.id}`, `PinName=${quote(p.name)}`, `Direction=${quote(p.direction === 'output' ? 'EGPD_Output' : 'EGPD_Input')}`, `PinType.PinCategory=${quote(category)}`, `PinType.PinSubCategory=${quote(p.type.subcategory)}`, `PinType.PinSubCategoryObject=${quote(p.type.object)}`, `PinType.ContainerType=${p.type.container}`, `DefaultValue=${quote(p.defaultValue || p.defaultText)}`, `bHidden=${p.flags & 1 ? 'True' : 'False'}`, `bAdvancedView=False`]
      if (p.friendlyName) fields.push(`PinFriendlyName=${quote(p.friendlyName)}`)
      if (p.defaultObject !== 'None') fields.push(`DefaultObject=${quote(p.defaultObject)}`)
      const links = p.links.filter(l => l.nodeName).map(l => `${l.nodeName} ${l.pin},`).join('')
      if (links) fields.push(`LinkedTo=(${links})`)
      lines.push(`CustomProperties Pin (${fields.join(',')},)`)
    }
    lines.push('End Object')
    return lines.join('\n')
  }).join('\n')
}
