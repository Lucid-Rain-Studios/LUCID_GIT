const { test, expect } = require('@playwright/test')
const { component, find } = require('./renderer-harness')
const { graphChanges, pairGraphs } = component('src/lib/blueprintGraph.ts').exports
const graphTools = component('src/lib/blueprintGraph.ts').exports
const node = (id = 'A') => ({ id, name: id, title: id, classPath: '/Script/BlueprintGraph.K2Node_CallFunction', complete: true, x: 10, y: 20, width: 0, height: 0, comment: '', properties: { NodePosX: 10, FunctionReference: { MemberName: 'Jump' } }, pins: [{ id: 'pin', name: 'value', tooltip: '', type: { category: 'int' }, defaultValue: '1', links: [] }] })
const graph = nodes => ({ id: 'graph', name: 'EventGraph', path: 'asset.EventGraph', complete: true, nodes })
test('semantic comparison distinguishes defaults, rewiring, node presence and layout', () => {
  const base = node(), changed = structuredClone(base)
  const diff = () => graphChanges({ left: graph([base]), right: graph([changed]) })
  expect(diff()).toEqual([])
  changed.x += 100; changed.properties.NodePosX += 100
  expect(diff().map(c => c.kind)).toEqual(['moved'])
  changed.pins[0].defaultValue = '2'
  expect(diff().map(c => c.kind)).toEqual(['modified'])
  changed.pins[0].defaultValue = '1'; changed.pins[0].links = [{ node: 'B', pin: 'other' }]
  expect(diff().map(c => c.kind)).toEqual(['modified'])
  changed.complete = false
  expect(diff()).toEqual([])
  expect(graphChanges({ left: graph([base]), right: graph([node('B')]) }).map(c => c.kind)).toEqual(['removed', 'added'])
})
test('graph fallback matches unique names and leaves ambiguous identities unmatched', () => {
  expect(pairGraphs([graph([])], [{ ...graph([]), id: 'different' }])[0].matchedByName).toBe(true)
  expect(pairGraphs([{ ...graph([]), id: 'one' }, { ...graph([]), id: 'two' }], [{ ...graph([]), id: 'three' }])).toHaveLength(3)
})

test('compiler banner text respects the Unreal active-message flag without losing saved properties', () => {
  for (const flag of [undefined, false, true]) {
    const saved = node()
    saved.pins = []
    saved.properties = { ErrorType: 1, ErrorMsg: '', ...(flag === undefined ? {} : { bHasCompilerMessage: flag }) }
    const before = structuredClone(saved)
    const text = graphTools.graphText(graph([saved]))
    expect(text.includes('ErrorType=1')).toBe(flag === true)
    expect(text.includes('ErrorMsg=""')).toBe(flag === true)
    expect(saved).toEqual(before)
  }
})

test('rapid file changes discard obsolete results and cancel only their subscriptions', async () => {
  const pending = [], cancelled = []
  const harness = component('src/components/diff/BlueprintDiff.tsx', {
    '@/ipc': { ipc: { blueprintCompare: (_, req) => new Promise(resolve => pending.push({ req, resolve })), blueprintCancel: async id => cancelled.push(id) } },
    '@/lib/blueprintGraph': graphTools,
  }, { crypto: require('node:crypto') })
  const props = filePath => ({ repoPath: 'repo', request: { filePath, leftRef: 'HEAD', rightRef: 'WORKING' }, onFallback() {} })
  harness.render('BlueprintDiff', props('A.uasset'))
  const cleanups = harness.effects.map(effect => effect())
  cleanups.forEach(cleanup => cleanup?.())
  harness.render('BlueprintDiff', props('B.uasset'))
  harness.effects.forEach(effect => effect())
  const result = path => ({ left: { status: 'absent', path, ref: 'HEAD' }, right: { status: 'ready', path, ref: 'WORKING', document: { status: 'complete', graphs: [graph([node()])] } } })
  pending[1].resolve(result('B.uasset')); await new Promise(resolve => setImmediate(resolve))
  pending[0].resolve(result('A.uasset')); await new Promise(resolve => setImmediate(resolve))
  expect(harness.slots[0].right.path).toBe('B.uasset')
  expect(cancelled).toEqual([pending[0].req.requestId])
})

test('retry refreshes cached revisions and incomplete warnings are deduplicated', async () => {
  const requests = []
  const partial = { ...graph([node()]), complete: false, diagnostics: ['Unparsed native node data'] }
  const result = { left: { status: 'ready', path: 'A.uasset', ref: 'INDEX', document: { status: 'partial', graphs: [partial] } }, right: { status: 'ready', path: 'A.uasset', ref: 'WORKING', document: { status: 'partial', graphs: [partial] } } }
  const harness = component('src/components/diff/BlueprintDiff.tsx', {
    '@/ipc': { ipc: { blueprintCompare: async (_, req) => { requests.push(req); return result }, blueprintCancel: async () => {} } },
    '@/lib/blueprintGraph': graphTools,
  }, { crypto: require('node:crypto') })
  const props = { repoPath: 'repo', request: { filePath: 'A.uasset', leftRef: 'INDEX', rightRef: 'WORKING' }, onFallback() {} }
  harness.render('BlueprintDiff', props)
  harness.effects.forEach(effect => effect())
  await new Promise(resolve => setImmediate(resolve))
  const tree = harness.render('BlueprintDiff', props)
  const warning = find(tree, entry => entry.props?.className === 'bp-warning')
  const details = find(warning, entry => entry.type === 'details')
  expect(details.props.children[1]).toHaveLength(1)
  expect(find(tree, entry => entry.props?.['aria-label'] === 'Graph change summary').props.children).toEqual(['0 decoded changes - Comparison incomplete'])
  find(warning, entry => entry.type === 'button').props.onClick()
  harness.render('BlueprintDiff', props)
  harness.effects.forEach(effect => effect())
  await new Promise(resolve => setImmediate(resolve))
  expect(requests.map(req => req.force)).toEqual([false, true])
})

test('graph dropdown identifies changes, presence and incomplete comparisons', () => {
  const makeGraph = (name, nodes = [node()]) => ({ ...graph(nodes), id: name, name })
  const modified = node(); modified.pins[0].defaultValue = '2'
  const moved = node(); moved.x += 20
  const left = [makeGraph('Same'), makeGraph('Edit'), makeGraph('Layout'), makeGraph('Removed'), { ...makeGraph('Partial'), complete: false }]
  const right = [makeGraph('Same'), makeGraph('Edit', [modified]), makeGraph('Layout', [moved]), makeGraph('Added'), { ...makeGraph('Partial'), complete: false }]
  const harness = component('src/components/diff/BlueprintDiff.tsx', { '@/lib/blueprintGraph': graphTools })
  harness.slots[0] = { left: { status: 'ready', document: { status: 'complete', graphs: left } }, right: { status: 'ready', document: { status: 'complete', graphs: right } } }
  const props = { repoPath: 'repo', request: { filePath: 'A.uasset', leftRef: 'INDEX', rightRef: 'WORKING' }, onFallback() {} }
  const labels = () => find(harness.render('BlueprintDiff', props), e => e.props?.id === 'bp-graph-choice').props.children[0].map(e => e.props.children[0])
  expect(labels()).toEqual(['Same', 'Edit (1 change)', 'Layout (1 change)', 'Removed (removed)', 'Partial (incomplete)', 'Added (added)'])
  harness.slots[0].left.status = 'unavailable'
  expect(labels().every(label => label.endsWith('(comparison unavailable)'))).toBe(true)
})
