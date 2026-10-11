import type { BlueprintGraph, BlueprintNode } from '../../electron/blueprintTypes'

/** Resolve only an exact, unique graph in the already captured package. */
export function boundGraphs(node: BlueprintNode, graphs: BlueprintGraph[]) {
  return ['BoundGraph', 'EditorStateMachineGraph'].flatMap(property => {
    const path = node.properties[property]
    if (typeof path !== 'string' || path === 'None') return []
    const matches = graphs.filter(graph => graph.path === path)
    return [{ property, path, graph: matches.length === 1 ? matches[0] : undefined }]
  })
}

export function animationNodeName(node: BlueprintNode): string {
  if (node.classPath === '/Script/AnimGraph.AnimStateEntryNode') return 'Entry'
  if (node.classPath === '/Script/AnimGraph.AnimStateAliasNode' && typeof node.properties.StateAliasName === 'string') return node.properties.StateAliasName
  if (['/Script/AnimGraph.AnimStateNode', '/Script/AnimGraph.AnimStateConduitNode'].includes(node.classPath) && typeof node.properties.BoundGraph === 'string' && node.properties.BoundGraph !== 'None') return node.properties.BoundGraph.split('.').pop() || node.title
  return node.title
}

export function animationStateMachine(graph: BlueprintGraph, graphs: BlueprintGraph[]) {
  const nodes = graph.nodes.slice(0, 500)
  const member = (path: unknown) => {
    if (typeof path !== 'string') return undefined
    const matches = graph.nodes.filter(candidate => `${graph.path}.${candidate.name}` === path)
    return matches.length === 1 ? matches[0] : undefined
  }
  const endpoint = (node: BlueprintNode, direction: 'input' | 'output') => {
    const pins = node.pins.filter(pin => pin.direction === direction && pin.name === (direction === 'input' ? 'In' : 'Out'))
    if (pins.length !== 1 || pins[0].links.length !== 1) return undefined
    const pin = pins[0], link = pin.links[0]
    const matches = graph.nodes.filter(candidate => candidate.id === link.node)
    if (matches.length !== 1 || !matches[0].complete) return undefined
    const target = matches[0], opposite = target.pins.filter(candidate => candidate.id === link.pin && candidate.direction !== direction)
    if (opposite.length !== 1 || !opposite[0].links.some(back => back.node === node.id && back.pin === pin.id)) return undefined
    return target
  }
  return {
    omitted: Math.max(0, graph.nodes.length - nodes.length),
    rows: nodes.filter(node => node.classPath.startsWith('/Script/AnimGraph.AnimState')).map(node => {
      const transition = node.classPath === '/Script/AnimGraph.AnimStateTransitionNode'
      const from = transition && node.complete ? endpoint(node, 'input') : undefined
      const to = transition && node.complete ? endpoint(node, 'output') : undefined
      const kind = transition ? 'Transition' : node.classPath.endsWith('AnimStateEntryNode') ? 'Entry' : node.classPath.endsWith('AnimStateAliasNode') ? 'Alias' : node.classPath.endsWith('AnimStateConduitNode') ? 'Conduit' : 'State'
      const aliases = node.properties.AliasedStateNodes
      const paths = kind === 'Alias' && aliases && typeof aliases === 'object' ? Object.values(aliases).slice(0, 100) : []
      const members = paths.map(path => ({ path: typeof path === 'string' ? path : 'Unsupported saved member', node: member(path) }))
      return { node, kind, members, name: transition ? `${from ? animationNodeName(from) : 'Unresolved source'} → ${to ? animationNodeName(to) : 'Unresolved target'}` : animationNodeName(node), links: boundGraphs(node, graphs) }
    }),
  }
}
