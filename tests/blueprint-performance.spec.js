const { test, expect } = require('@playwright/test')
const { component } = require('./renderer-harness')
const { connectBlueprintPins } = component('tools/blueprint-connections.js').exports
const { Scene } = component('third_party/klee/src/scene.ts', {
  './data/pin/pin-direction': { PinDirection: { EGPD_Output: 'output' } },
  './controls/node-connection.control': { NodeConnectionControl: class { constructor(a, b) { this.edge = [a.label, b.label] } } },
  './controls/partial-node-connection.control': { NodePartialConnectionControl: class { constructor(a) { this.edge = [a.label] } } },
}).exports

function pin(label, nodeName, id, direction, links) {
  return { label, pinProperty: { nodeName, id, direction, linkedTo: links, isLinked: links.length > 0, getUniqueName() { return this.nodeName + ':' + this.id } } }
}

test('indexed wiring matches pinned Klee for duplicate, missing and asymmetric endpoints', () => {
  let seed = 47
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  for (let fixture = 0; fixture < 200; fixture++) {
    const pins = Array.from({ length: 60 }, (_, i) => pin(String(i), 'node' + random(10), String(random(4)), random(2) ? 'input' : 'output',
      Array.from({ length: random(4) }, () => ({ nodeName: 'node' + random(12), pinID: String(random(5)) }))))
    const original = { _pins: [...pins], _controls: [] }
    Scene.prototype.createConnectionLines.call(original)
    const edges = []
    const remaining = connectBlueprintPins(pins, 'output', (a, b) => edges.push([a.label, b.label]), a => edges.push([a.label]))
    expect(edges).toEqual(original._controls.map(control => control.edge))
    expect(remaining.map(p => p.label)).toEqual(original._pins.map(p => p.label))
  }
})

test('large graph wire lookup work grows linearly with pin count', () => {
  const measure = count => {
    let reads = 0, connections = 0, partials = 0
    const pins = []
    for (let i = 0; i < count; i++) {
      const output = pin('o' + i, 'source' + i, 'out', 'output', [{ nodeName: 'target' + i, pinID: 'in' }])
      const input = pin('i' + i, 'target' + i, 'in', 'input', [{ nodeName: 'source' + i, pinID: 'out' }])
      for (const p of [output, input]) {
        const name = p.pinProperty.nodeName
        Object.defineProperty(p.pinProperty, 'nodeName', { get() { reads++; return name } })
        pins.push(p)
      }
    }
    connectBlueprintPins(pins, 'output', () => connections++, () => partials++)
    expect(connections).toBe(count); expect(partials).toBe(0)
    expect(reads).toBeLessThan(count * 20)
    return reads
  }
  const small = measure(1000), large = measure(10000)
  expect(large).toBeLessThanOrEqual(small * 10)
})
