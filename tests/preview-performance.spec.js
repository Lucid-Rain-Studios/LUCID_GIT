const {test,expect}=require('@playwright/test')
const fs=require('node:fs'),path=require('node:path'),http=require('node:http')
const {EventEmitter}=require('node:events')
const {DIST,tmpDir,cleanup}=require('./helpers')
const {component}=require('./renderer-harness')
const root=path.resolve(__dirname,'..'),helper=path.join(root,'tools/BlueprintExtractor/bin/Release/net10.0')
const fixture=path.join(root,'third_party/UAssetAPI/UAssetAPI.Tests/TestAssets/TestEditorAssets/TestActorBP.uasset')
test.afterAll(cleanup)

test('real Blueprint worker reuses its process for independent reads, package mode and failures',async({},testInfo)=>{
 const {BlueprintReaderWorker}=require(path.join(DIST,'services/BlueprintReaderWorker')),worker=new BlueprintReaderWorker(),times=[],docs=[]
 const before=fs.readFileSync(fixture)
 try {
  for(let i=0;i<2;i++){const start=Date.now();docs.push(JSON.parse(await worker.read(helper,fixture,false)));times.push(Date.now()-start);if(i===0)worker.firstPid=worker.child.pid;else expect(worker.child.pid).toBe(worker.firstPid)}
  expect(docs[1]).toEqual(docs[0]);expect(docs[0].graphs.length).toBeGreaterThan(0)
  const packages=JSON.parse(await worker.read(helper,fixture,true));expect(packages.assetReview.objects).toEqual([])
  await expect(worker.read(helper,path.join(root,'missing-blueprint.uasset'),false)).rejects.toThrow()
  expect(JSON.parse(await worker.read(helper,fixture,false))).toEqual(docs[0]);expect(fs.readFileSync(fixture)).toEqual(before)
  const evidence={coldMs:times[0],warmMs:times[1],sameProcess:true,graphs:docs[0].graphs.length,sourceUnchanged:true}
  console.log('Blueprint warm reader:',JSON.stringify(evidence));await testInfo.attach('blueprint-reader-timing.json',{body:Buffer.from(JSON.stringify(evidence)),contentType:'application/json'})
 } finally {worker.stop()}
})

test('Blueprint worker bounds output, rejects mismatched replies, times out, idles and restarts',async()=>{
 const children=[],timers=new Map()
 const spawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.write=(text,callback)=>{child.request=JSON.parse(text);callback()};child.kill=()=>{child.killed=true;setImmediate(()=>child.emit('close',1))};children.push(child);return child}
 const globals={process,Buffer,setTimeout:(fn,ms)=>{const timer={unref(){}};timers.set(ms,fn);return timer},clearTimeout(){}}
 const {BlueprintReaderWorker}=component('electron/services/BlueprintReaderWorker.ts',{'node:child_process':{spawn}},globals).exports
 const worker=new BlueprintReaderWorker(),reply=child=>child.stdout.emit('data',Buffer.from(JSON.stringify({id:child.request.id,document:{graphs:[],name:'雪'}})+'\n'))
 try {
  let job=worker.read(helper,fixture,false);await expect.poll(()=>children.length).toBe(1);await expect.poll(()=>!!children[0].request).toBe(true)
  const bytes=Buffer.from(JSON.stringify({id:children[0].request.id,document:{graphs:[],name:'雪'}})+'\n'),split=bytes.indexOf(Buffer.from('雪'))+1
  children[0].stdout.emit('data',bytes.subarray(0,split));children[0].stdout.emit('data',bytes.subarray(split));expect(JSON.parse(await job).name).toBe('雪')
  timers.get(30000)();expect(children[0].killed).toBe(true)
  job=worker.read(helper,fixture,false);await expect.poll(()=>children.length).toBe(2);await expect.poll(()=>!!children[1].request).toBe(true)
  children[0].stdout.emit('data',Buffer.from('late old output\n'));children[0].stdin.emit('error',new Error('late old pipe error'));expect(children[1].killed).not.toBe(true)
  const timeout=expect(job).rejects.toThrow('25 second');timers.get(25000)();await timeout
  job=worker.read(helper,fixture,false);await expect.poll(()=>children.length).toBe(3);await expect.poll(()=>!!children[2].request).toBe(true)
  const mismatch=expect(job).rejects.toThrow('identity mismatch');children[2].stdout.emit('data',Buffer.from('{"id":"wrong"}\n'));await mismatch
  job=worker.read(helper,fixture,false);await expect.poll(()=>children.length).toBe(4);await expect.poll(()=>!!children[3].request).toBe(true)
  const oversized=expect(job).rejects.toThrow('32 MB');children[3].stdout.emit('data',Buffer.alloc(32*1024*1024+1));await oversized
  for(let i=0;i<33;i++) {job=worker.read(helper,fixture,false);await expect.poll(()=>!!children.at(-1).request && worker.pending).toBeTruthy();reply(children.at(-1));await job}
  expect(children).toHaveLength(6)
 } finally {worker.stop()}
})

test('map scene scope captures only the requested revision and rejects invalid scope',async()=>{
 const {BlueprintRevisionService}=require(path.join(DIST,'services/BlueprintRevisionService')),reader=new BlueprintRevisionService(),calls=[]
 reader.side=async(_,file,ref)=>({status:'ready',path:file,ref,document:{assetClass:'/Script/Engine.World',graphs:[]}})
 reader.scene=async(_,side)=>{calls.push(side.ref);return {status:'unavailable',reason:'controlled capture'}}
 const request={filePath:'Content/Map.umap',leftRef:'a'.repeat(40),rightRef:'WORKING',requestId:'scope',nativeScene:true}
 for(const side of ['left','right']){calls.length=0;const result=await reader.compare(root,{...request,nativeSceneSide:side});expect(calls).toEqual([side==='left'?'a'.repeat(40):'WORKING']);expect(result[side].scene).toBeDefined();expect(result[side==='left'?'right':'left'].scene).toBeUndefined()}
 await expect(reader.compare(root,{...request,nativeSceneSide:'other'})).rejects.toThrow('Invalid native scene revision')
})

test('map browser exports the selected side first, retains completed sides and discards cancelled captures',async({page})=>{
 const dir=tmpDir('lg-map-selected-first-'),doc={schemaVersion:1,readerVersion:17,assetClass:'/Script/Engine.World',graphs:[],diagnostics:[],status:'unsupported',assetReview:{family:'map',objects:[],coverage:[],cooked:false}}
 const result={left:{status:'ready',ref:'a'.repeat(40),resolvedRef:'a'.repeat(40),path:'Content/Map.umap',documentKey:'left',document:doc},right:{status:'ready',ref:'WORKING',resolvedRef:'WORKING',path:'Content/Map.umap',documentKey:'right',document:doc}}
 await require('esbuild').build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';function App(){const[file,setFile]=useState('Content/Map.umap');window.chooseMap=setFile;return <UnrealAssetReview repoPath="test" request={{filePath:file,leftRef:'${'a'.repeat(40)}',rightRef:'WORKING'}}/>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><div id="root"></div><script>window.calls=[];window.jobs=[];window.cancelled=[];window.lucidGit={blueprintCancel:async id=>window.cancelled.push(id),blueprintCompare:async(_,r)=>{window.calls.push(r);const data=${JSON.stringify(result)};if(r.nativeScene){await new Promise(resolve=>window.jobs.push({side:r.nativeSceneSide,finish:resolve}));data[r.nativeSceneSide].scene={status:'unavailable',reason:r.nativeSceneSide+' exported',engineVersion:'5.8',packages:[],diagnostics:[],complete:false}}return data}}</script><script type="module" src="/app.js"></script></html>`)}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',error=>errors.push(error.message))
 try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Preview',exact:true}).click();await page.getByText('3D geometry export (slow)',{exact:true}).click();await page.getByRole('button',{name:'Export 3D geometry (slow)',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>window.jobs.map(job=>job.side))).toEqual(['right']);await expect(page.locator('.uar-scene-loading')).toBeVisible()
  await page.evaluate(()=>window.jobs[0].finish());await expect(page.getByRole('alert')).toContainText('right exported')
  await page.getByRole('button',{name:'Base',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.jobs.map(job=>job.side))).toEqual(['right','left']);await expect(page.locator('.uar-scene-loading')).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0)
  await page.evaluate(()=>window.jobs[1].finish());await expect(page.getByRole('alert')).toContainText('left exported')
  await page.getByRole('button',{name:'Selected',exact:true}).click();await expect(page.getByRole('alert')).toContainText('right exported');expect(await page.evaluate(()=>window.jobs.length)).toBe(2)
  await page.getByRole('button',{name:'Retry 3D export (slow)',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.jobs.length)).toBe(3)
  const request=await page.evaluate(()=>window.calls.at(-1));expect(request).toMatchObject({nativeSceneSide:'right',sceneRenderOnly:true,leftRef:'a'.repeat(40),rightRef:'WORKING',force:true})
  await page.evaluate(()=>window.chooseMap('Content/Other.umap'));await expect(page.locator('.uar-heading strong')).toHaveText('Other.umap');await page.evaluate(()=>window.jobs[2].finish());await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.getByRole('button',{name:'Changes',exact:true})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.getByRole('button',{name:'Saved positions',exact:true})).toHaveAttribute('aria-pressed','true');expect(await page.evaluate(()=>window.jobs.length)).toBe(3);expect(await page.evaluate(id=>window.cancelled.includes(id),request.requestId)).toBe(true);expect(errors).toEqual([])
 } finally {await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
