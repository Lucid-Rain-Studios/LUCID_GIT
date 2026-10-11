const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { execFileSync } = require('node:child_process')
const { component } = require('./renderer-harness')
const { tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
const { animationStateMachine, boundGraphs } = component('src/lib/animationReview.ts').exports
const graphTools = component('src/lib/blueprintGraph.ts').exports
const read = file => JSON.parse(execFileSync('dotnet',['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',file],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}))
test.afterAll(cleanup)
const pin = (id,name,direction,links=[]) => ({id,name,direction,links})
const node = (id,type,properties={},pins=[]) => ({id,name:id,title:type,classPath:'/Script/AnimGraph.'+type,properties,pins,complete:true})
const a = node('a','AnimStateNode',{BoundGraph:'Asset.Machine.a.Idle'},[pin('a-out','Out','output',[{node:'t',pin:'t-in'}])])
const b = node('b','AnimStateNode',{BoundGraph:'Asset.Machine.b.Run'},[pin('b-in','In','input',[{node:'t',pin:'t-out'}])])
const t = node('t','AnimStateTransitionNode',{BoundGraph:'Asset.Machine.t.Rule',CrossfadeDuration:.25},[pin('t-in','In','input',[{node:'a',pin:'a-out'}]),pin('t-out','Out','output',[{node:'b',pin:'b-in'}])])
const machine = {id:'m',kind:'state-machine',name:'Machine',path:'Asset.Machine',nodes:[a,b,t],complete:true}
const rule = {id:'r',kind:'transition',name:'Rule',path:'Asset.Machine.t.Rule',nodes:[],complete:true}

test('state summaries require unique reciprocal endpoints and exact captured graph references', () => {
  let model = animationStateMachine(machine,[machine,rule])
  expect(model.rows.map(row=>row.name)).toEqual(['Idle','Run','Idle → Run'])
  expect(model.rows[2].links[0].graph).toEqual(rule)
  expect(boundGraphs(t,[rule,{...rule}])[0].graph).toBeUndefined()
  expect(boundGraphs(t,[{...rule,path:'Other.Rule'}])[0].graph).toBeUndefined()
  const broken = structuredClone(machine);broken.nodes[1].pins[0].links=[]
  expect(animationStateMachine(broken,[rule]).rows[2].name).toBe('Idle → Unresolved target')
  expect(animationStateMachine({...machine,nodes:[a,{...a},b,t]},[rule]).rows[3].name).toBe('Unresolved source → Run')
  expect(animationStateMachine({...machine,nodes:[a,b,{...t,complete:false}]},[rule]).rows[2].name).toBe('Unresolved source → Unresolved target')
  const alias=node('alias','AnimStateAliasNode',{StateAliasName:'To Run',AliasedStateNodes:{0:'Asset.Machine.a',1:'Foreign.a'}})
  const row=animationStateMachine({...machine,nodes:[a,b,t,alias]},[]).rows[3]
  expect(row.name).toBe('To Run');expect(row.members[0].node).toEqual(a);expect(row.members[1].node).toBeUndefined()
  expect(animationStateMachine({...machine,nodes:Array.from({length:501},(_,i)=>({...a,id:String(i)}))},[]).omitted).toBe(1)
})

test('real complex animation exposes named states and captured rules without modifying source', () => {
  test.skip(!process.env.UNREAL_REVIEW_COMPLEX_ANIMATION,'Set complex animation fixture')
  const file=process.env.UNREAL_REVIEW_COMPLEX_ANIMATION,before=fs.readFileSync(file),doc=read(file)
  const graph=doc.graphs.find(g=>g.name==='Locomotion'&&g.kind==='state-machine')
  const model=animationStateMachine(graph,doc.graphs)
  expect(model.rows.map(row=>row.name)).toEqual(['Entry','Idle','Walk / Run','Idle → Walk / Run','Walk / Run → Idle'])
  expect(model.rows.filter(row=>row.kind==='Transition').every(row=>row.links[0].graph.kind==='transition')).toBe(true)
  const pose = doc.graphs.find(g=>g.name==='AnimGraph')
  expect(pose.complete).toBe(true)
  expect(pose.nodes).toHaveLength(8)
  expect(pose.nodes.flatMap(node=>node.pins)).toHaveLength(17)
  expect(pose.nodes.every(node=>node.complete)).toBe(true)
  expect(pose.diagnostics).toEqual([])
  for (const node of pose.nodes) for (const pin of node.pins) for (const link of pin.links) {
    const peer = pose.nodes.find(node=>node.id===link.node)?.pins.find(pin=>pin.id===link.pin)
    expect(peer?.links.some(link=>link.node===node.id&&link.pin===pin.id)).toBe(true)
  }
  const changed = structuredClone(pose)
  changed.nodes.find(node=>node.classPath.endsWith('AnimGraphNode_SaveCachedPose')).properties.CacheName = 'Changed saved cache'
  const source = changed.nodes.find(node=>node.classPath.endsWith('AnimGraphNode_Root')), link = source.pins[0].links[0]
  const peer = changed.nodes.find(node=>node.id===link.node).pins.find(pin=>pin.id===link.pin)
  source.pins[0].links=[]; peer.links=peer.links.filter(link=>link.node!==source.id)
  expect(graphTools.graphChanges({left:pose,right:changed}).filter(change=>change.kind==='modified').length).toBeGreaterThanOrEqual(2)
  expect(graphTools.wireChanges({left:pose,right:changed})).toMatchObject([{kind:'removed'}])
  expect(fs.readFileSync(file)).toEqual(before)
})

test('shared animation review focuses saved transitions and navigates rules without another capture', async ({page},testInfo) => {
  test.setTimeout(30000)
  test.skip(!process.env.UNREAL_REVIEW_COMPLEX_ANIMATION,'Set complex animation fixture')
  const document=read(process.env.UNREAL_REVIEW_COMPLEX_ANIMATION),dir=tmpDir('lg-animation-review-')
  const modified=structuredClone(document)
  modified.graphs.find(g=>g.name==='Locomotion'&&g.kind==='state-machine').nodes.find(n=>n.classPath.endsWith('AnimStateTransitionNode')).properties.CrossfadeDuration=.75
  const result={left:{status:'ready',ref:'a'.repeat(40),document},right:{status:'ready',ref:'b'.repeat(40),document:modified}}
  await require('esbuild').build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/ABP.uasset',leftRef:'${result.left.ref}',rightRef:'${result.right.ref}'}} onFallback={()=>{}}/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm'})
  const server=http.createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.calls=[];window.lucidGit={blueprintCompare:async(_,r)=>{window.calls.push(r);return ${JSON.stringify(result)}},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`)}
    const target=req.url==='/blueprint/klee.js'?path.join(root,'public/blueprint/klee.js'):path.join(dir,req.url.slice(1))
    res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(target))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{
    window.poseWireDraws=0
    const original=CanvasRenderingContext2D.prototype.bezierCurveTo
    CanvasRenderingContext2D.prototype.bezierCurveTo=function(...args){window.poseWireDraws++;return original.apply(this,args)}
  })
  try{
    await page.setViewportSize({width:1200,height:900});await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByLabel('Choose Blueprint graph or file').click();await page.getByRole('combobox',{name:'Blueprint graph',exact:true}).click()
    await page.getByRole('option').filter({has:page.locator('.bp-choice-name',{hasText:/^Locomotion$/})}).click()
    await page.getByText('States and transitions',{exact:true}).click()
    const selected=page.getByRole('region',{name:'Selected saved state machine'})
    await expect(selected).toContainText('Idle → Walk / Run')
    await selected.getByRole('button',{name:'Idle → Walk / Run Transition · modified',exact:true}).click()
    await expect(page.locator('.bp-inspector')).toContainText('AnimStateTransitionNode')
    await expect(selected).toContainText('CrossfadeDuration: 0.75')
    await expect(page.locator('.bp-inspector')).toContainText('Modified')
    await page.screenshot({path:testInfo.outputPath('animation-states.png')})
    await selected.getByRole('button',{name:'Open rule · Transition',exact:true}).first().click()
    await expect(page.locator('.bp-active-graph')).toHaveText('Transition')
    await page.getByRole('button',{name:'Back to graph',exact:true}).click();await expect(page.locator('.bp-active-graph')).toHaveText('Locomotion')
    await page.getByLabel('Choose Blueprint graph or file').click();await page.getByRole('combobox',{name:'Blueprint graph',exact:true}).click()
    await page.getByRole('option').filter({has:page.locator('.bp-choice-name',{hasText:/^Main States$/})}).click()
    await page.getByText('States and transitions',{exact:true}).click()
    const aliasMember=page.getByRole('region',{name:'Selected saved state machine'}).getByRole('button',{name:/^Inspect alias member/}).first()
    const memberName=(await aliasMember.innerText()).split(' · ')[1];await aliasMember.click()
    await expect(page.locator('.bp-inspector>strong')).toHaveText(memberName)
    await page.getByLabel('Choose Blueprint graph or file').click();await page.getByRole('combobox',{name:'Blueprint graph',exact:true}).click()
    await page.getByRole('option').filter({has:page.locator('.bp-choice-name',{hasText:/^AnimGraph$/})}).click()
    await expect(page.locator('.bp-canvas-hint').first()).toContainText('8 nodes')
    await expect(page.locator('.bp-warning')).toHaveCount(0)
    await expect.poll(()=>page.evaluate(()=>window.poseWireDraws)).toBeGreaterThan(0)
    await page.screenshot({path:testInfo.outputPath('animation-recovered-pose.png')})
    await page.setViewportSize({width:480,height:700});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    expect(await page.evaluate(()=>window.calls.length)).toBe(1);expect(errors).toEqual([])
  }finally{await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
