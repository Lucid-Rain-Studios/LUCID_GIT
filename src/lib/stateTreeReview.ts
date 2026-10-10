import type { UnrealAssetObject } from '../../electron/blueprintTypes'

type Fields = Record<string, unknown>
const record = (value: unknown): Fields => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {}
export const stateClass = (object: UnrealAssetObject) => object.classPath === '/Script/StateTreeEditorModule.StateTreeState'
export const entryClass = (object: UnrealAssetObject) => object.classPath.startsWith('/Review/StateTree.')
export function stateName(object: UnrealAssetObject): string {
  const name = object.properties.Name
  return typeof name === 'string' ? name : typeof record(name).Name === 'string' ? String(record(name).Name) : object.name
}
function unwrap(value: unknown, key: string): Fields {
  const fields = record(value)
  return record(fields[key] ?? value)
}
function guid(value: unknown, key = 'ID'): string {
  for (let depth = 0; depth < 8 && typeof value !== 'string'; depth++) value = record(value)[key]
  const id = typeof value === 'string' ? value.replace(/[{}-]/g, '').toUpperCase() : ''
  return /^[A-F0-9]{32}$/.test(id) && !/^0+$/.test(id) ? id : ''
}
const fields = ['Tasks', 'SingleTask', 'EnterConditions', 'Transitions', 'Evaluators', 'GlobalTasks']
const label: Record<string, string> = { Tasks: 'Task', SingleTask: 'Task', EnterConditions: 'Enter condition', Conditions: 'Transition condition', Transitions: 'Transition', Evaluators: 'Evaluator', GlobalTasks: 'Global task', Bindings: 'Binding' }

export function bindingEndpoint(value: unknown) {
  const path = record(value), id = guid(path.StructID, 'StructID')
  const segments = Array.isArray(path.Segments) ? path.Segments : []
  const parts = segments.map(segment => {
    const fields = record(segment)
    return { name: typeof fields.Name === 'string' ? fields.Name : '', index: typeof fields.ArrayIndex === 'number' ? fields.ArrayIndex : -1 }
  })
  return { id, key: JSON.stringify([id, parts]), label: parts.map(part => part.name + (part.index >= 0 ? `[${part.index}]` : '')).join('.') || '(whole value / unresolved path)' }
}

/** Resolve only saved IDs within this captured side; never load current defaults. */
export function stateTreeLinks(object: UnrealAssetObject, objects: UnrealAssetObject[]) {
  const links: Array<{ label: string; object?: UnrealAssetObject; description: string }> = []
  const resolve = (id: string) => {
    if (!id) return []
    return objects.filter(candidate => candidate.id === id || guid(record(candidate.properties.Parameters).ID) === id || guid(record(candidate.properties.RootParameters).ID) === id || Array.isArray(candidate.properties.ContextDataDescs) && candidate.properties.ContextDataDescs.some(value => guid(record(value).ID) === id))
  }
  if (object.classPath === '/Review/StateTree.Bindings') for (const [key, label] of [['SourcePropertyPath', 'Binding source'], ['TargetPropertyPath', 'Binding target']]) {
    const endpoint = bindingEndpoint(object.properties[key]), matches = resolve(endpoint.id)
    links.push({ label, object: matches.length === 1 ? matches[0] : undefined, description: endpoint.label + (matches.length === 1 ? ' · ' + matches[0].name : ' · unresolved or ambiguous saved ID') })
  }
  for (const [key, label] of [['TargetResolution', 'Transition target'], ['InstanceObject', 'Task instance'], ['LinkedAsset', 'Linked asset'], ['LinkedSubtree', 'Linked subtree']]) {
    const value = object.properties[key]
    if (typeof value !== 'string' || value === 'None') continue
    const matches = objects.filter(candidate => candidate.path === value)
    links.push({ label, object: matches.length === 1 ? matches[0] : undefined, description: value })
  }
  return links
}

/** Derived authored entries. Never use compiled runtime indexes as identities.
 * Preserve unknown/raw fields on the original object for binary/property recovery. */
export function stateTreeEntries(objects: UnrealAssetObject[]) {
  const entries: UnrealAssetObject[] = []
  const byId = new Map<string, UnrealAssetObject[]>()
  for (const object of objects) if (stateClass(object) && object.id) byId.set(object.id, [...(byId.get(object.id) ?? []), object])
  let omitted = 0
  const pathCounts = new Map<string, number>()
  const add = (parent: UnrealAssetObject, key: string, value: unknown, index: number) => {
    const data = record(value)
    if (!Object.keys(data).length) return
    if (entries.length >= 5000) { omitted++; return }
    const id = guid(data.ID)
    const node = unwrap(data.Node, 'Node'), target = unwrap(data.State, 'State')
    const kind = label[key], type = typeof node.structType === 'string' ? node.structType : ''
    const targetId = guid(target.ID)
    const targetState = targetId ? byId.get(targetId) ?? [] : []
    const targetName = targetState.length === 1 ? stateName(targetState[0]) : typeof target.Name === 'string' ? target.Name : ''
    const source = bindingEndpoint(data.SourcePropertyPath), destination = bindingEndpoint(data.TargetPropertyPath)
    const name = key === 'Bindings' ? `Binding: ${source.label} → ${destination.label}` : key === 'Transitions' ? `${kind} → ${targetName || String(target.LinkType ?? 'unresolved target')}` : type && type !== 'None' ? `${kind}: ${type.split('.').pop()}` : `${kind} ${index + 1}`
    // Unidentified entries deliberately include their order in the fallback path.
    // Reordering them is not a proven identity match.
    const identity = key === 'Bindings' && source.id && destination.id ? source.key + '→' + destination.key : id || index
    const candidatePath = parent.path + '.' + key + '[' + identity + ']'
    const count = (pathCounts.get(candidatePath) ?? 0) + 1
    pathCounts.set(candidatePath, count)
    const path = candidatePath + (count > 1 ? `#${count}` : '')
    if (count > 1 && key === 'Bindings') {
      const previous = entries.find(entry => entry.path === candidatePath)
      if (previous) { previous.decoded = false; previous.diagnostics.push('Duplicate saved binding endpoints; identity is ambiguous.') }
    }
    const properties: Fields = { ...data, SavedOrder: index, Owner: parent.path }
    if (key === 'Transitions') properties.TargetResolution = targetState.length === 1 ? targetState[0].path : 'Unresolved or non-state target; inspect saved link type and ID'
    const entry: UnrealAssetObject = { id, path, name, classPath: '/Review/StateTree.' + key, outer: parent.path, properties, decoded: parent.decoded && !parent.opaqueProperties?.includes(key) && !(key === 'Bindings' && count > 1), opaqueProperties: parent.opaqueProperties?.includes(key) ? Object.keys(properties) : [], opaqueHash: '', opaqueBytes: 0, diagnostics: [...(id ? [] : [key === 'Bindings' && source.id && destination.id ? 'Matched by saved binding endpoint paths; no authored binding GUID.' : 'No saved GUID; order/path fallback only.']), ...(parent.opaqueProperties?.includes(key) ? ['This saved entry group contains opaque fields; semantic details are incomplete.'] : []), ...(key === 'Bindings' && count > 1 ? ['Duplicate saved binding endpoints; identity is ambiguous.'] : [])] }
    entries.push(entry)
    if (key === 'Transitions' && Array.isArray(data.Conditions)) data.Conditions.forEach((condition, i) => add(entry, 'Conditions', condition, i))
  }
  for (const object of objects) {
    if (!stateClass(object) && object.classPath !== '/Script/StateTreeEditorModule.StateTreeEditorData') continue
    for (const key of fields) {
      const data = object.properties[key]
      if (Array.isArray(data)) data.forEach((entry, i) => add(object, key, entry, i))
      else if (key === 'SingleTask' && data) add(object, key, unwrap(data, key), 0)
    }
    const bindings = unwrap(object.properties.EditorBindings, 'EditorBindings').PropertyBindings
    if (!object.opaqueProperties?.includes('EditorBindings') && Array.isArray(bindings)) bindings.forEach((binding, i) => add(object, 'Bindings', binding, i))
  }
  return { entries, omitted }
}

export function stateTreeComparisonObjects(objects: UnrealAssetObject[]): UnrealAssetObject[] {
  const { entries, omitted } = stateTreeEntries(objects)
  // If derived entries were capped, retain every original saved array so omitted
  // data can still produce an aggregate saved-field change.
  const originals = omitted ? objects : objects.map(object => {
    if (object.classPath === '/Script/StateTreeModule.StateTree') return { ...object, name: object.name + ' (compiled/runtime package)' }
    if (!stateClass(object) && object.classPath !== '/Script/StateTreeEditorModule.StateTreeEditorData') return object
    const properties = { ...object.properties }
    for (const key of fields) if (!object.opaqueProperties?.includes(key) && (Array.isArray(properties[key]) || key === 'SingleTask' && properties[key])) delete properties[key]
    if (!object.opaqueProperties?.includes('EditorBindings') && Array.isArray(unwrap(properties.EditorBindings, 'EditorBindings').PropertyBindings)) delete properties.EditorBindings
    return { ...object, properties }
  })
  return [...originals, ...entries]
}
