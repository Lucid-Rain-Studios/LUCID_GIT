const { test, expect } = require('@playwright/test')
const { component, find } = require('./renderer-harness')
const { stateTreeEntries, stateTreeLinks, stateTreeHierarchy } = component('src/lib/stateTreeReview.ts').exports
const { assetChanges } = component('src/lib/unrealAssetReview.ts').exports
const guid = n => n.toString(16).padStart(32, '0')
const endpoint = (id, name) => ({ StructID: { StructID: id }, Segments: [{ Name: name, ArrayIndex: -1 }] })
const binding = (source, target, name = 'Value') => ({ SourcePropertyPath: endpoint(source, 'Input'), TargetPropertyPath: endpoint(target, name), bIsOutputBinding: false })
const object = (name, id, properties, classPath = '/Script/StateTreeEditorModule.StateTreeState') => ({ name, id, path: 'Tree.' + name, classPath, outer: 'Tree.Editor', properties, decoded: true, opaqueProperties: [], opaqueHash: '', opaqueBytes: 0, diagnostics: [] })
const a = object('Source', guid(1), {}), b = object('Target', guid(2), {})
const editor = bindings => object('Editor', '', { EditorBindings: { PropertyBindings: bindings } }, '/Script/StateTreeEditorModule.StateTreeEditorData')
const side = objects => ({ status: 'ready', document: { assetReview: { family: 'statetree', objects } } })

test('binding matching follows saved endpoints across reorder and rejects ambiguous or missing owners', () => {
  const before = editor([binding(a.id, b.id), binding(a.id, b.id, 'Other')])
  const after = editor([...before.properties.EditorBindings.PropertyBindings].reverse())
  const entries = stateTreeEntries([a, b, before]).entries
  expect(entries[0].name).toBe('Binding: Input → Value')
  const links = stateTreeLinks(entries[0], [a, b, before, ...entries])
  expect(links[0].object).toBe(a); expect(links[1].object).toBe(b)
  const changes = assetChanges({ left: side([a, b, before]), right: side([a, b, after]) })
  expect(changes).toHaveLength(2)
  expect(changes.every(change => change.kind === 'modified' && change.properties.every(field => field.path === 'SavedOrder'))).toBe(true)
  expect(stateTreeLinks(entries[0], [a, { ...a, path: 'Duplicate' }, b])[0].object).toBeUndefined()
  expect(stateTreeLinks(entries[0], [a])[1].object).toBeUndefined()
  const duplicate = stateTreeEntries([a, b, editor([binding(a.id, b.id), binding(a.id, b.id)])]).entries
  expect(new Set(duplicate.map(entry => entry.path)).size).toBe(2)
  expect(duplicate.every(entry => !entry.decoded)).toBe(true)
})

test('binding inspection uses only the captured side and links context/parameters and instance objects', () => {
  const schema = object('Schema', '', { ContextDataDescs: [{ ID: { ID: guid(7) }, Name: 'AIController' }] }, '/Script/GameplayStateTreeModule.StateTreeAIComponentSchema')
  const state = object('State', guid(8), { Parameters: { ID: { ID: guid(9) } } })
  const entries = stateTreeEntries([schema, state, editor([binding(guid(7), guid(9))])]).entries
  const links = stateTreeLinks(entries[0], [schema, state, ...entries])
  expect(links.map(link => link.object)).toEqual([schema, state])
  const instance = object('Instance', '', {})
  expect(stateTreeLinks({ ...state, properties: { InstanceObject: instance.path } }, [instance])[0].object).toBe(instance)
  let selected
  const harness = component('src/components/diff/UnrealAssetReview.tsx', { '../../lib/stateTreeReview': { stateTreeLinks }, '@/lib/unrealAssetReview': component('src/lib/unrealAssetReview.ts').exports }, { __privateExports: ['ObjectInspector'] })
  const tree = harness.render('ObjectInspector', { object: entries[0], objects: [schema, state, ...entries], linkSides: [], onOpen() {}, onSelect: value => { selected = value } })
  const button = find(tree, node => node.type === 'button' && node.props.children.flat().join('') === 'Inspect binding source')
  expect(button).toBeTruthy(); button.props.onClick(); expect(selected).toBe(schema)
})


test('linked subtrees resolve only direct unique state GUIDs within the captured source package',()=>{
  const linked={...a,properties:{LinkedSubtree:{LinkedSubtree:{ID:{ID:b.id},Name:'Old target name',LinkType:'EStateTreeTransitionType::GotoState'}}}}
  expect(stateTreeLinks(linked,[a,b])[0]).toMatchObject({label:'Linked subtree',object:b})
  expect(stateTreeLinks(linked,[b,{...b,path:'Duplicate'}])[0].object).toBeUndefined()
  expect(stateTreeLinks(linked,[b,{...b,id:guid(99)}])[0].object).toBeUndefined()
  expect(stateTreeLinks(linked,[{...b,sourcePackage:'Other.uasset'}])[0].object).toBeUndefined()
  expect(stateTreeLinks({...linked,opaqueProperties:['LinkedSubtree']},[b])[0].object).toBeUndefined()
  expect(stateTreeLinks({...linked,properties:{LinkedSubtree:{ID:{ID:b.id},LinkType:'NextState'}}},[b])[0].object).toBeUndefined()
  expect(stateTreeLinks({...linked,properties:{LinkedSubtree:{ID:{ID:b.id}}}},[b])[0].object).toBeUndefined()
  expect(stateTreeLinks({...linked,properties:{LinkedSubtree:{ID:{ID:b.id},LinkType:'GotoState'}}},[])[0].object).toBeUndefined()
})

test('hierarchy avoids ambiguous child paths, collapse leaks, cycles and excessive preview rows',()=>{
  const root={...a,properties:{Children:[b.path]}},child={...b,properties:{Children:[a.path,'Missing']}}
  const cycle=stateTreeHierarchy([root,child],new Set())
  expect(cycle.rows).toHaveLength(2);expect(cycle.unresolved).toBe(2)
  const collapsed=stateTreeHierarchy([root,b],new Set([a.path]))
  expect(collapsed.rows.map(row=>row.state.path)).toEqual([a.path])
  const duplicate=stateTreeHierarchy([root,b,{...b}],new Set())
  expect(duplicate.rows.map(row=>row.state.path)).toEqual([a.path]);expect(duplicate.unresolved).toBeGreaterThan(0)
  expect(stateTreeHierarchy([root,b],new Set(),b.path).rows.map(row=>row.state.path)).toEqual([b.path])
  expect(stateTreeHierarchy([root,b],new Set(),'Unavailable').unresolved).toBe(1)
  const large=Array.from({length:1005},(_,i)=>({...b,path:'Tree.'+i}))
  expect(stateTreeHierarchy(large,new Set())).toMatchObject({omitted:5});expect(stateTreeHierarchy(large,new Set()).rows).toHaveLength(1000)
})
