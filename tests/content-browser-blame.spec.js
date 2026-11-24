const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
test.afterAll(cleanup)

test('Content Browser targets the right-clicked file for Blame and recognizes owned locks regardless of casing', async ({ page }) => {
  const dir = tmpDir('lg-content-blame-')
  await require('esbuild').build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ContentBrowserPanel} from './src/components/map/ContentBrowserPanel';import {useAuthStore} from './src/stores/authStore';import {useLockStore} from './src/stores/lockStore';import {useRepoStore} from './src/stores/repoStore';import './src/index.css';useRepoStore.setState({repoPath:'repo'});useAuthStore.setState({accounts:[{userId:'me',login:'me'}],currentAccountId:'me'});useLockStore.setState({locks:[{id:'own',path:'Map.umap',owner:{name:'Me',login:'Me'}},{id:'foreign',path:'Other.txt',owner:{name:'Other Owner',login:'other'}}]});createRoot(document.getElementById('root')).render(<ContentBrowserPanel repoPath="repo" onNavigate={tab=>window.navigations.push(tab)}/>);`, resolveDir: root, loader: 'tsx' }, alias: { '@': path.join(root, 'src') }, outfile: path.join(dir, 'app.js'), bundle: true, format: 'esm' })
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type','text/html')
      return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>
      window.reads=[];window.navigations=[];window.unlocks=[];
      window.lucidGit=new Proxy({unlockFile:async(...args)=>window.unlocks.push(args),gitLsFiles:async()=>['Readme.txt','Other.txt','Map.umap'],getRemoteUrl:async()=>null,gitFileLog:async()=>[],assetExtractMetadata:async()=>({}),gitBlame:async(repo,file,ref)=>{window.reads.push(['lines',file,ref]);return [{hash:'abcdef123456',author:file==='Other.txt'?'Other Author':'Text Author',timestamp:1000,summary:'Text edit',lineNo:1,content:'Text line'}]},log:async(repo,args)=>{window.reads.push(['history',args]);return [{hash:'012345abcdef',author:'Map Author',timestamp:1000,message:'Map edit'}]}},{get:(o,k)=>o[k]||(()=>Promise.resolve(null))});
      </script><script type="module" src="/app.js"></script></html>`)
    }
    if (req.url !== '/app.css' && req.url !== '/app.js') { res.writeHead(404); return res.end() }
    res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript')
    res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  try {
    await page.setViewportSize({width:1000,height:720})
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByText('Readme.txt',{exact:true}).click()
    await expect(page.getByText('Text Author',{exact:true})).toBeVisible()
    const before=await page.evaluate(()=>window.reads.length)
    await page.getByText('Map.umap',{exact:true}).click({button:'right'})
    await expect(page.getByRole('button',{name:'Blame',exact:true})).toBeVisible()
    expect(await page.evaluate(()=>window.reads.length)).toBe(before)
    await page.getByRole('button',{name:'Blame',exact:true}).click()
    await expect(page.getByRole('button',{name:'Blame',exact:true})).toHaveCount(0)
    await expect(page.getByRole('region',{name:'Asset blame'})).toContainText('Map Author')
    expect(await page.evaluate(()=>window.reads.at(-1))).toEqual(['history',{filePath:'Map.umap',refs:['HEAD'],limit:101}])
    expect(await page.evaluate(()=>window.reads.some(read=>read[0]==='lines'&&read[1]==='Map.umap'))).toBe(false)
    await page.getByText('Other.txt',{exact:true}).click({button:'right'})
    await expect(page.getByRole('button',{name:'Locked by Other Owner'})).toBeDisabled()
    await page.getByRole('button',{name:'Blame',exact:true}).click()
    await expect(page.getByText('Other Author',{exact:true})).toBeVisible()
    await expect(page.getByRole('region',{name:'Asset blame'})).toHaveCount(0)
    expect(await page.evaluate(()=>window.reads.at(-1))).toEqual(['lines','Other.txt','HEAD'])
    expect(await page.evaluate(()=>window.navigations)).toEqual([])
    await page.getByText('Map.umap',{exact:true}).click({button:'right'})
    await page.getByRole('button',{name:'Unlock File',exact:true}).click()
    await expect.poll(()=>page.evaluate(()=>window.unlocks)).toEqual([['repo','Map.umap',undefined,'own']])
    fs.mkdirSync(path.join(root,'audit/evidence/asset-blame'),{recursive:true})
    await page.getByText('Readme.txt',{exact:true}).first().click({button:'right'})
    await page.screenshot({path:path.join(root,'audit/evidence/asset-blame/content-browser-menu.png')})
    expect(errors).toEqual([])
  } finally {await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
