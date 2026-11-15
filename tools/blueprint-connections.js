// Match the pinned Klee traversal (including duplicate identities and missing
// endpoints) without scanning/splicing the entire pin array for each wire.
export function connectBlueprintPins(pins, outputDirection, connect, partial) {
  const index = new Map(), removed = new Set(), connected = new Set()
  for (const pin of pins) {
    const { nodeName, id } = pin.pinProperty
    let node = index.get(nodeName)
    if (!node) index.set(nodeName, node = new Map())
    let matches = node.get(id)
    if (!matches) node.set(id, matches = new Set())
    matches.add(pin)
  }
  const remove = pin => {
    removed.add(pin)
    index.get(pin.pinProperty.nodeName).get(pin.pinProperty.id).delete(pin)
  }
  for (let i = pins.length - 1; i >= 0; i--) {
    const pin = pins[i], property = pin.pinProperty
    if (!property.isLinked) { remove(pin); continue }
    if (property.direction !== outputDirection) continue
    let found = false
    for (const link of property.linkedTo) {
      const other = index.get(link.nodeName)?.get(link.pinID)?.values().next().value
      if (!other) continue
      connect(pin, other)
      connected.add(property.getUniqueName())
      connected.add(other.pinProperty.getUniqueName())
      found = true
    }
    if (found) remove(pin)
  }
  const remaining = pins.filter(pin => !removed.has(pin))
  for (let i = remaining.length - 1; i >= 0; i--) {
    const pin = remaining[i]
    if (pin.pinProperty.isLinked && !connected.has(pin.pinProperty.getUniqueName())) partial(pin)
  }
  return remaining
}
