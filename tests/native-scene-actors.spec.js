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
test('repeated source GUIDs match only within their saved instance-owner chain',()=>{
 const make=(id,world)=>({...actor('Repeated'),path:'/Game/'+world+'.Source:PersistentLevel.Cube',sourcePath:'/Game/Source.Source:PersistentLevel.Cube',instancePath:id,guid:'c'.repeat(32)}),one=make('a'.repeat(32),'One'),two=make('b'.repeat(32),'Two'),right=[{...one,location:[100,0,0]},two],paths=['Content/Map.umap','Content/Map.umap']
 const changes=nativeActorChanges([scene([one,two]),scene(right)],paths).changes
 expect(changes.get(one.path)).toMatchObject({kind:'moved',identity:'guid',delta:[100,0,0]});expect(changes.get(two.path).kind).toBe('unchanged')
 const ambiguous=nativeActorChanges([scene([one,{...two,instancePath:one.instancePath}]),scene(right)],paths).changes
 expect(ambiguous.get(one.path).kind).toBe('unknown')
 expect(nativeActorChanges([scene([{...one,instancePath:'invalid'}]),scene(right)],paths).changes.get(one.path).kind).toBe('unknown')
 const renamed={...one,path:'/Game/Renamed.Source:PersistentLevel.Cube'};expect(nativeActorChanges([scene([one]),scene([renamed])],paths).changes.get(one.path).kind).toBe('repathed')
})

test('native pose comparison detects scale/rotation and rejects invalid poses without quaternion sign noise',()=>{
 const old={...actor('Pose'),rotation:[0,0,0,1],scale:[1,1,1]},paths=['Content/Map.umap','Content/Map.umap'],change=next=>nativeActorChanges([scene([old]),scene([next])],paths).changes.get(old.path)
 expect(change({...old,scale:[2,3,1.5]})).toMatchObject({kind:'scaled',scaleChanged:true})
 const rotated=change({...old,rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2]});expect(rotated.kind).toBe('rotated');expect(rotated.rotationDegrees).toBeCloseTo(90,6)
 expect(change({...old,rotation:[0,0,0,-1]}).kind).toBe('unchanged')
 expect(change({...old,rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2],scale:[2,2,2]}).kind).toBe('modified')
 for(const bad of [{rotation:[0,0,0,0]},{rotation:[0,0,0,2]},{rotation:null},{scale:[1,NaN,1]},{scale:null}])expect(change({...old,...bad}).kind).toBe('unknown')
 expect(change({...old,rotation:undefined,scale:undefined}).kind).toBe('unchanged')
 const huge={...old,scale:[-1e308,1,1]};expect(nativeActorChanges([scene([huge]),scene([{...huge,scale:[1e308,1,1]}])],paths).changes.get(old.path).kind).toBe('unknown')
})

test('GUID identities survive path changes and refuse recreated, duplicate, swapped and invalid identities',()=>{
 const old={...actor('Old'),guid:'a'.repeat(32)},next={...actor('New'),guid:old.guid,location:[10,0,0]},paths=['Content/Map.umap','Content/Map.umap']
 const changes=nativeActorChanges([scene([old]),scene([next])],paths).changes
 expect(changes.get(old.path)).toMatchObject({kind:'modified',identity:'guid',pathChanged:true,delta:[10,0,0]});expect(changes.get(next.path)).toBe(changes.get(old.path))
 expect(nativeActorChanges([scene([old]),scene([{...next,name:old.name,location:old.location}])],['Content/Old.umap','Content/New.umap']).changes.get(old.path)).toMatchObject({kind:'repathed',identity:'guid'})
 expect(nativeActorChanges([scene([old]),scene([{...old,guid:'b'.repeat(32)}])],paths).changes.get(old.path).kind).toBe('replaced')
 expect(nativeActorChanges([scene([old]),{...scene([{...old,guid:'b'.repeat(32)}]),actorInventoryComplete:false}],paths).changes.get(old.path).kind).toBe('unknown')
 for(const guid of ['invalid','0'.repeat(32)])expect(nativeActorChanges([scene([{...old,guid}]),scene([next])],paths).changes.get(old.path).kind).toBe('unknown')
 expect(nativeActorChanges([scene([old,{...actor('Duplicate'),guid:old.guid}]),scene([next])],paths).changes.get(next.path).kind).toBe('unknown')
 const second={...actor('Second'),guid:'b'.repeat(32)}
 const swapped=nativeActorChanges([scene([old,second]),scene([{...old,path:second.path},{...second,path:old.path}])],paths)
 expect(swapped.changes.get(old.path).kind).toBe('unknown');expect(swapped.changes.get(second.path).kind).toBe('unknown')
 expect(nativeActorChanges([scene([old]),scene([{...old,guid:undefined}])],paths).changes.get(old.path).identity).toBe('path')
 expect(nativeActorChanges([scene([old]),{...scene([next]),engineVersion:'5.7'}],paths).changes.get(old.path).kind).toBe('unknown')
 expect(nativeActorChanges([scene([old]),scene([{...next,location:[NaN,0,0]}])],paths).changes.get(old.path).kind).toBe('unknown')
})

for(const [kind,variable] of [['placement','UNREAL_SCENE_WORLD_DIFF'],['membership','UNREAL_SCENE_WORLD_MEMBERSHIP'],['rename','UNREAL_SCENE_WORLD_RENAME'],['pose','UNREAL_SCENE_WORLD_SCALE_DIFF']])test(`real native world ${kind} comparison stays pinned with verified actor inventories`,async()=>{
 test.setTimeout(600000);const fixture=process.env[variable];test.skip(!fixture,'Enable a moved-parent map fixture')
 const beforeFile=path.join(path.dirname(path.dirname(fixture)),'FixtureMap.before.umap'),before=fs.readFileSync(beforeFile),after=fs.readFileSync(fixture),repo=tmpDir('lg-world-placement-'),cache=tmpDir('lg-world-placement-cache-'),oldFile='Content/FixtureMap.umap',file=kind==='rename'?'Content/RenamedMap.umap':oldFile,root=path.resolve(__dirname,'..')
 git(repo,'init','-q');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.com');fs.mkdirSync(path.join(repo,'Content'));fs.writeFileSync(path.join(repo,oldFile),before);fs.copyFileSync(path.join(path.dirname(fixture),'SubFixture.umap'),path.join(repo,'Content/SubFixture.umap'))
 if(kind==='pose')fs.copyFileSync(path.join(path.dirname(fixture),'NestedLeaf.umap'),path.join(repo,'Content/NestedLeaf.umap'))
 fs.writeFileSync(path.join(repo,'Fixture.uproject'),JSON.stringify({FileVersion:3,EngineAssociation:'5.8'}));git(repo,'add','-A');git(repo,'commit','-qm','base');const base=git(repo,'rev-parse','HEAD').trim();if(kind==='rename')fs.unlinkSync(path.join(repo,oldFile));fs.writeFileSync(path.join(repo,file),after);git(repo,'add','-A');git(repo,'commit','-qm','selected world');const selected=git(repo,'rev-parse','HEAD').trim();fs.writeFileSync(path.join(repo,file),'invalid working bytes')
 const {BlueprintRevisionService}=require(path.join(DIST,'services/BlueprintRevisionService')),service=new BlueprintRevisionService(path.join(root,'tools/BlueprintExtractor/bin/Release/net10.0'),cache),result=await service.compare(repo,{filePath:file,oldPath:kind==='rename'?oldFile:undefined,leftRef:base,rightRef:selected,requestId:'world-placement',nativeScene:true})
 expect(result.left.scene.status).toBe('ready');expect(result.right.scene.status).toBe('ready')
 console.log('native inventory',result.left.scene.actorInventoryComplete,result.left.scene.actorInventory,result.right.scene.actorInventory)
 expect(result.left.scene.actorInventoryComplete).toBe(true);expect(result.right.scene.actorInventoryComplete).toBe(true)
 const changes=nativeActorChanges([result.left.scene,result.right.scene],[kind==='rename'?oldFile:file,file]).changes
 if(kind==='placement'){
  const parent=[...changes.values()].find(change=>change.before?.name==='Captured Parent'),child=[...changes.values()].find(change=>change.before?.name==='Captured Child')
  expect(parent).toMatchObject({kind:'modified',delta:[25,0,0]});expect(parent.after.name).toBe('Moved Parent');expect(child.kind).toBe('moved');expect(child.delta[0]).toBeCloseTo(25)
 }else if(kind==='pose'){
  for(const name of ['Captured Nested Actor','Captured Nested Child']){
   const old=result.left.scene.actors.find(actor=>actor.name===name),next=result.right.scene.actors.find(actor=>actor.name===name),change=changes.get(old.path)
   expect(old.guid).toBe(next.guid);expect(old.scale).toEqual([1,1,1]);expect(next.scale).toEqual([1,1.5,.75]);expect(change).toMatchObject({kind:'modified',identity:'guid',scaleChanged:true});expect(change.rotationDegrees).toBeUndefined();[-200,-1500,-115].forEach((value,index)=>expect(change.delta[index]).toBeCloseTo(value,6))
  }
 }else if(kind==='rename'){
  const parent=result.left.scene.actors.find(actor=>actor.name==='Captured Parent'),next=result.right.scene.actors.find(actor=>actor.name==='Captured Parent')
  expect(parent.guid).toMatch(/^[a-f0-9]{32}$/);expect(next.guid).toBe(parent.guid);expect(next.path).not.toBe(parent.path)
  expect(changes.get(parent.path)).toMatchObject({kind:'repathed',identity:'guid',pathChanged:true});expect(changes.get(next.path)).toBe(changes.get(parent.path))
 }else{
  expect([...changes.values()].find(change=>change.before?.name==='Captured Child').kind).toBe('removed')
  expect([...changes.values()].find(change=>change.after?.name==='Added Actor')).toMatchObject({kind:'added',after:{location:[500,300,20]}})
  expect(result.left.scene.complete).toBe(false);expect(result.right.scene.complete).toBe(false)
 }
 expect(fs.readFileSync(fixture)).toEqual(after);expect(fs.readFileSync(beforeFile)).toEqual(before);expect(fs.readFileSync(path.join(repo,file),'utf8')).toBe('invalid working bytes')
})

test('real repeated-level comparison moves only the selected instance of a shared source actor',async()=>{
 test.setTimeout(600000);const fixture=process.env.UNREAL_SCENE_INSTANCE_DIFF;test.skip(!fixture,'Enable a saved level-instance movement fixture')
 const root=path.resolve(__dirname,'..'),dir=path.dirname(fixture),beforeFile=path.join(path.dirname(dir),'InstanceMap.before.umap'),before=fs.readFileSync(beforeFile),after=fs.readFileSync(fixture),leaf=fs.readFileSync(path.join(dir,'InstanceLeaf.umap')),repo=tmpDir('lg-instance-diff-'),cache=tmpDir('lg-instance-cache-'),file='Content/InstanceMap.umap'
 git(repo,'init','-q');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.com');fs.mkdirSync(path.join(repo,'Content'));fs.writeFileSync(path.join(repo,file),before);fs.writeFileSync(path.join(repo,'Content/InstanceLeaf.umap'),leaf);fs.writeFileSync(path.join(repo,'Fixture.uproject'),JSON.stringify({FileVersion:3,EngineAssociation:'5.8'}));git(repo,'add','-A');git(repo,'commit','-qm','base');const base=git(repo,'rev-parse','HEAD').trim();fs.writeFileSync(path.join(repo,file),after);git(repo,'add','-A');git(repo,'commit','-qm','move one instance');const selected=git(repo,'rev-parse','HEAD').trim();fs.writeFileSync(path.join(repo,file),'invalid working map');fs.writeFileSync(path.join(repo,'Content/InstanceLeaf.umap'),'invalid working source')
 const {BlueprintRevisionService}=require(path.join(DIST,'services/BlueprintRevisionService')),service=new BlueprintRevisionService(path.join(root,'tools/BlueprintExtractor/bin/Release/net10.0'),cache),result=await service.compare(repo,{filePath:file,leftRef:base,rightRef:selected,requestId:'instance-diff',nativeScene:true})
 expect(result.left.scene.actorInventoryComplete).toBe(true);expect(result.right.scene.actorInventoryComplete).toBe(true)
 const copies=result.left.scene.actors.filter(actor=>actor.name==='Repeated Cube'),changes=nativeActorChanges([result.left.scene,result.right.scene],[file,file]).changes;expect(copies).toHaveLength(2)
 for(const copy of copies){const change=changes.get(copy.path);expect(change.identity).toBe('guid');expect(change.after.instancePath).toBe(copy.instancePath);expect(change.after.sourcePath).toBe(copy.sourcePath);expect(change.kind).toBe(copy.location[0]===110?'moved':'unchanged');if(copy.location[0]===110)expect(change.delta).toEqual([50,0,0])}
 expect(fs.readFileSync(fixture)).toEqual(after);expect(fs.readFileSync(beforeFile)).toEqual(before);expect(fs.readFileSync(path.join(dir,'InstanceLeaf.umap'))).toEqual(leaf);expect(fs.readFileSync(path.join(repo,file),'utf8')).toBe('invalid working map');expect(fs.readFileSync(path.join(repo,'Content/InstanceLeaf.umap'),'utf8')).toBe('invalid working source')
})

test('GUID path changes show both identities and select the actual revision-side actor at narrow widths',async({page})=>{
 const dir=tmpDir('lg-native-guid-browser-'),root=path.resolve(__dirname,'..'),old={...actor('Original'),guid:'a'.repeat(32),rotation:[0,0,0,1],scale:[1,1,1]},next={...actor('Renamed'),guid:old.guid,rotation:[0,0,Math.SQRT1_2,Math.SQRT1_2],scale:[2,3,1.5]},recreated={...actor('Recreated'),guid:'b'.repeat(32)},scenes=[scene([old,recreated]),scene([next,{...recreated,guid:'c'.repeat(32)}])]
 await require('esbuild').build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {NativeSceneActors} from './src/components/diff/NativeSceneActors';import './src/index.css';import './src/components/diff/UnrealAssetReview.css';const scenes=${JSON.stringify(scenes)};function App(){const[side,setSide]=useState('right');return <div className="uar"><button onClick={()=>setSide(side==='right'?'left':'right')}>Switch revision</button><NativeSceneActors scenes={scenes} side={side} paths={['Content/Map.umap','Content/Map.umap']} labels={{left:'Base',right:'Selected'}} onSelect={actor=>window.selected=actor.path}/></div>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>')}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',error=>errors.push(error.message))
 try{
  await page.setViewportSize({width:480,height:740});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('summary').click();await page.getByRole('button',{name:'Changed actors only',exact:true}).click()
  const row=page.locator('.uar-row').filter({hasText:'Matched by saved actor GUID'});await expect(row).toHaveCount(1);await expect(row).toContainText('Path: '+old.path+' → '+next.path);await row.click();expect(await page.evaluate(()=>window.selected)).toBe(next.path)
  await expect(row).toContainText('World rotation changed 90°');await expect(row).toContainText('World scale: 1, 1, 1 → 2, 3, 1.5')
  await expect(page.locator('.uar-row').filter({hasText:'Actor recreated'})).toHaveCount(1);await page.getByRole('button',{name:'Switch revision',exact:true}).click();await row.click();expect(await page.evaluate(()=>window.selected)).toBe(old.path)
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([])
 }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
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
