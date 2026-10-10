const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { execFileSync } = require('node:child_process')
const { DIST, git, tmpDir, cleanup } = require('./helpers')
const { gitService } = require(path.join(DIST, 'services/GitService'))
const root = path.resolve(__dirname, '..')
test.afterAll(cleanup)

test('PR text review compares both pinned tips, preserves renames and handles additions/deletions', async () => {
  const dir = tmpDir('lg-pr-file-review-')
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.name', 'Test'); git(dir, 'config', 'user.email', 'test@example.com'); git(dir, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(dir, 'old [name].txt'), 'original\n'.repeat(12))
  fs.writeFileSync(path.join(dir, 'deleted.txt'), 'removed\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'base')
  const base = git(dir, 'rev-parse', 'HEAD').trim()
  git(dir, 'checkout', '-qb', 'feature')
  git(dir, 'mv', 'old [name].txt', 'new [name].txt')
  fs.writeFileSync(path.join(dir, 'new [name].txt'), 'original\n'.repeat(12) + 'first edit\n')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'first')
  fs.appendFileSync(path.join(dir, 'new [name].txt'), 'second edit\n')
  fs.writeFileSync(path.join(dir, 'added.txt'), 'added\n'); git(dir, 'rm', 'deleted.txt')
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'second')
  const head = git(dir, 'rev-parse', 'HEAD').trim()
  const summary = await gitService.branchDiff(dir, base, head)
  expect(summary.files.find(f => f.path === 'new [name].txt')).toMatchObject({ status: 'R', oldPath: 'old [name].txt' })
  git(dir, 'checkout', '-q', 'main')
  const before = { head: git(dir, 'rev-parse', 'HEAD'), index: fs.readFileSync(path.join(dir, '.git/index')), file: fs.readFileSync(path.join(dir, 'old [name].txt')) }
  const diff = await gitService.diffCommit(dir, 'new [name].txt', head, base, 'old [name].txt')
  expect(diff.oldContent).toBe('original\n'.repeat(12)); expect(diff.newContent).toContain('first edit\nsecond edit\n')
  expect(await gitService.diffCommit(dir, 'added.txt', head, base)).toMatchObject({ oldContent: '', newContent: 'added\n' })
  expect(await gitService.diffCommit(dir, 'deleted.txt', head, base)).toMatchObject({ oldContent: 'removed\n', newContent: '' })
  await expect(gitService.diffCommit(dir, 'added.txt', '1'.repeat(40), base)).rejects.toThrow('Reviewed commit is unavailable')
  expect(git(dir, 'rev-parse', 'HEAD')).toBe(before.head); expect(fs.readFileSync(path.join(dir, '.git/index'))).toEqual(before.index); expect(fs.readFileSync(path.join(dir, 'old [name].txt'))).toEqual(before.file)
})

async function reviewServer() {
  const dir = tmpDir('lg-pr-review-browser-')
  const fixture = path.join(root, 'third_party/UAssetAPI/UAssetAPI.Tests/TestAssets/TestEditorAssets/TestActorBP.uasset')
  const document = JSON.parse(execFileSync('dotnet', [path.join(root, 'tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll'), fixture], { encoding: 'utf8', windowsHide: true }))
  const incoming = structuredClone(document); incoming.graphs[0].nodes[0].x += 100
  await require('esbuild').build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ResolveDialog} from './src/components/overview/OverviewPanel';import {useRepoStore} from './src/stores/repoStore';import './src/index.css';useRepoStore.setState({repoPath:'test',currentBranch:'unrelated',refreshStatus:async()=>{}});createRoot(document.getElementById('root')).render(<ResolveDialog pr={{number:20,title:'Better Hand Motions',headBranch:'dev_Jake',baseBranch:'main',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),author:'jacoblauriecontact-debug'}} ghSlug='org/repo' repoPath='test' onClose={()=>window.closedReview++} onDone={result=>window.done=result}/>);`, resolveDir: root, loader: 'tsx' }, alias: { '@': path.join(root, 'src') }, outfile: path.join(dir, 'app.js'), bundle: true, format: 'esm' })
  const setup = `
    window.calls=[];window.closedReview=0;window.logCount=0;
    const file=path=>({path,status:'M',additions:0,deletions:0});
    window.lucidGit={
      fetch:async()=>{},
      mergePreview:async()=>['Content/animations/ABP_Hazmat.uasset','Content/mesh/SK_Hazmat.uasset'].map(path=>({path,type:'ue-asset',conflictType:'binary'})),
      branchDiff:async()=>({aheadCommits:[{hash:'a'.repeat(40),message:'Better Hand Motions',author:'jacoblauriecontact-debug'}],files:['Content/DataAssets/DA_Box.uasset','Content/animations/ABP_Hazmat.uasset','Content/mesh/SK_Hazmat.uasset','first.txt','second.txt'].map(file),totalAdditions:0,totalDeletions:0}),
      blueprintCompare:async(repo,request)=>{window.calls.push(['graph',request]);const doc=request.filePath.includes('DA_Box')?{status:'unsupported',assetClass:'/Script/Engine.DataAsset',graphs:[],diagnostics:['No editor Blueprint graph.']}:request.rightRef==='ABSENT'?null:${JSON.stringify(incoming)};return {left:{ref:request.leftRef,path:request.oldPath||request.filePath,status:'ready',document:doc?.status==='unsupported'?doc:${JSON.stringify(document)}},right:{ref:request.rightRef,path:request.filePath,status:'ready',document:doc}}},
      blueprintCancel:async()=>{},assetRenderThumbnail:async()=>null,
      assetExtractMetadata:async(...args)=>{window.calls.push(['metadata',...args]);return {AssetClass:'Animation Blueprint',SizeBytes:'184000'}},
      gitFileLog:async(...args)=>{window.calls.push(['history',...args]);return []},
      gitCommitFileDiff:async(...args)=>{window.calls.push(['text',...args]);if(args[1]==='first.txt')return new Promise(resolve=>window.resolveFirst=()=>resolve({oldContent:'first old',newContent:'first stale',language:'plaintext'}));return {oldContent:'second old',newContent:'second current',language:'plaintext'}},
      checkout:async(...args)=>window.calls.push(['checkout',...args]),log:async()=>[{hash:(window.logCount++?'c':'a').repeat(40)}],
      merge:async()=>{throw Error('automatic merge failed: conflict')},mergeResolveText:async(...args)=>window.calls.push(['resolve',...args]),mergeContinue:async()=>{},push:async()=>{},mergeInProgress:async()=>null,
      githubMergePR:async args=>window.calls.push(['mergePR',args]),githubClosePR:async args=>window.calls.push(['closePR',args]),
      openExternal:async url=>window.calls.push(['external',url]),openPath:async()=>{},showInFolder:async()=>{},logRendererEvent:async()=>{},notifyDesktop:async()=>{},forecastPause:async()=>{},forecastResume:async()=>{}
    };
  `
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;background:#090c11}</style><div id="root"></div><script>${setup}</script><script type="module" src="/app.js"></script></html>`); return }
    const target = req.url === '/blueprint/klee.js' ? path.join(root, 'public/blueprint/klee.js') : path.join(dir, req.url.slice(1))
    if (!fs.existsSync(target)) { res.writeHead(404); res.end(); return }
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(target))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

test('PR dialog reuses real graph/details, syncs choices, collapses without rereading, and resolves reviewed sides', async ({ page }, testInfo) => {
  const { server, url } = await reviewServer(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') console.log('PR browser:', message.text()) })
  try {
    await page.setViewportSize({ width: 1669, height: 942 }); await page.goto(url)
    const left = page.getByRole('complementary', { name: 'PR changed files' })
    const selected = page.getByRole('region', { name: 'Selected file review' })
    const merge = page.getByRole('button', { name: 'Resolve & Merge', exact: true })
    await expect(page.locator('.bp-revisions canvas')).toHaveCount(2)
    await expect(page.locator('.bp-pane header').first()).toContainText('Current main')
    await expect(merge).toBeDisabled()
    expect(await page.evaluate(() => window.calls.filter(c => c[0] === 'graph').map(c => [c[1].leftRef,c[1].rightRef]))).toEqual([['b'.repeat(40),'a'.repeat(40)]])
    expect(await page.evaluate(() => window.calls.filter(c => c[0] === 'metadata' || c[0] === 'history'))).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('pr-review-expanded.png') })
    await left.getByRole('button', { name: 'Accept dev_Jake', exact: true }).first().click()
    await expect(selected.getByRole('button', { name: 'Accept dev_Jake', exact: true })).toHaveAttribute('aria-pressed','true')
    await page.getByRole('button', { name: 'Next change', exact: true }).click()
    await page.getByRole('button', { name: 'BP Graph View', exact: true }).click()
    await expect(page.locator('#pr-file-preview')).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('pr-review-collapsed.png') })
    await page.getByRole('button', { name: 'BP Graph View', exact: true }).click()
    await expect(page.locator('.bp-revisions canvas').first()).toBeVisible()
    expect(await page.evaluate(() => window.calls.filter(c => c[0] === 'graph').length)).toBe(1)
    await selected.getByRole('button', { name:'Details', exact:true }).click()
    await expect(page.getByText('File History', {exact:true})).toBeVisible()
    expect(await page.evaluate(() => window.calls.filter(c => c[0] === 'metadata').at(-1).slice(1))).toEqual(['test','Content/animations/ABP_Hazmat.uasset','a'.repeat(40)])
    await selected.getByRole('button', { name:'Back to preview',exact:true }).click()
    expect(await page.evaluate(() => window.calls.filter(c => c[0] === 'graph').length)).toBe(1)
    await selected.getByRole('button', { name:'Selected file actions' }).click()
    await expect(page.getByRole('button',{name:'Open Blueprint graph',exact:true})).toBeVisible()
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => window.closedReview)).toBe(0)
    await expect(selected.getByRole('button', { name:'Selected file actions' })).toBeFocused()
    await left.locator('.pr-review-file-select').filter({hasText:'SK_Hazmat.uasset'}).click({button:'right'})
    await page.getByRole('button',{name:'View on GitHub',exact:true}).click()
    expect(await page.evaluate(() => window.calls.filter(c=>c[0]==='external').at(-1)[1])).toContain('/'+'a'.repeat(40)+'/Content/mesh/SK_Hazmat.uasset')
    await left.getByRole('button',{name:'Keep main',exact:true}).nth(1).click()
    await expect(merge).toBeEnabled()
    await merge.click()
    await expect.poll(()=>page.evaluate(()=>window.done)).toEqual({prNumber:20,action:'accept'})
    expect(await page.evaluate(()=>window.calls.filter(c=>c[0]==='resolve'))).toEqual([
      ['resolve','test','Content/animations/ABP_Hazmat.uasset','ours'],['resolve','test','Content/mesh/SK_Hazmat.uasset','theirs'],
    ])
    expect(await page.evaluate(()=>window.calls.find(c=>c[0]==='mergePR')[1].expectedSha)).toBe('c'.repeat(40))
    expect(errors).toEqual([])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('PR file switching ignores stale text responses and unsupported assets keep the shared binary fallback', async ({page}) => {
  const {server,url}=await reviewServer()
  try {
    await page.goto(url)
    const left=page.getByRole('complementary',{name:'PR changed files'})
    await expect(page.locator('.bp-revisions canvas')).toHaveCount(2)
    await left.locator('.pr-review-file-select').filter({hasText:'DA_Box.uasset'}).click()
    await expect(page.getByText('Asset class: /Script/Engine.DataAsset.',{exact:false})).toBeVisible()
    await expect(page.getByRole('button',{name:'Binary details',exact:true})).toBeVisible()
    await left.locator('.pr-review-file-select').filter({hasText:'first.txt'}).click()
    await expect.poll(()=>page.evaluate(()=>typeof window.resolveFirst)).toBe('function')
    await left.locator('.pr-review-file-select').filter({hasText:'second.txt'}).click()
    await expect(page.locator('.monaco-diff-editor')).toBeVisible()
    await page.evaluate(()=>window.resolveFirst())
    await expect.poll(async()=> (await page.locator('.pr-review-preview').innerText()).replace(/\u00a0/g,' ')).toContain('second current')
    expect((await page.locator('.pr-review-preview').innerText()).replace(/\u00a0/g,' ')).not.toContain('first stale')
    await page.setViewportSize({width:560,height:640})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
})
