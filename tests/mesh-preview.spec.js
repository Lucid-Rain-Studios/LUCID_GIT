const { test, expect } = require('@playwright/test')
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { execFileSync } = require('node:child_process')
const { component, find } = require('./renderer-harness')
const { tmpDir, cleanup } = require('./helpers')
const root = path.resolve(__dirname, '..')
const { collisionHulls, collisionBounds } = component('src/lib/meshReview.ts').exports
const vertices = [[0,0,0],[100,0,0],[0,100,0],[0,0,100]]
const hull = () => ({ VertexData: vertices.map(([X,Y,Z]) => ({ VertexData: { X,Y,Z } })), IndexData: [0,2,1,0,1,3,0,3,2,1,2,3], Transform: { Rotation: { Rotation: { X: 0,Y: 0,Z: 0,W: 1 } }, Translation: { Translation: { X: 0,Y: 0,Z: 0 } }, Scale3D: { Scale3D: { X: 1,Y: 1,Z: 1 } } } })
const object = convex => ({ id: '', path: 'Mesh.BodySetup', name: 'BodySetup', outer: 'Mesh', classPath: '/Script/Engine.BodySetup', properties: { AggGeom: { ConvexElems: convex } }, decoded: true, opaqueBytes: 0, opaqueHash: '', diagnostics: [] })
const box = () => ({Center:{Center:{X:10,Y:20,Z:30}},Rotation:{Rotation:{Pitch:0,Yaw:0,Roll:0}},X:2,Y:4,Z:6})
const capsule = () => ({...box(),Radius:5,Length:10,Rotation:{Rotation:{Pitch:0,Yaw:0,Roll:0}}})
const capsuleObject = value => ({...object([]),properties:{AggGeom:{SphylElems:[value]}}})
const legacyCapsule = () => {const value=capsule();delete value.Rotation;value.Orientation={Orientation:{X:0,Y:Math.SQRT1_2,Z:0,W:Math.SQRT1_2}};return value}
const sphere = () => ({Center:{Center:{X:10,Y:20,Z:30}},Radius:5})
const sphereObject = value => ({...object([]),properties:{AggGeom:{SphereElems:[value]}}})
const boxObject = value => ({...object([]),properties:{AggGeom:{BoxElems:[value]}}})
test.afterAll(cleanup)

test('box collision uses complete saved centers, degree rotations and full dimensions with explicit omissions',()=>{
  const value=box(),decoded=collisionHulls([boxObject(value)])
  expect(decoded).toMatchObject({vertices:8,triangles:12,omitted:0})
  expect(decoded.hulls[0].kind).toBe('box')
  expect(collisionBounds(decoded.hulls)).toMatchObject({min:[9,18,27],max:[11,22,33]})
  for(const [axis,expected] of [['Yaw',[2,-1,-3]],['Pitch',[3,-2,-1]],['Roll',[-1,-3,2]]]){
    const rotated=box();rotated.Center.Center={X:0,Y:0,Z:0};rotated.Rotation.Rotation[axis]=90
    collisionHulls([boxObject(rotated)]).hulls[0].vertices[0].forEach((coordinate,index)=>expect(coordinate).toBeCloseTo(expected[index],8))
  }
  const missing=box();delete missing.Rotation.Rotation.Roll
  const invalid=box();invalid.X=-1
  const empty=box();empty.X=empty.Y=empty.Z=0
  expect(collisionHulls([boxObject(missing),boxObject(invalid),boxObject(empty)])).toMatchObject({hulls:[],omitted:3})
  const plane=box();plane.Z=0;expect(collisionHulls([boxObject(plane)]).hulls).toHaveLength(1)
  const mixed={...object([hull()]),properties:{AggGeom:{ConvexElems:[hull()],BoxElems:[box()],SphereElems:[{}],SphylElems:[{},{}]}}}
  expect(collisionHulls([mixed])).toMatchObject({vertices:12,triangles:16,omitted:3})
  expect(collisionHulls([mixed]).diagnostics.join(' ')).toContain('invalid saved center/radius')
  expect(collisionHulls([{...mixed,properties:{AggGeom:{BoxElems:Array.from({length:70},box)}}}])).toMatchObject({vertices:512,triangles:768,omitted:6})
})

test('sphere collision preserves saved center/radius, closed topology and shared budgets',()=>{
  const decoded=collisionHulls([sphereObject(sphere())])
  expect(decoded).toMatchObject({vertices:114,triangles:224,omitted:0})
  expect(decoded.hulls[0].kind).toBe('sphere')
  expect(collisionBounds(decoded.hulls)).toMatchObject({min:[5,15,25],max:[15,25,35]})
  const edges=new Map(),shape=decoded.hulls[0]
  for(let i=0;i<shape.indices.length;i+=3){
    const triangle=shape.indices.slice(i,i+3)
    expect(new Set(triangle).size).toBe(3)
    for(const index of triangle)expect(index>=0&&index<shape.vertices.length).toBe(true)
    for(let j=0;j<3;j++){const key=[triangle[j],triangle[(j+1)%3]].sort((a,b)=>a-b).join(':');edges.set(key,(edges.get(key)||0)+1)}
  }
  expect([...edges.values()].every(count=>count===2)).toBe(true)
  const invalid=[sphere(),sphere(),sphere(),sphere(),sphere(),sphere(),sphere()]
  delete invalid[0].Center;delete invalid[1].Radius;invalid[2].Radius='';invalid[3].Radius=0;invalid[4].Radius=-1;invalid[5].Radius=Infinity;invalid[6].Center.Center.X=Number.MAX_VALUE;invalid[6].Radius=Number.MAX_VALUE
  expect(collisionHulls(invalid.map(sphereObject))).toMatchObject({hulls:[],omitted:7})
  expect(collisionHulls([{...object([]),properties:{AggGeom:{SphereElems:Array.from({length:70},sphere)}}}])).toMatchObject({vertices:5016,triangles:9856,omitted:26})
})

test('capsules preserve cylinder length, axis rotations, closed topology, limits and bone-local exclusion',()=>{
  const value=capsule(),decoded=collisionHulls([capsuleObject(value)]),shape=decoded.hulls[0]
  expect(decoded).toMatchObject({vertices:130,triangles:256,omitted:0})
  expect(collisionBounds(decoded.hulls)).toMatchObject({min:[5,15,20],max:[15,25,40]})
  const edges=new Map()
  for(let i=0;i<shape.indices.length;i+=3){const t=shape.indices.slice(i,i+3);expect(new Set(t).size).toBe(3);for(let j=0;j<3;j++){expect(t[j]).toBeLessThan(shape.vertices.length);const k=[t[j],t[(j+1)%3]].sort((a,b)=>a-b).join(':');edges.set(k,(edges.get(k)||0)+1)}}
  expect([...edges.values()].every(n=>n===2)).toBe(true)
  for(const [axis,expected] of [['Pitch',[-10,0,0]],['Roll',[0,10,0]],['Yaw',[0,0,10]]]){
    const rotated=capsule();rotated.Center.Center={X:0,Y:0,Z:0};rotated.Rotation.Rotation[axis]=90
    collisionHulls([capsuleObject(rotated)]).hulls[0].vertices[0].forEach((n,i)=>expect(n).toBeCloseTo(expected[i],8))
  }
  const zero=capsule();zero.Length=0;expect(collisionHulls([capsuleObject(zero)])).toMatchObject({vertices:114,triangles:224})
  const invalid=[capsule(),capsule(),capsule(),capsule(),capsule(),capsule()]
  delete invalid[0].Rotation;delete invalid[1].Length;invalid[2].Length=-1;invalid[3].Radius=0;invalid[4].Length='';invalid[5].Length=Infinity
  expect(collisionHulls(invalid.map(capsuleObject))).toMatchObject({hulls:[],omitted:6})
  expect(collisionHulls([{...capsuleObject(value),properties:{AggGeom:{SphylElems:Array.from({length:70},capsule)}}}])).toMatchObject({vertices:5070,triangles:9984,omitted:31})
  const bone={...capsuleObject(value),classPath:'/Script/Engine.SkeletalBodySetup',properties:{...capsuleObject(value).properties,BoneName:'pelvis'}}
  expect(collisionHulls([bone]).hulls).toEqual([])
  expect(collisionHulls([bone],true).hulls).toHaveLength(1)
  expect(collisionHulls([{...bone,classPath:'/Script/Engine.BodySetup'}]).hulls).toEqual([])
})

test('saved quaternion collision supports legacy boxes/capsules and rejects competing or non-unit profiles',()=>{
  const shape=legacyCapsule(),decoded=collisionHulls([capsuleObject(shape)])
  expect(decoded).toMatchObject({vertices:130,triangles:256,omitted:0})
  const bounds=collisionBounds(decoded.hulls)
  for(const [i,n] of [0,1,2].map(i=>[i,[20,10,10][i]]))expect(bounds.max[i]-bounds.min[i]).toBeCloseTo(n,8)
  const negative=legacyCapsule();for(const key of ['X','Y','Z','W'])negative.Orientation.Orientation[key]*=-1
  expect(collisionHulls([capsuleObject(negative)]).hulls[0].vertices).toEqual(decoded.hulls[0].vertices)
  const legacyBox=box();delete legacyBox.Rotation;legacyBox.Orientation={Orientation:{X:0,Y:0,Z:Math.SQRT1_2,W:Math.SQRT1_2}}
  collisionHulls([boxObject(legacyBox)]).hulls[0].vertices[0].forEach((n,i)=>expect(n).toBeCloseTo([12,19,27][i],8))
  const invalid=[legacyCapsule(),legacyCapsule(),legacyCapsule(),legacyCapsule(),legacyCapsule()]
  invalid[0].Rotation=capsule().Rotation;delete invalid[1].Orientation.Orientation.W;invalid[2].Orientation.Orientation.W=0;invalid[3].Orientation.Orientation.X=Infinity;invalid[4].Orientation.Orientation.X=''
  expect(collisionHulls(invalid.map(capsuleObject))).toMatchObject({hulls:[],omitted:5})
  const conflict=box();conflict.Orientation=legacyBox.Orientation;expect(collisionHulls([boxObject(conflict)]).hulls).toEqual([])
})

test('bounded physics selector retains explicitly selected late bodies and rejects duplicate path geometry',()=>{
  const preview=component('src/components/diff/PhysicsAssetPreview.tsx',{}, {React:{createElement:(type,props,...children)=>({type,props:{...props,children}})}})
  const bodies=Array.from({length:1002},(_,i)=>({...capsuleObject(capsule()),path:`Physics.Body${i}`,name:`Body${i}`,properties:{...capsuleObject(capsule()).properties,BoneName:`Bone${i}`}}))
  const props={objects:bodies,allObjects:[[],bodies],camera:{yaw:0,pitch:0,zoom:1,wireframe:false},onCamera(){},selected:bodies[1001].path,onSelect(){},labels:{left:'Base',right:'Selected'},single:false}
  const tree=preview.render('PhysicsAssetPreview',props),choice=find(tree,node=>node.props?.id==='uar-physics-body')
  expect(choice.props.items).toHaveLength(1000)
  expect(choice.props.items.find(item=>item.value===props.selected).name).toBe('Body1001')
  expect(find(tree,node=>node.type==='MeshPreview').props.objects[0].path).toBe(props.selected)
  const duplicate=[bodies[0],{...bodies[0],name:'Conflicting body'}]
  const ambiguous=preview.render('PhysicsAssetPreview',{...props,objects:duplicate,allObjects:[[],duplicate],selected:bodies[0].path})
  expect(find(ambiguous,node=>node.type==='MeshPreview').props.objects).toEqual([])
})

test('real UE 4.9 eel PhysicsAsset preserves quaternion capsule orientation and source bytes',()=>{
  const file=process.env.UNREAL_REVIEW_LEGACY_PHYSICS
  test.skip(!file,'Set UNREAL_REVIEW_LEGACY_PHYSICS to SK_Eel_PhysicsAsset')
  const before=fs.readFileSync(file),doc=JSON.parse(execFileSync('dotnet',['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',file],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}))
  expect(doc.engineVersion).toBe('4.9.2');expect(doc.assetClass).toBe('/Script/Engine.PhysicsAsset')
  const bodies=doc.assetReview.objects.filter(o=>o.classPath.endsWith('.BodySetup'))
  expect(bodies).toHaveLength(27)
  for(const body of bodies){
    const decoded=collisionHulls([body],true),saved=body.properties.AggGeom.SphylElems[0]
    expect(decoded).toMatchObject({vertices:130,triangles:256,omitted:0})
    const q=saved.Orientation.Orientation,norm=Math.hypot(q.X,q.Y,q.Z,q.W),x=q.X/norm,y=q.Y/norm,z=q.Z/norm,w=q.W/norm
    const axis=[2*(x*z+w*y),2*(y*z-w*x),1-2*(x*x+y*y)],center=saved.Center.Center,distance=Number(saved.Length)/2+Number(saved.Radius)
    decoded.hulls[0].vertices[0].forEach((n,i)=>expect(n).toBeCloseTo(Number(center[['X','Y','Z'][i]])+axis[i]*distance,6))
  }
  expect(collisionHulls(doc.assetReview.objects).hulls).toEqual([])
  expect(fs.readFileSync(file)).toEqual(before)
})

test('real PhysicsAsset capsules retain saved body-local geometry and source bytes',()=>{
  const file=process.env.UNREAL_REVIEW_PHYSICS
  test.skip(!file,'Set UNREAL_REVIEW_PHYSICS to PA_Mannequin')
  const before=fs.readFileSync(file),doc=JSON.parse(execFileSync('dotnet',['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',file],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}))
  expect(doc.assetClass).toBe('/Script/Engine.PhysicsAsset')
  const body=doc.assetReview.objects.find(o=>o.properties.BoneName==='spine_03')
  const decoded=collisionHulls([body],true),saved=body.properties.AggGeom.SphylElems[0]
  expect(decoded).toMatchObject({vertices:130,triangles:256,omitted:0})
  expect(decoded.hulls[0].kind).toBe('capsule')
  const bounds=collisionBounds(decoded.hulls)
  expect(bounds.max[2]-bounds.min[2]).toBeCloseTo(Number(saved.Length)+2*Number(saved.Radius),6)
  expect(bounds.max[0]-bounds.min[0]).toBeCloseTo(2*Number(saved.Radius),6)
  expect(collisionHulls(doc.assetReview.objects).hulls).toEqual([])
  expect(fs.readFileSync(file)).toEqual(before)
})

test('real sphere profile preserves source bytes and saved radius without inferring shape from filename',()=>{
  const file=process.env.UNREAL_REVIEW_SPHERE
  test.skip(!file,'Set UNREAL_REVIEW_SPHERE to a saved sphere collision fixture')
  const before=fs.readFileSync(file)
  const doc=JSON.parse(execFileSync('dotnet',['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',file],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}))
  const decoded=collisionHulls(doc.assetReview.objects)
  expect(decoded).toMatchObject({vertices:114,triangles:224,omitted:0});expect(decoded.hulls[0].kind).toBe('sphere')
  const saved=doc.assetReview.objects.find(item=>item.classPath.endsWith('.BodySetup')).properties.AggGeom.SphereElems[0]
  expect(Number(saved.Radius)).toBeCloseTo(50.000003814697266,6)
  const bounds=collisionBounds(decoded.hulls)
  for(const [index,axis] of ['X','Y','Z'].entries()){
    expect(bounds.min[index]).toBeCloseTo(Number(saved.Center.Center[axis])-Number(saved.Radius),6)
    expect(bounds.max[index]).toBeCloseTo(Number(saved.Center.Center[axis])+Number(saved.Radius),6)
  }
  expect(fs.readFileSync(file)).toEqual(before)
})

test('real box and planar collision profiles preserve saved dimensions and source bytes',()=>{
  test.skip(!process.env.UNREAL_REVIEW_BOX||!process.env.UNREAL_REVIEW_PLANE,'Set box/plane fixtures')
  for(const file of [process.env.UNREAL_REVIEW_BOX,process.env.UNREAL_REVIEW_PLANE]){
    const before=fs.readFileSync(file)
    const doc=JSON.parse(execFileSync('dotnet',['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',file],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}))
    const decoded=collisionHulls(doc.assetReview.objects)
    expect(decoded).toMatchObject({vertices:8,triangles:12,omitted:0});expect(decoded.hulls[0].kind).toBe('box')
    const saved=doc.assetReview.objects.find(item=>item.classPath.endsWith('.BodySetup')).properties.AggGeom.BoxElems[0]
    const bounds=collisionBounds(decoded.hulls)
    for(const [index,axis] of ['X','Y','Z'].entries())expect(bounds.max[index]-bounds.min[index]).toBeCloseTo(Number(saved[axis]),6)
    expect(fs.readFileSync(file)).toEqual(before)
  }
})

test('collision geometry requires saved finite vertices, valid triangles and complete explicit transforms', () => {
  const valid = hull(); valid.Transform.Translation.Translation.X = 50
  valid.Transform.Scale3D.Scale3D.Y = 2
  const parsed = collisionHulls([object([valid])])
  expect(parsed).toMatchObject({ vertices: 4, triangles: 4, omitted: 0 })
  expect(parsed.hulls[0].vertices[2]).toEqual([50,200,0])
  expect(collisionBounds(parsed.hulls)).toMatchObject({ min: [50,0,0], max: [150,200,100] })
  const invalid = [hull(),hull(),hull(),hull(),hull()]
  invalid[0].IndexData[0] = 90
  delete invalid[1].Transform.Scale3D
  invalid[2].VertexData[0].VertexData.X = ''
  invalid[3].Transform.Rotation.Rotation.W = 0
  invalid[4].IndexData.pop()
  expect(collisionHulls([object(invalid)])).toMatchObject({ hulls: [], omitted: 5 })
  expect(collisionHulls([object(Array.from({ length: 70 }, hull))])).toMatchObject({ omitted: 6, vertices: 256, triangles: 256 })
  expect(collisionHulls([object([{ ...hull(), VertexData: Array(20001).fill({ VertexData: { X: 1,Y: 1,Z: 1 } }) }])])).toMatchObject({ hulls: [], omitted: 1 })
})

test('collision quaternions preserve scale, rotation and translation without normalizing absent defaults', () => {
  const value = hull()
  value.Transform.Rotation.Rotation = { X: 0,Y: 0,Z: Math.SQRT1_2,W: Math.SQRT1_2 }
  const parsed = collisionHulls([object([value])])
  expect(parsed.hulls[0].vertices[1][0]).toBeCloseTo(0)
  expect(parsed.hulls[0].vertices[1][1]).toBeCloseTo(100)
})

test('real static mesh fixture retains convex arrays and accurate collision counts', () => {
  const fixture = process.env.UNREAL_REVIEW_MESH
  test.skip(!fixture, 'Set UNREAL_REVIEW_MESH to a local saved convex cube fixture')
  const before = require('node:crypto').createHash('sha256').update(fs.readFileSync(fixture)).digest('hex')
  const doc = JSON.parse(execFileSync('dotnet', ['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',fixture], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
  expect(doc.readerVersion).toBe(14)
  expect(doc.assetReview.family).toBe('mesh')
  const decoded = collisionHulls(doc.assetReview.objects)
  expect(decoded).toMatchObject({ vertices: 8, triangles: 12, omitted: 0 })
  expect(decoded.hulls).toHaveLength(1)
  expect(require('node:crypto').createHash('sha256').update(fs.readFileSync(fixture)).digest('hex')).toBe(before)
})

test('real skeletal mesh remains an explicit native-payload fallback without invented geometry or LODs', () => {
  const fixture = process.env.UNREAL_REVIEW_SKELETAL
  test.skip(!fixture, 'Set UNREAL_REVIEW_SKELETAL to SKM_Manny_Simple')
  const before = fs.readFileSync(fixture)
  const doc = JSON.parse(execFileSync('dotnet', ['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',fixture], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
  expect(doc.assetReview.family).toBe('mesh')
  const mesh = doc.assetReview.objects.find(object => object.classPath === '/Script/Engine.SkeletalMesh')
  expect(mesh.decoded).toBe(false)
  expect(mesh.opaqueBytes).toBeGreaterThan(0)
  expect(mesh.opaqueHash).toMatch(/^[A-F0-9]{64}$/)
  expect(collisionHulls(doc.assetReview.objects).hulls).toEqual([])
  const metadata = component('src/lib/meshMetadata.ts').exports.meshMetadata(doc.assetReview.objects)
  expect(metadata.find(entry => entry.object.path === mesh.path).fields).toEqual([])
  expect(fs.readFileSync(fixture)).toEqual(before)
})

test('complex Animation Blueprint decodes tagged pose nodes and graph families', () => {
  const fixture = process.env.UNREAL_REVIEW_COMPLEX_ANIMATION
  test.skip(!fixture, 'Set UNREAL_REVIEW_COMPLEX_ANIMATION to ABP_Unarmed')
  const doc = JSON.parse(execFileSync('dotnet', ['tools/BlueprintExtractor/bin/Release/net10.0/BlueprintExtractor.dll',fixture], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
  expect(doc.graphs.find(graph => graph.name === 'AnimGraph')).toMatchObject({ kind: 'pose', schema: '/Script/AnimGraph.AnimationGraphSchema', complete: true })
  expect(doc.graphs.some(graph => graph.kind === 'state-machine')).toBe(true)
  expect(doc.graphs.some(graph => graph.kind === 'transition')).toBe(true)
  expect(doc.graphs.find(graph => graph.name === 'EventGraph')).toMatchObject({ kind: 'event' })
  expect(doc.diagnostics).toEqual([])
})

for(const profile of ['convex','box','sphere','capsule','physics','legacyphysics']) test(`shared ${profile} preview orbits, zooms, selects collision, toggles wireframe and retains camera without rereads`, async ({ page }, testInfo) => {
  const dir = tmpDir('lg-mesh-preview-')
  const physics=profile.endsWith('physics')
  const factory={convex:hull,box,sphere,capsule,physics:capsule,legacyphysics:legacyCapsule}[profile],wrap={convex:value=>object([value]),box:boxObject,sphere:sphereObject,capsule:capsuleObject,physics:value=>({...capsuleObject(value),classPath:'/Script/Engine.SkeletalBodySetup',properties:{...capsuleObject(value).properties,BoneName:'pelvis'}}),legacyphysics:value=>({...capsuleObject(value),properties:{...capsuleObject(value).properties,BoneName:'pelvis'}})}[profile]
  const base=wrap(factory()),edited=factory()
  if(profile==='convex')edited.Transform.Scale3D.Scale3D.X=2
  else if(profile==='box')edited.X=4
  else if(profile==='capsule'||physics)edited.Length=20
  else edited.Radius=10
  const counts={convex:[4,4],box:[8,12],sphere:[114,224],capsule:[130,256],physics:[130,256],legacyphysics:[130,256]}[profile]
  const extents={convex:['100.00 × 100.00 × 100.00','200.00 × 100.00 × 100.00'],box:['2.00 × 4.00 × 6.00','4.00 × 4.00 × 6.00'],sphere:['10.00 × 10.00 × 10.00','20.00 × 20.00 × 20.00'],capsule:['10.00 × 10.00 × 20.00','10.00 × 10.00 × 30.00'],physics:['10.00 × 10.00 × 20.00','10.00 × 10.00 × 30.00'],legacyphysics:['20.00 × 10.00 × 10.00','30.00 × 10.00 × 10.00']}[profile]
  const doc = objects => ({ schemaVersion: 1, readerVersion: 12, assetClass: physics?'/Script/Engine.PhysicsAsset':'/Script/Engine.StaticMesh', engineVersion: '5.8.0', graphs: [], status: 'unsupported', diagnostics: [], assetReview: { family: physics?'asset':'mesh', objects, coverage: ['Native render mesh unsupported'], cooked: false } })
  const extra={...wrap(factory()),path:'Mesh.OtherBody',name:'OtherBody',properties:{...wrap(factory()).properties,BoneName:'arm'}}
  const removed={...extra,path:'Mesh.RemovedBody',name:'RemovedBody',properties:{...extra.properties,BoneName:'removed_bone'}}
  const result = { left: { ref: 'HEAD', status: 'ready', document: doc(physics?[base,extra,removed]:[base]) }, right: { ref: 'WORKING', status: 'ready', document: doc(physics?[wrap(edited),extra]:[wrap(edited)]) } }
  await require('esbuild').build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {UnrealAssetReview} from './src/components/diff/UnrealAssetReview';import './src/index.css';createRoot(document.getElementById('root')).render(<UnrealAssetReview repoPath="test" request={{filePath:'Mesh.uasset',leftRef:'HEAD',rightRef:'WORKING'}}/>);`, resolveDir: root, loader: 'tsx' }, alias: { '@': path.join(root, 'src') }, outfile: path.join(dir,'app.js'), bundle: true, format: 'esm' })
  const server = http.createServer((req,res) => {
    if (req.url === '/') { res.setHeader('Content-Type','text/html'); return res.end(`<html><link rel="stylesheet" href="/app.css"><style>html,body,#root{margin:0;width:100%;height:100%;display:flex}</style><div id="root"></div><script>window.calls=[];window.lucidGit={blueprintCompare:async(_,r)=>{window.calls.push(r);return ${JSON.stringify(result)}},blueprintCancel:async()=>{}}</script><script type="module" src="/app.js"></script></html>`) }
    res.setHeader('Content-Type',req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(dir,req.url.slice(1))))
  })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.setViewportSize({ width: 1100,height: 800 }); await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button',{ name: 'Preview',exact: true }).click()
    const field = page.getByRole('region',{ name: 'Saved collision preview' })
    if(physics){
      await expect(page.getByRole('region',{name:'Saved physics bodies'})).toContainText('Selected body local coordinates')
      expect(await page.getByRole('combobox',{name:'Physics body'}).evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgb(239, 239, 239)')
      await page.getByRole('combobox',{name:'Physics body'}).click();await page.getByRole('option').first().click()
    }
    await expect(field.locator('polygon')).toHaveCount(counts[1])
    await expect(page.locator('.uar-mesh')).toContainText(`${counts[0]} preview vertices · ${counts[1]} preview triangles`)
    await page.getByText('Collision geometry by revision',{exact:true}).click()
    const summary=page.locator('.uar-collision-summary')
    await expect(summary.locator('tbody tr')).toHaveCount(2)
    await expect(summary.locator('tbody tr').first()).toContainText(extents[0])
    await expect(summary.locator('tbody tr').last()).toContainText(extents[1])
    await page.getByText('Collision geometry by revision',{exact:true}).click()
    const before = await field.locator('polygon').first().getAttribute('points'), box = await field.boundingBox()
    await page.mouse.move(box.x + box.width / 2,box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 50,box.y + box.height / 2 + 20); await page.mouse.up()
    expect(await field.locator('polygon').first().getAttribute('points')).not.toBe(before)
    await field.focus(); await page.keyboard.press('+'); await expect(page.locator('.uar-mesh .uar-map-tools small')).toHaveText('150%')
    await page.getByRole('button',{ name: 'Wireframe',exact: true }).click(); await expect(field.locator('polygon').first()).toHaveAttribute('fill','none')
    await page.locator('.uar-mesh .uar-row').click(); await expect(page.getByRole('region',{ name: 'Saved object details' })).toContainText('BodySetup')
    await page.getByRole('button',{ name: 'Base',exact: true }).click(); await expect(page.locator('.uar-mesh .uar-map-tools small')).toHaveText('150%')
    await page.getByRole('button',{ name: 'Contents',exact: true }).click(); await expect(page.getByRole('region', { name: 'Saved mesh metadata' })).toContainText('AggGeom'); await page.getByRole('button', { name: 'All objects', exact: true }).click(); await expect(page.locator('.uar-content .uar-row')).toHaveCount(physics?3:1); await page.getByRole('button',{ name: 'Preview',exact: true }).click(); await expect(page.getByRole('button',{ name: 'Wireframe',exact: true })).toHaveAttribute('aria-pressed','true')
    await page.getByRole('button',{ name: 'Fit collision',exact: true }).click(); await expect(page.locator('.uar-mesh .uar-map-tools small')).toHaveText('100%')
    await page.mouse.move(box.x + box.width / 2,box.y + box.height / 2); await page.mouse.wheel(0,-70); await expect(page.locator('.uar-mesh .uar-map-tools small')).not.toHaveText('100%')
    await page.screenshot({ path: testInfo.outputPath('mesh-collision-preview.png') })
    await page.setViewportSize({ width: 480,height: 640 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if(physics){
      await page.getByRole('combobox',{name:'Physics body'}).click();await page.getByRole('option',{name:/OtherBody/}).click()
      await expect(page.getByRole('region',{name:'Saved object details'})).toContainText('OtherBody')
      await expect(page.locator('.uar-mesh .uar-map-tools small')).toHaveText('100%')
      await page.getByRole('combobox',{name:'Physics body'}).click();await page.getByRole('option',{name:/RemovedBody/}).click()
      await expect(field.locator('polygon')).toHaveCount(256)
      await page.getByRole('button',{name:'Selected',exact:true}).click()
      await expect(page.getByRole('region',{name:'Saved physics bodies'})).toContainText('Collision vertex/triangle counts unavailable')
      await expect(page.getByRole('combobox',{name:'Physics body'})).toContainText('RemovedBody')
      await page.getByText('Collision geometry by revision',{exact:true}).click()
      await expect(summary.locator('tbody tr').last()).toContainText('Unavailable')
      await page.getByRole('button',{name:'Contents',exact:true}).click()
      await page.getByRole('button',{name:'Mesh metadata',exact:true}).click()
      await expect(page.getByRole('region',{name:'Saved mesh metadata'})).toContainText('BoneName')
    }
    expect(await page.evaluate(() => window.calls.length)).toBe(1); expect(errors).toEqual([])
  } finally { await page.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
