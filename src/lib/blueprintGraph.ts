import type { BlueprintGraph, BlueprintNode } from '@/ipc'

export type NodeChange = 'added' | 'removed' | 'modified' | 'moved' | 'commented'
export interface GraphChange { id: string; kind: NodeChange; title: string; left?: BlueprintNode; right?: BlueprintNode; commentChanged?: boolean; layoutChanged?: boolean }
export interface WireChange { id: string; kind: 'added' | 'removed' | 'modified'; category: string }
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
  const referenced = new Set(node.pins.flatMap(pin => [pin.parent, pin.passThrough, ...(Array.isArray(pin.subPins) ? pin.subPins : []), ...pin.links.filter(link => link.node === node.id).map(link => link.pin)]).filter(value => typeof value === 'string'))
  const pins = node.pins.map(pin => {
    const { links, ...rest } = pin
    // Reconstructing a Blueprint can regenerate an unused hidden pin's GUID.
    // Its type/default/flags still matter; a connected or referenced ID does too.
    const unusedHidden = !!(pin.flags & 1) && !links.length && !(Array.isArray(pin.subPins) && pin.subPins.length) && !pin.parent && !pin.passThrough && !referenced.has(pin.id)
    return { ...rest, id: unusedHidden ? undefined : pin.id, tooltip: undefined, links: links.map(link => ({ node: link.node, pin: link.pin })).sort((a, b) => canonical(a).localeCompare(canonical(b))) }
  }).sort((a, b) => canonical(a).localeCompare(canonical(b)))
  return canonical({ class: node.classPath, properties, pins })
}
export function graphChanges(pair: GraphPair): GraphChange[] {
  const result: GraphChange[] = [], right = new Map(pair.right?.nodes.map(n => [n.id, n]) ?? [])
  for (const l of pair.left?.nodes ?? []) {
    if (!l.id) continue
    const r = l.id ? right.get(l.id) : undefined
    if (r) right.delete(l.id)
    if (!r) result.push({ id: l.id || l.name, kind: 'removed', title: l.title, left: l })
    else if (!l.complete || !r.complete) continue // Unknown pin data is not a diff.
    else {
      const commentChanged = l.comment !== r.comment
      const layoutChanged = l.x !== r.x || l.y !== r.y || l.width !== r.width || l.height !== r.height
      const kind = semantic(l) !== semantic(r) ? 'modified' : commentChanged ? 'commented' : layoutChanged ? 'moved' : undefined
      if (kind) result.push({ id: l.id, kind, title: r.title, left: l, right: r, commentChanged, layoutChanged })
    }
  }
  for (const r of right.values()) if (r.id) result.push({ id: r.id, kind: 'added', title: r.title, right: r })
  return result
}

// Undirected endpoint identity deduplicates reciprocal serialized pin links.
export function wireId(node: string, pin: string, otherNode: string, otherPin: string): string {
  return JSON.stringify([[node, pin], [otherNode, otherPin]].sort((a, b) => canonical(a).localeCompare(canonical(b))))
}
export function wireChanges(pair: GraphPair): WireChange[] {
  if (pair.left?.complete === false || pair.right?.complete === false) return []
  const connections = (graph?: BlueprintGraph) => {
    const result = new Map<string, string>(), nodes = new Map(graph?.nodes.map(n => [n.id, n]) ?? [])
    for (const node of nodes.values()) for (const pin of node.pins) for (const link of pin.links) {
      const target = link.node ? nodes.get(link.node) : undefined
      if (!node.complete || !target?.complete || !target.pins.some(p => p.id === link.pin)) continue
      const id = wireId(node.id, pin.id, target.id, link.pin)
      if (pin.direction === 'output' || !result.has(id)) result.set(id, pin.type.category)
    }
    return result
  }
  const left = connections(pair.left), right = connections(pair.right)
  return [...Array.from(left, ([id, category]) => ({ id, category, kind: 'removed' as const })).filter(c => !right.has(c.id)),
    ...Array.from(right, ([id, category]) => ({ id, category, kind: 'added' as const })).filter(c => !left.has(c.id)),
    ...Array.from(right, ([id, category]) => ({ id, category, kind: 'modified' as const })).filter(c => left.has(c.id) && left.get(c.id) !== c.category)]
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
