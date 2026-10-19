import { memo, useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { NativeSceneReview } from '../../../electron/blueprintTypes'
import { ipc } from '@/ipc'
import { BlueprintChoice } from './BlueprintChoice'
import { NativeSceneActors as ActorInventory } from './NativeSceneActors'
import { nativeBagFields } from '../../lib/nativeBag'
import { nativeActorForObject, nativeClipLabels, nativeClipPlayback, primeNativeAnimationPose } from '../../lib/nativeSceneObjects'
const NativeSceneActors = memo(ActorInventory)

function disposeScene(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>(), materials = new Set<THREE.Material>(), geometries = new Set<THREE.BufferGeometry>(), skeletons = new Set<THREE.Skeleton>()
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return
    if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton)
    geometries.add(object.geometry)
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  for (const texture of textures) { const data = texture.source.data as { close?: () => void } | undefined; data?.close?.(); texture.dispose() }
  for (const material of materials) material.dispose()
  for (const geometry of geometries) geometry.dispose()
  for (const skeleton of skeletons) skeleton.dispose()
}

/** One immutable scene pair; controls and playback never extract additional assets. */
export function ScenePreview({ scenes, side, labels, visible = true, onInspectActor, paths, surfaceKind }: { surfaceKind?: 'texture' | 'material'; scenes: Array<NativeSceneReview | undefined>; side: 'left' | 'right'; labels: { left: string; right: string }; paths?: readonly string[]; visible?: boolean; onInspectActor?(path: string): void }) {
  const host = useRef<HTMLDivElement>(null)
  const savedCamera = useRef<{ position: THREE.Vector3; target: THREE.Vector3; near: number; far: number }>()
  const runtime = useRef<{ groups: THREE.Group[]; mixers: THREE.AnimationMixer[]; clips: THREE.AnimationClip[][]; clipLabels: string[][]; profiles: Array<Array<NonNullable<NativeSceneReview['playback']>[number]|undefined>>; fit(): void; controls: OrbitControls; invalidate(): void; suspend(): void; load(index: number): Promise<void> }>()
  const [error, setError] = useState(''), [ready, setReady] = useState(false), [wireframe, setWireframe] = useState(false), [bones, setBones] = useState(false)
  const [playing, setPlaying] = useState(false), [clip, setClip] = useState(0), [time, setTime] = useState(0), [duration, setDuration] = useState(0), [clips, setClips] = useState<string[]>([]), [picked, setPicked] = useState('')
  const [pickedPath, setPickedPath] = useState('')
  const [unmatchedPlayback,setUnmatchedPlayback]=useState(false)
  const [loadVersion,setLoadVersion]=useState(0)
  const playingRef = useRef(false), clipRef = useRef(0), sideRef = useRef(side)
  const visibleRef = useRef(visible)
  const scenesRef=useRef(scenes);scenesRef.current=scenes
  sideRef.current = side; playingRef.current = playing && visible; clipRef.current = clip; visibleRef.current = visible
  const active = scenes[side === 'left' ? 0 : 1]
  const selectedProfile=runtime.current?.profiles[side==='left'?0:1][clip]
  const inspectRef = useRef(onInspectActor), actorsRef = useRef(active?.actors)
  inspectRef.current = onInspectActor; actorsRef.current = active?.actors
  const keys = JSON.stringify(scenes.map(scene => scene?.key ?? ''))
  useEffect(() => {
    let disposed = false, frame = 0
    const mount = host.current
    if (!mount || !scenes.some(scene => scene?.key)) return
    setError(''); setReady(false); setPlaying(false); setTime(0)
    let renderer: THREE.WebGLRenderer | undefined, controls: OrbitControls | undefined, resize: ResizeObserver | undefined
    const groups: THREE.Group[] = [new THREE.Group(), new THREE.Group()], helpers: THREE.SkeletonHelper[] = []
    const scene = new THREE.Scene()
    const cleanup = () => {
      const camera = controls?.object as THREE.PerspectiveCamera | undefined
      if (camera && fitted) savedCamera.current = { position:camera.position.clone(),target:controls!.target.clone(),near:camera.near,far:camera.far }
      cancelAnimationFrame(frame); resize?.disconnect(); controls?.dispose()
      for (const group of new Set(groups)) disposeScene(group)
      for (const helper of helpers) { helper.geometry.dispose(); (helper.material as THREE.Material).dispose() }
      renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove(); runtime.current = undefined
    }
    let fitted = false
    const start = async () => {
      // Keep the last frame presentable while an idle viewport has no animation loop.
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = surfaceKind === 'texture' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping
      renderer.domElement.tabIndex = 0; renderer.domElement.setAttribute('aria-label', 'Engine scene viewport'); renderer.domElement.setAttribute('role', 'region')
      mount.appendChild(renderer.domElement)
      const camera = new THREE.PerspectiveCamera(45, 1, .01, 1000000)
      controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.enableRotate = surfaceKind !== 'texture'
      scene.add(new THREE.HemisphereLight(0xffffff, 0x657082, 2))
      const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(4, 8, 5); scene.add(light)
      const manager = new THREE.LoadingManager()
      manager.setURLModifier(url => { if (!url.startsWith('blob:')) throw new Error('External scene resource rejected.'); return url })
      const loader = new GLTFLoader(manager), animations: THREE.AnimationClip[][] = [[], []]
      const mixers = groups.map(group => new THREE.AnimationMixer(group))
      let previous = performance.now(), lastTimeUpdate = 0
      const invalidate = () => {
        if (!disposed && visibleRef.current && !frame) { previous = performance.now(); frame = requestAnimationFrame(render) }
      }
      const suspend = () => { cancelAnimationFrame(frame); frame = 0 }
      const fit = () => {
        const box = new THREE.Box3().setFromObject(groups[sideRef.current === 'left' ? 0 : 1])
        if (box.isEmpty()) return
        const center = box.getCenter(new THREE.Vector3()), radius = Math.max(.01,box.getSize(new THREE.Vector3()).length() / 2)
        controls!.target.copy(center); camera.position.copy(center).add((surfaceKind === 'texture' ? new THREE.Vector3(0,0,1) : new THREE.Vector3(1,.65,1).normalize()).multiplyScalar(radius * 3)); camera.near = Math.max(.001,radius / 10000); camera.far = Math.max(100,radius * 100); camera.updateProjectionMatrix(); controls!.update(); invalidate()
      }
      const render = () => {
        frame = 0
        if (disposed) return
        if (!visibleRef.current) return
        const now = performance.now(), delta = Math.min(.1,(now - previous) / 1000); previous = now
        const index = sideRef.current === 'left' ? 0 : 1
        groups.forEach(group => { group.visible = group === groups[index] })
        helpers.forEach(helper => { helper.visible = mount.dataset.bones === 'true' && helper.root.visible })
        if (playingRef.current) {
          mixers[index]?.update(delta)
          const selected=animations[index]?.[clipRef.current],action=selected ? mixers[index]?.existingAction(selected) : undefined
          if (now - lastTimeUpdate >= 100 || action?.paused) { lastTimeUpdate = now; setTime(action?.time ?? 0) }
          if(action?.paused){playingRef.current=false;setPlaying(false)}
        }
        controls!.update(); renderer!.render(scene,camera)
        // Controls emit change while damping settles; playback alone needs a continuous loop.
        if (playingRef.current && !frame) frame = requestAnimationFrame(render)
      }
      controls.addEventListener('change',invalidate)
      const clipLabels: string[][] = [[],[]], profiles: Array<Array<NonNullable<NativeSceneReview['playback']>[number]|undefined>> = [[],[]]
      const loaded = new Map<string, Promise<{ group: THREE.Group; clips: THREE.AnimationClip[]; mixer: THREE.AnimationMixer } | undefined>>()
      const metadata=new WeakMap<NativeSceneReview,{labels:string[];profiles:ReturnType<typeof nativeClipPlayback>}>(),shown:Array<NativeSceneReview|undefined>=[]
      const load = async (index: number) => {
        const captured = scenesRef.current[index]
        if (!captured?.key) { setReady(false); invalidate(); return }
        if(shown[index]===captured){if(index===(sideRef.current==='left'?0:1))setReady(true);invalidate();return}
        setError(''); setReady(false)
        try {
          let pending = loaded.get(captured.key)
          if (!pending) {
            pending = (async () => {
              const data = await ipc.nativeSceneRead(captured.key!)
              if (disposed) return undefined
              const buffer = data.buffer.slice(data.byteOffset,data.byteOffset + data.byteLength) as ArrayBuffer
              const gltf = await loader.parseAsync(buffer,'')
              if (disposed) { disposeScene(gltf.scene); return undefined }
              if (new THREE.Box3().setFromObject(gltf.scene).isEmpty()) { disposeScene(gltf.scene); throw new Error('Export contains no displayable geometry.') }
              scene.add(gltf.scene)
              const skeleton = new THREE.SkeletonHelper(gltf.scene); skeleton.visible = false; helpers.push(skeleton); scene.add(skeleton)
              return { group:gltf.scene,clips:gltf.animations,mixer:new THREE.AnimationMixer(gltf.scene) }
            })()
            loaded.set(captured.key,pending)
          }
          const value = await pending
          if (disposed || !value) return
          let details=metadata.get(captured)
          if(!details){details={labels:nativeClipLabels(value.clips,value.group,captured.actors ?? []),profiles:nativeClipPlayback(value.clips,value.group,captured.actors ?? [],captured.playback)};metadata.set(captured,details)}
          groups[index] = value.group; animations[index] = value.clips; clipLabels[index] = details.labels; profiles[index] = details.profiles; mixers[index] = value.mixer;shown[index]=captured
          if (index === (sideRef.current === 'left' ? 0 : 1)) {
            value.mixer.stopAllAction();value.mixer.uncacheRoot(value.group)
            if(captured.playback?.length)primeNativeAnimationPose(value.group,value.clips,details.profiles)
            if (!fitted) {
              const saved = savedCamera.current
              if (saved) { camera.position.copy(saved.position); controls!.target.copy(saved.target); camera.near = saved.near; camera.far = saved.far; camera.updateProjectionMatrix(); controls!.update() }
              else fit()
              fitted = true
            }
            setReady(true);setLoadVersion(value=>value+1); invalidate()
          }
        } catch (reason) {
          loaded.delete(captured.key)
          if (!disposed && index === (sideRef.current === 'left' ? 0 : 1)) setError(String((reason as Error).message ?? reason))
        }
      }
      runtime.current = { groups,mixers,clips:animations,clipLabels,profiles,fit,controls,invalidate,suspend,load }
      const resizeView = () => { const width = mount.clientWidth,height = Math.max(300,mount.clientHeight); if (!width) return; renderer!.setSize(width,height,false); camera.aspect = width / height; camera.updateProjectionMatrix(); invalidate() }
      resize = new ResizeObserver(resizeView); resize.observe(mount); resizeView()
      void load(sideRef.current === 'left' ? 0 : 1)
      renderer.domElement.addEventListener('keydown', event => {
        if (event.key === 'Home') { event.preventDefault(); fit() }
        if (['+','=','-','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) {
          event.preventDefault()
          const offset = camera.position.clone().sub(controls!.target)
          if (['+','=','-'].includes(event.key)) offset.multiplyScalar(event.key === '-' ? 1.2 : 1 / 1.2)
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') offset.applyAxisAngle(new THREE.Vector3(0,1,0),event.key === 'ArrowLeft' ? -.15 : .15)
          else offset.applyAxisAngle(new THREE.Vector3(1,0,0),event.key === 'ArrowUp' ? .1 : -.1)
          camera.position.copy(controls!.target).add(offset); controls!.update()
        }
      })
      renderer.domElement.addEventListener('click', event => {
        const rect = renderer!.domElement.getBoundingClientRect(), ray = new THREE.Raycaster()
        ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1),camera)
        const hit = ray.intersectObject(groups[sideRef.current === 'left' ? 0 : 1],true)[0]
        if (hit) {
          setPicked(hit.object.name || hit.object.parent?.name || 'Mesh section')
          const actor = nativeActorForObject(hit.object,actorsRef.current ?? [])
          if (actor) { setPicked(actor.name + (actor.instanceLabel ? ' · ' + actor.instanceLabel : '')); setPickedPath(actor.path); inspectRef.current?.(actor.inspectPath ?? actor.path) }
        }
      })
    }
    void start().catch(reason => { if (!disposed) { setError(String(reason.message ?? reason)); cleanup() } })
    return () => { disposed = true; cleanup() }
  // Captured keys alone define the immutable GPU lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceKind, keys])
  useEffect(() => { void runtime.current?.load(side === 'left' ? 0 : 1) }, [side, keys, scenes])
  useEffect(() => {
    if (visible) runtime.current?.invalidate()
    else runtime.current?.suspend()
  }, [visible, playing, bones, ready])
  useEffect(() => {
    const value = runtime.current, index = side === 'left' ? 0 : 1
    const available = value?.clips[index] ?? []
    setUnmatchedPlayback(Boolean(scenes[index]?.playback?.length && value?.profiles[index]?.some(profile=>!profile)))
    setClips(value?.clipLabels[index] ?? []); setDuration(available[clip]?.duration ?? 0);setTime(value?.profiles[index][clip]?.position ?? 0)
    if (value) {
      for(const mixer of new Set(value.mixers))mixer.stopAllAction()
      const i=index
      value.mixers[i].uncacheRoot(value.groups[i])
      if(scenes[index]?.playback?.length)primeNativeAnimationPose(value.groups[i],value.clips[i],value.profiles[i])
      if (value.clips[i][clip]) {
        const action=value.mixers[i].clipAction(value.clips[i][clip]).reset()
        const profile=value.profiles[i][clip],looping=profile?.looping ?? true;action.setLoop(looping ? THREE.LoopRepeat : THREE.LoopOnce,looping ? Infinity : 1);action.setEffectiveTimeScale(profile?.rate ?? 1);action.time=profile?.position ?? 0
        action.clampWhenFinished=true; action.play()
      }
      value.mixers[i].update(0)
    }
    value?.invalidate()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, side, clip, loadVersion])
  useEffect(() => {
    runtime.current?.groups.forEach(group => group.traverse(object => { if (object instanceof THREE.Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) if ('wireframe' in material) material.wireframe = wireframe }))
    runtime.current?.invalidate()
  }, [wireframe, ready, side])
  const seek = (value: number) => { setTime(value); runtime.current?.mixers.forEach((mixer,index) => {const selected=runtime.current?.clips[index][clip];if(selected){const action=mixer.clipAction(selected);action.paused=false;action.time=value}mixer.update(0)}); runtime.current?.invalidate() }
  const selectActor = useCallback((actor: NonNullable<NativeSceneReview['actors']>[number]) => {
    setPicked(actor.name + (actor.instanceLabel ? ' · ' + actor.instanceLabel : '')); setPickedPath(actor.path); onInspectActor?.(actor.inspectPath ?? actor.path)
    const view = runtime.current, group = view?.groups[side === 'left' ? 0 : 1], matches: THREE.Object3D[] = []
    group?.traverse(object => { if (nativeActorForObject(object,[actor])) matches.push(object) })
    if (view && matches.length > 0 && active?.actors?.filter(value => (value.renderName ?? value.name) === (actor.renderName ?? actor.name)).length === 1) { const bounds = new THREE.Box3(); matches.forEach(object => bounds.expandByObject(object)); const center = bounds.isEmpty() ? matches[0].getWorldPosition(new THREE.Vector3()) : bounds.getCenter(new THREE.Vector3()), delta = center.clone().sub(view.controls.target); view.controls.object.position.add(delta); view.controls.target.copy(center); view.controls.update() }
  }, [side,active,onInspectActor])
  return <section className="uar-scene" aria-label="Captured engine scene">
    {active?.key && !active.complete && <p className="uar-warning" role="status">Partial export: some geometry or materials may be missing. See Scene and dependency coverage.</p>}
    <p className="uar-caption">{surfaceKind === 'texture' ? 'Texture2D source image · unlit · alpha · original aspect ratio. Display preview; runtime compression, HDR precision and mipmaps are not reproduced.' : 'Engine-exported scene · meters · glTF Y up. Materials use glTF shading and may simplify Unreal shaders. No gameplay or Animation Blueprint execution.'}</p>
    <div className="uar-map-tools"><button className="lg-toolbar-control" onClick={() => runtime.current?.fit()} disabled={!ready}>Fit scene</button>{surfaceKind !== 'texture' && <><button className="lg-toolbar-control" aria-pressed={wireframe} onClick={() => setWireframe(v => !v)} disabled={!ready}>Wireframe</button><button className="lg-toolbar-control" aria-pressed={bones} onClick={() => setBones(v => !v)} disabled={!ready}>Skeleton</button></>}</div>
    {clips.length > 0 && <div className="uar-map-tools"><BlueprintChoice id="uar-scene-animation" label="Animation clip" value={String(clip)} items={clips.map((name,index) => ({value:String(index),name,detail:'',color:'var(--lg-text-secondary)'}))} onChange={v => { setClip(Number(v)); seek(0) }}/><button className="lg-toolbar-control" disabled={selectedProfile?.rate===0} onClick={() => {if(!playing && (time>=duration || (selectedProfile?.rate ?? 1)<0 && time<=0))seek(selectedProfile?.position ?? 0);setPlaying(v => !v)}}>{playing ? 'Pause' : 'Play'}</button><label>Time <input type="range" aria-label="Animation time" min={0} max={duration || 1} step={.01} value={Math.min(time,duration)} onChange={e => {setPlaying(false);seek(Number(e.target.value))}}/></label><small>{time.toFixed(2)} / {duration.toFixed(2)} s</small>{selectedProfile && <small>Saved start {selectedProfile.position}s · {selectedProfile.rate}× · {selectedProfile.looping ? "loop" : "once"} · source {selectedProfile.playing ? "playing" : "paused"}</small>}</div>}
    {error && <p role="alert" className="uar-warning">{error}</p>}
    {unmatchedPlayback && <p className="uar-warning">Some clips have ambiguous owners; their saved playback state could not be applied.</p>}
    {!active?.key && <p role="alert" className="uar-warning"><span>{active?.reason ?? 'Scene unavailable in this revision.'}</span><small>Retry the export, or switch to the saved-data view.</small></p>}
    <div ref={host} data-bones={bones} className="uar-scene-field" style={{display:active?.key ? undefined : 'none'}}/>
    {scenes.some(scene => scene?.key) && !ready && !error && <p role="status">Loading captured geometry and textures…</p>}
    <p className="uar-caption">{surfaceKind === 'texture' ? 'Right-drag to pan' : 'Drag to orbit · right-drag to pan'} · scroll to zoom · arrows and +/− work with viewport focus · Home fits. {picked && 'Selected: ' + picked}</p>
    <NativeSceneActors scenes={scenes} side={side} paths={paths} labels={labels} selectedPath={pickedPath} onSelect={selectActor}/>
    <details><summary>Scene and dependency coverage</summary>{scenes.map((scene,index) => <div key={index}><strong>{index === 0 ? labels.left : labels.right}: {scene?.status ?? 'absent'} · {scene?.complete ? 'captured closure complete' : 'partial/unavailable'}</strong>{scene?.renderLod && <small>Requested LOD {scene.renderLod.requested} / {scene.renderLod.count} engine LODs</small>}{scene?.stats && <small>{scene.stats.meshes} meshes · {scene.stats.materials} materials · {scene.stats.textures} textures · {scene.stats.skins} skins · {scene.stats.animations} clips · {scene.stats.vertices} vertices · {scene.stats.triangles} triangles</small>}{scene?.diagnostics.map((message,i) => <p className="uar-warning" key={i}>{message}</p>)}<details><summary>{scene?.packages.length ?? 0} captured packages</summary>{scene?.packages.map(pkg => <p className="uar-caption" key={pkg.path}>{pkg.path}<br/><small>{pkg.bytes.toLocaleString()} bytes · {pkg.hash}</small></p>)}</details></div>)}</details>
  </section>
}

export function NativeStateTreeBags({ scenes, side }: { scenes: Array<NativeSceneReview | undefined>; side: 'left' | 'right' }) {
  const active = scenes[side === 'left' ? 0 : 1]
  return <section className="uar-native-bags" aria-label="Native StateTree parameters"><p className="uar-caption">Engine-decoded parameters from the captured revision. Nested values retain their native text; no type or missing-value defaults are inferred by this viewer.</p>{active?.reason && <p role="alert">{active.reason}</p>}{active?.bags?.map((bag,index) => { const before = scenes[0]?.bags?.filter(value => value.object === bag.object && value.property === bag.property) ?? []; const after = scenes[1]?.bags?.filter(value => value.object === bag.object && value.property === bag.property) ?? []; const fields = nativeBagFields(bag.text); const changed = before.length === 1 && after.length === 1 && before[0].text !== after[0].text;return <details key={index} open><summary>{bag.object} · {bag.property}{changed ? ' · changed' : ''}</summary>{fields ? fields.length ? <table><thead><tr><th>Parameter</th><th>Native value</th></tr></thead><tbody>{fields.map(field => <tr key={field.name}><th>{field.name}</th><td><pre>{field.value}</pre></td></tr>)}</tbody></table> : <p className="uar-caption">Empty property bag.</p> : <pre>{bag.text}</pre>}<details><summary>Native export text</summary><pre>{bag.text}</pre></details>{changed && <div className="uar-values uar-native-bag-values"><pre className="uar-before">{before[0].text}</pre><pre className="uar-after">{after[0].text}</pre></div>}</details> })}{active?.diagnostics.map((message,index) => <p key={index} className="uar-warning">{message}</p>)}</section>
}
