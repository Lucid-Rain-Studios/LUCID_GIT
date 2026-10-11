const {test,expect}=require('@playwright/test')
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{execFileSync}=require('node:child_process')
const {component}=require('./renderer-harness'),{tmpDir,cleanup}=require('./helpers')
const root=path.resolve(__dirname,'..'),{animationTimeline,animationMetadata}=component('src/lib/animationTimeline.ts', {'./blendSpaceReview':component('src/lib/blendSpaceReview.ts').exports}).exports
const anchor=time=>({LinkValue:time,LinkMethod:{EnumValue:'EAnimLinkMethod::Absolute'},CachedLinkMethod:{EnumValue:'EAnimLinkMethod::Absolute'}})
const segment=()=>({StartPos:0,AnimStartTime:0,AnimEndTime:1,AnimPlayRate:1,LoopingCount:1,AnimReference:'/Game/Anim.Run'})
const object=properties=>({id:'',path:'Montage',name:'Montage',classPath:'/Script/Engine.AnimMontage',outer:'None',properties,decoded:true,opaqueBytes:0,opaqueHash:'',diagnostics:[]})
test.afterAll(cleanup)

test('authored timing requires explicit finite values and absolute saved link profiles',()=>{
 const value=segment();value.AnimPlayRate=-2;value.LoopingCount=3
 const model=animationTimeline([object({SequenceLength:3,CompositeSections:[{...anchor(0),SectionName:'Start'}],SlotAnimTracks:[{SlotName:'Main',AnimTrack:{AnimSegments:[value]}}],Notifies:[{...anchor(.5),NotifyName:'Fire',Duration:.25}]})])
 expect(model.entries.map(e=>[e.kind,e.start,e.end])).toEqual([['Section',0,undefined],['Segment',0,1.5],['Notify',.5,.75]])
 const invalid=[segment(),segment(),segment(),segment(),segment(),segment()]
 delete invalid[0].AnimPlayRate;invalid[1].AnimPlayRate=0;invalid[2].LoopingCount=1.5;invalid[3].AnimEndTime=-1;invalid[4].StartPos='';invalid[5].AnimEndTime=Infinity
 expect(animationTimeline([object({SlotAnimTracks:[{AnimTrack:{AnimSegments:invalid}}]})]).entries.every(e=>e.start===undefined&&e.reason)).toBe(true)
 const links=[anchor(''),anchor(.5),anchor(.5),anchor(.5)]
 links[1].CachedLinkMethod={EnumValue:'EAnimLinkMethod::Relative'};delete links[2].LinkMethod;links[3].LinkValue=NaN
 expect(animationTimeline([object({CompositeSections:links})]).entries.every(e=>e.start===undefined)).toBe(true)
 const opaque={...object({SequenceLength:2,Notifies:[anchor(0)]}),opaqueProperties:['SequenceLength','Notifies']}
 expect(animationTimeline([opaque])).toMatchObject({entries:[],length:undefined})
 expect(animationTimeline([object({}),object({})]).object).toBeUndefined()
 expect(animationTimeline([object({SequenceLength:''})]).length).toBeUndefined()
 const overflow=segment();overflow.AnimEndTime=Number.MAX_VALUE;overflow.LoopingCount=3
 expect(animationTimeline([object({SlotAnimTracks:[{AnimTrack:{AnimSegments:[overflow]}}]})]).entries[0].start).toBeUndefined()
})

test('timing entry budgets are shared across sections, segments and notifies while metadata retains absent fields',()=>{
 const root=object({CompositeSections:Array.from({length:600},()=>anchor(0)),SlotAnimTracks:[{AnimTrack:{AnimSegments:Array.from({length:600},segment)}}],Notifies:Array.from({length:600},()=>anchor(0))})
 expect(animationTimeline([root])).toMatchObject({omitted:800});expect(animationTimeline([root]).entries).toHaveLength(1000)
 expect(animationMetadata([object({SequenceLength:2,Skeleton:'/Game/Skel.Skel',Unrelated:'x'})])[0].fields.map(([name])=>name)).toEqual(['SequenceLength','Skeleton'])
 expect(animationMetadata([object({})])[0].fields).toEqual([])
})

const read=file=>JSON.parse(execFileSync('dotnet',['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',file],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}))
test('real montage exposes saved segment ranges and section anchor without changing bytes',()=>{
 const file=process.env.UNREAL_REVIEW_MONTAGE;test.skip(!file,'Set real montage fixture')
 const before=fs.readFileSync(file),doc=read(file),model=animationTimeline(doc.assetReview.objects)
 expect(doc.assetReview.family).toBe('animation-sequence');expect(model.length).toBeCloseTo(1.3,6)
 expect(model.entries).toHaveLength(3);expect(model.entries[0]).toMatchObject({kind:'Section',start:0,label:'Default'})
 const segments=model.entries.filter(e=>e.kind==='Segment')
 expect(segments[0].end).toBeCloseTo(.65,6);expect(segments[1].start).toBeCloseTo(.65,6);expect(segments[1].end).toBeCloseTo(1.3,6)
 expect(model.object.references.some(r=>r.propertyPath==='SlotAnimTracks[0].AnimTrack.AnimSegments[0].AnimReference'&&r.className==='AnimSequence')).toBe(true)
 expect(fs.readFileSync(file)).toEqual(before)
})

test('real sequences distinguish saved duration from native data with unavailable duration',()=>{
 const file=process.env.UNREAL_REVIEW_SEQUENCE,missing=process.env.UNREAL_REVIEW_NATIVE_SEQUENCE;test.skip(!file||!missing,'Set real sequence fixtures')
 for(const [fixture,length] of [[file,1.5],[missing,undefined]]){
  const before=fs.readFileSync(fixture),doc=read(fixture),model=animationTimeline(doc.assetReview.objects)
  expect(model.length).toBe(length);expect(model.entries).toEqual([]);expect(fs.readFileSync(fixture)).toEqual(before)
 }
})

test('shared timing preview inspects authored entries, metadata, revision references and narrow layout with one capture',async({page},testInfo)=>{
 const dir=tmpDir('lg-animation-timing-'),commit='a'.repeat(40)
 const base=object({SequenceLength:2,Skeleton:'/Game/Anim/Skel.Skel',CompositeSections:[{...anchor(0),SectionName:'Start'}],SlotAnimTracks:[{SlotName:'Main',AnimTrack:{AnimSegments:[segment()]}}],Notifies:[{...anchor(.25),NotifyName:'Fire',Duration:.2}]})
 base.references=[{propertyPath:'Skeleton',target:'/Game/Anim/Skel.Skel',className:'Skeleton'}]
 const edited=JSON.parse(JSON.stringify(base));edited.properties.SlotAnimTracks[0].AnimTrack.AnimSegments[0].StartPos=.5
 const doc=object=>({schemaVersion:1,readerVersion:12,assetClass:'/Script/Engine.AnimMontage',engineVersion:'5.8.3',graphs:[],status:'unsupported',diagnostics:[],assetReview:{family:'animation-sequence',objects:[object],coverage:['Saved subset; native poses unavailable'],cooked:false}})
 const result={left:{status:'ready',ref:'HEAD',resolvedRef:commit,document:doc(base)},right:{status:'ready',ref:'WORKING',document:doc(edited)}}
 await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import {useAssetViewerStore} from './src/stores/assetViewerStore';import './src/index.css';useAssetViewerStore.subscribe(state=>window.opened={path:state.filePath,ref:state.revision});createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/Anim/Montage.uasset',leftRef:'HEAD',rightRef:'WORKING'}}/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.calls=[];window.lucidGit={blueprintCompare:async(_,r)=>{window.calls.push(r);return ${JSON.stringify(result)}},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`)}
  res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',e=>errors.push(e.message))
 try{
  await page.setViewportSize({width:1100,height:800});await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button',{name:'Preview',exact:true}).click();const timing=page.getByRole('region',{name:'Saved animation timing'})
  await expect(timing.locator('.uar-timing-row')).toHaveCount(3);await expect(timing).toContainText('0.500 s → 1.500 s')
  await timing.getByRole('button',{name:/Segment: Main/}).click();await expect(timing).toContainText('Selected saved timing fields: Main')
  await expect(page.getByRole('region',{name:'Saved object details'})).toContainText('Montage')
  const width=await timing.locator('.uar-timing-track span').nth(1).evaluate(el=>getComputedStyle(el).width)
  await page.getByRole('button',{name:'Base',exact:true}).click();await expect(timing).toContainText('0.000 s → 1.000 s')
  expect(await timing.locator('.uar-timing-track span').nth(1).evaluate(el=>getComputedStyle(el).width)).toBe(width)
  await timing.getByRole('button',{name:'Inspect animation and saved references',exact:true}).click()
  await page.getByRole('button',{name:'Open base Skeleton',exact:true}).click();expect(await page.evaluate(()=>window.opened)).toEqual({path:'Content/Anim/Skel.uasset',ref:commit})
  await page.getByRole('button',{name:'Contents',exact:true}).click();await expect(page.getByRole('region',{name:'Saved animation metadata'})).toContainText('SequenceLength: 2')
  await page.getByRole('button',{name:'All objects',exact:true}).click();await expect(page.locator('.uar-content .uar-row')).toHaveCount(1)
  await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.getByRole('button',{name:'Preview',exact:true})).toHaveAttribute('aria-pressed','true');await expect(timing).toContainText('0.000 s → 1.000 s');await expect(timing).toContainText('Selected saved timing fields: Main')
  await page.screenshot({path:testInfo.outputPath('animation-timing.png')})
  await page.setViewportSize({width:480,height:640});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  expect(await page.evaluate(()=>window.calls.length)).toBe(1);expect(errors).toEqual([])
 }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
