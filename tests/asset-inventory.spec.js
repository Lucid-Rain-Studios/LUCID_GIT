const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { execFileSync } = require('node:child_process')
const { component } = require('./renderer-harness')
const { tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
const references = component('src/lib/assetReferences.ts').exports
const { mapInventory } = component('src/lib/mapInventory.ts', { './assetReferences': references }).exports
const { meshMetadata } = component('src/lib/meshMetadata.ts').exports
const { stateTreeEntries } = component('src/lib/stateTreeReview.ts').exports
const object = (name, properties = {}, outer = 'Map.Level') => ({ id: '', path: 'Map.Level.' + name, name, classPath: '/Script/Engine.Actor', outer, properties, decoded: true, opaqueBytes: 0, opaqueHash: '', diagnostics: [] })
const actor = object('Actor', { ActorLabel: 'Display actor', RootComponent: 'Map.Level.Root' })
const level = { ...object('Level', { Actors: [actor.path] }), path: 'Map.Level', classPath: '/Script/Engine.Level' }
const owned = { ...object('Root', { RelativeLocation: { X: 20, Y: 30 }, StaticMesh: '/Game/Meshes/Cube.Cube' }, actor.path), classPath: '/Script/Engine.StaticMeshComponent', references: [{ propertyPath: 'StaticMesh', target: '/Game/Meshes/Cube.Cube', className: 'StaticMesh' }, { propertyPath: 'Owner', target: actor.path, className: 'Actor' }] }
test.afterAll(cleanup)

test('map actor inventory follows saved membership/outer chains and rejects ambiguous or cyclic ownership', () => {
  const nested = object('Nested', {}, owned.path), cycle = object('Cycle', {}, 'Map.Level.Cycle')
  const inventory = mapInventory([level,actor,owned,nested,cycle,object('Unlisted')])
  expect(inventory.actors).toHaveLength(1)
  expect(inventory.actors[0]).toMatchObject({ name: 'Display actor', root: owned })
  expect(inventory.roots).toEqual([owned])
  expect(mapInventory([level,actor,{...owned,outer:'Other.Actor'}]).roots).toEqual([])
  expect(mapInventory([level,actor,owned,{...owned}]).roots).toEqual([])
  expect(inventory.actors[0].owned.map(item => item.name)).toEqual(['Root','Nested'])
  expect(inventory.unassigned.map(item => item.name)).toContain('Cycle')
  expect(mapInventory([level,actor,{ ...actor },owned]).actors).toHaveLength(0)
  const external = { ...actor, id: 'A'.repeat(32), sourcePackage: 'Content/__ExternalActors__/Map/1.uasset', serializedPath: actor.path, path: 'one :: ' + actor.path, outer: 'Map.PersistentLevel', properties: { ActorGuid: 'A'.repeat(32) } }
  const child = { ...owned, sourcePackage: external.sourcePackage, serializedPath: owned.path, path: 'one :: ' + owned.path }
  const foreign = { ...child, sourcePackage: 'Content/__ExternalActors__/Map/2.uasset', path: 'two :: ' + owned.path }
  expect(mapInventory([external,child,foreign]).actors[0].owned).toEqual([child])
})

test('typed references resolve unique objects within their captured source and safely map supported Game assets', () => {
  const resolve = references.savedObjectIndex([actor,owned])
  expect(resolve(owned,actor.path)).toEqual(actor)
  expect(references.savedObjectIndex([actor,{ ...actor }])(owned,actor.path)).toBeUndefined()
  const ref = owned.references[0]
  expect(references.referencePackage(ref,'Content/Maps/Map.umap')).toBe('Content/Meshes/Cube.uasset')
  expect(references.referencePackage({ ...ref,className:'World' },'Content/Maps/Map.umap')).toBe('Content/Meshes/Cube.umap')
  for (const target of ['/Engine/Foo.Foo','/Plugin/Foo.Foo','/Game/../Foo.Foo','/Game/Foo:Bar.Foo','/Game/Foo.Foo.Subobject','/Game/Bad\u0000.Foo','/Game/Bad\\Name.Foo']) expect(references.referencePackage({ ...ref,target },'Content/Map.umap')).toBeUndefined()
  expect(references.referencePackage(ref,'Plugins/Test/Content/Map.umap')).toBeUndefined()
  expect(references.referencePackage({ ...ref,className:'Actor' },'Content/Map.umap')).toBeUndefined()
})

test('mesh metadata summarizes saved fields without inventing render counts, and StateTree entries retain their typed references', () => {
  const mesh = object('Mesh', { StaticMaterials: ['one','two'], MinLOD: 1, TriangleCountGuess: 99 })
  expect(meshMetadata([mesh])[0].fields.map(([key]) => key)).toEqual(['StaticMaterials','MinLOD'])
  const state = { ...object('State', { Tasks: [{ ID: 'A'.repeat(32), Node: { structType: 'Task' } }] }), classPath: '/Script/StateTreeEditorModule.StateTreeState', references: [{ propertyPath: 'Tasks[0].InstanceObject', target: owned.path, className: 'TaskInstance' },{ propertyPath: 'Tasks[1].InstanceObject', target: 'other', className: 'TaskInstance' }] }
  expect(stateTreeEntries([state]).entries[0].references).toEqual([{ propertyPath: 'InstanceObject', target: owned.path, className: 'TaskInstance' }])
})

test('real map membership and typed mesh/material references survive the reader upgrade', () => {
  test.skip(!process.env.UNREAL_REVIEW_MAP, 'Set UNREAL_REVIEW_MAP to the local Overview fixture')
  const file = process.env.UNREAL_REVIEW_MAP, before = fs.readFileSync(file)
  const document = JSON.parse(execFileSync('dotnet',['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',file],{ cwd:root,encoding:'utf8',maxBuffer:32*1024*1024 }))
  expect(document.readerVersion).toBe(16)
  const inventory = mapInventory(document.assetReview.objects)
  expect(inventory.actors).toHaveLength(51)
  expect(inventory.roots).toHaveLength(50)
  expect(inventory.actors.filter(item => item.object.classPath.endsWith('.StaticMeshActor'))).toHaveLength(27)
  expect(inventory.actors.some(item => item.object.classPath.endsWith('.WorldSettings'))).toBe(true)
  expect(document.assetReview.objects.some(item => item.references.some(ref => ref.propertyPath === 'OverrideMaterials[2]' && ref.className === 'MaterialInstanceConstant'))).toBe(true)
  expect(document.assetReview.objects.every(item => item.references.length <= 128)).toBe(true)
  expect(fs.readFileSync(file)).toEqual(before)
})

test('shared inventory groups actors, labels dots, and opens deleted-side references at the captured commit', async ({ page }, testInfo) => {
  test.setTimeout(30000)
  const dir = tmpDir('lg-asset-inventory-'), commit = 'a'.repeat(40)
  const doc = objects => ({ schemaVersion:1,readerVersion:12,assetClass:'/Script/Engine.World',graphs:[],status:'unsupported',diagnostics:[],assetReview:{family:'map',objects,coverage:['Saved subset'],cooked:false} })
  const result = { left:{status:'ready',ref:'HEAD',resolvedRef:commit,path:'Content/Maps/Map.umap',document:doc([level,actor,owned])},right:{status:'ready',ref:'WORKING',path:'Content/Maps/Map.umap',document:doc([level,actor])} }
  await require('esbuild').build({ stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import {useAssetViewerStore} from './src/stores/assetViewerStore';import './src/index.css';useAssetViewerStore.subscribe(state=>window.opened={path:state.filePath,ref:state.revision});createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Content/Maps/Map.umap',leftRef:'HEAD',rightRef:'WORKING'}}/>);`,resolveDir:root,loader:'tsx'},alias:{'@':path.join(root,'src')},outfile:path.join(dir,'app.js'),bundle:true,format:'esm' })
  const server = http.createServer((req,res) => {
    if(req.url === '/') {res.setHeader('Content-Type','text/html');return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.calls=[];window.lucidGit={blueprintCompare:async(_,r)=>{window.calls.push(r);return ${JSON.stringify(result)}},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`)}
    res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  try {
    await page.setViewportSize({width:1100,height:820});await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button',{name:'Contents',exact:true}).click();await expect(page.getByRole('region',{name:'Saved map actor inventory'})).toContainText('Display actor')
    await page.getByRole('button',{name:'Base',exact:true}).click();await page.getByLabel('Expand Display actor',{exact:true}).click()
    await page.getByRole('button',{name:'Inspect saved root component',exact:true}).click();await expect(page.getByRole('region',{name:'Saved object details'})).toContainText('Root')
    await page.screenshot({path:testInfo.outputPath('actor-inventory.png')})
    await page.getByRole('button',{name:'Preview',exact:true}).click();await expect(page.getByLabel('Display actor: X 20, Y 30 cm',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Changes',exact:true}).click();await page.locator('.uar-content .uar-row').filter({hasText:/Root/}).click()
    await expect(page.getByRole('button',{name:'Inspect base Owner',exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Open base StaticMesh',exact:true}).click();expect(await page.evaluate(()=>window.opened)).toEqual({path:'Content/Meshes/Cube.uasset',ref:commit})
    await page.getByRole('button',{name:'Inspect base Owner',exact:true}).click();await expect(page.getByRole('button',{name:'Base',exact:true})).toHaveAttribute('aria-pressed','true')
    await expect(page.getByRole('region',{name:'Saved object details'})).toContainText('Actor')
    await page.setViewportSize({width:480,height:640});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
    expect(await page.evaluate(()=>window.calls.length)).toBe(1);expect(errors).toEqual([])
  } finally {await page.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
