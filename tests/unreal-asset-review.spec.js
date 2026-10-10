const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { execFileSync } = require('node:child_process')
const { component } = require('./renderer-harness')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
const helper = path.join(root, 'tools/BlueprintExtractor/bin/Release/net10.0')
const fixture = path.join(root, 'third_party/UAssetAPI/UAssetAPI.Tests/TestAssets/TestEditorAssets/TestMaterial.uasset')
const read = file => JSON.parse(execFileSync('dotnet', [path.join(helper, 'BlueprintExtractor.dll'), file], { encoding: 'utf8', windowsHide: true }))
const { assetChanges, propertyChanges } = component('src/lib/unrealAssetReview.ts').exports
const object = (path, properties = {}) => ({ id: '', path, name: path, classPath: '/Script/Engine.Actor', outer: 'Level', properties, decoded: true, opaqueHash: '', opaqueBytes: 0, diagnostics: [] })
const side = objects => ({ status: 'ready', document: { assetReview: { objects } } })
test.afterAll(cleanup)

test('saved property comparison preserves absent defaults, stable identities and opaque limits', () => {
  expect(propertyChanges({ value: { A: 1, B: 2 } }, { value: { B: 2, A: 1 } })).toEqual([])
  expect(propertyChanges({}, { value: 0 })[0]).toMatchObject({ beforePresent: false, afterPresent: true, after: 0 })
  const a = { ...object('Old', { Location: { X: 1 } }), id: 'stable' }
  const b = { ...object('New', { Location: { X: 2 } }), id: 'stable', opaqueHash: 'changed' }
  const changes = assetChanges({ left: side([a]), right: side([b, object('Added')]) })
  expect(changes.map(item => item.kind)).toEqual(['modified', 'added'])
  expect(changes[0].properties.map(item => item.path)).toEqual(['Object path', 'Location.X'])
  expect(changes[0].opaqueChanged).toBe(true)
  const rawChange = assetChanges({ left: side([{ ...a, opaqueProperties: ['Raw'], properties: { Raw: 'AAAA' } }]), right: side([{ ...a, opaqueProperties: ['Raw'], properties: { Raw: 'BBBB' } }]) })[0]
  expect(rawChange.properties).toEqual([]); expect(rawChange.opaqueChanged).toBe(true)
  expect(assetChanges({ left: { status: 'unavailable' }, right: side([b]) })).toEqual([])
  expect(assetChanges({ left: side([{ ...a, decoded: false }]), right: side([b]) })[0].kind).toBe('unknown')
  expect(assetChanges({ left: side([a, { ...a, path: 'Duplicate' }]), right: side([b]) }).every(item => item.kind === 'unknown')).toBe(true)
})

test('reader exposes real material contents and accepts umap revision captures without modifying repository state', async () => {
  const bytes = fs.readFileSync(fixture), document = read(fixture)
  expect(document.assetReview.objects.find(item => item.name === 'TestMaterial').properties).toHaveProperty('BaseColor')
  expect(document.assetReview.coverage.join(' ')).toContain('not interpreted')
  expect(fs.readFileSync(fixture)).toEqual(bytes)
  const repo = tmpDir('lg-asset-review-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  // Extension acceptance is independent of serialized class; never infer World from .umap.
  fs.writeFileSync(path.join(repo, 'Package.umap'), bytes); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture')
  const status = git(repo, 'status', '--porcelain'), index = fs.readFileSync(path.join(repo, '.git/index'))
  const { BlueprintRevisionService } = require(path.join(DIST, 'services/BlueprintRevisionService'))
  const service = new BlueprintRevisionService(helper, tmpDir('lg-asset-review-cache-'))
  const result = await service.compare(repo, { filePath: 'Package.umap', leftRef: 'HEAD', rightRef: 'WORKING' })
  expect(result.right.status, result.right.reason).toBe('ready')
  expect(result.right.document.assetClass).toBe('/Script/Engine.Material')
  expect(assetChanges(result)).toEqual([])
  expect(fs.readFileSync(path.join(repo, '.git/index'))).toEqual(index)
  expect(git(repo, 'status', '--porcelain')).toBe(status)
})

test('local source map and animation fixture acceptance', () => {
  test.skip(!process.env.UNREAL_REVIEW_MAP || !process.env.UNREAL_REVIEW_ANIMATION, 'Set local source fixtures to verify target engine assets.')
  const map = read(process.env.UNREAL_REVIEW_MAP), animation = read(process.env.UNREAL_REVIEW_ANIMATION)
  expect(map.assetReview.family).toBe('map')
  expect(map.assetReview.objects.some(item => Array.isArray(item.properties.Actors))).toBe(true)
  expect(animation.graphs.find(graph => graph.name === 'AnimGraph').nodes.length).toBeGreaterThan(0)
})

test('shared browser review inspects values, changes, deleted sides, map positions, fullscreen and narrow windows', async ({ page }, testInfo) => {
  const dir = tmpDir('lg-asset-review-browser-'), document = read(fixture)
  const a = object('Level.Component', { RelativeLocation: { RelativeLocation: { X: '+0', Y: 100, Z: 5 } }, Value: 1 })
  const b = { ...a, properties: { ...a.properties, Value: 2 } }
  const doc = { ...document, assetClass: '/Script/Engine.World', assetReview: { ...document.assetReview, family: 'map', objects: [a] } }
  const result = { left: { ...side([a]), ref: 'HEAD', document: doc }, right: { ...side([b]), ref: 'WORKING', document: { ...doc, assetReview: { ...doc.assetReview, objects: [b] } } } }
  await require('esbuild').build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/Test.umap',leftRef:'HEAD',rightRef:'WORKING'}} onFallback={()=>window.fallback=true}/>);`, resolveDir: root, loader: 'tsx' }, alias: { '@': path.join(root, 'src') }, outfile: path.join(dir, 'app.js'), bundle: true, format: 'esm' })
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.calls=[];window.result=${JSON.stringify(result)};window.lucidGit={blueprintCompare:async(_,r)=>{window.calls.push(r);return window.result},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`); return }
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(dir, req.url.slice(1))))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await expect(page.getByText('~ 1 modified')).toBeVisible()
    await page.locator('.uar-row').click()
    await expect(page.locator('.uar-before')).toHaveText('1'); await expect(page.locator('.uar-after')).toHaveText('2')
    await page.getByRole('button', { name: 'Contents', exact: true }).click()
    await page.getByLabel('Filter asset objects').fill('no-match'); await expect(page.locator('.uar-row')).toHaveCount(0)
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await page.getByLabel('Level.Component: X 0, Y 100 cm', { exact: true }).click()
    await expect(page.getByRole('region', { name: 'Saved object details' }).getByText('Level.Component', { exact: true }).first()).toBeVisible()
    await page.getByLabel('Expand asset review').click(); await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape'); await expect(page.getByLabel('Expand asset review')).toBeFocused()
    await page.setViewportSize({ width: 480, height: 640 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('unreal-review-map.png') })
    await page.evaluate(() => { window.result.right = { status: 'absent', ref: 'WORKING' } })
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByText('− 1 removed')).toBeVisible()
    await page.getByRole('button', { name: 'Contents', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Base', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => window.calls.length)).toBe(2)
    await page.evaluate(() => {
      const state = (path, properties) => ({ id: '', path, name: path, classPath: '/Script/StateTreeEditorModule.StateTreeState', outer: 'EditorData', properties, decoded: true, opaqueBytes: 0, opaqueHash: '', diagnostics: [] })
      const inventory = { ...window.result.left.document.assetReview, family: 'statetree', objects: [state('Root', { Name: { Name: 'Idle' }, Children: { 0: 'Child' } }), state('Child', { Name: 'Move', Tasks: ['SavedTask'] })] }
      window.result.right = { ...window.result.left, document: { ...window.result.left.document, assetReview: inventory } }
    })
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.locator('.uar-row').filter({ hasText: 'Root' })).toBeVisible()
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
    await expect(page.getByLabel('Decoded StateTree children').getByText('Idle', { exact: true })).toBeVisible()
    await page.getByLabel('Decoded StateTree children').getByRole('button').filter({ hasText: 'Move' }).click()
    await expect(page.getByRole('region', { name: 'Saved object details' }).getByText('Tasks', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
