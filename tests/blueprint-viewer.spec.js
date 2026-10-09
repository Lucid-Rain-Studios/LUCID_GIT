const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { execFileSync } = require('node:child_process')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
const helper = path.join(root, 'tools/BlueprintExtractor/bin/Release/net10.0')
const fixture = path.join(root, 'third_party/UAssetAPI/UAssetAPI.Tests/TestAssets/TestEditorAssets/TestActorBP.uasset')
const { BlueprintRevisionService } = require(path.join(DIST, 'services/BlueprintRevisionService'))
const read = file => JSON.parse(execFileSync('dotnet', [path.join(helper, 'BlueprintExtractor.dll'), file], { encoding: 'utf8', windowsHide: true }))
test.afterAll(cleanup)

test('UE 5.8 localized text keeps pin fields aligned and rejects truncated notes', () => {
  const output = execFileSync('dotnet', ['run', '--project', path.join(root, 'tests/blueprint-reader/ReaderTests.csproj'), '-c', 'Release', '--verbosity', 'quiet', '--', fixture], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
  expect(output).toContain('5 localized-text alignment checks passed.')
  expect(output).toContain('8 native cast/pin retention checks passed.')
})



test('old cached graphs are re-extracted and an outdated helper is rejected', async () => {
  const cache = tmpDir('lg-blueprint-version-cache-'), key = 'old-document'
  fs.writeFileSync(path.join(cache, key + '.json'), JSON.stringify({ schemaVersion: 1, readerVersion: 5, status: 'complete', graphs: [], diagnostics: [] }))
  const reader = new BlueprintRevisionService(helper, cache)
  const document = await reader.extract(key, fixture)
  expect(document.readerVersion).toBe(6)
  expect(document.graphs.length).toBeGreaterThan(0)
  expect(JSON.parse(fs.readFileSync(path.join(cache,key + '.json'),'utf8')).readerVersion).toBe(6)
  const stale = { ...document, graphs: [] }
  reader.cache.set(key, stale)
  fs.writeFileSync(path.join(cache,key + '.json'),JSON.stringify(stale))
  expect((await reader.extract(key,fixture)).graphs).toHaveLength(0)
  expect((await reader.extract(key,fixture,true)).graphs.length).toBeGreaterThan(0)
  const { component } = require('./renderer-harness')
  const { BlueprintRevisionService: OldReader } = component('electron/services/BlueprintRevisionService.ts', {
    electron: { app: { getPath: () => cache } },
    'node:child_process': { execFile: (_, __, ___, callback) => {
      setImmediate(() => callback(null, JSON.stringify({ schemaVersion: 1, readerVersion: 5, graphs: [] }), ''))
      return { kill() {} }
    } },
  }, { process, Buffer, __dirname: path.join(root, 'electron/services') }).exports
  const outdated = new OldReader(helper, tmpDir('lg-blueprint-old-helper-'))
  await expect(outdated.extract('old-helper', fixture)).rejects.toThrow('installed Blueprint reader is outdated')
})

test('reader preserves saved identities, positions and reciprocal pins without modifying input', () => {
  const before = fs.readFileSync(fixture), document = read(fixture)
  expect(document.status).toBe('complete')
  expect(document.graphs.map(g => g.nodes.length)).toEqual([3, 1])
  expect(document.graphs.flatMap(g => g.nodes).every(n => /^[A-F0-9]{32}$/.test(n.id))).toBe(true)
  expect(document.graphs.flatMap(g => g.nodes).flatMap(n => n.pins)).toHaveLength(9)
  for (const node of document.graphs.flatMap(g => g.nodes)) for (const id of [node.id, ...node.pins.map(p => p.id)]) {
    const wire = Buffer.alloc(16)
    for (let part = 0; part < 4; part++) wire.writeUInt32LE(parseInt(id.slice(part * 8, part * 8 + 8), 16), part * 4)
    expect(before.includes(wire)).toBe(true)
  }
  expect(fs.readFileSync(fixture).equals(before)).toBe(true)
  const modernPath = path.join(root, 'third_party/UAssetAPI/UAssetAPI.Tests/TestAssets/TestEditorUE5_7/Blueprints/BP_FirstPersonCharacter.uasset')
  const modernBytes = fs.readFileSync(modernPath), modern = read(modernPath)
  expect(modern.status).toBe('complete'); expect(modern.engineVersion).toBe('5.7.4')
  let connections = 0
  for (const graph of modern.graphs) for (const node of graph.nodes) for (const pin of node.pins) for (const link of pin.links) {
    const target = graph.nodes.find(n => n.id === link.node).pins.find(p => p.id === link.pin)
    expect(target.links.some(l => l.node === node.id && l.pin === pin.id)).toBe(true)
    connections++
  }
  expect(connections).toBe(70)
  expect(fs.readFileSync(modernPath).equals(modernBytes)).toBe(true)
})

test('exact root, rename, index, working and deletion sides; concurrent caching and validation', async () => {
  const repo = tmpDir('lg-blueprint-'), cache = tmpDir('lg-blueprint-cache-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.copyFileSync(fixture, path.join(repo, 'Old name.uasset'))
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'root')
  const first = git(repo, 'rev-parse', 'HEAD').trim()
  const service = new BlueprintRevisionService(helper, cache)
  const compare = (leftRef, rightRef, filePath = 'Old name.uasset', oldPath) => service.compare(repo, { leftRef, rightRef, filePath, oldPath, requestId: 'test' })
  const initial = await compare('ABSENT', first)
  expect(initial.left.status).toBe('absent'); expect(initial.right.document.status).toBe('complete')
  git(repo, 'mv', 'Old name.uasset', 'New name.uasset'); git(repo, 'commit', '-qm', 'rename')
  const second = git(repo, 'rev-parse', 'HEAD').trim()
  const renamed = await compare(first, second, 'New name.uasset', 'Old name.uasset')
  expect(renamed.left.contentHash).toBe(renamed.right.contentHash)
  expect(renamed.right.ref).toBe(second)
  const staged = await compare('HEAD', 'INDEX', 'New name.uasset')
  expect(staged.left.ref).toBe('HEAD'); expect(staged.right.ref).toBe('INDEX')
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => compare('INDEX', 'WORKING', 'New name.uasset')))
  expect(concurrent.every(r => r.right.document.status === 'complete')).toBe(true)
  expect(fs.readdirSync(cache).filter(f => f.endsWith('.json'))).toHaveLength(1)
  const extract = service.extract.bind(service); let forcedExtractions = 0
  service.extract = (...args) => { if (args[2]) forcedExtractions++; return extract(...args) }
  const refreshed = await service.compare(repo, { filePath: 'New name.uasset', leftRef: 'INDEX', rightRef: 'WORKING', requestId: 'retry', force: true })
  expect(refreshed.left.document.status).toBe('complete'); expect(refreshed.right.document.status).toBe('complete')
  expect(forcedExtractions).toBe(1) // Identical sides share one deliberate refresh.
  fs.writeFileSync(path.join(repo, 'New name.uasset'), 'malformed')
  const bad = await compare('INDEX', 'WORKING', 'New name.uasset')
  expect(bad.left.status).toBe('ready'); expect(bad.right.status).toBe('unavailable')
  fs.unlinkSync(path.join(repo, 'New name.uasset'))
  expect((await compare('INDEX', 'WORKING', 'New name.uasset')).right.status).toBe('absent')
  await expect(compare('HEAD', 'WORKING', '../escape.uasset')).rejects.toThrow('repository-relative')
  await expect(compare('--help', 'WORKING')).rejects.toThrow('Invalid Blueprint revision')
  const controller = new AbortController(); controller.abort()
  await expect(service.compare(repo, { filePath: 'New name.uasset', leftRef: 'HEAD', rightRef: 'WORKING', requestId: 'cancel' }, controller.signal)).rejects.toThrow('cancelled')
})

test('LFS pointers resolve exact local content without modifying pointer, index or worktree', async () => {
  const repo = tmpDir('lg-blueprint-lfs-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'lfs', 'install', '--local'); git(repo, 'lfs', 'track', '*.uasset')
  fs.copyFileSync(fixture, path.join(repo, 'BP_Test.uasset')); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'asset')
  const pointer = git(repo, 'show', 'HEAD:BP_Test.uasset')
  fs.writeFileSync(path.join(repo, 'BP_Test.uasset'), pointer)
  const before = git(repo, 'status', '--porcelain'), index = git(repo, 'write-tree')
  const service = new BlueprintRevisionService(helper, tmpDir('lg-blueprint-lfs-cache-'))
  const result = await service.compare(repo, { filePath: 'BP_Test.uasset', leftRef: 'HEAD', rightRef: 'WORKING', requestId: 'lfs' })
  expect(result.left.document.status).toBe('complete'); expect(result.right.document.status).toBe('complete')
  expect(result.left.contentHash).toBe(result.right.contentHash)
  expect(fs.readFileSync(path.join(repo, 'BP_Test.uasset'), 'utf8')).toBe(pointer)
  expect(git(repo, 'status', '--porcelain')).toBe(before); expect(git(repo, 'write-tree')).toBe(index)
})

test('CPU extraction releases the repository slot before a write needs it', async () => {
  const repo = tmpDir('lg-blueprint-gate-')
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.com')
  fs.copyFileSync(fixture, path.join(repo, 'BP_Test.uasset')); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'asset')
  const service = new BlueprintRevisionService(helper, tmpDir('lg-blueprint-gate-cache-'))
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), paused = new Promise(resolve => { release = resolve })
  const original = service.extract.bind(service)
  service.extract = async (...args) => { entered(); await paused; return original(...args) }
  const reading = service.compare(repo, { filePath: 'BP_Test.uasset', leftRef: 'ABSENT', rightRef: 'HEAD', requestId: 'gate' })
  await started
  const { withRepoSlot } = require(path.join(DIST, 'util/repo-gate'))
  let timeout
  try {
    await Promise.race([withRepoSlot(repo, 'write', async () => { release() }), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Reader retained the repository slot during CPU extraction.')), 2000) })])
  } finally { clearTimeout(timeout); release() }
  expect((await reading).right.document.status).toBe('complete')
})

test('real Klee canvas renders, pans, inspects and expands read-only without browser errors', async ({ page }) => {
  const dir = tmpDir('lg-blueprint-browser-'), document = read(process.env.BLUEPRINT_ACCEPTANCE_ASSET || path.join(root, 'third_party/UAssetAPI/UAssetAPI.Tests/TestAssets/TestEditorUE5_7/Blueprints/BP_FirstPersonCharacter.uasset'))
  const baseDocument = process.env.BLUEPRINT_ACCEPTANCE_BASE_ASSET ? read(process.env.BLUEPRINT_ACCEPTANCE_BASE_ASSET) : document
  const modified = structuredClone(document)
  modified.graphs.find(g => g.name === 'EventGraph').nodes[0].x += 160
  const result = { left: { ref: 'HEAD', path: 'BP_Test.uasset', status: 'ready', document: baseDocument }, right: { ref: 'WORKING', path: 'BP_Test.uasset', status: 'ready', document: modified } }
  await require('esbuild').build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BlueprintDiff} from './src/components/diff/BlueprintDiff'; import './src/index.css'; createRoot(document.getElementById('root')).render(<BlueprintDiff files={[{path:"BP_Test.uasset",onSelect:()=>{}},{path:"Other.uasset",onSelect:()=>{window.chosenFile="Other.uasset"}}]} project={{name:"Test Project",engineVersion:"5.7",uprojectPath:"test/Game.uproject"}} repoPath="test" request={{filePath:'BP_Test.uasset',leftRef:'HEAD',rightRef:'WORKING'}} onFallback={()=>{window.fallback=true}}/>);`, resolveDir: root, loader: 'tsx' }, alias: { '@': path.join(root, 'src') }, outfile: path.join(dir, 'app.js'), bundle: true, format: 'esm' })
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.lucidGit=new Proxy({blueprintCompare:async()=>(${JSON.stringify(result)}),blueprintCancel:async()=>{}},{get:(o,k)=>o[k]||(()=>{})})</script><script type="module" src="/app.js"></script></html>`); return }
    const target = req.url === '/blueprint/klee.js' ? path.join(root, 'public/blueprint/klee.js') : path.join(dir, req.url.slice(1))
    if (!fs.existsSync(target)) { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(target))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await page.addInitScript(() => {
    window.wireDraws = 0
    const segments = new WeakMap(), curve = CanvasRenderingContext2D.prototype.bezierCurveTo, fill = CanvasRenderingContext2D.prototype.fillRect
    window.getWireCount = canvas => segments.get(canvas)?.size ?? 0
    CanvasRenderingContext2D.prototype.fillRect = function(x,y,w,h) {
      if (x === 0 && y === 0 && w === this.canvas.clientWidth && h === this.canvas.clientHeight) segments.set(this.canvas,new Set())
      return fill.call(this,x,y,w,h)
    }
    CanvasRenderingContext2D.prototype.bezierCurveTo = function(...args) {
      if (this.lineWidth === 1.5 || this.lineWidth === 2.5) { window.wireDraws++; segments.get(this.canvas)?.add(args.join(',')) }
      return curve.apply(this,args)
    }
  })
  const errors = []; page.on('pageerror', e => { errors.push(e.message); console.log('Browser error:', e.message) })
  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
  await expect(page.getByText('Test Project � UE 5.7 � Read-only revision review')).toBeVisible()
  await expect(page.getByText('Test Project � UE 5.7 � Read-only revision review')).toHaveAttribute('title', /test\/Game\.uproject/)
    await expect(page.getByText('Views synchronized')).toBeVisible()
    await expect(page.locator('.bp-empty')).toHaveCount(0)
    await page.waitForTimeout(500)
    expect(errors).toEqual([])
    expect(await page.evaluate(() => window.wireDraws)).toBeGreaterThan(0)
    for (const [index, doc] of [baseDocument, document].entries()) {
      const eventGraph = doc.graphs.find(g => g.name === 'EventGraph')
      const connections = new Set(eventGraph.nodes.flatMap(n => n.pins.flatMap(p => p.links.filter(l => l.node).map(l => [n.id + ':' + p.id, l.node + ':' + l.pin].sort().join('|')))))
      await expect.poll(() => page.locator('canvas').nth(index).evaluate(c => window.getWireCount(c))).toBe(connections.size)
    }
    await page.getByLabel('Choose Blueprint graph or file').click()
    const graphMenu = page.getByRole('combobox', { name: 'Blueprint graph', exact: true })
    const otherGraph = document.graphs.find(g => g.name !== 'EventGraph').name
    await graphMenu.selectOption({ label: otherGraph })
    await expect(page.locator('.bp-active-graph')).toHaveText(otherGraph)
    await page.getByLabel('Choose Blueprint graph or file').click()
    await expect(graphMenu.locator('option').filter({ hasText: /^EventGraph/ })).toHaveText(/EventGraph \(\d+ changes?\)/)
    await graphMenu.selectOption(await graphMenu.locator('option').filter({ hasText: /^EventGraph/ }).getAttribute('value'))
    expect(await page.getByRole('dialog').count()).toBe(0)
    if (process.env.BLUEPRINT_SCREENSHOT_EMBEDDED) { await page.getByLabel('Choose Blueprint graph or file').click(); await page.screenshot({ path: process.env.BLUEPRINT_SCREENSHOT_EMBEDDED }); await page.keyboard.press('Escape') }
    expect(await page.locator('canvas').first().evaluate(c => c.width)).toBeGreaterThan(100)
    await page.getByRole('button', { name: 'Toggle node inspector' }).click()
    await expect(page.getByText('Saved layout changed')).toBeVisible()
    await page.getByText('Saved layout changed').click()
    await expect(page.getByText('Serialized node data decoded.')).toBeVisible()
    const before = await page.locator('canvas').first().evaluate(c => c.toDataURL())
    await page.locator('canvas').first().hover(); await page.mouse.wheel(0, -150)
    await expect.poll(() => page.locator('canvas').first().evaluate(c => c.toDataURL())).not.toBe(before)
    await page.getByRole('button', { name: 'Full screen', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    if (process.env.BLUEPRINT_SCREENSHOT) await page.screenshot({ path: process.env.BLUEPRINT_SCREENSHOT })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused()
    await expect(page.getByText('Saved layout changed')).toBeVisible()
    await page.getByRole('button', { name: 'Binary details', exact: true }).click()
    expect(await page.evaluate(() => window.fallback)).toBe(true)
    expect(errors).toEqual([])
    await page.getByRole('button', { name: 'Toggle node inspector' }).click()
    await page.setViewportSize({ width: 560, height: 640 })
    await expect(page.getByRole('button', { name: 'Full screen', exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.setViewportSize({ width: 560, height: 400 })
    await page.getByLabel('Choose Blueprint graph or file').click()
    await expect(graphMenu).toBeVisible()
    await page.getByRole('combobox', { name: 'Blueprint file', exact: true }).selectOption('1')
    expect(await page.evaluate(() => window.chosenFile)).toBe('Other.uasset')
  } finally { await new Promise(resolve => server.close(resolve)) }
})


test('Klee draws compiler errors only for an active saved compiler message', async ({ page }) => {
  const { graphText } = require('./renderer-harness').component('src/lib/blueprintGraph.ts').exports
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/' ? 'text/html' : 'text/javascript')
    res.end(req.url === '/' ? '<canvas style="width:600px;height:400px"></canvas>' : fs.readFileSync(path.join(root, 'public/blueprint/klee.js')))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    for (const flag of [undefined, false, true]) {
      const properties = { ErrorType: 1, ErrorMsg: '', ...(flag === undefined ? {} : { bHasCompilerMessage: flag }) }
      const text = graphText({ nodes: [{ classPath: '/Script/BlueprintGraph.K2Node_VariableGet', name: 'K2Node_VariableGet_0', id: 'A'.repeat(32), x: 0, y: 0, properties, pins: [] }] })
      const labels = await page.evaluate(async text => {
        window.compilerCanvas?.destroy()
        const labels = [], original = CanvasRenderingContext2D.prototype.fillText
        CanvasRenderingContext2D.prototype.fillText = function(label, ...args) { labels.push(label); return original.call(this, label, ...args) }
        try {
          const { createKleeCanvas } = await import('/klee.js')
          window.compilerCanvas = createKleeCanvas(document.querySelector('canvas'), text)
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          return labels
        } finally { CanvasRenderingContext2D.prototype.fillText = original }
      }, text)
      expect(labels.includes('ERROR!')).toBe(flag === true)
    }
  } finally { await new Promise(resolve => server.close(resolve)) }
})
