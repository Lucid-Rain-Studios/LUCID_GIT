const fs = require('fs')
const path = require('path')
const vm = require('vm')
const ts = require('typescript')

// Exercise component callbacks with deterministic hook state and controlled IPC.
// Effects and rerenders are explicit so response order can be tested without Electron.
function component(file, mocks = {}, globals = {}) {
  const slots = [], effects = [], refs = []
  let cursor = 0, refCursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: 'fragment',
    useState: initial => {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef: initial => { const index = refCursor++; return refs[index] ||= { current: initial } },
    useEffect: effect => { effects.push(effect) },
    useMemo: fn => fn(),
    useCallback: fn => fn,
  }
  const module = { exports: {} }
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText
  const exposed = (globals.__privateExports ?? []).map(name => {
    if (!/^[A-Za-z]+$/.test(name)) throw Error('Invalid test export')
    return `\nmodule.exports.${name} = ${name};`
  }).join('')
  vm.runInNewContext(source + exposed, {
    module, exports: module.exports,
    require: name => name === 'react' ? React : mocks[name] || (
      ['../util/network', '../util/git-paths', '../util/json-store', '@/lib/staging'].includes(name)
        ? component(name === '@/lib/staging' ? 'src/lib/staging.ts' : 'electron/util/' + name.split('/').pop() + '.ts', {}, globals).exports
        : name.startsWith('node:') || ['fs', 'path', 'crypto'].includes(name) ? require(name)
        : name === '@/lib/utils' ? { cn: (...args) => args.filter(Boolean).join(' ') } : new Proxy({}, { get: (_, key) => key })),
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { addEventListener() {}, removeEventListener() {} },
    navigator: { clipboard: { writeText() {} } },
    localStorage: { getItem() { return null }, setItem() {}, removeItem() {} },
    window: { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    ...globals,
  }, { filename: file })
  return {
    exports: module.exports, slots, effects,
    render(name, props) { cursor = 0; refCursor = 0; effects.length = 0; return module.exports[name](props) },
  }
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child, predicate); if (found) return found } }
  else { if (predicate(tree)) return tree; return find(tree.props?.children, predicate) }
  return null
}
const store = state => Object.assign(selector => selector ? selector(state) : state, { getState: () => state })
module.exports = { component, find, store }
