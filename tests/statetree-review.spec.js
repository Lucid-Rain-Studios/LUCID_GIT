const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { execFileSync } = require('node:child_process')
const { component } = require('./renderer-harness')
const { tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
const { stateTreeEntries } = component('src/lib/stateTreeReview.ts').exports
const { assetChanges, reviewObjects } = component('src/lib/unrealAssetReview.ts').exports
const id = n => n.toString(16).padStart(32, '0').toUpperCase()
const task = (n, duration) => ({ ID: { ID: id(n) }, Node: { Node: { structType: '/Script/StateTreeModule.StateTreeDelayTask', fields: {} } }, Instance: { Instance: { structType: '/Script/StateTreeModule.StateTreeDelayTaskInstanceData', fields: { Duration: duration } } } })
const object = (path, n, props) => ({ id: id(n), path, name: path.split('.').pop(), classPath: '/Script/StateTreeEditorModule.StateTreeState', outer: path.split('.').slice(0, -1).join('.'), properties: props, decoded: true, opaqueProperties: [], opaqueBytes: 0, opaqueHash: '', diagnostics: [] })
const state = object('Tree.Root', 1, { Name: 'Root', LinkedSubtree: { LinkedSubtree: { ID: { ID: id(2) }, Name: 'Child', LinkType: 'GotoState' } }, Children: ['Tree.Root.Child'], Tasks: [task(3, 1), task(4, 2)], Transitions: [{ ID: { ID: id(5) }, Trigger: 'OnTick', State: { Name: 'Child', ID: { ID: id(2) }, LinkType: 'GotoState' }, Conditions: [task(6, 0)] }] })
const child = object('Tree.Root.Child', 2, { Name: 'Child', Parent: state.path })
const side = objects => ({ ref: 'WORKING', path: 'Tree.uasset', status: 'ready', document: { schemaVersion: 1, readerVersion: 12, assetClass: '/Script/StateTreeModule.StateTree', graphs: [], status: 'unsupported', diagnostics: [], assetReview: { family: 'statetree', objects, coverage: ['Saved editor data only'], cooked: false } } })
test.afterAll(cleanup)

test('authored entry GUIDs preserve task edits/order, transition targets and incomplete fields', () => {
  const right = { ...state, properties: { ...state.properties, Tasks: [task(4, 2), task(3, 10)] } }
  const changes = assetChanges({ left: side([state, child]), right: side([right, child]) })
  expect(changes).toHaveLength(2)
  const edited = changes.find(change => change.left.id === id(3))
  expect(edited.properties.map(field => field.path)).toContain('Instance.Instance.fields.Duration')
  expect(edited.properties.map(field => field.path)).toContain('SavedOrder')
  const entries = stateTreeEntries([state, child]).entries
  expect(entries.find(entry => entry.id === id(5)).properties.TargetResolution).toBe(child.path)
  expect(entries.find(entry => entry.id === id(6)).outer).toContain('Transitions')
  const raw = { ...state, opaqueProperties: ['Tasks'] }
  expect(stateTreeEntries([raw, child]).entries.filter(entry => entry.classPath.endsWith('.Tasks')).every(entry => !entry.decoded)).toBe(true)
  expect(assetChanges({ left: { status: 'unavailable' }, right: side([right]) })).toEqual([])
  const duplicated = { ...right, properties: { ...right.properties, Tasks: [task(3, 1), task(3, 2)] } }
  expect(assetChanges({ left: side([state]), right: side([duplicated]) }).filter(change => change.left?.id === id(3) || change.right?.id === id(3)).every(change => change.kind === 'unknown')).toBe(true)
})

test('authored entry bounds preserve aggregate saved arrays and opaque parameter bags', () => {
  const large = { ...state, properties: { ...state.properties, Tasks: Array.from({ length: 5002 }, (_, i) => task(i + 10, i)) } }
  const { entries, omitted } = stateTreeEntries([large])
  expect(entries).toHaveLength(5000); expect(omitted).toBeGreaterThan(0)
  const changed = { ...large, properties: { ...large.properties, Tasks: [...large.properties.Tasks.slice(0, -1), task(5011, 9000)] } }
  expect(assetChanges({ left: side([large]), right: side([changed]) }).some(change => change.properties.some(field => field.path === 'Tasks'))).toBe(true)
})

test('real saved StateTree preserves arrays, typed tasks and edited copied instance data', () => {
  test.skip(!process.env.UNREAL_REVIEW_STATETREE, 'Set UNREAL_REVIEW_STATETREE to the local ST_Shooter fixture.')
  const file = process.env.UNREAL_REVIEW_STATETREE, bytes = fs.readFileSync(file)
  const read = asset => JSON.parse(execFileSync('dotnet', [path.join(root, 'tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll'), asset], { encoding: 'utf8', windowsHide: true }))
  const before = read(file)
  expect(before.readerVersion).toBe(14); expect(before.assetReview.family).toBe('statetree')
  expect(before.assetReview.objects.filter(item => item.classPath.endsWith('.StateTreeState'))).toHaveLength(15)
  const authored = stateTreeEntries(before.assetReview.objects).entries
  expect(authored.filter(entry => entry.classPath.endsWith('.Tasks'))).toHaveLength(20)
  expect(authored.filter(entry => entry.classPath.endsWith('.Transitions'))).toHaveLength(17)
  expect(authored.some(entry => entry.classPath.endsWith('.Bindings'))).toBe(true)
  const copy = Buffer.from(bytes), needle = Buffer.alloc(4); needle.writeFloatLE(0.1)
  const positions = []; for (let i = 0; (i = bytes.indexOf(needle, i)) >= 0; i += 4) positions.push(i)
  expect(positions).toHaveLength(2)
  const output = path.join(tmpDir('lg-statetree-copy-'), 'ST_Shooter.uasset')
  // The same float also exists in compiled runtime data. Select the occurrence
  // proven by readback to belong to the authored task instance, leaving the other.
  let taskEdits = []
  for (const position of positions) {
    bytes.copy(copy); copy.writeFloatLE(0.2, position); fs.writeFileSync(output, copy)
    const after = read(output)
    const changes = assetChanges({ left: { ...side([]), document: before }, right: { ...side([]), document: after } })
    taskEdits = changes.filter(change => change.left?.classPath.endsWith('.Tasks') && change.properties.some(field => field.path === 'Instance.Instance.fields.Duration'))
    if (taskEdits.length) break
  }
  expect(taskEdits).toHaveLength(1)
  expect(taskEdits.every(change => change.left.id === change.right.id)).toBe(true)
  expect(fs.readFileSync(file)).toEqual(bytes)
})

test('browser expands authored hierarchy, inspects changed tasks and retains revision-side contents', async ({ page }, testInfo) => {
  const dir = tmpDir('lg-statetree-browser-')
  const result = { left: side([state, child]), right: side([{ ...state, properties: { ...state.properties, Tasks: [task(3, 10), task(4, 2)] } }, child]) }
  const missing = object('Tree.Disconnected', 8, { Name: 'Disconnected', Children: ['Tree.Disconnected', 'Missing'] })
  result.left.document.assetReview.objects.push(missing); result.right.document.assetReview.objects.push(missing)
  expect(reviewObjects(result, 'right').filter(entry => entry.classPath.startsWith('/Review/'))).toHaveLength(4)
  await require('esbuild').build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Tree.uasset',leftRef:'HEAD',rightRef:'WORKING'}}/>);`, resolveDir: root, loader: 'tsx' }, alias: { '@': path.join(root, 'src') }, outfile: path.join(dir, 'app.js'), bundle: true, format: 'esm' })
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.calls=[];window.lucidGit={blueprintCompare:async(_,r)=>{window.calls.push(r);return ${JSON.stringify(result)}},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`) }
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(dir, req.url.slice(1))))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByText('3 states · 4 authored entries.', { exact: false })).toBeVisible()
    await page.getByRole('button',{name:'View linked subtree: Child',exact:true}).click()
    await expect(page.locator('.uar-tree')).toContainText('Focused saved subtree: Child')
    await expect(page.getByRole('region',{name:'Saved object details'})).toContainText('Child')
    await expect(page.locator('.uar-tree-heading')).toHaveCount(1)
    await page.screenshot({path:testInfo.outputPath('linked-subtree-preview.png')})
    await page.getByRole('button',{name:'Show whole tree',exact:true}).click()
    await expect(page.locator('.uar-tree-heading')).toHaveCount(3)
    await page.getByRole('button', { name: 'Collapse Root', exact: true }).click()
    await expect(page.locator('.uar-tree-state').filter({ hasText: /^Child/ })).toHaveCount(0)
    await page.getByRole('button', { name: 'Expand Root', exact: true }).click()
    await page.locator('.uar-tree-state').filter({ hasText: 'Task: StateTreeDelayTask' }).first().click()
    await expect(page.getByRole('region', { name: 'Saved object details' })).toContainText('Duration')
    await expect(page.locator('.uar-after')).toContainText('10')
    await page.getByRole('button', { name: 'Contents', exact: true }).click()
    await page.getByLabel('Filter asset objects').fill('DelayTask')
    await expect(page.locator('.uar-row')).toHaveCount(3)
    await page.setViewportSize({ width: 480, height: 640 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.evaluate(() => window.calls.length)).toBe(1)
    expect(errors).toEqual([])
  } finally { await page.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
