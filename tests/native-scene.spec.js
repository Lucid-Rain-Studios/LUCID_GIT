const {test,expect}=require('@playwright/test')
const fs=require('node:fs'),path=require('node:path'),http=require('node:http')
const {DIST,tmpDir,cleanup,git}=require('./helpers')
const {inspectSceneGlb}=require(path.join(DIST,'util/scene-glb'))
const {captureSceneSnapshot,gamePackageFile}=require(path.join(DIST,'services/SceneSnapshot'))
const {component}=require('./renderer-harness')
const root=path.resolve(__dirname,'..')

for (const identical of [false,true]) test(`GPU preview is demand-driven and lazily reuses ${identical?'identical':'different'} revisions`,async({page})=>{
 const dir=tmpDir('lg-scene-performance-'),keys=['a'.repeat(64),(identical?'a':'b').repeat(64)]
 const scenes=keys.map(key=>({status:'ready',key,engineVersion:'5.8.3',packages:[],diagnostics:[],complete:true}))
 await require('esbuild').build({stdin:{contents:`import React,{useState,Profiler} from 'react';import {createRoot} from 'react-dom/client';import {ScenePreview} from './src/components/diff/ScenePreview';import './src/index.css';import './src/components/diff/UnrealAssetReview.css';const scenes=${JSON.stringify(scenes)},labels={left:'Base',right:'Selected'};function App(){const[side,setSide]=useState('right'),[visible,setVisible]=useState(true),[mounted,setMounted]=useState(true);return <div className="uar"><button onClick={()=>setSide(side==='right'?'left':'right')}>Switch revision</button><button onClick={()=>setVisible(!visible)}>Toggle visibility</button><button onClick={()=>setMounted(false)}>Close preview</button>{mounted&&<div style={{display:visible?'block':'none'}}><Profiler id="scene" onRender={()=>window.commits++}><ScenePreview scenes={scenes} side={side} labels={labels} visible={visible}/></Profiler></div>}</div>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
 await page.addInitScript(()=>{
  window.draws=0;window.frames=0;window.commits=0
  const raf=window.requestAnimationFrame;window.requestAnimationFrame=callback=>raf.call(window,time=>{window.frames++;callback(time)})
  for(const name of ['drawElements','drawArrays']){const original=WebGL2RenderingContext.prototype[name];WebGL2RenderingContext.prototype[name]=function(...args){window.draws++;return original.apply(this,args)}}
 })
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><div id="root"></div><script>window.reads=[];window.lucidGit={nativeSceneRead:async key=>{window.reads.push(key);return new Uint8Array(${JSON.stringify([...animatedGlb()])})}}</script><script type="module" src="/app.js"></script></html>`)}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PLAYBACK PAGE ERROR',e.message)})
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);await expect(page.getByRole('button',{name:'Fit scene',exact:true})).toBeEnabled();await expect.poll(()=>page.evaluate(()=>window.draws)).toBeGreaterThan(0)
  expect(await page.evaluate(()=>window.reads)).toEqual([keys[1]])
  await page.waitForTimeout(350);const idle=await page.evaluate(()=>[window.frames,window.draws]);await page.waitForTimeout(350);expect(await page.evaluate(()=>[window.frames,window.draws])).toEqual(idle)
  await page.getByRole('button',{name:'Play',exact:true}).click();const commits=await page.evaluate(()=>window.commits);await page.waitForTimeout(800);expect(await page.evaluate(()=>window.commits)-commits).toBeLessThanOrEqual(10);expect(await page.evaluate(()=>window.draws)).toBeGreaterThan(idle[1])
  await page.getByRole('button',{name:'Toggle visibility',exact:true}).click();await page.waitForTimeout(100);const hidden=await page.evaluate(()=>[window.frames,window.draws]);await page.waitForTimeout(350);expect(await page.evaluate(()=>[window.frames,window.draws])).toEqual(hidden)
  await page.getByRole('button',{name:'Toggle visibility',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.draws)).toBeGreaterThan(hidden[1]);if(await page.getByRole('button',{name:'Pause',exact:true}).isVisible())await page.getByRole('button',{name:'Pause',exact:true}).click()
  await page.getByRole('button',{name:'Switch revision',exact:true}).click();await expect(page.getByRole('button',{name:'Fit scene',exact:true})).toBeEnabled();expect(await page.evaluate(()=>window.reads)).toEqual(identical?[keys[1]]:[keys[1],keys[0]])
  await page.getByRole('button',{name:'Switch revision',exact:true}).click();await expect(page.getByRole('button',{name:'Fit scene',exact:true})).toBeEnabled();expect(await page.evaluate(()=>window.reads.length)).toBe(identical?1:2)
  await page.getByRole('button',{name:'Close preview',exact:true}).click();await expect(page.locator('canvas')).toHaveCount(0);expect(errors).toEqual([])
 }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
test.afterAll(cleanup)
test('quality refresh keeps the old viewport and camera, and Retry bypasses cache once',async({page})=>{
 const dir=tmpDir('lg-scene-refresh-'),asset={id:'',name:'Mesh',path:'Mesh',classPath:'/Script/Engine.SkeletalMesh',outer:'',properties:{},decoded:false,opaqueBytes:1,opaqueHash:'x',diagnostics:[]}
 const document={schemaVersion:1,readerVersion:16,engineVersion:'5.8.3',assetClass:asset.classPath,graphs:[],diagnostics:[],status:'unsupported',assetReview:{family:'mesh',objects:[asset],coverage:[],cooked:false}}
 const scene={status:'ready',key:'d'.repeat(64),renderLod:{requested:0,count:2},engineVersion:'5.8.3',packages:[],diagnostics:[],complete:true}
 const result={left:{status:'absent',ref:'ABSENT',path:'Content/Mesh.uasset'},right:{status:'ready',ref:'WORKING',path:'Content/Mesh.uasset',document}}
 await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/Mesh.uasset',leftRef:'ABSENT',rightRef:'WORKING'}}/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm',plugins:[{name:'camera-proof',setup(build){build.onLoad({filter:/ScenePreview\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8').replace('renderer!.render(scene,camera)', '(window as any).cameraProof={position:camera.position.toArray(),target:controls!.target.toArray(),near:camera.near,far:camera.far};renderer!.render(scene,camera)'),loader:'tsx'}))}}]})
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><div id="root"></div><script>window.calls=[];window.reads=0;window.lucidGit={logRendererEvent:async()=>{},blueprintCompare:async(_,r)=>{window.calls.push(r);if(window.hold)await new Promise((resolve,reject)=>{window.release=resolve;window.fail=reject});const result=${JSON.stringify(result)};if(r.nativeScene)result.right.scene={...${JSON.stringify(scene)},key:(r.sceneLod===1?'f':'d').repeat(64),renderLod:{requested:r.sceneLod,count:2}};return result},nativeSceneRead:async()=>{window.reads++;return new Uint8Array(${JSON.stringify([...animatedGlb()])})},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`)}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',error=>errors.push(error.message))
 try{
  await page.setViewportSize({width:1100,height:1000});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Preview',exact:true}).click();await page.getByRole('button',{name:'Render scene with dependencies',exact:true}).click();const viewport=page.getByRole('region',{name:'Engine scene viewport'});await expect(page.getByRole('button',{name:'Fit scene',exact:true})).toBeEnabled()
  await viewport.focus();await page.keyboard.press('+');const before=await viewport.screenshot();const cameraBefore=await page.evaluate(()=>window.cameraProof)
  await page.getByRole('button',{name:'Retry',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.calls.at(-1).force)).toBe(true);await expect(page.getByText(/Updating preview/)).toHaveCount(0)
  await page.evaluate(()=>{window.hold=true;window.oldCanvas=document.querySelector('.uar-scene-field canvas')});await page.getByRole('combobox',{name:'Render LOD preference'}).click();await page.getByRole('option',{name:/LOD 1/}).click();await expect(page.getByText(/Updating preview/)).toBeVisible();expect(await page.evaluate(()=>window.calls.at(-1).force)).toBe(false);expect(await page.evaluate(()=>window.oldCanvas.isConnected)).toBe(true);await expect(viewport).toBeVisible()
  await page.getByRole('button',{name:'Contents',exact:true}).click();await page.evaluate(()=>{window.hold=false;window.release()});await expect(page.getByText(/Updating preview/)).toHaveCount(0);await expect(page.getByRole('button',{name:'Contents',exact:true})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.getByRole('button',{name:'Fit scene',exact:true})).toBeEnabled();await viewport.focus();await page.waitForTimeout(150);const after=await viewport.screenshot();expect(await page.evaluate(()=>window.cameraProof)).toEqual(cameraBefore);const sharp=require('sharp'),meta=await sharp(before).metadata(),crop={left:2,top:2,width:meta.width-4,height:meta.height-4};const a=await sharp(after).extract(crop).raw().toBuffer(),b=await sharp(before).extract(crop).raw().toBuffer();expect(a.length).toBe(b.length);expect(a.reduce((sum,value,i)=>sum+Math.abs(value-b[i]),0)/a.length).toBeLessThan(1)
  await page.evaluate(()=>{window.hold=true;window.oldCanvas=document.querySelector('.uar-scene-field canvas')});await page.getByText('Render options',{exact:true}).click();await page.getByRole('checkbox',{name:'Bake complex materials with GPU'}).check();await expect(page.getByText(/Updating preview/)).toBeVisible();expect(await page.evaluate(()=>window.calls.at(-1).force)).toBe(false);await page.evaluate(()=>window.fail(new Error('Quality capture failed')));await expect(page.getByRole('alert')).toContainText('Quality capture failed');expect(await page.evaluate(()=>window.oldCanvas.isConnected)).toBe(true);await expect(viewport).toBeVisible();expect(errors).toEqual([])
 }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
for(const skinned of [false,true])test(`${skinned?'Separate-root skin':'Multipart instance'} selection frames only its geometry and inspects its saved owner without rereading`,async({page})=>{
 const dir=tmpDir('lg-instance-parts-browser-'),key='f'.repeat(64),source=animatedGlb(),length=source.readUInt32LE(12),data=JSON.parse(source.subarray(20,20+length).toString()),binary=source.subarray(28+length)
 delete data.skins;delete data.animations
 data.nodes=['One','Two'].flatMap((alias,index)=>[0,1].map(part=>({name:alias+'__part_0_instance_'+part,mesh:0,translation:[index===0?10+part*10:-100+part*10,0,0]})))
 data.scenes=[{nodes:[0,1,2,3]}];
 if(skinned){data.nodes=[{name:'One',translation:[10,0,0],children:[2,3]},{name:'Two',translation:[-100,0,0],children:[4,5]},{name:'Bone01'},{name:'Bone02',translation:[10,0,0]},{name:'Bone01'},{name:'Bone02',translation:[10,0,0]},...Array.from({length:4},(_,index)=>({name:'Unnamed body '+index,mesh:0,skin:index}))];data.skins=Array.from({length:4},(_,index)=>({joints:[index+2],inverseBindMatrices:5}));data.scenes=[{nodes:[0,1,6,7,8,9]}]}
 const bytes=glb(data,binary)
 const actors=['One','Two'].map(alias=>({name:'Repeated actor',path:'/Game/LGI_'+alias+'.Source:PersistentLevel.Actor',saved:true,location:[0,0,0],renderName:alias,instanceLabel:'Instance '+alias,instancePath:(alias==='One'?'a':'b').repeat(32),sourcePath:'/Game/Source.Source:PersistentLevel.Actor',inspectPath:'/Game/Root.Root:PersistentLevel.'+alias}))
 const scene={status:'ready',key,engineVersion:'5.8.3',packages:[],diagnostics:[],complete:true,actorInventoryComplete:true,actors}
 await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ScenePreview} from './src/components/diff/ScenePreview';import './src/index.css';import './src/components/diff/UnrealAssetReview.css';createRoot(document.getElementById('root')).render(<div className="uar"><ScenePreview scenes={[undefined,${JSON.stringify(scene)}]} side="right" labels={{left:'Base',right:'Selected'}} onInspectActor={path=>window.inspected=path}/></div>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm',plugins:[{name:'camera-proof',setup(build){build.onLoad({filter:/ScenePreview\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8').replace('renderer!.render(scene,camera)','(window as any).cameraTarget=controls!.target.toArray();groups[1].traverse(object=>{if(object instanceof THREE.SkinnedMesh && nativeActorForObject(object,actorsRef.current ?? [])?.renderName==="One"){const p=object.applyBoneTransform(0,new THREE.Vector3(.25,.25,0)).applyMatrix4(object.matrixWorld).project(camera);(window as any).skinHit=[p.x,p.y]}});renderer!.render(scene,camera)'),loader:'tsx'}))}}]})
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><div id="root"></div><script>window.reads=0;window.lucidGit={nativeSceneRead:async()=>{window.reads++;return new Uint8Array(${JSON.stringify([...bytes])})}}</script><script type="module" src="/app.js"></script></html>`)}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PLAYBACK PAGE ERROR',e.message)})
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);await expect(page.getByRole('button',{name:'Fit scene',exact:true})).toBeEnabled();await page.getByText('Reconstructed actors (2 saved · 0 engine-generated)',{exact:true}).click()
  for(const [alias,x] of [['One',15.5],['Two',-94.5]]){
   await page.getByLabel('Filter native actors').fill('Instance '+alias);await page.locator('.uar-row').click();await expect.poll(()=>page.evaluate(()=>window.cameraTarget?.[0])).toBeCloseTo(x,4);expect(await page.evaluate(()=>window.inspected)).toBe('/Game/Root.Root:PersistentLevel.'+alias);await expect(page.locator('.uar-row')).toHaveAttribute('aria-pressed','true')
   if(skinned && alias==='One'){await page.getByRole('region',{name:'Engine scene viewport'}).focus();for(let i=0;i<8;i++)await page.keyboard.press('+');await page.waitForTimeout(150);await expect.poll(()=>page.evaluate(()=>window.skinHit?.length)).toBe(2);const point=await page.evaluate(()=>window.skinHit),box=await page.locator('canvas').boundingBox();await page.evaluate(()=>window.inspected=null);await page.mouse.click(box.x+(point[0]+1)*box.width/2,box.y+(1-point[1])*box.height/2);await expect.poll(()=>page.evaluate(()=>window.inspected)).toBe('/Game/Root.Root:PersistentLevel.One')}
  }
  expect(await page.evaluate(()=>window.reads)).toBe(1);expect(errors).toEqual([])
 }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

function glb(json,binary=Buffer.alloc(0)){
 const text=Buffer.from(JSON.stringify(json)),padding=(4-text.length%4)%4,binPadding=(4-binary.length%4)%4
 const size=12+8+text.length+padding+(binary.length?8+binary.length+binPadding:0),out=Buffer.alloc(size)
 out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(size,8);out.writeUInt32LE(text.length+padding,12);out.writeUInt32LE(0x4e4f534a,16);text.copy(out,20);out.fill(32,20+text.length,20+text.length+padding)
 if(binary.length){const offset=20+text.length+padding;out.writeUInt32LE(binary.length+binPadding,offset);out.writeUInt32LE(0x004e4942,offset+4);binary.copy(out,offset+8)}return out
}
function animatedGlb(){
 const arrays=[new Float32Array([0,0,0,1,0,0,0,1,0]),new Float32Array([0,0,1,0,0,1,0,0,1]),new Uint16Array([0,1,2]),new Uint16Array(12),new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0]),new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),new Float32Array([0,1]),new Float32Array([0,0,0,1,0,0,Math.SQRT1_2,Math.SQRT1_2])]
 const buffers=[],views=[];let offset=0
 arrays.forEach(array=>{const b=Buffer.from(array.buffer);views.push({buffer:0,byteOffset:offset,byteLength:b.length});buffers.push(b);const pad=(4-b.length%4)%4;if(pad)buffers.push(Buffer.alloc(pad));offset+=b.length+pad})
 return glb({asset:{version:'2.0'},scene:0,scenes:[{nodes:[0,1]}],nodes:[{name:'Skinned triangle',mesh:0,skin:0},{name:'Root bone'}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1,JOINTS_0:3,WEIGHTS_0:4},indices:2,material:0}]}],materials:[{name:'Captured red',doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[1,.05,.05,1],metallicFactor:0,roughnessFactor:.8}}],skins:[{joints:[1],inverseBindMatrices:5}],animations:[{name:'Captured rotation',samplers:[{input:6,output:7,interpolation:'LINEAR'}],channels:[{sampler:0,target:{node:1,path:'rotation'}}]}],buffers:[{byteLength:offset}],bufferViews:views,accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5126,count:3,type:'VEC3'},{bufferView:2,componentType:5123,count:3,type:'SCALAR'},{bufferView:3,componentType:5123,count:3,type:'VEC4'},{bufferView:4,componentType:5126,count:3,type:'VEC4'},{bufferView:5,componentType:5126,count:1,type:'MAT4'},{bufferView:6,componentType:5126,count:2,type:'SCALAR',min:[0],max:[1]},{bufferView:7,componentType:5126,count:2,type:'VEC4'}]},Buffer.concat(buffers))
}
test('skin joint ancestry resolves separate mesh roots and refuses mixed or ambiguous owners',async()=>{
 const THREE=await import('three'),{nativeActorForObject}=component('src/lib/nativeSceneObjects.ts',{'three':THREE}).exports
 const actors=['One','Two'].map(name=>({name:'Repeated',path:name,renderName:name,saved:true})),roots=actors.map(actor=>{const root=new THREE.Group();root.name=actor.renderName;return root}),bones=roots.map(root=>{const bone=new THREE.Bone();bone.name='Bone01';root.add(bone);return bone}),mesh=new THREE.SkinnedMesh()
 mesh.skeleton=new THREE.Skeleton([bones[0]])
 expect(nativeActorForObject(mesh,actors)).toBe(actors[0]);expect(nativeActorForObject(mesh,[...actors,{name:'Bone01',path:'Misleading'}])).toBe(actors[0])
 mesh.skeleton=new THREE.Skeleton(bones);expect(nativeActorForObject(mesh,actors)).toBeUndefined();mesh.skeleton=new THREE.Skeleton([bones[0],new THREE.Bone()]);expect(nativeActorForObject(mesh,actors)).toBeUndefined()
 mesh.skeleton=new THREE.Skeleton([bones[0]]);expect(nativeActorForObject(mesh,[...actors,{...actors[0]}])).toBeUndefined()
 bones[0].add(roots[1]);mesh.skeleton=new THREE.Skeleton([bones[1]]);expect(nativeActorForObject(mesh,actors)).toBe(actors[1])
 const part=new THREE.Mesh();part.name='One__part_0_instance_0';expect(nativeActorForObject(part,actors)).toBe(actors[0])
})

test('clip labels identify unique actor targets and keep duplicate or unknown names selectable',async()=>{
 const THREE=await import('three'),{nativeClipLabels}=component('src/lib/nativeSceneObjects.ts',{'three':THREE}).exports,group=new THREE.Group()
 const actors=['One','Two'].map(name=>({name:'Parent',path:name,renderName:name,instanceLabel:'Instance '+name})),clips=[]
 for(const actor of actors){const root=new THREE.Group();root.name=actor.renderName;group.add(root);const joint=new THREE.Bone();joint.name='Joint'+actor.path;root.add(joint);clips.push(new THREE.AnimationClip('Motion',1,[new THREE.VectorKeyframeTrack(joint.name+'.position',[0,1],[0,0,0,1,0,0])]))}
 expect(nativeClipLabels(clips,group,actors)).toEqual(['Motion · Parent · Instance One','Motion · Parent · Instance Two'])
 group.getObjectByName('JointOne').add(group.getObjectByName('Two'));expect(nativeClipLabels(clips,group,actors)).toEqual(['Motion · Parent · Instance One','Motion · Parent · Instance Two'])
 expect(nativeClipLabels(clips,group,[])).toEqual(['Motion · clip 1','Motion · clip 2'])
 expect(nativeClipLabels(clips,group,actors.map(actor=>({...actor,instanceLabel:undefined})))).toEqual(['Motion · Parent · clip 1','Motion · Parent · clip 2'])
 const mixed=new THREE.AnimationClip('Mixed',1,[...clips[0].tracks,...clips[1].tracks]);expect(nativeClipLabels([mixed],group,actors)).toEqual(['Mixed'])
})

test('scene boundary validates embedded geometry/skins and rejects remote resources, cycles and texture bombs',()=>{
 expect(inspectSceneGlb(animatedGlb())).toMatchObject({meshes:1,materials:1,skins:1,animations:1,vertices:3,triangles:1})
 for(const data of [{asset:{version:'2.0'},buffers:[{uri:'https://example.com/x',byteLength:0}]},{asset:{version:'2.0'},nodes:[{children:[0]}]},{asset:{version:'2.0'},accessors:[{type:'VEC3',count:1e9,componentType:5126,bufferView:0}]}])expect(()=>inspectSceneGlb(glb(data))).toThrow()
 const png=Buffer.alloc(24);png.writeUInt32BE(0x89504e47,0);png.writeUInt32BE(0x49484452,12);png.writeUInt32BE(100000,16);png.writeUInt32BE(100000,20)
 expect(()=>inspectSceneGlb(glb({asset:{version:'2.0'},buffers:[{byteLength:24}],bufferViews:[{buffer:0,byteLength:24}],images:[{bufferView:0,mimeType:'image/png'}]},png))).toThrow('pixel budget')
 const invalid=animatedGlb();invalid.writeUInt32LE(1,8);expect(()=>inspectSceneGlb(invalid)).toThrow()
})
test('native bag fields preserve quoted/nested values and reject ambiguous or truncated text',()=>{
 const {nativeBagFields}=component('src/lib/nativeBag.ts').exports
 expect(nativeBagFields('(Value=/Engine/Transient.PropertyBag_x(Count=42,Position=(X=1,Y=2,Z=3),Label="a,b=c"))')).toEqual([{name:'Count',value:'42'},{name:'Position',value:'(X=1,Y=2,Z=3)'},{name:'Label',value:'"a,b=c"'}])
 expect(nativeBagFields('(Value=None)')).toEqual([])
 for(const text of ['(Value=/Engine/X(A=1,A=2))','(Value=/Engine/X(A=(X=1))','garbage','(Value=/Engine/X(A="truncated))'])expect(nativeBagFields(text)).toBeNull()
})
test('native actor inspection requires unique captured package/object identity',()=>{
 const {nativeSceneObject}=component('src/lib/assetReferences.ts').exports
 const actor={path:'Map.PersistentLevel.Actor_0',name:'Shared label'}
 expect(nativeSceneObject('/Game/Map.Map:PersistentLevel.Actor_0',[actor],'Content/Map.umap')).toBe(actor)
 expect(nativeSceneObject('/Game/Sub.Sub:PersistentLevel.Actor_0',[actor],'Content/Map.umap')).toBeUndefined()
 expect(nativeSceneObject('/Game/Map.Map:PersistentLevel.Actor_0',[actor,actor],'Content/Map.umap')).toBeUndefined()
 const external={...actor,sourcePackage:'Content/__ExternalActors__/Map/A/B.uasset',serializedPath:'/Game/Map.Map.PersistentLevel.Actor_0'}
 expect(nativeSceneObject('/Game/Map.Map:PersistentLevel.Actor_0',[external],'Content/Map.umap')).toBe(external)
 expect(nativeSceneObject('Shared label',[actor],'Content/Map.umap')).toBeUndefined()
})
test('real render LOD preference exports reduced geometry and keeps a missing base LOD unavailable',async()=>{
 test.setTimeout(600000)
 const fixture=process.env.UNREAL_SCENE_LOD;test.skip(!fixture,'Enable a saved two-LOD fixture')
 const before=fs.readFileSync(fixture),base=fs.readFileSync('C:/Program Files/Epic Games/UE_5.8/Engine/Content/BasicShapes/Sphere.uasset'),repo=tmpDir('lg-render-lod-'),cache=tmpDir('lg-render-lod-cache-'),file='Content/LODSphere.uasset'
 git(repo,'init','-q');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.com');fs.mkdirSync(path.join(repo,'Content'));fs.writeFileSync(path.join(repo,file),base);fs.writeFileSync(path.join(repo,'Fixture.uproject'),JSON.stringify({FileVersion:3,EngineAssociation:'5.8'}));git(repo,'add','-A');git(repo,'commit','-qm','one LOD');const old=git(repo,'rev-parse','HEAD').trim();fs.writeFileSync(path.join(repo,file),before);git(repo,'add','-A');git(repo,'commit','-qm','two LODs');const selected=git(repo,'rev-parse','HEAD').trim();fs.writeFileSync(path.join(repo,file),'different working bytes')
 const {BlueprintRevisionService}=require(path.join(DIST,'services/BlueprintRevisionService')),service=new BlueprintRevisionService(path.join(root,'tools/BlueprintExtractor/bin/Release/net10.0'),cache)
 const request={filePath:file,leftRef:old,rightRef:selected,requestId:'render-lod',nativeScene:true}
 const lower=await service.compare(repo,{...request,sceneLod:1})
 expect(lower.left.scene.status).toBe('unavailable');expect([lower.left.scene.reason,...lower.left.scene.diagnostics].join(' ')).toContain('absent in this revision');expect(lower.right.scene.status).toBe('ready');expect(lower.right.scene.renderLod).toEqual({requested:1,count:2})
 const full=await service.compare(repo,{...request,sceneLod:0})
 expect(full.right.scene.renderLod).toEqual({requested:0,count:2});expect(lower.right.scene.stats.triangles).toBeLessThan(full.right.scene.stats.triangles);expect(lower.right.scene.key).not.toBe(full.right.scene.key)
 expect(fs.readFileSync(fixture)).toEqual(before);expect(fs.readFileSync(path.join(repo,file),'utf8')).toBe('different working bytes')
 for(const lod of [-1,8,1.5,'1'])await expect(service.compare(repo,{...request,sceneLod:lod})).rejects.toThrow('Render LOD')
 console.log('render LOD triangles',full.right.scene.stats.triangles,lower.right.scene.stats.triangles)
})
test('native scene retries publish immutable payload handles and reject modified inputs/cache bytes',async()=>{
 const {NativeSceneService}=require(path.join(DIST,'services/NativeSceneService')),{ueHeadlessService}=require(path.join(DIST,'services/UEHeadlessService'))
 const dir=tmpDir('lg-scene-cache-'),capture=path.join(dir,'capture'),editor=path.join(dir,'engine'),cache=path.join(dir,'cache')
 fs.mkdirSync(path.join(capture,'Content'),{recursive:true});fs.writeFileSync(path.join(capture,'Content/Mesh.uasset'),'captured package');fs.writeFileSync(editor,'engine')
 const document={engineVersion:'5.8.3',assetClass:'/Script/Engine.SkeletalMesh',assetReview:{objects:[{classPath:'/Script/Engine.SkeletalMesh',name:'SavedMesh'}],cooked:false}}
 const side={path:'Content/Mesh.uasset',document},snapshot={packages:[],diagnostics:[],complete:true,identity:'fixed'},service=new NativeSceneService(cache)
 const original={find:ueHeadlessService.findEditorBinary,run:ueHeadlessService.runCommandlet};let calls=0,tamper=false
 ueHeadlessService.findEditorBinary=async()=>editor
 ueHeadlessService.runCommandlet=async()=>{calls++;const bytes=animatedGlb();if(calls>1){const start=bytes.indexOf(Buffer.from('Captured red'));bytes[start]='C'.charCodeAt(0);bytes[start+1]='H'.charCodeAt(0)}fs.writeFileSync(path.join(capture,'scene.glb'),bytes);fs.writeFileSync(path.join(capture,'scene.json'),JSON.stringify({engineVersion:'5.8.3-test',diagnostics:[],actors:[],bags:[]}));if(tamper)fs.writeFileSync(path.join(capture,'Content/Mesh.uasset'),'modified');return{success:true,output:''}}
 try{
  const [first,joined]=await Promise.all([service.extract(side,capture,snapshot),service.extract(side,capture,snapshot)]);expect(joined).toBe(first);expect(first.status).toBe('ready');expect(Buffer.from(await service.read(first.key))).toEqual(animatedGlb())
  expect(await service.extract(side,capture,snapshot)).toBe(first);expect(calls).toBe(1)
  const retry=await service.extract(side,capture,snapshot,undefined,false,true);expect(retry.status).toBe('ready');expect(retry.key).not.toBe(first.key);expect(calls).toBe(2)
  fs.appendFileSync(path.join(cache,retry.key+'.glb'),'tampered');await expect(service.read(retry.key)).rejects.toThrow('changed')
  tamper=true;expect((await service.extract(side,capture,snapshot,undefined,false,true)).reason).toContain('changed captured scene input')
  expect(fs.readdirSync(cache).some(file=>file.endsWith('.tmp'))).toBe(false);await expect(service.read('../file')).rejects.toThrow('expired')
 }finally{service.stop();ueHeadlessService.findEditorBinary=original.find;ueHeadlessService.runCommandlet=original.run}
})
test('dependency snapshots close package cycles, retain missing mounts and reject mutable changes',async()=>{
 const dir=tmpDir('lg-scene-closure-'),key='a'.repeat(64),rootSide={path:'Content/Root.uasset',documentKey:key,status:'ready'}
 const make=(file,packages)=>({status:'ready',path:file,documentKey:file===rootSide.path?key:'b'.repeat(64),sourceBytes:16,document:{assetClass:'/Script/Engine.StaticMesh',assetReview:{packages,packageReferencesComplete:true}}})
 const calls=[],snapshot=await captureSceneSnapshot({root:rootSide,directory:dir,external:async()=>[],stamp:async()=>'',capture:async(file,destination)=>{calls.push(file);expect(destination.startsWith(dir+path.sep)).toBe(true);return make(file,file===rootSide.path?['/Game/Material','/Engine/Default','/Custom/Missing']:['/Game/Root'])}})
 expect(calls).toEqual(['Content/Root.uasset','Content/Material.uasset']);expect(snapshot.packages).toHaveLength(2);expect(snapshot.complete).toBe(false);expect(snapshot.diagnostics.join(' ')).toContain('/Custom/Missing')
 let stamps=0
 await expect(captureSceneSnapshot({root:rootSide,directory:dir,external:async()=>[],capture:async file=>make(file,[]),stamp:async files=>files.length?String(stamps++):''})).rejects.toThrow('Working dependency changed')
 expect(gamePackageFile('/Game/../Secret','Content/Root.uasset')).toBeNull();expect(gamePackageFile('/Game/Valid','Plugins/X/Content/Root.uasset')).toBeNull()
})
test('attachment capture preserves package identity, explicit fields and a shared closure budget',async()=>{
 const {savedSceneAttachments}=require(path.join(DIST,'util/saved-attachments'))
 const object={path:'Leaf.PersistentLevel.Child.Mesh',properties:{AttachParent:'Leaf.PersistentLevel.Parent.Mesh',AttachSocketName:'ProbeSocket',RelativeLocation:{RelativeLocation:{X:'5',Y:0,Z:0}}}}
 const side={status:'ready',path:'Content/Maps/Leaf.umap',documentKey:'leaf',sourceBytes:16,document:{engineVersion:'5.8.3',assetClass:'/Script/Engine.World',assetReview:{objects:[object],packages:[],packageReferencesComplete:true,actorCandidates:[],actorCandidatesComplete:true}}}
 const fields=savedSceneAttachments(side);expect(fields.complete).toBe(true);expect(fields.components).toEqual([{path:'/Game/Maps/Leaf.Leaf:PersistentLevel.Child.Mesh',parent:'/Game/Maps/Leaf.Leaf:PersistentLevel.Parent.Mesh',socket:'ProbeSocket',location:[5,0,0],rotation:undefined,scale:undefined}])
 expect(savedSceneAttachments({...side,document:{...side.document,assetReview:{...side.document.assetReview,objects:[{...object,properties:{...object.properties,RelativeLocation:{X:null,Y:0,Z:0}}}]}}}).components).toEqual([])
 expect(savedSceneAttachments(side,0)).toMatchObject({complete:false,components:[]})
 const rootSide={...side,path:'Content/Root.umap',documentKey:'root',document:{...side.document,assetReview:{...side.document.assetReview,objects:[],packages:['/Game/Maps/Leaf']}}},dir=tmpDir('lg-socket-closure-')
 const snapshot=await captureSceneSnapshot({root:rootSide,directory:dir,stamp:async()=>'',external:async()=>[],capture:async file=>file===rootSide.path?rootSide:side})
 expect(snapshot.components).toEqual(fields.components);expect(snapshot.componentsComplete).toBe(true)
 const many={...side,document:{...side.document,assetReview:{...side.document.assetReview,objects:Array.from({length:10001},(_,index)=>({...object,path:object.path+index}))}}}
 const bounded=await captureSceneSnapshot({root:rootSide,directory:dir,stamp:async()=>'',external:async()=>[],capture:async file=>file===rootSide.path?rootSide:many})
 expect(bounded.components).toHaveLength(10000);expect(bounded.componentsComplete).toBe(false)
})

test('nested streaming traversal closes newly loaded tables and cycles within its budget',()=>{
 const {SCENE_SCRIPT}=require(path.join(DIST,'services/SceneExportScript'))
 const traversal=SCENE_SCRIPT.slice(SCENE_SCRIPT.indexOf('def load_streamed_worlds('),SCENE_SCRIPT.indexOf('def attachment_depth('))
 const {spawnSync}=require('node:child_process')
 const result=spawnSync(process.env.PYTHON || 'python',[path.join(__dirname,'fixtures/nested-streaming.py')],{input:traversal,encoding:'utf8'})
 test.skip(result.error?.code==='ENOENT','Python is required for controlled engine-boundary checks')
 expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({depth:3,cycles:true,duplicateTargets:true,missing:true,budget:256})
})

test('streaming ancestor transforms refuse conflicting instances and missing transforms',()=>{
 const {SCENE_SCRIPT}=require(path.join(DIST,'services/SceneExportScript'))
 const resolver=SCENE_SCRIPT.slice(SCENE_SCRIPT.indexOf('def streaming_parent_transforms('),SCENE_SCRIPT.indexOf('def restore_saved_attachments('))
 const result=require('node:child_process').spawnSync(process.env.PYTHON || 'python',[path.join(__dirname,'fixtures/streaming-transforms.py')],{input:resolver,encoding:'utf8'})
 test.skip(result.error?.code==='ENOENT','Python is required for controlled engine-boundary checks')
 expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({ancestorOnly:true,conflict:true,missing:true,cycle:true,foreign:true})
})

test('single-sequence instance playback initializes without notifies and refuses unsupported saved profiles',()=>{
 const {SCENE_SCRIPT}=require(path.join(DIST,'services/SceneExportScript'))
 const script=require(path.join(DIST,'services/SceneAnimationScript')).ANIMATION_SCRIPT
 const result=require('node:child_process').spawnSync(process.env.PYTHON || 'python',[path.join(__dirname,'fixtures/instance-animation.py')],{input:script,encoding:'utf8'})
 test.skip(result.error?.code==='ENOENT','Python is required for controlled engine-boundary checks')
 expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual({compatibleSequence:true,notifyFree:true,unsupportedProfiles:true})
})

test('native nested instance loading reserves the whole subtree before engine loading and preserves the missing-bridge fallback',()=>{
 const script=require(path.join(DIST,'services/SceneInstanceScript')).INSTANCE_SCRIPT,result=require('node:child_process').spawnSync(process.env.PYTHON || 'python',[path.join(__dirname,'fixtures/native-instance-budget.py')],{input:script,encoding:'utf8'})
 expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual({actors:true,worlds:true,missingBridge:true})
})

test('instance mesh staging uses world transforms and refuses expansion before spawning or scanning instances',()=>{
 const {SCENE_SCRIPT}=require(path.join(DIST,'services/SceneExportScript'))
 const script=SCENE_SCRIPT.slice(SCENE_SCRIPT.indexOf('        renderer_actors = set(actors)'),SCENE_SCRIPT.indexOf("    if request.get('renderOnly'):"))
 const result=require('node:child_process').spawnSync(process.env.PYTHON || 'python',[path.join(__dirname,'fixtures/instance-mesh-staging.py')],{input:script,encoding:'utf8'})
 test.skip(result.error?.code==='ENOENT','Python is required for controlled engine-boundary checks')
 expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual({worldTransforms:true,preflightBudget:true,zeroAndMissing:true,customDataDiagnostic:true,skeletalReferencePose:true,skeletalAttachments:true})
})

test('saved socket correction requires matching parents and sockets and never invents omitted fields',()=>{
 const {SCENE_SCRIPT}=require(path.join(DIST,'services/SceneExportScript'))
 const script=SCENE_SCRIPT.slice(SCENE_SCRIPT.indexOf('def restore_saved_attachments('),SCENE_SCRIPT.indexOf('def bag('))
 const result=require('node:child_process').spawnSync(process.env.PYTHON || 'python',[path.join(__dirname,'fixtures/saved-attachments.py')],{input:script,encoding:'utf8'})
 test.skip(result.error?.code==='ENOENT','Python is required for controlled engine-boundary checks')
 expect(result.stderr).toBe('');expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual({explicitOnly:true,parentSocketGuard:true,missing:true,truncated:true,instanceRemap:true,expansionBudget:true})
})

test('native actor manifests retain full source paths and mark missing/truncated tables unverified',async()=>{
 const dir=tmpDir('lg-scene-manifest-'),key='a'.repeat(64),rootSide={path:'Content/Map.umap',documentKey:key,status:'ready'}
 const document={engineVersion:'5.8.3',assetClass:'/Script/Engine.World',assetReview:{packages:['/Game/__ExternalActors__/Map/A/B'],packageReferencesComplete:true,actorCandidatesComplete:true,actorCandidates:[{path:'Map.PersistentLevel.Actor_0',classPath:'/Script/Engine.StaticMeshActor'}]}}
 const args={root:rootSide,directory:dir,external:async()=>[],stamp:async()=>'',capture:async file=>({status:'ready',path:file,documentKey:key,sourceBytes:20,document:file===rootSide.path?document:{engineVersion:'5.8.3',assetClass:'/Script/Engine.StaticMeshActor',assetReview:{packages:[],packageReferencesComplete:true,actorCandidatesComplete:true,actorCandidates:[{path:'/Game/Map.Map.PersistentLevel.Actor_1',classPath:'/Script/Engine.StaticMeshActor'}]}}})}
 const snapshot=await captureSceneSnapshot(args);expect(snapshot.actorManifestComplete).toBe(true);expect(snapshot.actorCandidates.map(value=>value.path)).toEqual(['/Game/Map.Map:PersistentLevel.Actor_0','/Game/Map.Map:PersistentLevel.Actor_1']);expect(snapshot.actorCandidates[1].package).toBe('/Game/__ExternalActors__/Map/A/B')
 document.assetReview.actorCandidatesComplete=false;expect((await captureSceneSnapshot(args)).actorManifestComplete).toBe(false)
 delete document.assetReview.actorCandidates;expect((await captureSceneSnapshot(args)).actorManifestComplete).toBe(false)
})
test('instance provenance allows bounded source expansion and rejects forged sources, owners and identities',async()=>{
 const {NativeSceneService}=require(path.join(DIST,'services/NativeSceneService')),{ueHeadlessService}=require(path.join(DIST,'services/UEHeadlessService')),dir=tmpDir('lg-instance-proof-'),editor=path.join(dir,'engine'),capture=path.join(dir,'capture');fs.writeFileSync(editor,'engine');fs.mkdirSync(path.join(capture,'Content'),{recursive:true});fs.writeFileSync(path.join(capture,'Content/Map.umap'),'snapshot')
 const owner='/Game/Map.Map:PersistentLevel.Instance_0',source='/Game/Source.Source:PersistentLevel.Cube',world='/Game/LGI.Source',guid='a'.repeat(32),rootSide={path:'Content/Map.umap',document:{engineVersion:'5.8.3',assetClass:'/Script/Engine.World',assetReview:{objects:[{name:'Map',classPath:'/Script/Engine.World'}]}}},snapshot={identity:'proof',packages:[],diagnostics:[],complete:true,actorManifestComplete:true,actorCandidates:[{path:owner,classPath:'/Script/Engine.LevelInstance',package:'/Game/Map'},{path:source,classPath:'/Script/Engine.StaticMeshActor',package:'/Game/Source'}]}
 const valid={engineVersion:'5.8.3-test',diagnostics:[],bags:[],actors:[{name:'Owner',path:owner,guid,saved:true,location:[0,0,0]},{name:'Cube',path:world+':PersistentLevel.Cube',guid:'c'.repeat(32),instancePath:guid,sourcePath:source,inspectPath:owner,renderName:'Cube__Instance',saved:true,location:[100,0,0]}],instances:[{world,source:'/Game/Source.Source',identity:guid,owner}],actorInventory:{expected:2,matched:2,missing:[],diagnostics:[]},actorInventoryComplete:true}
 const original={find:ueHeadlessService.findEditorBinary,run:ueHeadlessService.runCommandlet},service=new NativeSceneService(path.join(dir,'cache'));let output=structuredClone(valid)
 ueHeadlessService.findEditorBinary=async()=>editor;ueHeadlessService.runCommandlet=async()=>{fs.writeFileSync(path.join(capture,'scene.json'),JSON.stringify(output));fs.writeFileSync(path.join(capture,'scene.glb'),animatedGlb());return{success:true,output:''}}
 const run=()=>service.extract(rootSide,capture,snapshot,undefined,false,true)
 try{
  expect((await run()).actorInventoryComplete).toBe(true)
  for(const edit of [value=>value.instances[0].source='/Game/Uncaptured.World',value=>value.instances.push(value.instances[0]),value=>value.instances[0].identity='b'.repeat(32),value=>value.actors[1].sourcePath=owner,value=>value.actors[1].inspectPath=source,value=>value.actors[0].path='/Game/Forged.World:PersistentLevel.Actor',value=>value.actors[1].instancePath='invalid']){output=structuredClone(valid);edit(output);expect((await run()).status).toBe('unavailable')}
 }finally{service.stop();ueHeadlessService.findEditorBinary=original.find;ueHeadlessService.runCommandlet=original.run}
})

test('native actor proof is independent of visuals and refuses incomplete snapshots, missing actors and inconsistent counts',async()=>{
 const {NativeSceneService}=require(path.join(DIST,'services/NativeSceneService')),{ueHeadlessService}=require(path.join(DIST,'services/UEHeadlessService'))
 const dir=tmpDir('lg-native-inventory-'),editor=path.join(dir,'engine'),capture=path.join(dir,'capture'),cache=path.join(dir,'cache');fs.writeFileSync(editor,'engine');fs.mkdirSync(path.join(capture,'Content'),{recursive:true});fs.writeFileSync(path.join(capture,'Content/Map.umap'),'snapshot')
 const actorPath='/Game/Map.Map:PersistentLevel.Actor_0',rootSide={path:'Content/Map.umap',document:{engineVersion:'5.8.3',assetClass:'/Script/Engine.World',assetReview:{objects:[{name:'Map',classPath:'/Script/Engine.World'}]}}},snapshot={identity:'actor-proof',packages:[],diagnostics:[],complete:true,actorManifestComplete:true,actorCandidates:[{path:actorPath,classPath:'/Script/Engine.StaticMeshActor',package:'/Game/Map'}]}
 const original={find:ueHeadlessService.findEditorBinary,run:ueHeadlessService.runCommandlet},service=new NativeSceneService(cache)
 let info={engineVersion:'5.8.3-test',diagnostics:['Rendering is partial'],actors:[{name:'Actor',path:actorPath,location:[0,0,0],saved:true}],bags:[],actorInventory:{expected:1,matched:1,missing:[],diagnostics:[]},actorInventoryComplete:true},output=''
 ueHeadlessService.findEditorBinary=async()=>editor;ueHeadlessService.runCommandlet=async()=>{fs.writeFileSync(path.join(capture,'scene.json'),JSON.stringify(info));fs.writeFileSync(path.join(capture,'scene.glb'),animatedGlb());return{success:true,output}}
 const run=source=>service.extract(rootSide,capture,source,undefined,false,true)
 try{
  const valid=await run(snapshot);expect(valid.reason).toBeUndefined();expect(valid.actorInventoryComplete).toBe(true);expect(valid.complete).toBe(false)
  info.actors[0].guid='not-a-guid';expect((await run(snapshot)).reason).toContain('Invalid native actor GUID');info.actors[0].guid='0'.repeat(32);expect((await run(snapshot)).reason).toContain('Invalid native actor GUID');info.actors[0].guid='a'.repeat(32);expect((await run(snapshot)).actors[0].guid).toBe('a'.repeat(32));delete info.actors[0].guid
  info.actors[0].guid='a'.repeat(32);info.actors[0].saved=false;expect((await run(snapshot)).reason).toContain('Invalid native actor GUID');delete info.actors[0].guid;info.actors[0].saved=true
  for(const invalid of [{rotation:[0,0,0,0]},{rotation:[0,0,0,2]},{scale:[1,null,1]}]){Object.assign(info.actors[0],invalid);expect((await run(snapshot)).reason).toContain('Invalid native actor rotation or scale');delete info.actors[0].rotation;delete info.actors[0].scale}
  Object.assign(info.actors[0],{rotation:[0,0,0,1],scale:[2,3,1.5]});expect((await run(snapshot)).actors[0].scale).toEqual([2,3,1.5]);delete info.actors[0].rotation;delete info.actors[0].scale
  expect((await run({...snapshot,actorCandidates:[]})).reason).toContain('outside the captured source manifest')
  expect((await run({...snapshot,complete:false})).actorInventoryComplete).toBe(false);expect((await run({...snapshot,actorManifestComplete:false})).actorInventoryComplete).toBe(false)
  output='LogLinker: Warning: Dependency unavailable';expect((await run(snapshot)).actorInventoryComplete).toBe(false);output=''
  info={...info,actors:[],actorInventory:{expected:1,matched:0,missing:[actorPath],diagnostics:[]}};expect((await run(snapshot)).actorInventoryComplete).toBe(false)
  info.actorInventory.matched=1;expect((await run(snapshot)).reason).toContain('Invalid native actor inventory proof')
 }finally{service.stop();ueHeadlessService.findEditorBinary=original.find;ueHeadlessService.runCommandlet=original.run}
})
for(const [name,env] of [['texture','UNREAL_SCENE_TEXTURE'],['material','UNREAL_SCENE_MATERIAL'],['material-instance','UNREAL_SCENE_MATERIAL_INSTANCE'],['mesh','UNREAL_SCENE_MESH'],['StateTree','UNREAL_SCENE_STATETREE'],['world','UNREAL_SCENE_WORLD'],['animation','UNREAL_SCENE_ANIMATION'],['composite','UNREAL_SCENE_COMPOSITE'],['partition','UNREAL_SCENE_PARTITION'],['nested','UNREAL_SCENE_NESTED'],['nested-missing','UNREAL_SCENE_NESTED'],['nested-offset','UNREAL_SCENE_OFFSETS'],['nested-scale','UNREAL_SCENE_SCALE'],['instances','UNREAL_SCENE_INSTANCES'],['instance-meshes','UNREAL_SCENE_INSTANCE_MESHES'],['instances-nested','UNREAL_SCENE_NESTED_INSTANCES'],['sockets','UNREAL_SCENE_SOCKETS'],['socket-host','UNREAL_SCENE_SOCKET_HOST'],['skeletal-sockets','UNREAL_SCENE_SKELETAL_SOCKETS'],['skeletal-host','UNREAL_SCENE_SKELETAL_HOST'],['saved-base','UNREAL_SCENE_SAVED_BASE'],['animated-host','UNREAL_SCENE_ANIMATED_SOCKETS']])test(`real ${name} dependency scene capture stays pinned and read-only`,async({},info)=>{
 const skeletalHost=['skeletal-host','animated-host'].includes(name)
 test.setTimeout(900000);const fixture=process.env[env];test.skip(!fixture,'Enable an installed-engine fixture')
 const before=fs.readFileSync(fixture),repo=tmpDir('lg-scene-real-'),cache=tmpDir('lg-scene-real-cache-'),normalized=fixture.replaceAll('\\','/'),content=normalized.slice(0,normalized.lastIndexOf('/Content/')+9),file='Content/'+normalized.slice(content.length)
 git(repo,'init','-q');git(repo,'config','user.name','Test');git(repo,'config','user.email','test@example.com')
 const {execFileSync}=require('node:child_process'),pending=[file.slice(8)],seen=new Set();let size=0
 if(name==='partition')for(const kind of ['__ExternalActors__','__ExternalObjects__']){const external=path.join(content,kind,file.slice(8).replace(/\.umap$/i,''));if(fs.existsSync(external))for(const relative of fs.readdirSync(external,{recursive:true}))if(relative.endsWith('.uasset'))pending.push(path.relative(content,path.join(external,relative)))}
 while(pending.length){const relative=pending.shift();if(seen.has(relative))continue;seen.add(relative);if(seen.size>256)break;let source=path.join(content,relative);if(!fs.existsSync(source)&&source.endsWith('.uasset')){source=source.slice(0,-7)+'.umap'}if(!fs.existsSync(source))continue;const target=path.join(repo,'Content',path.relative(content,source));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);size+=fs.statSync(source).size;if(size>512*1024*1024)throw Error('Fixture closure exceeds byte count');for(const ext of ['.uexp','.ubulk','.uptnl']){const extra=source.replace(/\.(uasset|umap)$/i,ext);if(fs.existsSync(extra))fs.copyFileSync(extra,target.replace(/\.(uasset|umap)$/i,ext))}const document=JSON.parse(execFileSync('dotnet',[path.join(root,'tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll'),target,'--packages'],{maxBuffer:32*1024*1024}));for(const name of document.assetReview.packages)if(name.startsWith('/Game/'))pending.push(name.slice(6)+'.uasset')}
 fs.writeFileSync(path.join(repo,'Fixture.uproject'),JSON.stringify({FileVersion:3,EngineAssociation:'5.8'}))
 if(name==='nested-missing')fs.unlinkSync(path.join(repo,'Content/NestedLeaf.umap'))
 git(repo,'add','-A');git(repo,'commit','-qm','fixture');const ref=git(repo,'rev-parse','HEAD').trim()
 const socketSource=name==='socket-host'?fs.readFileSync(path.join(content,'SocketMap.umap')):undefined
 if(socketSource){fs.chmodSync(path.join(repo,'Content/SocketMap.umap'),0o666);fs.writeFileSync(path.join(repo,'Content/SocketMap.umap'),'invalid working socket dependency')}
 const nestedBytes=new Map()
 if(name.startsWith('nested'))for(const relative of ['SubFixture.umap','NestedLeaf.umap']){
  nestedBytes.set(relative,fs.readFileSync(path.join(content,relative)))
  const target=path.join(repo,'Content',relative);if(fs.existsSync(target)){fs.chmodSync(target,0o666);fs.writeFileSync(target,'invalid working dependency')}
 }
 fs.chmodSync(path.join(repo,file),0o666);fs.writeFileSync(path.join(repo,file),'different working bytes')
 const {BlueprintRevisionService}=require(path.join(DIST,'services/BlueprintRevisionService')),service=new BlueprintRevisionService(path.join(root,'tools/BlueprintExtractor/bin/Release/net10.0'),cache)
 const result=await service.compare(repo,{filePath:file,leftRef:'ABSENT',rightRef:ref,requestId:'scene-test',nativeScene:true,sceneBakeMaterials:process.env.UNREAL_SCENE_BAKE==='1'})
 console.log(name,JSON.stringify({...result.right.scene,packages:result.right.scene.packages.length,actors:result.right.scene.actors?.length,bags:result.right.scene.bags?.length,diagnostics:result.right.scene.diagnostics.slice(0,5)}));expect(result.right.scene.status).toBe('ready');expect(fs.readFileSync(fixture)).toEqual(before);expect(fs.readFileSync(path.join(repo,file),'utf8')).toBe('different working bytes')
 await info.attach('scene-review.json',{body:Buffer.from(JSON.stringify(result.right.scene)),contentType:'application/json'})
  if(name==='texture'){expect(result.right.scene.stats).toMatchObject({meshes:1,materials:1,textures:1,vertices:4,triangles:2});expect(result.right.scene.diagnostics.join(' ')).toContain('Texture2D source image:')}
  if(name==='material' || name==='material-instance'){expect(result.right.scene.stats.materials).toBeGreaterThan(0);expect(result.right.scene.stats.triangles).toBeGreaterThan(0)}
  if(name==='StateTree'){expect(result.right.scene.bags.length).toBeGreaterThan(0);expect(result.right.scene.bags.some(bag=>bag.text.includes('WeaponSearchDistance=20000.000000'))).toBe(true);expect(new Set(result.right.scene.bags.map(bag=>bag.object+'\0'+bag.property)).size).toBe(result.right.scene.bags.length)}
  if(name==='world'){const parent=result.right.scene.actors.find(actor=>actor.name==='Captured Parent'),child=result.right.scene.actors.find(actor=>actor.name==='Captured Child'),sub=result.right.scene.actors.find(actor=>actor.name==='Captured Sublevel Actor');expect(parent.location).toEqual([100,200,30]);expect(child.location[0]).toBeCloseTo(100);expect(child.location[1]).toBeCloseTo(200);expect(child.location[2]).toBeCloseTo(50);expect(parent.saved).toBe(true);expect(child.saved).toBe(true);expect(sub.location).toEqual([1000,0,0]);expect(sub.saved).toBe(true)}
  if(name==='partition'){expect(result.right.scene.actorInventoryComplete).toBe(true);expect(result.right.scene.actorInventory.expected).toBe(result.right.scene.actorInventory.matched);const actor=result.right.scene.actors.find(actor=>actor.name==='Captured Partition Actor');expect(actor.location).toEqual([10000,20000,300]);expect(actor.saved).toBe(true);expect(result.right.scene.packages.some(pkg=>pkg.path.includes('/__ExternalActors__/'))).toBe(true)}
  if(name==='nested'){
   const scene=result.right.scene;expect(scene.actorInventoryComplete).toBe(true);expect(scene.actorInventory.expected).toBe(10);expect(scene.actorInventory.matched).toBe(10)
   for(const [label,location] of [['Captured Parent',[100,200,30]],['Captured Child',[100,200,50]],['Captured Sublevel Actor',[1000,0,0]],['Captured Nested Actor',[2000,3000,400]]]){const actor=scene.actors.find(actor=>actor.name===label);expect(actor).toBeDefined();location.forEach((value,index)=>expect(actor.location[index]).toBeCloseTo(value,6));expect(actor.saved).toBe(true)}
   expect(scene.packages.some(pkg=>pkg.path==='Content/NestedLeaf.umap')).toBe(true)
  }
  if(name==='nested-missing'){const scene=result.right.scene;expect(scene.actorInventoryComplete).toBe(false);expect(scene.diagnostics.join(' ')).toContain('Dependency is absent in the selected revision');expect(scene.actors.some(actor=>actor.name==='Captured Nested Actor')).toBe(false);expect(scene.actors.find(actor=>actor.name==='Captured Sublevel Actor')?.saved).toBe(true)}
  if(name==='nested-offset' || name==='nested-scale'){
   const scene=result.right.scene,reference=JSON.parse(fs.readFileSync(path.join(path.dirname(content),'offset-reference.json'),'utf8'))
   expect(scene.actorInventoryComplete).toBe(true);expect(scene.actorInventory.expected).toBe(11);expect(scene.actorInventory.matched).toBe(11)
   for(const [label,position] of Object.entries(reference.actors)){const actor=scene.actors.find(actor=>actor.name===label);expect(actor?.saved).toBe(true);position.forEach((value,index)=>expect(actor.location[index]).toBeCloseTo(value,6))}
   if(name==='nested-scale')for(const [label,pose] of Object.entries(reference.transforms)){
    const actor=scene.actors.find(actor=>actor.name===label);pose.scale.forEach((value,index)=>expect(actor.scale[index]).toBeCloseTo(value,6));expect(Math.abs(actor.rotation.reduce((sum,value,index)=>sum+value*pose.rotation[index],0))).toBeCloseTo(1,6)
   }
   if(name==='nested-offset'){
   const sub=scene.actors.find(actor=>actor.name==='Captured Sublevel Actor');[500,800,50].forEach((value,index)=>expect(sub.location[index]).toBeCloseTo(value,6))
    ;[-1700,-3100,480].forEach((value,index)=>expect(reference.actors['Captured Nested Actor'][index]).toBeCloseTo(value,6))
    ;[-1710,-3100,480].forEach((value,index)=>expect(reference.actors['Captured Nested Child'][index]).toBeCloseTo(value,6))
   }
  }
  for(const [relative,bytes] of nestedBytes){expect(fs.readFileSync(path.join(content,relative))).toEqual(bytes);const target=path.join(repo,'Content',relative);if(fs.existsSync(target))expect(fs.readFileSync(target,'utf8')).toBe('invalid working dependency')}
  if(name==='animation' || name==='composite'){expect(result.right.scene.stats.skins).toBeGreaterThan(0);expect(result.right.scene.stats.animations).toBeGreaterThan(0)}
  if(name==='saved-base'){expect(result.right.scene.actorInventoryComplete).toBe(true);expect(result.right.scene.playback).toHaveLength(4);for(const profile of result.right.scene.playback){expect(profile.position).toBe(.75);expect(profile.rate).toBe(-1)}fs.writeFileSync(path.join(root,'.blueprint-build/saved-base-proof.json'),JSON.stringify({scene:result.right.scene}))}
  if(name==='instances-nested'){
   const scene=result.right.scene;expect(scene.actorInventoryComplete).toBe(true);expect(scene.instances).toHaveLength(4);const cubes=scene.actors.filter(actor=>actor.name==='Repeated Cube');expect(cubes).toHaveLength(2);expect(cubes.map(actor=>actor.location[0]).sort((a,b)=>a-b)).toEqual([160,1060]);expect(new Set(cubes.map(actor=>actor.instancePath)).size).toBe(2);for(const actor of cubes)expect(actor.instancePath.split('/')).toHaveLength(2)
  }
  if(name==='instances'){
   const scene=result.right.scene;expect(scene.actorInventoryComplete).toBe(true);expect(scene.actorInventory.expected).toBe(name==='instances'?10:16);expect(scene.actorInventory.matched).toBe(scene.actorInventory.expected);expect(scene.instances).toHaveLength(name==='instances'?2:4)
   const copies=scene.actors.filter(actor=>actor.name==='Repeated Cube');expect(copies).toHaveLength(2);expect(new Set(copies.map(actor=>actor.guid)).size).toBe(1);expect(new Set(copies.map(actor=>actor.instancePath)).size).toBe(2);expect(new Set(copies.map(actor=>actor.path)).size).toBe(2);expect(new Set(copies.map(actor=>actor.sourcePath)).size).toBe(1)
   expect(copies.map(actor=>actor.location[0]).sort((a,b)=>a-b)).toEqual(name==='instances'?[110,1010]:[160,1060]);copies.forEach(actor=>{expect(actor.saved).toBe(true);expect(actor.location.slice(1)).toEqual([20,30]);expect(actor.inspectPath).toContain('InstanceMap:PersistentLevel.LevelInstance_');expect(actor.instancePath.split('/')).toHaveLength(name==='instances'?1:2)})
  }
  if(name==='instance-meshes'){
   const scene=result.right.scene;expect(scene.actorInventoryComplete).toBe(true);expect(scene.actorInventory.expected).toBe(14);expect(scene.actorInventory.matched).toBe(14);expect(scene.instances).toHaveLength(2);expect(scene.diagnostics.join(' ')).not.toContain('Instance mesh component profile unavailable');expect(scene.diagnostics.join(' ')).not.toContain('Instance geometry')
   for(const label of ['Repeated ISM','Repeated HISM']){const copies=scene.actors.filter(actor=>actor.name===label);expect(copies).toHaveLength(2);expect(new Set(copies.map(actor=>actor.guid)).size).toBe(1);expect(new Set(copies.map(actor=>actor.instancePath)).size).toBe(2)}
  }
  if(name==='skeletal-sockets' || skeletalHost){
   const scene=result.right.scene,reference=JSON.parse(fs.readFileSync(path.join(path.dirname(content),'skeletal-socket-reference.json'),'utf8'));expect(scene.actorInventoryComplete).toBe(true);expect(scene.actorInventory.expected).toBe((skeletalHost?18:7)+(reference.intermediarySocket?(skeletalHost?2:1):0));expect(scene.actorInventory.matched).toBe(scene.actorInventory.expected);expect(scene.stats.skins).toBeGreaterThan(0);expect(reference.bone).not.toBe('None')
   if(reference.skeletonSocket){
    const read=relative=>JSON.parse(execFileSync('dotnet',[path.join(root,'tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll'),path.join(content,relative)],{maxBuffer:32*1024*1024})).assetReview.objects
    const skeleton=read('OwnedSocketMesh_Skeleton.uasset'),socket=skeleton.find(object=>object.classPath==='/Script/Engine.SkeletalMeshSocket' && object.properties.SocketName==='SkeletalProbeSocket')
    expect(socket).toBeDefined();expect(socket.properties.BoneName).toBe(reference.bone);expect(skeleton.find(object=>object.classPath==='/Script/Engine.Skeleton').properties.Sockets).toContain(socket.path)
   }
   for(const [label,position] of Object.entries(reference.actors)){
    const copies=scene.actors.filter(actor=>actor.name===label);expect(copies).toHaveLength(skeletalHost?2:1)
     for(const actor of copies){const offset=skeletalHost?(actor.instanceLabel==='Skeletal Instance One'?100:1000):0;expect(actor.saved).toBe(true);position.forEach((v,index)=>{const expected=v+(index===0?offset:0);if(reference.skeletonSocket && label.endsWith('Child'))expect(Math.abs(actor.location[index]-expected)).toBeLessThan(.01);else expect(actor.location[index]).toBeCloseTo(expected,5)})}
   }
   expect(reference.actors['Skeletal Socket Child']).not.toEqual(reference.actors['Skeletal Bone Child'])
   if(skeletalHost){expect(scene.instances).toHaveLength(2);if(reference.inheritedAnimation)expect(scene.diagnostics.join(' ')).not.toContain('Instance skeletal geometry uses reference pose');else expect(scene.diagnostics.join(' ')).toContain('Instance skeletal geometry uses reference pose');expect(scene.diagnostics.join(' ')).not.toContain('Instance mesh component profile unavailable')}
  }
  if(name==='socket-host'){
   const scene=result.right.scene,reference=JSON.parse(fs.readFileSync(path.join(path.dirname(content),'socket-reference.json'),'utf8'));expect(scene.actorInventoryComplete).toBe(true);expect(scene.actorInventory.expected).toBe(22);expect(scene.actorInventory.matched).toBe(22);expect(scene.instances).toHaveLength(2)
   for(const label of ['Socket Child','Inherited Socket Child']){
    const copies=scene.actors.filter(actor=>actor.name===label);expect(copies).toHaveLength(3);expect(new Set(copies.map(actor=>actor.guid)).size).toBe(1)
    for(const actor of copies){const offset=actor.instanceLabel==='Socket Instance One'?100:actor.instanceLabel==='Socket Instance Two'?1000:2000;reference[label].forEach((v,index)=>expect(actor.location[index]).toBeCloseTo(v+(index===0?offset:0),5))}
   }
   expect(fs.readFileSync(path.join(content,'SocketMap.umap'))).toEqual(socketSource);expect(fs.readFileSync(path.join(repo,'Content/SocketMap.umap'),'utf8')).toBe('invalid working socket dependency')
  }
  if(name==='sockets'){
   const scene=result.right.scene,reference=JSON.parse(fs.readFileSync(path.join(path.dirname(content),'socket-reference.json'),'utf8'));expect(scene.actorInventoryComplete).toBe(true);expect(scene.actorInventory.expected).toBe(6)
   for(const [label,position] of Object.entries(reference)){if(label==='Inherited Mesh')continue;const actor=scene.actors.find(actor=>actor.name===label);expect(actor?.saved).toBe(true);position.forEach((value,index)=>expect(actor.location[index]).toBeCloseTo(value,5))}
   ;[90,250,50].forEach((value,index)=>expect(reference['Socket Child'][index]).toBeCloseTo(value,5));[395,165,10].forEach((value,index)=>expect(reference['Inherited Socket Child'][index]).toBeCloseTo(value,5));expect(reference['Inherited Mesh']).toEqual([400,140,0])
  }
  if(name!=='StateTree'){
   expect(result.right.scene.stats.meshes).toBeGreaterThan(0);const {nativeSceneService}=require(path.join(DIST,'services/NativeSceneService')),bytes=Buffer.from(await nativeSceneService.read(result.right.scene.key));expect(inspectSceneGlb(bytes).meshes).toBeGreaterThan(0)
   if(name.startsWith('instances')){
    const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString()),copies=result.right.scene.actors.filter(actor=>actor.name==='Repeated Cube')
    for(const actor of copies){const nodes=gltf.nodes.filter(node=>node.name===actor.renderName);expect(nodes).toHaveLength(1);expect(nodes[0].mesh).toBeDefined();[actor.location[0]/100,actor.location[2]/100,actor.location[1]/100].forEach((value,index)=>expect(nodes[0].translation[index]).toBeCloseTo(value,5))}
   }
   if(name==='instance-meshes'){
    const scene=result.right.scene,gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString()),reference=JSON.parse(fs.readFileSync(path.join(path.dirname(content),'instance-mesh-reference.json'),'utf8'))
    expect(reference['Repeated ISM'][0][0]).toBeCloseTo(30,5);expect(reference['Repeated ISM'][0][1]).toBeCloseTo(10,5);expect(reference['Repeated ISM'][1][1]).toBeCloseTo(90,5);expect(reference['Repeated HISM']).toEqual([[65,0,0],[105,0,0]])
    for(const label of ['Repeated ISM','Repeated HISM'])for(const actor of scene.actors.filter(actor=>actor.name===label)){
     const nodes=gltf.nodes.filter(node=>node.name.startsWith(actor.renderName+'__part_'));expect(nodes).toHaveLength(2)
     for(let i=0;i<2;i++){const node=nodes.find(node=>node.name.endsWith('_instance_'+i));expect(node.mesh).toBeDefined();const p=reference[label][i],offset=actor.instanceLabel==='Instance One'?100:1000;[ (p[0]+offset)/100,p[2]/100,p[1]/100].forEach((v,index)=>expect((node.translation ?? [0,0,0])[index]).toBeCloseTo(v,5));expect(node.scale ?? [1,1,1]).toEqual(label==='Repeated ISM'?[2,2,2]:[1,1,1])}
    }
   }
   if(name==='skeletal-sockets' || skeletalHost){
    const scene=result.right.scene,gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString()),{Matrix4,Vector3,Quaternion}=await import('three'),parents=new Map();gltf.nodes.forEach((node,index)=>(node.children ?? []).forEach(child=>parents.set(child,index)))
    const matrix=index=>{const node=gltf.nodes[index],local=node.matrix?new Matrix4().fromArray(node.matrix):new Matrix4().compose(new Vector3().fromArray(node.translation ?? [0,0,0]),new Quaternion().fromArray(node.rotation ?? [0,0,0,1]),new Vector3().fromArray(node.scale ?? [1,1,1]));return parents.has(index)?matrix(parents.get(index)).multiply(local):local}
    const fixtureReference=JSON.parse(fs.readFileSync(path.join(path.dirname(content),'skeletal-socket-reference.json'),'utf8'))
    for(const actor of scene.actors.filter(actor=>!fixtureReference.savedProfile && ['Skeletal Socket Child','Skeletal Bone Child','Inherited Skeletal Socket Child','Socket Intermediary'].includes(actor.name))){const name=actor.renderName ?? actor.name,matches=gltf.nodes.map((node,index)=>({node,index})).filter(value=>value.node.name===name);expect(matches).toHaveLength(1);expect(matches[0].node.mesh).toBeDefined();const position=new Vector3().setFromMatrixPosition(matrix(matches[0].index)).toArray();[actor.location[0]/100,actor.location[2]/100,actor.location[1]/100].forEach((v,index)=>{if(fixtureReference.attachmentChain && (actor.name==='Inherited Skeletal Socket Child' || fixtureReference.intermediarySocket && actor.name==='Socket Intermediary'))expect(Math.abs(position[index]-v)).toBeLessThan(.00025);else expect(position[index]).toBeCloseTo(v,4)})}
    if(name==='animated-host'){
     expect(scene.stats.animations).toBeGreaterThan(0);expect(scene.diagnostics.join(' ')).not.toContain('Instance skeletal attachment')
     const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js'),THREE=await import('three'),loaded=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')
     const {primeNativeAnimationPose,nativeClipPlayback}=component('src/lib/nativeSceneObjects.ts',{'three':THREE}).exports,profiles=nativeClipPlayback(loaded.animations,loaded.scene,scene.actors,scene.playback);primeNativeAnimationPose(loaded.scene,loaded.animations,profiles);const objects=new Map();loaded.scene.traverse(object=>objects.set(object.userData.name ?? object.name,object));if(fixtureReference.savedProfile)for(const actor of scene.actors.filter(actor=>['Skeletal Socket Child','Skeletal Bone Child','Inherited Skeletal Socket Child'].includes(actor.name))){const p=objects.get(actor.renderName).getWorldPosition(new THREE.Vector3()).toArray();[actor.location[0]/100,actor.location[2]/100,actor.location[1]/100].forEach((v,i)=>expect(Math.abs(p[i]-v)).toBeLessThan(.00025))}
     const reference=JSON.parse(fs.readFileSync(path.join(path.dirname(content),'skeletal-socket-reference.json'),'utf8'));let moving=0,inheritedMoving=0
     for(const clip of loaded.animations){const mixer=new THREE.AnimationMixer(loaded.scene);const profile=profiles[loaded.animations.indexOf(clip)],action=mixer.clipAction(clip).setLoop(THREE.LoopOnce,1).setEffectiveTimeScale(profile?.rate ?? 1).play();action.clampWhenFinished=true;action.time=profile?.position ?? 0;mixer.update(0);loaded.scene.updateMatrixWorld(true);const starts=new Map(scene.actors.filter(actor=>['Skeletal Socket Child','Skeletal Bone Child','Inherited Skeletal Socket Child','Socket Intermediary'].includes(actor.name)).map(actor=>[actor,objects.get(actor.renderName).getWorldPosition(new THREE.Vector3())]));mixer.update(reference.savedProfile?.1:.5);loaded.scene.updateMatrixWorld(true)
      const moved=[];for(const [actor,before] of starts){const delta=objects.get(actor.renderName).getWorldPosition(new THREE.Vector3()).sub(before);if(delta.length()>.01)moved.push({actor,delta})}
      const ordinary=moved.some(({actor})=>actor.name!=='Inherited Skeletal Socket Child');for(const {delta} of moved){expect(delta.x).toBeCloseTo(0,4);expect(delta.y).toBeCloseTo(0,4);expect(delta.z).toBeCloseTo(ordinary?(reference.savedProfile?.08:.2):(reference.savedProfile?.04:.1),4)}
      expect(moved).toHaveLength(ordinary?(reference.intermediarySocket?4:reference.attachmentChain?3:2):1);expect(new Set(moved.map(({actor})=>actor.instancePath)).size).toBe(1)
      if(reference.composite){expect(clip.duration).toBeCloseTo(2,4);action.time=1.5;mixer.update(0);loaded.scene.updateMatrixWorld(true);for(const {actor,delta} of moved)expect(objects.get(actor.renderName).getWorldPosition(new THREE.Vector3()).sub(starts.get(actor)).distanceTo(delta)).toBeLessThan(.00005)}
      if(!ordinary)inheritedMoving++;moving++;mixer.stopAllAction();mixer.uncacheRoot(loaded.scene)
     }
     expect(moving).toBe(reference.inheritedAnimation?4:2);expect(inheritedMoving).toBe(reference.inheritedAnimation?2:0)
     fs.writeFileSync(path.join(root,'.blueprint-build/animated-socket-proof.glb'),bytes);fs.writeFileSync(path.join(root,'.blueprint-build/animated-socket-proof.json'),JSON.stringify({scene,inheritedAnimation:reference.inheritedAnimation,savedProfile:reference.savedProfile,composite:reference.composite,attachmentChain:reference.attachmentChain,intermediarySocket:reference.intermediarySocket,fixtureHashes:scene.packages.map(pkg=>[pkg.path,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(content,pkg.path.slice(8)))).digest('hex')])}))
    }
    if(skeletalHost){fs.writeFileSync(info.outputPath('skeletal-scene.glb'),bytes);await info.attach('skeletal-scene.glb',{path:info.outputPath('skeletal-scene.glb'),contentType:'model/gltf-binary'})}
    if(skeletalHost){const skeletalActors=scene.actors.filter(actor=>['Skeletal Parent','Inherited Skeletal Parent'].includes(actor.name)),owner=index=>{for(let current=index;current!==undefined;current=parents.get(current)){const match=skeletalActors.find(actor=>actor.renderName===gltf.nodes[current].name);if(match)return match}};for(const actor of skeletalActors){expect(gltf.nodes.some(node=>node.name===actor.renderName)).toBe(true);expect(gltf.nodes.filter(node=>node.skin!==undefined && gltf.skins[node.skin].joints.some(joint=>owner(joint)===actor))).toHaveLength(1)}}
   }
   if(name==='socket-host'){
    const scene=result.right.scene,gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString()),{Matrix4,Vector3,Quaternion}=await import('three'),parents=new Map();gltf.nodes.forEach((node,index)=>(node.children ?? []).forEach(child=>parents.set(child,index)))
    const matrix=index=>{const node=gltf.nodes[index],local=node.matrix?new Matrix4().fromArray(node.matrix):new Matrix4().compose(new Vector3().fromArray(node.translation ?? [0,0,0]),new Quaternion().fromArray(node.rotation ?? [0,0,0,1]),new Vector3().fromArray(node.scale ?? [1,1,1]));return parents.has(index)?matrix(parents.get(index)).multiply(local):local}
    for(const actor of scene.actors.filter(actor=>['Socket Child','Inherited Socket Child'].includes(actor.name))){const name=actor.renderName ?? actor.name,matches=gltf.nodes.map((node,index)=>({node,index})).filter(value=>value.node.name===name);expect(matches).toHaveLength(1);expect(matches[0].node.mesh).toBeDefined();const position=new Vector3().setFromMatrixPosition(matrix(matches[0].index)).toArray();[actor.location[0]/100,actor.location[2]/100,actor.location[1]/100].forEach((v,index)=>expect(position[index]).toBeCloseTo(v,5))}
   }
   if(name==='sockets'){
    const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString()),{Matrix4,Vector3,Quaternion}=await import('three'),parents=new Map();gltf.nodes.forEach((node,index)=>(node.children ?? []).forEach(child=>parents.set(child,index)))
    const matrix=index=>{const node=gltf.nodes[index],local=node.matrix?new Matrix4().fromArray(node.matrix):new Matrix4().compose(new Vector3().fromArray(node.translation ?? [0,0,0]),new Quaternion().fromArray(node.rotation ?? [0,0,0,1]),new Vector3().fromArray(node.scale ?? [1,1,1]));return parents.has(index)?matrix(parents.get(index)).multiply(local):local}
    for(const [label,position] of Object.entries(JSON.parse(fs.readFileSync(path.join(path.dirname(content),'socket-reference.json'),'utf8')))){const index=gltf.nodes.findIndex(node=>node.name===label);if(label==='Inherited Mesh')continue;expect(index).toBeGreaterThanOrEqual(0);const p=new Vector3().setFromMatrixPosition(matrix(index)).toArray();[position[0]/100,position[2]/100,position[1]/100].forEach((value,i)=>expect(p[i]).toBeCloseTo(value,5))}
   }
   if(name.startsWith('nested')){
    const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString()),node=gltf.nodes.find(node=>node.name==='Captured Nested Actor')
    if(name==='nested'){expect(node).toBeDefined();expect(node.mesh).toBeDefined();[20,4,30].forEach((value,index)=>expect(node.translation[index]).toBeCloseTo(value,5))}
    else if(name==='nested-missing')expect(node).toBeUndefined()
    else if(name==='nested-offset'){
     expect(node).toBeDefined();[-17,4.8,-31].forEach((value,index)=>expect(node.translation[index]).toBeCloseTo(value,5));expect(Math.abs(node.rotation[1])).toBeCloseTo(1,6)
     const childIndex=gltf.nodes.findIndex(node=>node.name==='Captured Nested Child');expect(node.children).toContain(childIndex);[.1,0,0].forEach((value,index)=>expect((gltf.nodes[childIndex].translation ?? [0,0,0])[index]).toBeCloseTo(value,5))
    }
    else{
     const reference=JSON.parse(fs.readFileSync(path.join(path.dirname(content),'offset-reference.json'),'utf8')),position=reference.actors['Captured Nested Actor'],scale=reference.transforms['Captured Nested Actor'].scale
     ;[position[0]/100,position[2]/100,position[1]/100].forEach((value,index)=>expect(node.translation[index]).toBeCloseTo(value,5))
     ;[scale[0],scale[2],scale[1]].forEach((value,index)=>expect((node.scale ?? [1,1,1])[index]).toBeCloseTo(value,5))
     expect(Math.abs(node.rotation[1])).toBeCloseTo(1,6)
     const childIndex=gltf.nodes.findIndex(node=>node.name==='Captured Nested Child');expect(node.children).toContain(childIndex);expect(gltf.nodes[childIndex].mesh).toBeDefined()
     const {Matrix4,Vector3,Quaternion}=await import('three'),matrix=n=>new Matrix4().compose(new Vector3().fromArray(n.translation ?? [0,0,0]),new Quaternion().fromArray(n.rotation ?? [0,0,0,1]),new Vector3().fromArray(n.scale ?? [1,1,1])),childWorld=new Vector3().setFromMatrixPosition(matrix(node).multiply(matrix(gltf.nodes[childIndex]))),childPosition=reference.actors['Captured Nested Child']
     ;[childPosition[0]/100,childPosition[2]/100,childPosition[1]/100].forEach((value,index)=>expect(childWorld.toArray()[index]).toBeCloseTo(value,5))
    }
   }
  }
})
test('shared animated-instance viewer labels owners and scrubs/plays captured socket motion without rereading',async({page})=>{
 const fixture=process.env.UNREAL_SCENE_ANIMATED_SOCKETS;test.skip(!fixture,'Enable the native animated socket capture case first')
 const proof=JSON.parse(fs.readFileSync(path.join(root,'.blueprint-build/animated-socket-proof.json'),'utf8')),content=path.dirname(fixture)
 for(const [file,hash] of proof.fixtureHashes)expect(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(content,file.slice(8)))).digest('hex')).toBe(hash)
 const baseProof=process.env.UNREAL_SCENE_SAVED_BASE?JSON.parse(fs.readFileSync(path.join(root,'.blueprint-build/saved-base-proof.json'),'utf8')):undefined;if(baseProof){expect(baseProof.scene.actors.filter(actor=>actor.renderName).map(actor=>actor.renderName).sort()).toEqual(proof.scene.actors.filter(actor=>actor.renderName).map(actor=>actor.renderName).sort());baseProof.scene.key=proof.scene.key} // Force shared-byte reuse; independent exports may reorder nodes.
 const dir=tmpDir('lg-animated-sockets-browser-'),scene=proof.scene,bytes=fs.readFileSync(path.join(root,'.blueprint-build/animated-socket-proof.glb'))
 await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ScenePreview} from './src/components/diff/ScenePreview';import './src/index.css';import './src/components/diff/UnrealAssetReview.css';const scenes=${JSON.stringify([baseProof?.scene ?? null,scene])};function App(){const [side,setSide]=React.useState<'left'|'right'>('right');return <div className="uar">${baseProof?'<button onClick={()=>setSide(\'left\')}>Base snapshot</button><button onClick={()=>setSide(\'right\')}>Selected snapshot</button>':''}<ScenePreview scenes={scenes} side={side} labels={{left:'Base',right:'Selected'}}/></div>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm',plugins:[{name:'socket-proof',setup(build){build.onLoad({filter:/ScenePreview\.tsx$/},args=>({contents:fs.readFileSync(args.path,'utf8').replace('renderer!.render(scene,camera)','groups[1].updateMatrixWorld(true);(window as any).socketPositions={};groups[1].traverse(object=>{const name=object.userData.name ?? object.name;if(name.startsWith("Skeletal Socket Child__LGI_") || name.startsWith("Inherited Skeletal Socket Child__LGI_") || name.startsWith("Socket Intermediary__LGI_"))(window as any).socketPositions[name]=object.getWorldPosition(new THREE.Vector3()).toArray()});renderer!.render(scene,camera)'),loader:'tsx'}))}}]})
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><div id="root"></div><script>window.reads=0;window.lucidGit={nativeSceneRead:async()=>{window.reads++;return new Uint8Array(${JSON.stringify([...bytes])})}}</script><script type="module" src="/app.js"></script></html>`)}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PLAYBACK PAGE ERROR',e.message)})
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);await expect(page.getByRole('button',{name:'Fit scene',exact:true})).toBeEnabled()
  for(const instance of ['Skeletal Instance One','Skeletal Instance Two'])for(const owner of (proof.inheritedAnimation?['Skeletal Parent','Inherited Skeletal Parent']:['Skeletal Parent'])){
   await page.getByRole('combobox',{name:'Animation clip'}).click();await page.getByRole('option').filter({hasText:' · '+owner+' · '+instance}).click();await expect(page.getByRole('combobox',{name:'Animation clip'})).toContainText(owner+' · '+instance)
   const child=owner==='Skeletal Parent'?'Skeletal Socket Child':'Inherited Skeletal Socket Child',actor=scene.actors.find(actor=>actor.name===child && actor.instanceLabel===instance)
   await page.getByRole('slider',{name:'Animation time'}).fill(proof.savedProfile?'0.5':'0');await page.waitForTimeout(100);const before=await page.evaluate(()=>window.socketPositions)
   await page.getByRole('slider',{name:'Animation time'}).fill(proof.savedProfile?'0.7':'0.5');await expect.poll(async()=>{const next=await page.evaluate(()=>window.socketPositions);return next[actor.renderName][2]-before[actor.renderName][2]}).toBeCloseTo(owner==='Skeletal Parent'?(proof.savedProfile?.08:.2):(proof.savedProfile?.04:.1),4)
   const after=await page.evaluate(()=>window.socketPositions);for(const other of scene.actors.filter(value=>['Skeletal Socket Child','Inherited Skeletal Socket Child','Socket Intermediary'].includes(value.name) && value!==actor)){const follows=proof.attachmentChain && owner==='Skeletal Parent' && ['Inherited Skeletal Socket Child','Socket Intermediary'].includes(other.name) && other.instanceLabel===instance;after[other.renderName].forEach((v,index)=>expect(v).toBeCloseTo(before[other.renderName][index]+(follows && index===2?(proof.savedProfile?.08:.2):0),4))}
   await page.getByRole('button',{name:'Play',exact:true}).click();await expect.poll(()=>page.getByRole('slider',{name:'Animation time'}).inputValue()).not.toBe(proof.savedProfile?'0.7':'0.5');if(await page.getByRole('button',{name:'Pause',exact:true}).isVisible())await page.getByRole('button',{name:'Pause',exact:true}).click()
  }
  if(baseProof){
   const actor=scene.actors.find(actor=>actor.name==='Skeletal Socket Child'),before=await page.evaluate(()=>window.socketPositions)
   await page.getByRole('button',{name:'Base snapshot',exact:true}).click();await expect(page.getByRole('slider',{name:'Animation time'})).toHaveValue('0.75')
   await expect(page.getByText('Saved start 0.75s · -1×',{exact:false})).toBeVisible()
   await expect.poll(async()=>{const next=await page.evaluate(()=>window.socketPositions);return next[actor.renderName][2]-before[actor.renderName][2]}).toBeCloseTo(.1,4)
   await page.getByRole('button',{name:'Selected snapshot',exact:true}).click();await expect(page.getByRole('slider',{name:'Animation time'})).toHaveValue('0.5')
   await expect(page.getByText('Saved start 0.5s · 2×',{exact:false})).toBeVisible()
   await expect.poll(async()=>{const next=await page.evaluate(()=>window.socketPositions);return next[actor.renderName][2]-before[actor.renderName][2]}).toBeCloseTo(0,4)
  }
  expect(await page.evaluate(()=>window.reads)).toBe(1);expect(errors).toEqual([])
 }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})

test('shared GPU scene renders materials and skins, scrubs/plays clips, retains camera across tabs and releases on close',async({page},info)=>{
 const dir=tmpDir('lg-scene-browser-'),bytes=[...animatedGlb()],key='d'.repeat(64)
 const asset={id:'',name:'Mesh',path:'Mesh',classPath:'/Script/Engine.SkeletalMesh',outer:'',properties:{},decoded:false,opaqueBytes:1,opaqueHash:'x',diagnostics:[]}
 const doc={schemaVersion:1,readerVersion:16,engineVersion:'5.8.3',assetClass:asset.classPath,graphs:[],diagnostics:[],status:'unsupported',assetReview:{family:'mesh',objects:[asset],coverage:[],cooked:false}}
 const scene={status:'ready',key,renderLod:{requested:0,count:2},engineVersion:'5.8.3',packages:[],diagnostics:[],complete:true,stats:inspectSceneGlb(animatedGlb())}
 const result={left:{status:'absent',ref:'ABSENT',path:'Content/Mesh.uasset'},right:{status:'ready',ref:'WORKING',path:'Content/Mesh.uasset',document:doc}}
 await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/Mesh.uasset',leftRef:'ABSENT',rightRef:'WORKING'}}/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.reads=0;window.calls=[];window.lucidGit={blueprintCompare:async(_,r)=>{window.calls.push(r);const result=${JSON.stringify(result)};if(r.nativeScene)result.right.scene=r.sceneLod===1?{status:'unavailable',reason:'Selected render LOD unavailable',engineVersion:'5.8.3',packages:[],diagnostics:[],complete:false}:${JSON.stringify(scene)};return result},nativeSceneRead:async()=>{window.reads++;return new Uint8Array(${JSON.stringify(bytes)})},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`)}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PLAYBACK PAGE ERROR',e.message)})
 try{
  await page.setViewportSize({width:1100,height:850});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Preview',exact:true}).click();await page.getByRole('button',{name:'Render scene with dependencies',exact:true}).click()
  const viewport=page.getByRole('region',{name:'Engine scene viewport'});await expect(viewport).toBeVisible();await expect(page.getByRole('combobox',{name:'Animation clip'})).toContainText('Captured rotation')
  const captureCalls=await page.evaluate(()=>window.calls.length);const before=await viewport.screenshot();await page.getByRole('slider',{name:'Animation time'}).fill('0.5');await expect(page.locator('.uar-scene')).toContainText('0.50 / 1.00 s');expect((await viewport.screenshot()).equals(before)).toBe(false)
  await page.getByRole('button',{name:'Play',exact:true}).click();await expect.poll(()=>page.getByRole('slider',{name:'Animation time'}).inputValue()).not.toBe('0.5');if(await page.getByRole('button',{name:'Pause',exact:true}).isVisible())await page.getByRole('button',{name:'Pause',exact:true}).click()
  await viewport.focus();await page.keyboard.press('+');await page.getByRole('button',{name:'Skeleton',exact:true}).click();await page.getByRole('button',{name:'Wireframe',exact:true}).last().click();await page.getByRole('button',{name:'Contents',exact:true}).click();await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.getByRole('button',{name:'Skeleton',exact:true})).toHaveAttribute('aria-pressed','true')
  expect(await page.evaluate(()=>window.reads)).toBe(1);expect(await page.evaluate(()=>window.calls.length)).toBe(captureCalls);await page.getByRole('combobox',{name:'Render LOD preference'}).click();await page.getByRole('option',{name:/LOD 1/}).click();await expect(page.getByText('Selected render LOD unavailable',{exact:true})).toBeVisible();await expect(page.getByRole('region',{name:'Engine scene viewport'})).not.toBeVisible();await page.getByRole('combobox',{name:'Render LOD preference'}).click();await page.getByRole('option',{name:/LOD 0/}).click();await expect(page.getByRole('region',{name:'Engine scene viewport'})).toBeVisible();expect(await page.evaluate(()=>window.calls.slice(-3).map(request=>request.sceneLod))).toEqual([0,1,0]);await page.screenshot({path:info.outputPath('native-scene.png')});await page.setViewportSize({width:480,height:640});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([])
 }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
test('native StateTree parameter table compares unique owners and preserves nested/native text at narrow widths',async({page})=>{
 const dir=tmpDir('lg-native-bags-ui-'),scenes=[20000,25000].map(value=>({status:'ready',engineVersion:'5.8.3',packages:[],diagnostics:[],complete:true,bags:[{object:'EditorData',property:'root_parameter_property_bag',text:`(Value=/Engine/Transient.PropertyBag_x(WeaponSearchDistance=${value},Location=(X=1,Y=2,Z=3)))`},{object:'StateTreeState_0.Child',property:'parameters',text:'(Value=None)'}]}))
 await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {NativeStateTreeBags} from './src/components/diff/ScenePreview';import './src/index.css';import './src/components/diff/UnrealAssetReview.css';createRoot(document.getElementById('root')).render(<div className="uar"><NativeStateTreeBags scenes={${JSON.stringify(scenes)}} side="right"/></div>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<html><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>')}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{await page.setViewportSize({width:480,height:640});await page.goto(`http://127.0.0.1:${server.address().port}`);await expect(page.getByRole('table')).toContainText('WeaponSearchDistance');await expect(page.getByRole('table')).toContainText('25000');await expect(page.getByRole('table')).toContainText('(X=1,Y=2,Z=3)');await expect(page.locator('summary').first()).toContainText('changed');await expect(page.locator('.uar-before')).toContainText('20000');await expect(page.getByText('Empty property bag.',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)}finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
for(const instanced of [false,true])test(`native ${instanced?'instanced':'ordinary'} actor list opens the shared saved-object inspector and retains it across tabs`,async({page})=>{
 const dir=tmpDir('lg-scene-inspector-'),actor={id:'',name:'Actor_0',path:'FixtureMap.PersistentLevel.Actor_0',outer:'FixtureMap.PersistentLevel',classPath:'/Script/Engine.StaticMeshActor',properties:{ActorLabel:'Captured Actor',Tags:['SavedTag']},decoded:true,opaqueBytes:0,opaqueHash:'',diagnostics:[]}
 const document={schemaVersion:1,readerVersion:16,engineVersion:'5.8.3',assetClass:'/Script/Engine.World',graphs:[],diagnostics:[],status:'unsupported',assetReview:{family:'map',objects:[actor],coverage:[],cooked:false}},scene={status:'ready',key:'e'.repeat(64),engineVersion:'5.8.3',packages:[],diagnostics:[],complete:true,actors:[{name:'Captured Actor',path:instanced?'/Game/LGI_copy.Source:PersistentLevel.Cube':'/Game/FixtureMap.FixtureMap:PersistentLevel.Actor_0',location:[0,0,0],saved:true,...(instanced?{instancePath:'a'.repeat(32),instanceLabel:'Instance One',sourcePath:'/Game/Source.Source:PersistentLevel.Cube',inspectPath:'/Game/FixtureMap.FixtureMap:PersistentLevel.Actor_0',renderName:'Captured Actor__LGI_copy'}:{})}]},result={left:{status:'absent',ref:'ABSENT',path:'Content/FixtureMap.umap'},right:{status:'ready',ref:'WORKING',path:'Content/FixtureMap.umap',document}}
 await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/FixtureMap.umap',leftRef:'ABSENT',rightRef:'WORKING'}}/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
 const server=http.createServer((req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.reads=0;window.calls=0;window.lucidGit={blueprintCompare:async(_,request)=>{window.calls++;const result=${JSON.stringify(result)};if(request.nativeScene)result.right.scene=${JSON.stringify(scene)};return result},nativeSceneRead:async()=>{window.reads++;return new Uint8Array(${JSON.stringify([...animatedGlb()])})},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`)}res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'Preview',exact:true}).click();await page.getByText('3D geometry export (slow)',{exact:true}).click();await page.getByRole('button',{name:'Export 3D geometry (slow)',exact:true}).click();await page.getByText('Reconstructed actors (1 saved · 0 engine-generated)',{exact:true}).click();if(instanced){await page.getByLabel('Filter native actors').fill('Instance One');await expect(page.locator('.uar-row')).toContainText('Source: /Game/Source.Source:PersistentLevel.Cube')}await page.getByRole('button',{name:/Captured Actor.*PersistentLevel/}).click();await expect(page.getByRole('region',{name:'Saved object details'})).toContainText('Actor_0');await page.getByRole('region',{name:'Saved object details'}).getByText('Tags',{exact:true}).click();await expect(page.getByRole('region',{name:'Saved object details'})).toContainText('SavedTag');await page.getByRole('button',{name:'Contents',exact:true}).click();await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.getByRole('region',{name:'Saved object details'})).toContainText('Actor_0');await page.getByRole('button',{name:'Saved positions',exact:true}).click();await page.getByText('3D geometry export (slow)',{exact:true}).click();await page.getByRole('button',{name:'Show exported geometry',exact:true}).click();await expect(page.getByRole('button',{name:'Fit scene',exact:true})).toBeEnabled();expect(await page.evaluate(()=>[window.calls,window.reads])).toEqual([2,1])}finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})


test('render-only map snapshots follow visual manifests without expanding gameplay and UI imports',async()=>{
 const dir=tmpDir('lg-visual-closure-'),root={path:'Content/Map.umap',documentKey:'root',status:'ready'},calls=[]
 const manifests={
  'Content/Map.umap':[['/Game/VisualActor','/Game/GameMode','/Game/Menu'],['/Game/VisualActor']],
  'Content/VisualActor.uasset':[['/Game/Parent','/Game/Mesh','/Game/FunctionLibrary'],['/Game/Parent','/Game/Mesh']],
  'Content/Parent.uasset':[[],[]],
  'Content/Mesh.uasset':[['/Game/Material'],['/Game/Material']],
  'Content/Material.uasset':[['/Game/Texture'],['/Game/Texture']],
  'Content/Texture.uasset':[[],[]],
 }
 const args={root,directory:dir,external:async()=>[],stamp:async()=>'',capture:async file=>{calls.push(file);const[packages,renderPackages]=manifests[file]??[[],[]];return {status:'ready',path:file,documentKey:file===root.path?'root':file,sourceBytes:16,document:{engineVersion:'5.8.3',assetClass:file===root.path?'/Script/Engine.World':'/Script/Engine.StaticMesh',assetReview:{objects:[],packages,renderPackages,packageReferencesComplete:true,actorCandidates:[],actorCandidatesComplete:true}}}}}
 const visual=await captureSceneSnapshot({...args,renderOnly:true});expect(calls).toEqual(Object.keys(manifests));expect(visual.complete).toBe(false);expect(visual.diagnostics.join(' ')).toContain('nonvisual dependencies are excluded')
 calls.length=0;const full=await captureSceneSnapshot(args);expect(calls).toContain('Content/GameMode.uasset');expect(calls).toContain('Content/Menu.uasset');expect(calls).toContain('Content/FunctionLibrary.uasset');expect(full.identity).not.toBe(visual.identity)
 await expect(captureSceneSnapshot({...args,renderOnly:true,capture:async file=>{const side=await args.capture(file);delete side.document.assetReview.renderPackages;return side}})).rejects.toThrow('render dependency manifest is unavailable')
})
