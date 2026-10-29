const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
test.afterAll(cleanup)

// HEAD, INDEX and WORKING name different content after a commit, stage or save. The review must re-read
// when a compared side's identity changes, and must not re-read when only unrelated repository ticks arrive.
test('Unreal asset review re-reads moving refs only when their identity changes', async ({ page }) => {
  const dir = tmpDir('lg-blueprint-refresh-')
  const doc = { graphs: [], status: 'unsupported', diagnostics: [], assetClass: '/Script/Engine.World', assetReview: { family: 'map', objects: [], coverage: [], cooked: false } }
  await require('esbuild').build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import {useRepoStore} from './src/stores/repoStore';import './src/index.css';useRepoStore.setState({repoPath:'repo'});const root=createRoot(document.getElementById('root'));window.tick=()=>useRepoStore.setState(s=>({statusTick:s.statusTick+1}));window.show=(leftRef,rightRef)=>root.render(<UnrealAssetReview repoPath="repo" request={{filePath:'Map.umap',leftRef,rightRef}}/>);window.show('HEAD','WORKING');`, resolveDir: root, loader: 'tsx' }, alias: { '@': path.join(root, 'src') }, outfile: path.join(dir, 'app.js'), bundle: true, format: 'esm' })
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html')
      return res.end(`<html><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>
        window.stamp='a';window.stamps=[];window.compares=[];
        window.lucidGit={logRendererEvent:async()=>{},blueprintCancel:async()=>{},
        blueprintStamp:async(repo,request)=>{window.stamps.push(request);return window.stamp},
        blueprintCompare:async(repo,request)=>{window.compares.push(request);return {left:{status:'ready',ref:request.leftRef,document:${JSON.stringify(doc)}},right:{status:'ready',ref:request.rightRef,document:${JSON.stringify(doc)}}}}};
      </script><script type="module" src="/app.js"></script></html>`)
    }
    res.setHeader('Content-Type', 'text/javascript')
    try { res.end(fs.readFileSync(path.join(dir, req.url.slice(1)))) } catch { res.statusCode = 404; res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await expect.poll(() => page.evaluate(() => window.compares.length)).toBe(1)
    // Baseline probe after the first load: no extra read.
    await expect.poll(() => page.evaluate(() => window.stamps.length)).toBe(1)
    // A tick with an unchanged identity probes but never re-reads.
    await page.evaluate(() => window.tick())
    await expect.poll(() => page.evaluate(() => window.stamps.length)).toBe(2)
    await page.waitForTimeout(150)
    expect(await page.evaluate(() => window.compares.length)).toBe(1)
    // A commit, stage or save changes the identity: the same HEAD/WORKING strings are read again.
    await page.evaluate(() => { window.stamp = 'b'; window.tick() })
    await expect.poll(() => page.evaluate(() => window.compares.length)).toBe(2)
    expect(await page.evaluate(() => window.compares.map(request => [request.leftRef, request.rightRef]))).toEqual([['HEAD', 'WORKING'], ['HEAD', 'WORKING']])
    // Immutable commit refs are never probed.
    await page.evaluate(() => window.show('a'.repeat(40) + '^1', 'a'.repeat(40)))
    await expect.poll(() => page.evaluate(() => window.compares.length)).toBe(3)
    const probes = await page.evaluate(() => window.stamps.length)
    await page.evaluate(() => { window.stamp = 'c'; window.tick() })
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.stamps.length)).toBe(probes)
    expect(await page.evaluate(() => window.compares.length)).toBe(3)
    expect(errors).toEqual([])
  } finally { server.close() }
})
