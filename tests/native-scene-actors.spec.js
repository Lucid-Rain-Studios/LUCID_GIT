const {test,expect}=require('@playwright/test')
const fs=require('node:fs'),path=require('node:path'),http=require('node:http')
const {component}=require('./renderer-harness'),{tmpDir,cleanup,git,DIST}=require('./helpers')
const {nativeActorChanges}=component('src/lib/nativeSceneReview.ts').exports
const actor=(name,location=[0,0,0])=>({name,path:'/Game/Map.Map:PersistentLevel.'+name,location,saved:true})
const scene=actors=>({status:'ready',engineVersion:'5.8.3',packages:[],diagnostics:[],complete:true,actorInventoryComplete:true,actors})
test.afterAll(cleanup)

test('native placements compare unique paths and reject incomplete presence, duplicate identities and incompatible exports',()=>{
 const old=actor('Moved'),next={...old,name:'New label',location:[100,200,300]},left=scene([old,actor('Removed')]),right=scene([next,actor('Added')])
 const result=nativeActorChanges([left,right],['Content/Map.umap','Content/Map.umap'])
 expect(result.changes.get(old.path)).toMatchObject({kind:'modified',delta:[100,200,300]});expect(result.changes.get(actor('Added').path).kind).toBe('added');expect(result.changes.get(actor('Removed').path).kind).toBe('removed')
 right.complete=false;right.actorInventoryComplete=false
 const partial=nativeActorChanges([left,right],['Content/Map.umap','Content/Map.umap']);expect(partial.changes.get(old.path).kind).toBe('modified');expect(partial.changes.get(actor('Added').path).kind).toBe('unknown');expect(partial.changes.get(actor('Removed').path).kind).toBe('unknown')
 expect(nativeActorChanges([left,scene([next,next])]).changes.get(old.path).kind).toBe('unknown')
 expect(nativeActorChanges([left,{...right,engineVersion:'5.7.0'}]).comparable).toBe(false)
 expect(nativeActorChanges([left,{...right,complete:true,actorInventoryComplete:undefined}],['Content/Map.umap','Content/Map.umap']).changes.get(actor('Added').path).kind).toBe('unknown')
 expect(nativeActorChanges([left,scene([next,actor('Added')])],['Content/Old.umap','Content/New.umap']).changes.get(actor('Added').path).kind).toBe('unknown')
 expect(nativeActorChanges([left,scene([{...next,location:[NaN,0,0]}])]).changes.get(old.path).kind).toBe('unknown')
 expect(nativeActorChanges([scene([old]),scene([{...old,location:[.00001,0,0]}])]).changes.get(old.path).kind).toBe('unchanged')
 expect(nativeActorChanges([scene([old]),scene([{...old,saved:false}])]).changes.get(old.path).kind).toBe('unknown')
})
for(const [kind,variable] of [['placement','UNREAL_SCENE_WORLD_DIFF'],['membership','UNREAL_SCENE_WORLD_MEMBERSHIP']])test(`real native world ${kind} comparison stays pinned with verified actor inventories`,async()=>{
 test.setTimeout(600000);const fixture=process.env[variable];test.skip(!fixture,'Enable a moved-parent map fixture')
 const beforeFile=path.join(path.dirname(path.dirname(fixture)),'FixtureMap.before.umap'),before=fs.readFileSync(beforeFile),after=fs.readFileSync(fixture),repo=tmpDir('lg-world-placement-'),cache=tmpDir('lg-world-placement-cache-'),file='Content/FixtureMap.umap',root=path.resolve(__dirname,'..')
 git(repo,'init','-q');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.com');fs.mkdirSync(path.join(repo,'Content'));fs.writeFileSync(path.join(repo,file),before);fs.copyFileSync(path.join(path.dirname(fixture),'SubFixture.umap'),path.join(repo,'Content/SubFixture.umap'));fs.writeFileSync(path.join(repo,'Fixture.uproject'),JSON.stringify({FileVersion:3,EngineAssociation:'5.8'}));git(repo,'add','-A');git(repo,'commit','-qm','base');const base=git(repo,'rev-parse','HEAD').trim();fs.writeFileSync(path.join(repo,file),after);git(repo,'add','-A');git(repo,'commit','-qm','move parent');const selected=git(repo,'rev-parse','HEAD').trim();fs.writeFileSync(path.join(repo,file),'invalid working bytes')
 const {BlueprintRevisionService}=require(path.join(DIST,'services/BlueprintRevisionService')),service=new BlueprintRevisionService(path.join(root,'tools/BlueprintExtractor/bin/Release/net10.0'),cache),result=await service.compare(repo,{filePath:file,leftRef:base,rightRef:selected,requestId:'world-placement',nativeScene:true})
 expect(result.left.scene.status).toBe('ready');expect(result.right.scene.status).toBe('ready')
 console.log('native inventory',result.left.scene.actorInventoryComplete,result.left.scene.actorInventory,result.right.scene.actorInventory)
 expect(result.left.scene.actorInventoryComplete).toBe(true);expect(result.right.scene.actorInventoryComplete).toBe(true)
 const changes=nativeActorChanges([result.left.scene,result.right.scene],[file,file]).changes
 if(kind==='placement'){
  const parent=[...changes.values()].find(change=>change.before?.name==='Captured Parent'),child=[...changes.values()].find(change=>change.before?.name==='Captured Child')
  expect(parent).toMatchObject({kind:'modified',delta:[25,0,0]});expect(parent.after.name).toBe('Moved Parent');expect(child.kind).toBe('moved');expect(child.delta[0]).toBeCloseTo(25)
 }else{
  expect([...changes.values()].find(change=>change.before?.name==='Captured Child').kind).toBe('removed')
  expect([...changes.values()].find(change=>change.after?.name==='Added Actor')).toMatchObject({kind:'added',after:{location:[500,300,20]}})
  expect(result.left.scene.complete).toBe(false);expect(result.right.scene.complete).toBe(false)
 }
 expect(fs.readFileSync(fixture)).toEqual(after);expect(fs.readFileSync(beforeFile)).toEqual(before);expect(fs.readFileSync(path.join(repo,file),'utf8')).toBe('invalid working bytes')
})

test('native actor search precedes row limits and comparison filters retain selection across revision sides',async({page},info)=>{
 const dir=tmpDir('lg-native-actor-browser-'),root=path.resolve(__dirname,'..'),actors=Array.from({length:1105},(_,i)=>actor('Actor_'+i)),late=actors[1104]
 late.name='Late actor';const left=scene(actors),right=scene([...actors.map(a=>a===late?{...a,location:[100,200,300]}:a),actor('Added actor'),{...actor('Helper'),saved:false}])
 await require('esbuild').build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {NativeSceneActors} from './src/components/diff/NativeSceneActors';import './src/index.css';import './src/components/diff/UnrealAssetReview.css';const scenes=${JSON.stringify([left,right])};function App(){const[side,setSide]=useState('right'),[partial,setPartial]=useState(false);const data=React.useMemo(()=>partial?[scenes[0],{...scenes[1],complete:false,actorInventoryComplete:false}]:scenes,[partial]);return <div className="uar"><button onClick={()=>setSide(side==='right'?'left':'right')}>Switch revision</button><button onClick={()=>setPartial(true)}>Partial capture</button><NativeSceneActors scenes={data} side={side} paths={['Content/Map.umap','Content/Map.umap']} labels={{left:'Base',right:'Selected'}} onSelect={actor=>window.selected=actor.path}/></div>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>')}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',error=>errors.push(error.message))
 try{
  await page.setViewportSize({width:480,height:740});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('summary').click();await expect(page.locator('.uar-row')).toHaveCount(1000)
  await page.getByLabel('Filter native actors').fill('Late actor');await expect(page.locator('.uar-row')).toHaveCount(1);await expect(page.locator('.uar-row')).toContainText('Moved');await expect(page.locator('.uar-row')).toContainText('Base: 0, 0, 0 cm');await expect(page.locator('.uar-row')).toContainText('Δ 100, 200, 300 cm')
  await page.locator('.uar-row').click();expect(await page.evaluate(()=>window.selected)).toBe(late.path);await page.getByRole('button',{name:'Changed actors only',exact:true}).click();await page.getByRole('button',{name:'Switch revision',exact:true}).click();await expect(page.getByLabel('Filter native actors')).toHaveValue('Late actor');await expect(page.locator('.uar-row')).toHaveAttribute('aria-pressed','true')
  await page.getByRole('button',{name:'Switch revision',exact:true}).click();await page.getByLabel('Filter native actors').fill('Added actor');await expect(page.locator('.uar-row')).toContainText('Added');await page.getByRole('button',{name:'Partial capture',exact:true}).click();await expect(page.locator('.uar-row')).toContainText('Unconfirmed')
  await page.getByRole('button',{name:'Changed actors only',exact:true}).click();await page.getByLabel('Filter native actors').fill('Helper');await expect(page.locator('.uar-row')).toHaveCount(0);await page.getByRole('button',{name:'Include engine-generated',exact:true}).click();await expect(page.locator('.uar-row')).toHaveCount(1)
  await page.getByLabel('Filter native actors').fill('Late actor');await page.screenshot({path:info.outputPath('native-actor-comparison.png')});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([])
 }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
