const { test, expect } = require('@playwright/test')
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{execFileSync}=require('node:child_process')
const {component}=require('./renderer-harness'),{tmpDir,cleanup}=require('./helpers')
const root=path.resolve(__dirname,'..')
const {blendSpaceModel,blendSpaceBounds}=component('src/lib/blendSpaceReview.ts').exports
const object=(properties={},classPath='/Script/Engine.BlendSpace')=>({id:'',name:'Blend',path:'Blend',outer:'None',classPath,properties,decoded:true,opaqueBytes:0,opaqueHash:'',diagnostics:[]})
const sample=(x,y,animation='/Game/Anim/Walk.Walk')=>({SampleValue:{SampleValue:{X:x,Y:y}},Animation:animation,RateScale:1})
test.afterAll(cleanup)

test('BlendSpace sample models require explicit coordinates, class and unambiguous roots',()=>{
 const model=blendSpaceModel([object({SampleData:[sample(0,10),sample('',10),sample(2,undefined),sample(Infinity,0)],'BlendParameters[0]':{DisplayName:'Direction',Min:-180,Max:180},'BlendParameters[1]':{DisplayName:'Speed',Max:600}})])
 expect(model.entries.map(e=>e.positioned)).toEqual([true,false,false,false]);expect(model.axes[1].min).toBeUndefined()
 const one=blendSpaceModel([object({SampleData:[sample(500,undefined)],BlendParameters:{DisplayName:'Speed',Max:500}},'/Script/Engine.BlendSpace1D')])
 expect(one.dimensions).toBe(1);expect(one.entries[0].positioned).toBe(true);expect(one.axes[0].min).toBeUndefined()
 expect(blendSpaceModel([object(),object()]).object).toBeUndefined()
 expect(blendSpaceModel([object({},'/Script/Engine.Material')]).object).toBeUndefined()
 expect(blendSpaceModel([{...object({SampleData:[sample(0,0)]}),opaqueProperties:['SampleData']}]).entries).toEqual([])
 const rawAxis=blendSpaceModel([{...object({'BlendParameters[0]':{Min:0,Max:99}}),opaqueProperties:['BlendParameters[0]']}]);expect(rawAxis.axes[0].max).toBeUndefined()
})

test('sample budget and shared observed bounds preserve omitted defaults',()=>{
 const model=blendSpaceModel([object({SampleData:Array.from({length:1200},(_,i)=>sample(i,i))})])
 expect(model.entries).toHaveLength(1000);expect(model.omitted).toBe(200)
 const other=blendSpaceModel([object({SampleData:[sample(-10,2000)]})])
 expect(blendSpaceBounds([model,other])).toEqual([{min:-10,max:999,available:true},{min:0,max:2000,available:true}])
 expect(blendSpaceBounds([blendSpaceModel([])])[0].available).toBe(false)
})

for(const [variable,dimensions,count] of [['UNREAL_REVIEW_BLENDSPACE',2,27],['UNREAL_REVIEW_BLENDSPACE1D',1,3]])test(`real ${dimensions}D BlendSpace exposes saved samples and static axis fields without changing bytes`,()=>{
 const file=process.env[variable];test.skip(!file,'Set real BlendSpace fixture')
 const bytes=fs.readFileSync(file),doc=JSON.parse(execFileSync('dotnet',['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',file],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024})),model=blendSpaceModel(doc.assetReview.objects)
 expect(doc.readerVersion).toBe(16);expect(model.object.decoded).toBe(true);expect(model.object.diagnostics).toEqual([])
 expect(model.dimensions).toBe(dimensions);expect(model.entries).toHaveLength(count);expect(model.entries.every(e=>e.positioned)).toBe(true)
 expect(model.axes[dimensions-1].min).toBeUndefined()
 expect(model.object.references.some(r=>r.propertyPath==='SampleData[0].Animation'&&r.className==='AnimSequence')).toBe(true)
 if(dimensions===2){expect(model.axes[0]).toMatchObject({label:'Direction',min:-180,max:180});expect(model.axes[1]).toMatchObject({label:'Speed',max:600})}
 expect(fs.readFileSync(file)).toEqual(bytes)
})

test('shared BlendSpace UI retains sample selection, common scale, exact reference revision and bounded layout',async({page},testInfo)=>{
 const dir=tmpDir('lg-blend-review-'),commit='a'.repeat(40)
 const base=object({SampleData:[sample(-90,300),sample(90,600)],'BlendParameters[0]':{DisplayName:'Direction',Min:-180,Max:180},'BlendParameters[1]':{DisplayName:'Speed',Max:600}})
 base.references=[{propertyPath:'SampleData[0].Animation',target:'/Game/Anim/Walk.Walk',className:'AnimSequence'}]
 const edited=JSON.parse(JSON.stringify(base));edited.properties.SampleData[0].SampleValue.SampleValue.X=-45
 const doc=object=>({schemaVersion:1,readerVersion:16,assetClass:object.classPath,engineVersion:'5.8.3',graphs:[],status:'unsupported',diagnostics:[],assetReview:{family:'asset',objects:[object],coverage:['Saved samples; native poses unavailable'],cooked:false}})
 const result={left:{status:'ready',ref:'HEAD',resolvedRef:commit,document:doc(base)},right:{status:'ready',ref:'WORKING',document:doc(edited)}}
 await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import {useAssetViewerStore} from './src/stores/assetViewerStore';import './src/index.css';useAssetViewerStore.subscribe(state=>window.opened={path:state.filePath,ref:state.revision});createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/Anim/Blend.uasset',leftRef:'HEAD',rightRef:'WORKING'}}/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.calls=[];window.lucidGit={blueprintCompare:async(_,r)=>{window.calls.push(r);return ${JSON.stringify(result)}},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`)}
  res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',e=>errors.push(e.message))
 try{
  await page.setViewportSize({width:1100,height:850});await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button',{name:'Preview',exact:true}).click();const plot=page.getByRole('region',{name:'Authored BlendSpace sample positions'})
  await expect(plot.locator('.uar-map-dot')).toHaveCount(2)
  const secondStyle=await plot.locator('.uar-map-dot').nth(1).getAttribute('style')
  await plot.locator('.uar-map-dot').first().focus();await page.keyboard.press('Enter')
  await expect(page.getByRole('region',{name:'Selected saved BlendSpace sample'})).toContainText('-45')
  await page.getByRole('button',{name:'Base',exact:true}).click()
  await expect(plot.locator('.uar-map-dot').first()).toHaveAttribute('aria-pressed','true')
  await expect(page.getByRole('region',{name:'Selected saved BlendSpace sample'})).toContainText('-90')
  expect(await plot.locator('.uar-map-dot').nth(1).getAttribute('style')).toBe(secondStyle)
  await page.getByRole('button',{name:'Open base SampleData[0].Animation',exact:true}).click();expect(await page.evaluate(()=>window.opened)).toEqual({path:'Content/Anim/Walk.uasset',ref:commit})
  await page.getByRole('button',{name:'Contents',exact:true}).click();await expect(page.getByRole('region',{name:'Saved animation metadata'})).toContainText('SampleData: 2 saved entries')
  await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(plot.locator('.uar-map-dot').first()).toHaveAttribute('aria-pressed','true')
  await page.screenshot({path:testInfo.outputPath('blendspace-samples.png')})
  await page.setViewportSize({width:480,height:640});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  expect(await page.evaluate(()=>window.calls.length)).toBe(1);expect(errors).toEqual([])
 }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
