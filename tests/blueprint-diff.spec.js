const { test, expect } = require('@playwright/test')
const { component, find } = require('./renderer-harness')
const { graphChanges, pairGraphs } = component('src/lib/blueprintGraph.ts').exports
const graphTools = component('src/lib/blueprintGraph.ts').exports
const { createBlueprintClient } = component('src/lib/blueprintClient.ts').exports
const node = (id = 'A') => ({ id, name: id, title: id, classPath: '/Script/BlueprintGraph.K2Node_CallFunction', complete: true, x: 10, y: 20, width: 0, height: 0, comment: '', properties: { NodePosX: 10, FunctionReference: { MemberName: 'Jump' } }, pins: [{ id: 'pin', name: 'value', tooltip: '', type: { category: 'int' }, defaultValue: '1', links: [] }] })
const graph = nodes => ({ id: 'graph', name: 'EventGraph', path: 'asset.EventGraph', complete: true, nodes })

test('graph routing uses decoded support on either revision and preserves unavailable diagnostics', async () => {
  const unsupported = { status: 'ready', document: { assetClass: '/Script/Engine.Material', status: 'unsupported', graphs: [], diagnostics: ['This asset does not contain an editor Blueprint.'] } }
  const supported = { status: 'ready', document: { assetClass: '/Script/Engine.Blueprint', status: 'complete', graphs: [graph([node()])], diagnostics: [] } }
  const absent = { status: 'absent' }, unavailable = { status: 'unavailable', reason: 'Offline object' }
  for (const [left, right, fallsBack] of [
    [absent, supported, false], [supported, absent, false],
    [unsupported, supported, false], [supported, unsupported, false],
    [absent, unsupported, true], [unsupported, absent, true], [unsupported, unsupported, true],
    [unavailable, unsupported, false], [absent, unavailable, false], [absent, absent, false],
  ]) {
    const messages = []
    const harness = component('src/components/diff/BlueprintDiff.tsx', { '@/lib/blueprintGraph': graphTools, '@/ipc': { ipc: { blueprintCompare: async () => ({ left, right }), blueprintCancel: async () => {} } } }, { crypto: { randomUUID: () => 'routing' } })
    harness.render('BlueprintDiff', { repoPath: 'repo', request: { filePath: 'BP_Misleading.uasset', leftRef: 'INDEX', rightRef: 'WORKING' }, onFallback() {}, onUnsupported: message => messages.push(message) })
    harness.effects.forEach(effect => effect())
    await new Promise(resolve => setImmediate(resolve))
    expect(messages.length).toBe(fallsBack ? 1 : 0)
    if (fallsBack) expect(messages[0]).toContain('/Script/Engine.Material')
  }
})

test('automatic binary fallback shows the detected class and manual fallback keeps graph return', () => {
  const harness = component('src/components/shared/FileDetailsSidePanel.tsx', { '@/stores/repoStore': { useRepoStore: fn => fn({ repoPath: 'repo', unrealProject: null }) } }, { __privateExports: ['BlueprintAssetPanel'] })
  const props = { repoPath: 'repo', filePath: 'BP_Texture.uasset', hash: 'HEAD', remoteUrl: null, request: { filePath: 'BP_Texture.uasset', leftRef: 'HEAD', rightRef: 'WORKING' } }
  let tree = harness.render('BlueprintAssetPanel', props)
  expect(tree.props.request).toBe(props.request) // Graph detection starts by default, independent of the name.
  tree.props.onFallback()
  tree = harness.render('BlueprintAssetPanel', props)
  find(tree, e => e.type === 'button').props.onClick()
  tree = harness.render('BlueprintAssetPanel', props)
  tree.props.onUnsupported('Asset class: /Script/Engine.Texture2D. Showing binary details.')
  tree = harness.render('BlueprintAssetPanel', props)
  expect(find(tree, e => e.props?.role === 'status').props.children.join('')).toContain('Texture2D')
  expect(find(tree, e => e.type === 'button')).toBeNull()
})

test('timeline changes-area route detects every uasset regardless of naming and keys revision changes', () => {
  const harness = component('src/components/shared/FileDetailsSidePanel.tsx', { '@/lib/binaryFormats': component('electron/util/binary-formats.ts').exports })
  for (const filePath of ['Ordinary.UASSET', 'Content/Materials/M_VisualScript.uasset', 'Content/Blueprints/BP_Texture.uasset']) {
    const request = { filePath, oldPath: 'Old.uasset', leftRef: 'HEAD', rightRef: 'INDEX' }
    const tree = harness.render('FileDetailsSidePanel', { repoPath: 'repo', filePath, blueprintRequest: request, blame: [], blameLoading: false })
    expect(tree.props.request).toBe(request)
    expect(tree.props.key).toContain('Old.uasset|HEAD|INDEX')
  }
})
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

test('unused hidden pin GUID churn is ignored while values, visible pins and references remain changes', () => {
  const left = node(), right = structuredClone(left)
  left.pins[0].flags = right.pins[0].flags = 1
  right.pins[0].id = 'regenerated'
  const diff = () => graphChanges({ left: graph([left]), right: graph([right]) })
  expect(diff()).toEqual([])
  right.pins[0].defaultValue = '2'; expect(diff()[0].kind).toBe('modified')
  right.pins[0].defaultValue = '1'; right.pins[0].type.category = 'float'; expect(diff()[0].kind).toBe('modified')
  right.pins[0].type.category = 'int'; left.pins[0].flags = right.pins[0].flags = 0; expect(diff()[0].kind).toBe('modified')
  left.pins[0].flags = right.pins[0].flags = 1
  left.pins[0].links = right.pins[0].links = [{ node: 'B', pin: 'target' }]; expect(diff()[0].kind).toBe('modified')
  left.pins[0].links = right.pins[0].links = []
  left.pins.push({ ...structuredClone(left.pins[0]), id: 'child', parent: 'pin' })
  right.pins.push({ ...structuredClone(right.pins[0]), id: 'child', parent: 'regenerated' })
  expect(diff()[0].kind).toBe('modified')
})

test('renderer cache hydrates shared documents, bounds retention and forces fresh retry data', async () => {
  const requests = [], doc = { graphs: [], status: 'complete' }, key = 'a'.repeat(64)
  const client = createBlueprintClient(async (_, req) => {
    requests.push(req)
    const side = { status: 'ready', documentKey: key }
    return { left: { ...side, document: req.knownDocuments.includes(key) ? undefined : doc }, right: side }
  })
  expect((await client('repo', {})).right.document).toBe(doc)
  expect((await client('repo', {})).left.document).toBe(doc)
  expect(requests[1].knownDocuments).toEqual([key])
  await client('repo', { force: true })
  expect(requests[2].knownDocuments).toEqual([])
  const bounded = createBlueprintClient(async (_, req) => {
    requests.push(req)
    return { left: { status: 'ready', documentKey: req.requestId.padStart(64,'0'), document: doc }, right: { status: 'absent' } }
  })
  for (let i = 0; i < 12; i++) await bounded('repo', { requestId: String(i) })
  expect(requests.at(-1).knownDocuments).toHaveLength(8)
  const invalid = createBlueprintClient(async () => ({ left: { status: 'ready', documentKey: key }, right: { status: 'absent' } }))
  await expect(invalid('repo', {})).rejects.toThrow('Cached Blueprint data is unavailable')
})

test('renderer keeps advertised documents alive during concurrent cache eviction', async () => {
  const doc = { graphs: [] }, key = 'a'.repeat(64)
  let release
  const client = createBlueprintClient(async (_, req) => {
    if (req.requestId === 'wait') return new Promise(resolve => { release = () => resolve({ left: { status: 'ready', documentKey: key }, right: { status: 'absent' } }) })
    return { left: { status: 'ready', documentKey: req.requestId === 'first' ? key : req.requestId.padStart(64,'0'), document: doc }, right: { status: 'absent' } }
  })
  await client('repo', { requestId: 'first' })
  const pending = client('repo', { requestId: 'wait' })
  for (let i = 0; i < 10; i++) await client('repo', { requestId: String(i) })
  release()
  expect((await pending).left.document).toBe(doc)
})

test('comments are distinct from logical changes and retain simultaneous layout changes', () => {
  const base = node(), changed = structuredClone(base)
  changed.comment = 'Explain the target'
  expect(graphChanges({ left: graph([base]), right: graph([changed]) })[0]).toMatchObject({ kind: 'commented', commentChanged: true, layoutChanged: false })
  changed.x += 20
  expect(graphChanges({ left: graph([base]), right: graph([changed]) })[0]).toMatchObject({ kind: 'commented', commentChanged: true, layoutChanged: true })
  changed.pins[0].defaultValue = '2'
  expect(graphChanges({ left: graph([base]), right: graph([changed]) })[0]).toMatchObject({ kind: 'modified', commentChanged: true, layoutChanged: true })
})

test('wire changes deduplicate reciprocal edges and suppress incomplete comparison claims', () => {
  const a = node('A'), b = node('B'), c = node('C')
  a.pins[0].links = [{ node: 'B', pin: 'pin' }]; b.pins[0].links = [{ node: 'A', pin: 'pin' }]
  const left = graph([a, b, c]), right = structuredClone(left)
  right.nodes[0].pins[0].links = [{ node: 'C', pin: 'pin' }]
  right.nodes[1].pins[0].links = []
  right.nodes[2].pins[0].links = [{ node: 'A', pin: 'pin' }]
  const result = graphTools.wireChanges({ left, right })
  expect(result.map(c => c.kind)).toEqual(['removed', 'added'])
  expect(result[0].id).toBe(graphTools.wireId('B', 'pin', 'A', 'pin'))
  expect(graphTools.wireChanges({ left, right: left })).toEqual([])
  expect(graphTools.wireChanges({ right: left })).toHaveLength(1)
  const changedType = structuredClone(left)
  changedType.nodes.slice(0,2).forEach(n => { n.pins[0].type.category = 'float' })
  expect(graphTools.wireChanges({ left, right: changedType })).toMatchObject([{ kind: 'modified', category: 'float' }])
  expect(graphTools.wireChanges({ left, right: { ...right, complete: false } })).toEqual([])
})

test('viewer sends wire decorations to the correct side and Changes disables them', () => {
  const a = node('A'), b = node('B')
  a.pins[0].links = [{ node: 'B', pin: 'pin' }]; b.pins[0].links = [{ node: 'A', pin: 'pin' }]
  const left = graph([a, b]), right = structuredClone(left)
  right.nodes.forEach(n => { n.pins[0].links = [] })
  const harness = component('src/components/diff/BlueprintDiff.tsx', { '@/lib/blueprintGraph': graphTools })
  harness.slots[0] = { left: { status: 'ready', document: { status: 'complete', graphs: [left] } }, right: { status: 'ready', document: { status: 'complete', graphs: [right] } } }
  const props = { repoPath: 'repo', request: { filePath: 'A.uasset', leftRef: 'INDEX', rightRef: 'WORKING' }, onFallback() {} }
  const tree = harness.render('BlueprintDiff', props)
  const panes = find(tree, e => e.props?.className === 'bp-revisions').props.children
  expect(Object.values(panes[0].props.wires)).toEqual(['removed'])
  expect(panes[1].props.wires).toEqual({})
  find(tree, e => e.type === 'button' && e.props.children[0] === 'Changes').props.onClick()
  const hidden = find(harness.render('BlueprintDiff', props), e => e.props?.className === 'bp-revisions').props.children
  expect(hidden.map(p => p.props.wires)).toEqual([{}, {}])
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
  const pending = [], cancelled = [], unsupported = []
  const harness = component('src/components/diff/BlueprintDiff.tsx', {
    '@/ipc': { ipc: { blueprintCompare: (_, req) => new Promise(resolve => pending.push({ req, resolve })), blueprintCancel: async id => cancelled.push(id) } },
    '@/lib/blueprintGraph': graphTools,
  }, { crypto: require('node:crypto') })
  const props = filePath => ({ repoPath: 'repo', request: { filePath, leftRef: 'HEAD', rightRef: 'WORKING' }, onFallback() {}, onUnsupported: message => unsupported.push(message) })
  harness.render('BlueprintDiff', props('A.uasset'))
  const cleanups = harness.effects.map(effect => effect())
  cleanups.forEach(cleanup => cleanup?.())
  harness.render('BlueprintDiff', props('B.uasset'))
  harness.effects.forEach(effect => effect())
  const result = path => ({ left: { status: 'absent', path, ref: 'HEAD' }, right: { status: 'ready', path, ref: 'WORKING', document: { status: 'complete', graphs: [graph([node()])] } } })
  pending[1].resolve(result('B.uasset')); await new Promise(resolve => setImmediate(resolve))
  pending[0].resolve({ left: { status: 'absent' }, right: { status: 'ready', document: { status: 'unsupported', assetClass: 'Material', graphs: [], diagnostics: [] } } }); await new Promise(resolve => setImmediate(resolve))
  expect(harness.slots[0].right.path).toBe('B.uasset')
  expect(cancelled).toEqual([pending[0].req.requestId])
  expect(unsupported).toEqual([]) // Late non-Blueprint results must not switch the newer selection to binary details.
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
  const labels = () => find(harness.render('BlueprintDiff', props), e => e.props?.id === 'bp-graph-choice').props.items.map(e => e.name + (e.detail ? ' ' + e.detail : ''))
  expect(labels()).toEqual(['Same', 'Edit (1 change)', 'Layout (1 change)', 'Removed (removed)', 'Partial (incomplete)', 'Added (added)'])
  const items = find(harness.render('BlueprintDiff', props), e => e.props?.id === 'bp-graph-choice').props.items
  expect(items.find(e => e.name === 'Edit').color).toBe('var(--lg-warning)')
  expect(items.find(e => e.name === 'Removed').color).toBe('var(--lg-error)')
  expect(items.find(e => e.name === 'Added').color).toBe('var(--lg-success)')
  harness.slots[0].left.status = 'unavailable'
  expect(labels().every(label => label.endsWith('(comparison unavailable)'))).toBe(true)
})


test('Blueprint file action accepts any uasset name, preserves revisions and excludes other files', () => {
  const opened=[],closed=[]
  const harness=component('src/components/shared/BlueprintFileAction.tsx',{'@/stores/assetViewerStore':{useAssetViewerStore:selector=>selector({openBlueprint:(...args)=>opened.push(args)})}})
  for(const [filePath,revision] of [['Ordinary.UASSET',undefined],['Content/M_VisualScript.uasset','INDEX'],['Historical.uasset','a'.repeat(40)]]) {
    const item=harness.render('BlueprintFileAction',{repoPath:'repo',filePath,revision,onClose:()=>closed.push(true)})
    expect(item.props.label).toBe('Open Blueprint graph');item.props.onClick()
    expect(opened.at(-1)).toEqual(['repo',filePath,revision??'WORKING'])
  }
  expect(closed).toHaveLength(3)
  for(const filePath of ['Readme.txt','BP_Test.umap','folder'])expect(harness.render('BlueprintFileAction',{repoPath:'repo',filePath,onClose(){}})).toBeNull()
})

test('asset viewer mode resets between graph and normal previews', () => {
  let state
  const harness=component('src/stores/assetViewerStore.ts',{zustand:{create:initialize=>{state=initialize(update=>Object.assign(state,update));return ()=>state}}})
  state.openBlueprint('repo','Ordinary.uasset','INDEX')
  expect(state).toMatchObject({view:'blueprint',revision:'INDEX',isOpen:true})
  state.close();expect(state.isOpen).toBe(false)
  state.open('other','Image.png');expect(state).toMatchObject({view:'asset',revision:'WORKING',isOpen:true,repoPath:'other',filePath:'Image.png'})
})

test('dashboard graph menus target the clicked status or lock file without navigation or unlocking', () => {
  const clicked=[],unexpected=[]
  const harness=component('src/components/dashboard/DashboardPanel.tsx',{'@/lib/useBlueprintFileMenu':{useBlueprintFileMenu:repo=>({menu:null,onContextMenu:(_,file)=>clicked.push([repo,file])})}}, {__privateExports:['LocalStatusCard','LocksCard']})
  let tree=harness.render('LocalStatusCard',{repoPath:'repo',sync:null,files:[{path:'Clicked.uasset',staged:false,status:'M'}],staged:0,unstaged:1,onNavigate:()=>unexpected.push('navigate')})
  find(tree,e=>e.props?.onContextMenu).props.onContextMenu({})
  harness.slots[0]='team'
  tree=harness.render('LocksCard',{repoPath:'repo',locks:[{id:'lock',path:'OtherOwner.uasset',owner:{login:'other',name:'Other'},lockedAt:new Date().toISOString()}],currentLogin:'me',isAdmin:false,unlockFile:()=>unexpected.push('unlock')})
  find(tree,e=>e.props?.onContextMenu).props.onContextMenu({})
  expect(clicked).toEqual([['repo','Clicked.uasset'],['repo','OtherOwner.uasset']]);expect(unexpected).toEqual([])
})
