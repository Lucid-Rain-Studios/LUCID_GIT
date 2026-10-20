const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
test.afterAll(cleanup)

test('Timeline file search filters loaded paths, old names and resets between commits', async ({ page }) => {
  const dir = tmpDir('lg-timeline-search-')
  const commits = [{hash:'a'.repeat(40),parentHashes:['b'.repeat(40)],author:'Tester',email:'test@example.com',timestamp:1000,message:'Update map and config'}, {hash:'b'.repeat(40),parentHashes:[],author:'Tester',email:'test@example.com',timestamp:500,message:'Initial files'}]
  const files = [{path:'Content/Maps/Facility.umap',oldPath:'Content/Maps/OldHub.umap',status:'R100'}, {path:'Config/DefaultGame.ini',status:'M'}, {path:'Config/DefaultInput.ini',status:'M'}]
  await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {TimelinePanel} from './src/components/timeline/TimelinePanel';import './src/index.css';createRoot(document.getElementById('root')).render(<TimelinePanel repoPath="repo"/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
  const server = http.createServer((req,res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type','text/html')
      return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.reads=[];window.lucidGit={mergeInProgress:async()=>null,forecastPause:async()=>{},forecastResume:async()=>{},logRendererEvent:async()=>{},branchList:async()=>[{name:'main',displayName:'main',current:true,ahead:0,behind:0,isRemote:false}],gitDefaultBranch:async()=>'main',getRemoteUrl:async()=>null,getSyncStatus:async()=>({ahead:0,behind:0,hasUpstream:false}),log:async(_,args)=>args.refs?.some(r=>r.includes('..'))?[]:args.limit===1?[${JSON.stringify(commits[0])}]:${JSON.stringify(commits)},commitMessage:async()=>'',commitFiles:async(_,hash)=>{window.reads.push(hash);return ${JSON.stringify(files)}},gitBlame:async()=>[],gitCommitFileDiff:async()=>null};</script><script type="module" src="/app.js"></script></html>`)
    }
    res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript')
    res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const errors=[]; page.on('pageerror',error=>errors.push(error.message))
  try {
    page.setDefaultTimeout(10000)
    await page.setViewportSize({width:1400,height:850})
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByText('Update map and config',{exact:true}).click()
    const search=page.getByRole('searchbox',{name:'Search changed files'})
    await expect(search).toBeVisible()
    await search.fill('  CONFIG\\DEFAULTGAME  ')
    await expect(page.getByText('1 / 3',{exact:true})).toBeVisible()
    await expect(page.getByText('Config/DefaultGame.ini',{exact:true})).toBeVisible()
    await expect(page.getByText('Config/DefaultInput.ini',{exact:true})).toHaveCount(0)
    await search.fill('oldhub')
    await expect(page.getByText(/OldHub\.umap.*Facility\.umap/)).toBeVisible()
    await search.fill('nothing-matches')
    await expect(page.getByRole('status')).toContainText('No files match your search')
    await search.press('Escape'); await expect(search).toHaveValue('')
    await expect(page.getByText('Config/DefaultInput.ini',{exact:true})).toBeVisible()
    await search.fill('config')
    expect(await page.evaluate(()=>window.reads.length)).toBe(1)
    fs.mkdirSync(path.join(root,'audit/evidence/timeline-file-search'),{recursive:true})
    await page.screenshot({path:path.join(root,'audit/evidence/timeline-file-search/search.png')})
    await page.getByText('Initial files',{exact:true}).click()
    await expect(search).toHaveValue('')
    await expect(page.getByText(/OldHub\.umap.*Facility\.umap/)).toBeVisible()
    expect(errors).toEqual([])
  } finally { await page.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)) }
})
