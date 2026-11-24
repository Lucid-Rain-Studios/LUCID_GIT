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

async function reviewServer(background = false) {
  const dir = tmpDir('lg-pr-review-browser-')
  const fixture = path.join(root, 'third_party/UAssetAPI/UAssetAPI.Tests/TestAssets/TestEditorAssets/TestActorBP.uasset')
  const document = JSON.parse(execFileSync('dotnet', [path.join(root, 'tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll'), fixture], { encoding: 'utf8', windowsHide: true }))
  const incoming = structuredClone(document); incoming.graphs[0].nodes[0].x += 100
  const backgroundEntry = `import React from 'react';import {createRoot} from 'react-dom/client';import {OverviewPanel} from './src/components/overview/OverviewPanel';import {PRReviewHost} from './src/components/pr/PRReviewTask';import {usePRReviewStore} from './src/stores/prReviewStore';import {useRepoStore} from './src/stores/repoStore';import {ipc,backgroundTaskIpc} from './src/ipc';import {useBackgroundRepoTaskStore} from './src/stores/backgroundRepoTaskStore';import './src/index.css';
    useRepoStore.setState({repoPath:'test',currentBranch:'main',refreshStatus:async()=>{}});
    window.reviewStore=usePRReviewStore;window.publicIpc=ipc;window.backgroundTaskIpc=backgroundTaskIpc;window.backgroundTask=useBackgroundRepoTaskStore;
    function App(){
      const [tab,setTab]=React.useState('Overview');
      return <><button onClick={()=>setTab(tab==='Overview'?'History':'Overview')}>Browse repository</button><h1>{tab}</h1>
        {tab==='Overview'&&<OverviewPanel repoPath="test" onNavigate={setTab} onRefresh={()=>{}}/>}
        <PRReviewHost/>
      </>;
    }
    createRoot(document.getElementById('root')).render(<App/>);`;
  await require('esbuild').build({ stdin: { contents: background ? backgroundEntry : `import React from 'react';import {createRoot} from 'react-dom/client';import {ResolveDialog} from './src/components/pr/PRReviewTask';import {useRepoStore} from './src/stores/repoStore';import './src/index.css';useRepoStore.setState({repoPath:'test',currentBranch:'unrelated',refreshStatus:async()=>{}});createRoot(document.getElementById('root')).render(<ResolveDialog pr={{number:20,title:'Better Hand Motions',headBranch:'dev_Jake',baseBranch:'main',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),author:'jacoblauriecontact-debug'}} ghSlug='org/repo' repoPath='test' onClose={()=>window.closedReview++} onDone={result=>window.done=result}/>);`, resolveDir: root, loader: 'tsx' }, alias: { '@': path.join(root, 'src') }, outfile: path.join(dir, 'app.js'), bundle: true, format: 'esm' })
  const setup = `
    window.calls=[];window.closedReview=0;window.logCount=0;window.fetchCount=0;
    const params=new URLSearchParams(location.search), delayed=params.has('delayed');
    let failPRList=params.has('listFailure');
    const file=path=>({path,status:'M',additions:0,deletions:0});
    window.lucidGit={
      branchList:async()=>[],currentBranch:async()=>delayed?'main':'unrelated',
      getRemoteUrl:async()=>'https://github.com/org/repo.git',
      getSyncStatus:async()=>({behind:9,ahead:0,remoteName:'origin',remoteBranch:'main',hasUpstream:true}),
      lfsStatus:async()=>({untracked:[]}),listLocks:async()=>[],gitBranchActivity:async()=>[],
      githubListPRs:async()=>{
        if(failPRList){failPRList=false;throw Error('503 unavailable')}
        return [
        {number:20,title:'Better Hand Motions',headBranch:'dev_Jake',baseBranch:'main',headSha:'a'.repeat(40),baseSha:'b'.repeat(40),author:'jacoblauriecontact-debug',updatedAt:new Date().toISOString()},
        {number:767,title:'Move FMOD events',headBranch:'dev_AudioTeam',baseBranch:'main',headSha:'d'.repeat(40),baseSha:'b'.repeat(40),author:'AudioTeam',updatedAt:new Date().toISOString()},
        ];
      },
      pull:async()=>{window.calls.push(['pull'])},
      fetch:async()=>{window.fetchCount++;if(delayed&&window.fetchCount===2)return new Promise((resolve,reject)=>{window.finishFetch=resolve;window.failFetch=()=>reject(Error('fetch offline'))})},
      mergePreview:async(repo,head,base)=>{window.lastPreview=[repo,head,base];return delayed?[]:['Content/animations/ABP_Hazmat.uasset','Content/mesh/SK_Hazmat.uasset'].map(path=>({path,type:'ue-asset',conflictType:'binary'}))},
      branchDiff:async()=>({aheadCommits:[{hash:'a'.repeat(40),message:'Better Hand Motions',author:'jacoblauriecontact-debug'}],files:['Content/DataAssets/DA_Box.uasset','Content/animations/ABP_Hazmat.uasset','Content/mesh/SK_Hazmat.uasset','first.txt','second.txt'].map(file),totalAdditions:0,totalDeletions:0}),
      blueprintCompare:async(repo,request)=>{window.calls.push(['graph',request]);const doc=request.filePath.includes('DA_Box')?{status:'unsupported',assetClass:'/Script/Engine.DataAsset',graphs:[],diagnostics:['No editor Blueprint graph.']}:request.rightRef==='ABSENT'?null:${JSON.stringify(incoming)};return {left:{ref:request.leftRef,path:request.oldPath||request.filePath,status:'ready',document:doc?.status==='unsupported'?doc:${JSON.stringify(document)}},right:{ref:request.rightRef,path:request.filePath,status:'ready',document:doc}}},
      blueprintCancel:async()=>{},assetRenderThumbnail:async()=>null,
      assetExtractMetadata:async(...args)=>{window.calls.push(['metadata',...args]);return {AssetClass:'Animation Blueprint',SizeBytes:'184000'}},
      gitFileLog:async(...args)=>{window.calls.push(['history',...args]);return []},
      gitCommitFileDiff:async(...args)=>{window.calls.push(['text',...args]);if(args[1]==='first.txt')return new Promise(resolve=>window.resolveFirst=()=>resolve({oldContent:'first old',newContent:'first stale',language:'plaintext'}));return {oldContent:'second old',newContent:'second current',language:'plaintext'}},
      checkout:async(...args)=>window.calls.push(['checkout',...args]),log:async()=>delayed?[]:[{hash:(window.logCount++?'c':'a').repeat(40)}],
      merge:async()=>{throw Error('automatic merge failed: conflict')},mergeResolveText:async(...args)=>window.calls.push(['resolve',...args]),mergeContinue:async()=>{},push:async()=>{},mergeInProgress:async()=>null,
      githubMergePR:async args=>{window.calls.push(['mergePR',args]);if(delayed)return new Promise((resolve,reject)=>{window.finishMerge=resolve;window.failMerge=()=>reject(Error('GitHub unavailable'))})},githubClosePR:async args=>window.calls.push(['closePR',args]),
      openExternal:async url=>window.calls.push(['external',url]),openPath:async()=>{},showInFolder:async()=>{},logRendererEvent:async()=>{},notifyDesktop:async()=>{},forecastPause:async()=>{},forecastResume:async()=>{}
    };
  `
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/') { res.setHeader('Content-Type', 'text/html'); res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;background:#090c11}</style><div id="root"></div><script>${setup}</script><script type="module" src="/app.js"></script></html>`); return }
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
    await page.getByRole('button', { name: 'Unreal Asset Review', exact: true }).click()
    await expect(page.locator('#pr-file-preview')).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('pr-review-collapsed.png') })
    await page.getByRole('button', { name: 'Unreal Asset Review', exact: true }).click()
    await expect(page.locator('.bp-revisions canvas').first()).toBeVisible()
    expect(await page.evaluate(() => window.calls.filter(c => c[0] === 'graph').length)).toBe(1)
    await selected.getByRole('button', { name:'Details', exact:true }).click()
    await expect(page.getByText('File History', {exact:true})).toBeVisible()
    expect(await page.evaluate(() => window.calls.filter(c => c[0] === 'metadata').at(-1).slice(1))).toEqual(['test','Content/animations/ABP_Hazmat.uasset','a'.repeat(40)])
    await selected.getByRole('button', { name:'Back to preview',exact:true }).click()
    expect(await page.evaluate(() => window.calls.filter(c => c[0] === 'graph').length)).toBe(1)
    await selected.getByRole('button', { name:'Selected file actions' }).click()
    await expect(page.getByRole('button',{name:'Open Unreal asset details',exact:true})).toBeVisible()
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
test('PR review escapes transformed page containers, resizes and expands without recapturing review state',async({page},info)=>{
 const {server,url}=await reviewServer()
 try{
  await page.setViewportSize({width:2200,height:1200});await page.goto(url);await expect(page.locator('.bp-revisions canvas')).toHaveCount(2)
  await page.addStyleTag({content:'#root{transform:translateZ(0);width:700px!important;height:340px!important;margin-top:100px}'})
  const dialog=page.locator('.pr-review-dialog'),bounds=await dialog.boundingBox()
  expect(bounds.x).toBeCloseTo(24,0);expect(bounds.y).toBeCloseTo(24,0);expect(bounds.width).toBeCloseTo(2152,0);expect(bounds.height).toBeCloseTo(1152,0)
  await expect(page.getByRole('button',{name:'Close PR review',exact:true})).toBeInViewport()
  const choice=page.getByRole('complementary',{name:'PR changed files'}).getByRole('button',{name:'Accept dev_Jake',exact:true}).first();await choice.click()
  await page.mouse.move(bounds.x+bounds.width-4,bounds.y+bounds.height-4);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width-184,bounds.y+bounds.height-124,{steps:8});await page.mouse.up()
  await expect.poll(async()=> (await dialog.boundingBox()).width).toBeLessThan(bounds.width-50)
  expect(await page.evaluate(()=>window.closedReview)).toBe(0)
  await page.getByRole('button',{name:'Expand PR review',exact:true}).click();expect((await dialog.boundingBox()).width).toBeCloseTo(2184,0);await expect(choice).toHaveAttribute('aria-pressed','true')
  await page.setViewportSize({width:1500,height:900});const expanded=await dialog.boundingBox();expect(expanded.width).toBeCloseTo(1484,0);expect(expanded.height).toBeCloseTo(884,0)
  await page.screenshot({path:info.outputPath('pr-review-responsive.png')})
  await page.getByRole('button',{name:'Restore PR review size',exact:true}).click();await page.setViewportSize({width:560,height:640});const small=await dialog.boundingBox();expect(small.x).toBeGreaterThanOrEqual(8);expect(small.y).toBeGreaterThanOrEqual(8);expect(small.width).toBeLessThanOrEqual(544);expect(small.height).toBeLessThanOrEqual(624)
  await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeInViewport();expect(await page.evaluate(()=>window.calls.filter(call=>call[0]==='graph').length)).toBe(1);expect(await page.evaluate(()=>window.calls.filter(call=>call[0]==='mergePR'||call[0]==='closePR').length)).toBe(0)
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})


function resolveButton(page, title) {
  return page.getByText(title, { exact: true }).locator('../..').getByRole('button', { name: 'Resolve', exact: true })
}

test('Overview opens the next PR after background merge even when main is behind and the follow-up fetch fails', async ({page}, testInfo) => {
  const {server,url}=await reviewServer(true), errors=[]
  page.on('pageerror', e=>errors.push(e.message))
  try {
    await page.setViewportSize({width:800,height:600}); await page.goto(url+'?delayed')
    await expect(page.getByText('9 commits behind origin/main')).toBeVisible()
    const previousResolve = resolveButton(page, 'Better Hand Motions')
    await previousResolve.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog',{name:'Review pull request'}).getByRole('heading',{name:'Better Hand Motions'})).toBeVisible()
    await expect(page.getByRole('button',{name:'Merge PR',exact:true})).toBeEnabled()
    await page.getByRole('button',{name:'Merge PR',exact:true}).click()
    await expect(page.getByRole('dialog',{name:'Review pull request'})).toBeHidden()
    const notice=page.getByRole('region',{name:'PR #20 progress'})
    await expect(notice).toContainText('Merging PR #20')
    await expect(page.getByRole('button',{name:'Browse repository'})).toBeEnabled()
    await page.getByRole('button',{name:'Browse repository'}).click()
    await expect(page.getByRole('heading',{name:'History',exact:true})).toBeVisible()
    const blocked=await page.evaluate(async()=>{try{await window.publicIpc.checkout('test','other')}catch(e){return e.message}})
    expect(blocked).toContain('pull request operation is running')
    await page.getByRole('button',{name:'Browse repository'}).click()
    await expect(resolveButton(page, 'Move FMOD events')).toBeDisabled()
    await expect(page.getByRole('dialog',{name:'Review pull request'})).toBeHidden()
    await notice.getByRole('button',{name:'View details'}).click()
    await expect(page.getByRole('dialog',{name:'Review pull request'})).toBeVisible()
    await expect(page.getByRole('button',{name:'Merging...',exact:true})).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(notice).toBeVisible()
    expect(await page.evaluate(()=>window.calls.filter(c=>c[0]==='mergePR').length)).toBe(1)
    await page.evaluate(()=>window.finishMerge())
    await expect(notice).toContainText('Merged - Updating repository...')
    expect(await page.evaluate(()=>window.reviewStore.getState().completed.test[20])).toBe('accept')
    await expect(resolveButton(page, 'Better Hand Motions')).toHaveCount(0)
    await expect(resolveButton(page, 'Move FMOD events')).toBeDisabled()
    await page.setViewportSize({width:390,height:500})
    await page.screenshot({path:testInfo.outputPath('background-pr-progress.png')})
    await page.evaluate(()=>window.failFetch())
    await expect(notice).toContainText('PR #20 merged')
    await expect(notice).toContainText('PR merged, but fetch failed')
    await expect(notice).toHaveCSS('animation-name', 'none')
    await notice.getByRole('button',{name:'View details'}).click()
    await expect(page.getByRole('button',{name:'Merged',exact:true})).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.setViewportSize({width:800,height:600})
    await expect(page.getByText('9 commits behind origin/main')).toBeVisible()
    await resolveButton(page, 'Move FMOD events').click()
    await expect(notice).toHaveCount(0)
    const nextReview=page.getByRole('dialog',{name:'Review pull request'})
    await expect(nextReview.getByRole('heading',{name:'Move FMOD events'})).toBeVisible()
    await expect(nextReview).toContainText('dev_AudioTeam')
    await expect(nextReview).not.toContainText('PR merged, but fetch failed')
    await expect(nextReview.getByRole('button',{name:'Merge PR',exact:true})).toBeEnabled()
    expect(await page.evaluate(()=>window.lastPreview)).toEqual(['test','d'.repeat(40),'b'.repeat(40)])
    expect(await page.evaluate(()=>window.calls.filter(([method])=>method==='pull'||method==='mergePR'))).toEqual([
      ['mergePR', {owner:'org',repo:'repo',prNumber:20,repoPath:'test',expectedSha:'a'.repeat(40)}],
    ])
    await nextReview.getByRole('button',{name:'Cancel',exact:true}).click()
    await page.evaluate(()=>window.publicIpc.checkout('test','other'))
    expect(await page.evaluate(()=>window.calls.filter(c=>c[0]==='checkout').length)).toBe(1)
    const guard = await page.evaluate(async () => {
      window.backgroundTask.setState({repoPath:'test'})
      try {
        await window.publicIpc.checkout('test','blocked')
        return null
      } catch (error) {
        await window.publicIpc.checkout('another-repo','allowed')
        await window.backgroundTaskIpc.checkout('test','task-owned')
        return error.message
      } finally {
        window.backgroundTask.setState({repoPath:null})
      }
    })
    expect(guard).toContain('repository operation is running')
    expect(await page.evaluate(()=>window.calls.filter(c=>c[0]==='checkout').slice(1))).toEqual([
      ['checkout','another-repo','allowed'], ['checkout','test','task-owned'],
    ])

    expect(errors).toEqual([])
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

test('Resolve opens the next PR while the previous successful merge notice is still visible', async ({ page }) => {
  const { server, url } = await reviewServer(true)
  try {
    await page.goto(url + '?delayed')
    await resolveButton(page, 'Better Hand Motions').click()
    await page.getByRole('button', { name: 'Merge PR', exact: true }).click()
    await page.evaluate(() => window.finishMerge())
    const notice = page.getByRole('region', { name: 'PR #20 progress' })
    await expect(notice).toContainText('Merged - Updating repository...')
    const next = resolveButton(page, 'Move FMOD events')
    await expect(next).toBeDisabled()

    await page.evaluate(() => window.finishFetch())
    await expect(notice).toContainText('PR #20 merged')
    await expect(notice).toBeVisible()
    await next.click()

    const review = page.getByRole('dialog', { name: 'Review pull request' })
    await expect(review.getByRole('heading', { name: 'Move FMOD events' })).toBeVisible()
    await expect(review.getByRole('button', { name: 'Merge PR', exact: true })).toBeEnabled()
    await expect(notice).toHaveCount(0)
    expect(await page.evaluate(() => window.lastPreview)).toEqual(['test', 'd'.repeat(40), 'b'.repeat(40)])
    expect(await page.evaluate(() => window.calls.some(([method]) => method === 'pull'))).toBe(false)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('failed background merge retains an actionable error and the reviewed file without another preview fetch', async ({page})=>{
  const {server,url}=await reviewServer(true)
  try {
    await page.goto(url+'?delayed')
    await resolveButton(page, 'Better Hand Motions').click()
    await expect(page.getByRole('button',{name:'Merge PR',exact:true})).toBeEnabled()
    await page.getByRole('button',{name:'Merge PR',exact:true}).click()
    await page.evaluate(()=>window.failMerge())
    const notice=page.getByRole('region',{name:'PR #20 progress'})
    await expect(notice).toContainText('GitHub unavailable')
    await expect(notice).toHaveCSS('animation-name', 'none')
    await notice.getByRole('button',{name:'Review issue'}).click()
    await expect(page.getByRole('dialog')).toContainText('GitHub unavailable')
    expect(await page.evaluate(()=>window.fetchCount)).toBe(1)
    await page.getByRole('button',{name:'Merge PR',exact:true}).click()
    await expect.poll(()=>page.evaluate(()=>window.calls.filter(c=>c[0]==='mergePR').length)).toBe(2)
    await page.evaluate(()=>window.finishMerge())
    await expect(notice).toContainText('Merged - Updating repository...')
    await expect(notice).toHaveCSS('animation-name', 'none')
    await page.evaluate(()=>window.finishFetch())
    await expect(notice).toContainText('PR #20 merged')
    await expect(notice).toHaveCSS('animation-name', 'merge-progress-fade-out')
    await expect(notice).toHaveCSS('animation-delay', '3s')
    expect(await page.evaluate(()=>window.reviewStore.getState().busy)).toBe(false)
    await expect(notice).toHaveCount(0, { timeout: 6000 })
    expect(await page.evaluate(()=>window.reviewStore.getState().request)).toBeNull()
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

test('Overview retries a failed PR list and opens the selected review', async ({ page }) => {
  const { server, url } = await reviewServer(true)
  try {
    await page.goto(url + '?delayed&listFailure')
    await expect(page.getByText('GitHub is temporarily unavailable', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resolve', exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'Try again', exact: true }).click()
    await expect(page.getByText('GitHub is temporarily unavailable', { exact: true })).toHaveCount(0)
    await resolveButton(page, 'Move FMOD events').click()
    const review = page.getByRole('dialog', { name: 'Review pull request' })
    await expect(review.getByRole('heading', { name: 'Move FMOD events' })).toBeVisible()
    await expect(review.getByRole('button', { name: 'Merge PR', exact: true })).toBeEnabled()
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('closing a PR requires confirmation, supports cancellation, and leaves the other row available', async ({ page }) => {
  const { server, url } = await reviewServer(true)
  try {
    await page.goto(url + '?delayed')
    const row = resolveButton(page, 'Better Hand Motions')
    const review = page.getByRole('dialog', { name: 'Review pull request' })
    const chooseClose = async () => {
      await row.click()
      await review.getByLabel('Pull request actions').click()
      await review.getByRole('button', { name: 'Close PR', exact: true }).click()
      await expect(review.getByText('This will close PR #20 without merging.', { exact: false })).toBeVisible()
    }
    const writes = () => page.evaluate(() => window.calls.filter(([method]) => method === 'mergePR' || method === 'closePR'))

    await chooseClose()
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(review).toBeHidden()
    await expect(row).toBeFocused()
    expect(await writes()).toEqual([])

    await chooseClose()
    await review.getByRole('button', { name: 'Close PR', exact: true }).click()
    await expect(page.getByRole('region', { name: 'PR #20 progress' })).toContainText('PR #20 closed')
    await expect(row).toHaveCount(0)
    await expect(resolveButton(page, 'Move FMOD events')).toBeEnabled()
    expect(await writes()).toEqual([['closePR', { owner: 'org', repo: 'repo', prNumber: 20 }]])
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
