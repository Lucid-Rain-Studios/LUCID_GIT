const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { execFileSync } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { DIST, tmpDir, cleanup, git } = require('./helpers')
const { component } = require('./renderer-harness')
const { NativeMeshService, validateNativeGeometry } = require(path.join(DIST, 'services/NativeMeshService'))
const { ueHeadlessService } = require(path.join(DIST, 'services/UEHeadlessService'))
const root = path.resolve(__dirname, '..')
const mesh = { id:'',name:'SavedName',path:'SavedName',classPath:'/Script/Engine.StaticMesh',outer:'',properties:{},decoded:true,opaqueBytes:0,opaqueHash:'',diagnostics:[] }
const doc = { schemaVersion:1,readerVersion:14,engineVersion:'5.8.3',assetClass:mesh.classPath,graphs:[],diagnostics:[],status:'unsupported',assetReview:{family:'mesh',objects:[mesh],cooked:false,coverage:[]} }
const geometry = () => ({status:'ready',provider:'unreal-source-mesh-v1',engineVersion:'5.8.3-test',totalLods:2,diagnostics:[],lods:[{index:0,vertexCount:3,triangleCount:1,vertices:[[0,0,0],[100,0,0],[0,100,20]],indices:[0,1,2]},{index:1,vertexCount:3,triangleCount:1,vertices:[[0,0,0],[20,0,0],[0,20,5]],indices:[0,1,2]}]})
test.afterAll(cleanup)

test('native geometry validator rejects invalid topology, counts, duplicates and output budgets', () => {
  expect(validateNativeGeometry(geometry()).lods).toHaveLength(2)
  for (const mutate of [g=>g.lods[0].vertices[0][0]=Infinity,g=>g.lods[0].indices[0]=8,g=>g.lods[0].indices.push(1),g=>g.lods[0].vertexCount=4,g=>g.lods[1].index=0,g=>g.lods[0].reason='omitted',g=>g.lods[0].vertices=Array.from({length:20001},()=>[0,0,0]),g=>g.totalLods=-1]) {
    const data=geometry();mutate(data);expect(()=>validateNativeGeometry(data)).toThrow()
  }
  const data=geometry();data.lods[0]={index:0,vertexCount:100000,triangleCount:200000,vertices:[],indices:[],reason:'Budget exceeded'}
  expect(validateNativeGeometry(data).lods[0].vertexCount).toBe(100000)
})

test('source geometry resolves one mesh root and does not substitute a missing revision LOD', () => {
  const {sourceMeshHulls,collisionBounds}=component('src/lib/meshReview.ts').exports
  const result=sourceMeshHulls([mesh],geometry(),1)
  expect(result).toMatchObject({vertices:3,triangles:1,omitted:0})
  expect(collisionBounds(result.hulls).max).toEqual([20,20,5])
  expect(sourceMeshHulls([mesh,mesh],geometry(),0).hulls).toEqual([])
  expect(sourceMeshHulls([mesh],geometry(),2).hulls).toEqual([])
  expect(sourceMeshHulls([mesh],{...geometry(),status:'unavailable',reason:'Engine missing'},0).diagnostics).toEqual(['Engine missing'])
})

test('compact document hydration retains native geometry only on the current captured side', async () => {
  const {createBlueprintClient}=component('src/lib/blueprintClient.ts').exports
  const key='c'.repeat(64),requests=[]
  const read=createBlueprintClient(async(_,request)=>{
    requests.push(request)
    return {left:{status:'absent',ref:'ABSENT',path:'Content/Mesh.uasset'},right:{status:'ready',ref:'WORKING',path:'Content/Mesh.uasset',documentKey:key,...(!request.knownDocuments.includes(key)?{document:doc}:{}),...(request.nativeGeometry?{geometry:geometry()}:{})}}
  })
  const request={filePath:'Content/Mesh.uasset',leftRef:'ABSENT',rightRef:'WORKING',requestId:'compact'}
  const first=await read('test',request),second=await read('test',{...request,nativeGeometry:true}),third=await read('test',request)
  expect(second.right.document).toBe(first.right.document);expect(second.right.geometry.lods).toHaveLength(2)
  expect(requests[1].knownDocuments).toEqual([key]);expect(third.right.geometry).toBeUndefined()
})

test('commandlet runner bounds output and waits for process close on timeout or cancellation', async () => {
  const processes=[]
  const {UEHeadlessService}=component('electron/services/UEHeadlessService.ts',{'child_process':{spawn:()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{child.killed=true;setImmediate(()=>child.emit('close',null))};processes.push(child);return child
  }}},{Buffer,process}).exports
  const runner=new UEHeadlessService(),args={editorBin:'mock',projectPath:'isolated',commandlet:'pythonscript',params:[],timeoutMs:30}
  const first=runner.runCommandlet(args),child=processes[0]
  child.stdout.emit('data',Buffer.alloc(2*1024*1024,65));child.stderr.emit('data',Buffer.from('tail'))
  const result=await first;expect(child.killed).toBe(true);expect(result.success).toBe(false);expect(result.error).toContain('Timed out');expect(result.output.length).toBe(1024*1024);expect(result.output.endsWith('tail')).toBe(true)
  const controller=new AbortController(),second=runner.runCommandlet({...args,timeoutMs:1000,signal:controller.signal});controller.abort()
  expect((await second).error).toContain('cancelled');expect(processes[1].killed).toBe(true)
  expect((await runner.runCommandlet({...args,signal:controller.signal})).error).toContain('cancelled');expect(processes).toHaveLength(2)
})

test('native service copies exact captured bytes, preserves export name on rename, caches content and cleans failures', async () => {
  const dir=tmpDir('lg-native-snapshot-'),blob=path.join(dir,'left.uasset'),extra=path.join(dir,'left.uexp'),editor=path.join(dir,'engine')
  fs.writeFileSync(blob,'captured old package');fs.writeFileSync(extra,'captured old exports');fs.writeFileSync(editor,'engine binary')
  const original={find:ueHeadlessService.findEditorBinary,run:ueHeadlessService.runCommandlet}
  let calls=0,expectedExtra='captured old exports',tamper=false
  ueHeadlessService.findEditorBinary=async()=>editor
  ueHeadlessService.runCommandlet=async args=>{
    calls++;const isolate=path.dirname(args.projectPath)
    expect(isolate.startsWith(dir+path.sep)).toBe(true)
    expect(fs.readFileSync(path.join(isolate,'Content/Meshes/Renamed.uasset'),'utf8')).toBe('captured old package')
    expect(fs.readFileSync(path.join(isolate,'Content/Meshes/Renamed.uexp'),'utf8')).toBe(expectedExtra)
    expect(JSON.parse(fs.readFileSync(path.join(isolate,'request.json'))).asset).toBe('/Game/Meshes/Renamed.SavedName')
    expect(fs.existsSync(path.join(isolate,'Plugins'))).toBe(false)
    fs.writeFileSync(path.join(isolate,'geometry.json'),JSON.stringify(geometry()))
    if(tamper)fs.writeFileSync(path.join(isolate,'Content/Meshes/Renamed.uasset'),'mutated copy')
    return {success:true,output:'',error:null,outputPath:null}
  }
  try {
    const service=new NativeMeshService()
    expect((await service.extract(blob,'Content/Meshes/Renamed.uasset',doc)).status).toBe('ready')
    await service.extract(blob,'Content/Meshes/Renamed.uasset',doc);expect(calls).toBe(1)
    expect(fs.readdirSync(dir).sort()).toEqual(['engine','left.uasset','left.uexp'])
    expectedExtra='different snapshot';fs.writeFileSync(extra,expectedExtra);expect((await service.extract(blob,'Content/Meshes/Renamed.uasset',doc)).status).toBe('ready');expect(calls).toBe(2)
    tamper=true;fs.writeFileSync(editor,'changed engine binary');expect((await service.extract(blob,'Content/Meshes/Renamed.uasset',doc)).reason).toContain('changed captured package bytes');expect(calls).toBe(3)
    expect(fs.readFileSync(blob,'utf8')).toBe('captured old package')
    expect(fs.readdirSync(dir).some(name=>name.startsWith('native-'))).toBe(false)
    expect((await service.extract(blob,'Plugins/Example/Content/Mesh.uasset',doc)).reason).toContain('Plugin content mounts')
    expect((await service.extract(blob,'Content/Meshes/Renamed.uasset',{...doc,assetReview:{...doc.assetReview,cooked:true}})).reason).toContain('uncooked')
    service.stop();expect((await service.extract(blob,'Content/Meshes/Renamed.uasset',doc)).reason).toContain('cancelled')
  } finally {ueHeadlessService.findEditorBinary=original.find;ueHeadlessService.runCommandlet=original.run}
})

test('cancelled queued native exports release their queue entries without spawning an engine', async () => {
  const dir=tmpDir('lg-native-queue-'),blob=path.join(dir,'left.uasset'),editor=path.join(dir,'engine');fs.writeFileSync(blob,'snapshot');fs.writeFileSync(editor,'engine')
  const original={find:ueHeadlessService.findEditorBinary,run:ueHeadlessService.runCommandlet};let started,release,calls=0
  const running=new Promise(resolve=>started=resolve)
  ueHeadlessService.findEditorBinary=async()=>editor
  ueHeadlessService.runCommandlet=async()=>{calls++;started();return new Promise(resolve=>release=()=>resolve({success:false,error:'controlled failure',output:'',outputPath:null}))}
  try {
    const service=new NativeMeshService(),first=service.extract(blob,'Content/First.uasset',doc);await running
    const controller=new AbortController(),second=service.extract(blob,'Content/Second.uasset',doc,controller.signal)
    controller.abort();expect((await second).reason).toContain('cancelled');expect(calls).toBe(1)
    release();expect((await first).reason).toBe('controlled failure');expect(service.waiting).toHaveLength(0)
    expect(fs.readdirSync(dir).some(name=>name.startsWith('native-'))).toBe(false)
  } finally {ueHeadlessService.findEditorBinary=original.find;ueHeadlessService.runCommandlet=original.run}
})

for(const kind of ['static','skeletal']) test(`real ${kind} mesh exports bounded source LODs from immutable Git revisions without changing assets`, async ({}, testInfo) => {
  test.setTimeout(300000)
  const fixture=process.env[kind==='static'?'UNREAL_NATIVE_MESH':'UNREAL_NATIVE_SKELETAL']
  test.skip(!fixture,'Enable a local source mesh fixture and matching installed Unreal engine')
  const before=fs.readFileSync(fixture),repo=tmpDir('lg-native-real-'),cache=tmpDir('lg-native-real-cache-'),file='Content/Meshes/Renamed.uasset'
  git(repo,'init','-q');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.com');fs.mkdirSync(path.dirname(path.join(repo,file)),{recursive:true});fs.copyFileSync(fixture,path.join(repo,file));git(repo,'add','-A');git(repo,'commit','-qm','mesh');const commit=git(repo,'rev-parse','HEAD').trim()
  // The working file is deliberately invalid: the pinned Git capture must still export.
  fs.chmodSync(path.join(repo,file),0o666)
  fs.writeFileSync(path.join(repo,file),'unavailable working replacement')
  const {BlueprintRevisionService}=require(path.join(DIST,'services/BlueprintRevisionService'))
  const service=new BlueprintRevisionService(path.join(root,'tools/BlueprintExtractor/bin/Release/net10.0'),cache)
  const result=await service.compare(repo,{filePath:file,leftRef:'ABSENT',rightRef:commit,requestId:'native-real',nativeGeometry:true})
  expect(result.right.status).toBe('ready');expect(result.right.resolvedRef).toBe(commit);expect(result.right.geometry.reason).toBeUndefined();expect(result.right.geometry.status).toBe('ready');expect(result.right.geometry.totalLods).toBeGreaterThan(0)
  if(kind==='static')expect(result.right.geometry.lods[0]).toMatchObject({vertexCount:8,triangleCount:12})
  expect(result.right.geometry.lods.some(lod=>lod.vertices.length>0)).toBe(true)
  const evidence={kind,engine:result.right.geometry.engineVersion,totalLods:result.right.geometry.totalLods,sourceBytes:result.right.sourceBytes,geometryBytes:Buffer.byteLength(JSON.stringify(result.right.geometry)),lods:result.right.geometry.lods.map(({index,vertexCount,triangleCount,reason})=>({index,vertexCount,triangleCount,reason}))}
  console.log('Native fixture evidence:',JSON.stringify(evidence))
  await testInfo.attach('native-geometry.json',{body:Buffer.from(JSON.stringify(result.right.geometry)),contentType:'application/json'})
  expect(fs.readFileSync(fixture)).toEqual(before);expect(fs.readFileSync(path.join(repo,file),'utf8')).toBe('unavailable working replacement')
  expect(fs.readdirSync(cache).some(name=>name.startsWith('read-'))).toBe(false)
})

test('shared native mesh preview requests exact refs once, retains LOD/camera and exposes missing-side geometry', async ({page},testInfo) => {
  const dir=tmpDir('lg-native-browser-'),base=geometry(),edited=geometry();base.lods=base.lods.slice(0,1);base.totalLods=1;edited.lods[0]={index:0,vertexCount:100000,triangleCount:200000,vertices:[],indices:[],reason:'Source geometry exceeds preview budget.'}
  const result={left:{ref:'a'.repeat(40),status:'ready',path:'Content/Meshes/Renamed.uasset',document:doc},right:{ref:'WORKING',status:'ready',path:'Content/Meshes/Renamed.uasset',document:doc}}
  await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/Meshes/Renamed.uasset',oldPath:'Content/Old.uasset',leftRef:'${'a'.repeat(40)}',rightRef:'WORKING'}}/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
  const server=http.createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.calls=[];window.lucidGit={blueprintCompare:async(_,r)=>{window.calls.push(r);const result=${JSON.stringify(result)};if(r.nativeGeometry){result.left.geometry=${JSON.stringify(base)};result.right.geometry=${JSON.stringify(edited)}}return result},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`)}
    res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',e=>errors.push(e.message))
  try {
    await page.setViewportSize({width:1100,height:800});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Preview',exact:true}).click();await page.getByRole('button',{name:'Preview source mesh with Unreal',exact:true}).click()
    const field=page.getByRole('region',{name:'Unreal source mesh preview'});await expect(field.locator('polygon')).toHaveCount(1)
    await expect(page.getByRole('combobox',{name:'Source LOD'})).toContainText('LOD 1')
    await page.getByRole('combobox',{name:'Source LOD'}).click();await page.getByRole('option',{name:'LOD 0',exact:true}).click();await expect(page.locator('.uar-mesh')).toContainText('Source geometry exceeds preview budget.');await expect(field).toHaveCount(0)
    await page.getByRole('combobox',{name:'Source LOD'}).click();await page.getByRole('option',{name:'LOD 1',exact:true}).click();await field.focus();await page.keyboard.press('+');await page.getByRole('button',{name:'Wireframe',exact:true}).click()
    await page.getByRole('button',{name:'Contents',exact:true}).click();await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.getByRole('combobox',{name:'Source LOD'})).toContainText('LOD 1');await expect(field.locator('polygon').first()).toHaveAttribute('fill','none')
    await page.getByRole('button',{name:'Base',exact:true}).click();await expect(page.locator('.uar-mesh')).toContainText('This source LOD is unavailable in this revision.');await expect(field).toHaveCount(0)
    await page.getByRole('button',{name:'Selected',exact:true}).click();await expect(field).toHaveCount(1);await page.screenshot({path:testInfo.outputPath('native-source-mesh.png')})
    await page.setViewportSize({width:480,height:640});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    await page.getByRole('button',{name:'Saved collision',exact:true}).click();await page.getByRole('button',{name:'Preview source mesh with Unreal',exact:true}).click();expect(await page.evaluate(()=>window.calls.length)).toBe(2)
    const request=await page.evaluate(()=>window.calls[1]);expect(request).toMatchObject({oldPath:'Content/Old.uasset',leftRef:'a'.repeat(40),rightRef:'WORKING',nativeGeometry:true});expect(errors).toEqual([])
  } finally {await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
