import React, { useMemo } from 'react'
import type { BlueprintGraph } from '../../../electron/blueprintTypes'
import { animationNodeName, animationStateMachine } from '../../lib/animationReview'
import type { NodeChange } from '../../lib/blueprintGraph'

export function AnimationStateMachine({ graph, graphs, label, selected, changes, onSelect, onOpen }: {
  graph: BlueprintGraph; graphs: BlueprintGraph[]; label: string; selected: string; changes: Record<string, NodeChange>;
  onSelect(id: string): void; onOpen(graph: BlueprintGraph): void
}) {
  const model = useMemo(() => animationStateMachine(graph, graphs), [graph, graphs])
  return <section className="bp-state-machine" aria-label={`${label} saved state machine`}>
    <strong>{label} · {graph.name}</strong>
    <small>Saved states and reciprocal pin connections · runtime activity is unavailable</small>
    {model.rows.map(row => <div className="bp-state-row" key={row.node.id || row.node.name}>
      <button className="lg-toolbar-control" aria-pressed={selected === row.node.id} onClick={() => onSelect(row.node.id)}><span>{row.name}</span><small>{row.kind}{changes[row.node.id] ? ` · ${changes[row.node.id]}` : ''}{!row.node.complete ? ' · incomplete' : ''}</small></button>
      {row.kind === 'Transition' && <small>{['CrossfadeDuration', 'BlendMode', 'PriorityOrder', 'bAutomaticRuleBasedOnSequencePlayerInState'].filter(key => Object.hasOwn(row.node.properties, key)).map(key => `${key}: ${JSON.stringify(row.node.properties[key])}`).join(' · ') || 'Blend settings not serialized'}</small>}
      {row.kind === 'Alias' && row.node.properties.bGlobalAlias === true && <small>Saved global alias</small>}
      {row.members.map((member, index) => member.node ? <button className="lg-toolbar-control" key={index} onClick={() => onSelect(member.node!.id)}>Inspect alias member · {animationNodeName(member.node)}</button> : <small key={index}>Unresolved alias member: {member.path}</small>)}
      {row.links.map(link => link.graph ? <button className="lg-toolbar-control" key={link.property} onClick={() => onOpen(link.graph!)}>Open {link.graph.kind === 'transition' ? 'rule' : 'pose graph'} · {link.graph.name}{!link.graph.complete ? ' · incomplete' : ''}</button> : <small key={link.property}>Saved graph unavailable or ambiguous: {link.path}</small>)}
    </div>)}
    {model.omitted > 0 && <small>{model.omitted} nodes omitted by the 500-node summary limit.</small>}
    <small>Alias membership is limited to 100 saved references per node. Missing/default blend values are not inferred.</small>
  </section>
}
