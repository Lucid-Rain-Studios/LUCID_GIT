// Engine APIs only; generated projects never import repository Python/configuration.
import { INSTANCE_SCRIPT } from './SceneInstanceScript'
import { ANIMATION_SCRIPT } from './SceneAnimationScript'
import { TEXTURE_PREVIEW_SCRIPT } from './TexturePreviewScript'
export const SCENE_SCRIPT = String.raw`
import unreal, json, os, hashlib, math
base = os.path.dirname(__file__)
with open(os.path.join(base, 'request.json'), encoding='utf-8') as stream:
    request = json.load(stream)
asset = unreal.load_asset(request['asset'], follow_redirectors=False)
if asset is None:
    raise RuntimeError('Captured root asset could not be loaded.')
result = {'engineVersion': unreal.SystemLibrary.get_engine_version(), 'diagnostics': [], 'actors': [], 'bags': []}
lod = request.get('lod', 0)
if isinstance(asset, unreal.StaticMesh):
    count = asset.get_num_lods()
elif isinstance(asset, unreal.SkeletalMesh):
    count = unreal.SkeletalMeshEditorSubsystem.get_lod_count(asset)
else:
    count = None
if count is not None:
    if lod >= count: raise RuntimeError('Requested render LOD ' + str(lod) + ' is absent in this revision (' + str(count) + ' LODs).')
    result['renderLod'] = {'requested': lod, 'count': count}
elif lod != 0:
    raise RuntimeError('Render LOD selection requires a StaticMesh or SkeletalMesh root.')
def prop(obj, name):
    for candidate in (name, ''.join(part[:1].upper() + part[1:] for part in name.split('_'))):
        try: return obj.get_editor_property(candidate)
        except Exception: pass
    return None
${INSTANCE_SCRIPT}
${ANIMATION_SCRIPT}
if isinstance(asset,unreal.AnimComposite):
    bridge=getattr(unreal,'LucidPreviewLibrary',None)
    mesh=bridge.animation_preview_mesh(asset) if bridge is not None else None
    if mesh is None: raise RuntimeError('Composite preview requires a matching native bridge and captured preview skeletal mesh')
    asset=bake_saved_animation(asset,mesh,0,1,False)
${TEXTURE_PREVIEW_SCRIPT}
def load_streamed_worlds(root):
    # Each sublevel owns a World with its own streaming table. Flush that owner,
    # then visit newly loaded worlds; never recurse indefinitely through cycles.
    worlds, levels, seen_streams, errors = {root}, set(), set(), []
    pending = [root]
    while pending:
        world = pending.pop(0)
        streams = [stream for stream in unreal.ObjectIterator(unreal.LevelStreaming) if stream.get_outer() == world and stream not in seen_streams]
        if len(seen_streams) + len(streams) > 256:
            errors.append('Streaming level enumeration exceeds the 256-level budget.')
            break
        seen_streams.update(streams)
        for stream in streams:
            try:
                stream.set_editor_property('should_be_loaded', True)
                stream.set_editor_property('should_be_visible', True)
            except Exception as error:
                errors.append('Streaming level request failed: ' + str(stream.get_world_asset_package_f_name()) + ': ' + str(error))
        try:
            if streams: unreal.GameplayStatics.flush_level_streaming(world)
        except Exception as error:
            errors.append('Streaming world flush failed: ' + world.get_path_name() + ': ' + str(error))
        for stream in streams:
            level = stream.get_loaded_level()
            if level is None:
                errors.append('Sublevel unavailable: ' + str(stream.get_world_asset_package_f_name()))
                continue
            levels.add(level)
            owner = level.get_outer()
            if not isinstance(owner, unreal.World):
                errors.append('Streaming level world ownership unavailable: ' + level.get_path_name())
                continue
            if owner in worlds: continue
            if len(worlds) >= 256:
                errors.append('Streaming world enumeration exceeds the 256-world budget.')
                continue
            worlds.add(owner)
            pending.append(owner)
    return worlds, levels, errors

def attachment_depth(actor):
    seen = set()
    parent = actor.get_attach_parent_actor()
    while parent is not None and parent not in seen and len(seen) < 32:
        seen.add(parent); parent = parent.get_attach_parent_actor()
    return len(seen)

def streaming_parent_transforms(root, worlds):
    identity = unreal.Transform(location=unreal.Vector(0,0,0), rotation=unreal.Rotator(0,0,0), scale=unreal.Vector(1,1,1))
    globals, parents, frames, errors, pending = {root: identity}, {root: identity}, {root:(identity,identity)}, [], [root]
    streams = {}
    for stream in unreal.ObjectIterator(unreal.LevelStreaming):
        if stream.get_outer() in worlds: streams.setdefault(stream.get_outer(), []).append(stream)
    while pending:
        world = pending.pop(0)
        for stream in streams.get(world, []):
            level = stream.get_loaded_level()
            if level is None or level.get_outer() not in worlds: continue
            owner = level.get_outer()
            try:
                local = stream.get_editor_property('level_transform')
                composed = unreal.MathLibrary.compose_transforms(local, globals[world])
                if owner in globals:
                    if not unreal.MathLibrary.nearly_equal_transform_transform(globals[owner], composed):
                        errors.append('Streaming world has conflicting instance transforms: ' + owner.get_path_name())
                    continue
                globals[owner], parents[owner] = composed, globals[world]
                frames[owner] = (local, composed)
                pending.append(owner)
            except Exception as error:
                errors.append('Streaming transform unavailable: ' + owner.get_path_name() + ': ' + str(error))
    return parents, errors, frames

def restore_saved_attachments(contexts=None):
    errors = []
    if request.get('componentsComplete') is False: errors.append('Saved component attachment correction table is truncated.')
    components = request.get('components',[])
    if contexts is not None:
        by_source = {}
        for saved in components: by_source.setdefault(saved['path'].split(':')[0],[]).append(saved)
        expanded = []
        for world, context in contexts.items():
            source, target = context['source'], world.get_path_name()
            for saved in by_source.get(source,[]):
                if len(expanded) >= 10000:
                    errors.append('Expanded attachment correction limit reached (10000).'); break
                parent = saved['parent']
                expanded.append(dict(saved,path=target+saved['path'][len(source):],parent=target+parent[len(source):] if parent.startswith(source+':') else parent))
        components = expanded
    for saved in components:
        component = unreal.load_object(None,saved['path'])
        if not isinstance(component,unreal.SceneComponent):
            errors.append('Saved attachment component unavailable: ' + saved['path']); continue
        parent = component.get_attach_parent()
        if parent is None or parent.get_path_name() != saved['parent'] or str(component.get_attach_socket_name()) != saved['socket']:
            errors.append('Saved attachment parent/socket does not match loaded component: ' + saved['path']); continue
        if saved.get('location') is not None: component.set_relative_location(unreal.Vector(*saved['location']),False,False)
        if saved.get('rotation') is not None: component.set_relative_rotation(unreal.Rotator(pitch=saved['rotation'][0],yaw=saved['rotation'][1],roll=saved['rotation'][2]),False,False)
        if saved.get('scale') is not None: component.set_relative_scale3d(unreal.Vector(*saved['scale']))
    return errors

def bag(obj, name, owner):
    value = prop(obj, name)
    if value is not None:
        try:
            text = value.export_text()
            if len(text) > 65536: raise RuntimeError('Native bag text exceeds 64 KB.')
            result['bags'].append({'object': owner, 'property': name, 'text': text})
        except Exception as error:
            result['diagnostics'].append('Native bag unavailable: ' + owner + '.' + name + ': ' + str(error))
if isinstance(asset, unreal.Texture):
    export_texture_preview(asset)
elif request['class'] == '/Script/StateTreeModule.StateTree':
    editor = prop(asset, 'editor_data')
    if editor is None:
        for name in request['editorObjects']:
            editor = unreal.load_object(None, asset.get_path_name() + ':' + name)
            if editor is not None: break
    if editor is None:
        for candidate in unreal.ObjectIterator(unreal.Object):
            if candidate.get_outer() == asset and candidate.get_name() in request['editorObjects']:
                editor = candidate
                break
    if editor is None: raise RuntimeError('StateTree editor data is unavailable.')
    bag(editor, 'root_parameter_property_bag', 'EditorData')
    legacy = prop(editor, 'root_parameters')
    if legacy is not None: bag(legacy, 'parameters', 'EditorData.RootParameters')
    pending = list(prop(editor, 'sub_trees') or [])
    seen = set()
    while pending:
        state = pending.pop(0)
        if state.get_path_name() in seen: continue
        seen.add(state.get_path_name())
        if len(seen) > 1000: raise RuntimeError('StateTree bag owner limit reached.')
        owner = state.get_path_name().removeprefix(asset.get_path_name() + ':').removeprefix(asset.get_path_name() + '.')
        parameters = prop(state, 'parameters')
        if parameters is not None: bag(parameters, 'parameters', owner)
        pending.extend(list(prop(state, 'children') or []))
else:
    actors = set()
    if isinstance(asset, unreal.World):
        if not unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).load_level(request['asset'].split('.')[0]):
            raise RuntimeError('Captured map could not be opened in the isolated editor.')
        asset = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
        loaded_worlds, loaded_levels, inventory_errors = load_streamed_worlds(asset)
        inventory_errors.extend(restore_saved_attachments({world:{'source':world.get_path_name()} for world in loaded_worlds}))
        parent_transforms, transform_errors, streaming_frames = streaming_parent_transforms(asset, loaded_worlds)
        inventory_errors.extend(transform_errors)
        instance_contexts, instance_levels, instance_errors = load_instances(asset,loaded_worlds,streaming_frames,parent_transforms)
        inventory_errors.extend(restore_saved_attachments({world:context for world,context in instance_contexts.items() if context['identity']}))
        loaded_levels.update(instance_levels)
        inventory_errors.extend(instance_errors)
        parent_transforms, transform_errors, streaming_frames = streaming_parent_transforms(asset,loaded_worlds)
        inventory_errors.extend(transform_errors)
        result['instances'] = [{'world':world.get_path_name(),'source':context['source'],'identity':context['identity'],'owner':context['owner']} for world,context in instance_contexts.items() if context['identity']]
        result['diagnostics'].extend(inventory_errors)
        # The descriptor library operates on the active editor world only.
        if any(partition.get_outer() in loaded_worlds and partition.get_outer() != asset for partition in unreal.ObjectIterator(unreal.WorldPartition)):
            inventory_errors.append('Nested World Partition descriptor enumeration is unverified.')
        # Load every captured OFPA package, including actors outside currently streamed cells.
        for package in request['external']:
            if unreal.load_package(package) is None:
                result['diagnostics'].append('External package unavailable: ' + package)
                inventory_errors.append('External package unavailable: ' + package)
        descriptions = unreal.WorldPartitionBlueprintLibrary.get_actor_descs() or []
        if len(descriptions) > 10000: raise RuntimeError('World Partition actor descriptor limit reached.')
        if descriptions: unreal.WorldPartitionBlueprintLibrary.load_actors([description.guid for description in descriptions])
        loaded_packages = {world.get_path_name().split('.')[0] for world in loaded_worlds}
        expected_paths, actor_packages, class_actors = set(), set(), {}
        candidates = []
        for world, context in instance_contexts.items():
            if not context['identity']: continue
            for candidate in request.get('actorCandidates', []):
                if candidate['path'].startswith(context['source'] + ':'):
                    candidates.append({**candidate,'path':world.get_path_name() + candidate['path'][len(context['source']):]})
                    if len(candidates) > 10000: raise RuntimeError('Expanded actor manifest limit reached.')
        candidates.extend(request.get('actorCandidates', []))
        for candidate in candidates:
            if candidate['path'].split('.')[0] not in loaded_packages: continue
            class_path = candidate['classPath']
            if class_path not in class_actors:
                try:
                    cls = unreal.load_class(None, class_path)
                    if cls is None: raise RuntimeError('Class unavailable')
                    class_actors[class_path] = isinstance(unreal.get_default_object(cls), unreal.Actor)
                except Exception:
                    class_actors[class_path] = None
                    inventory_errors.append('Actor class classification unavailable: ' + class_path)
            if class_actors[class_path] is None: continue
            if not class_actors[class_path]: continue
            if candidate['path'] in expected_paths: inventory_errors.append('Duplicate captured actor path: ' + candidate['path'])
            expected_paths.add(candidate['path']); actor_packages.add(candidate['package'])
            if len(expected_paths) > 10000: raise RuntimeError('Expected scene actor limit reached.')
        for description in descriptions:
            if str(description.actor_package) not in actor_packages:
                inventory_errors.append('World Partition descriptor has no captured actor export: ' + str(description.actor_package))
        if not request.get('actorManifestComplete', False): inventory_errors.append('Captured actor manifest is missing or truncated.')
        scoped = []
        for actor in unreal.ObjectIterator(unreal.Actor):
            outer = actor.get_outer()
            for depth in range(32):
                if outer is None or isinstance(outer, unreal.World): break
                outer = outer.get_outer()
            if outer not in loaded_worlds and actor.get_outer() not in loaded_levels: continue
            actors.add(actor)
            scoped.append((actor, outer))
        # Normalize captured single-node state before measuring attachment poses.
        # These loaded objects belong only to the disposable preview project.
        for actor,owner in scoped:
            for component in actor.get_components_by_class(unreal.SkeletalMeshComponent):
                copy_instance_animation(component,component)
        # Streaming applies the immediate level transform. Deeper worlds still
        # need the ancestor transform; capture all originals before moving parents
        # so attached children are corrected once, independently of iterator order.
        transforms = {}
        for actor, owner in scoped:
            if owner not in parent_transforms:
                inventory_errors.append('Streaming ancestor placement unavailable: ' + actor.get_path_name())
                continue
            if unreal.MathLibrary.nearly_equal_transform_transform(parent_transforms[owner], parent_transforms[asset]): continue
            # FTransform multiplication is not associative under rotated
            # nonuniform scales. Recover the authored frame before applying the
            # composed level frame, matching a direct engine streaming load.
            local, global_frame = streaming_frames[owner]
            relative = unreal.MathLibrary.make_relative_transform(actor.get_actor_transform(), local)
            transforms[actor] = unreal.MathLibrary.compose_transforms(relative, global_frame)
        for actor in sorted(transforms, key=attachment_depth):
            actor.set_actor_transform(transforms[actor], False, True)
        omitted_visuals = []
        for actor, owner in scoped:
            location = actor.get_actor_location()
            rotation, scale = actor.get_actor_transform().rotation, actor.get_actor_scale3d()
            record = {'name': actor.get_actor_label(), 'path': actor.get_path_name(), 'location': [location.x, location.y, location.z], 'rotation':[rotation.x,rotation.y,rotation.z,rotation.w], 'scale':[scale.x,scale.y,scale.z], 'saved': actor.get_path_name() in expected_paths}
            context = instance_contexts.get(owner)
            if context and context['identity']:
                record['instancePath'] = context['identity']
                record['instanceLabel'] = context['label']
                record['sourcePath'] = context['source'] + actor.get_path_name()[len(owner.get_path_name()):]
                record['inspectPath'] = context['owner']
                record['renderName'] = record['name'] + '__LGI_' + hashlib.sha256(context['identity'].encode('utf-8')).hexdigest()[:16] + '_' + actor.get_name()
            if record['saved']:
                identity = guid_text(actor)
                if identity: record['guid'] = identity
            result['actors'].append(record)
            if record.get('renderName'): actor.set_actor_label(record['renderName'],False)
            else:
                for component in actor.get_components_by_class(unreal.SkeletalMeshComponent):
                    playback=playback_record(component,component,actor.get_actor_label())
                    if playback: result.setdefault('playback',[]).append(playback)
            classes = [actor.get_class().get_name()] + [component.get_class().get_name() for component in actor.get_components_by_class(unreal.SceneComponent)]
            if any(any(kind in name for kind in ('Landscape', 'Niagara', 'ParticleSystem', 'HeightFog', 'VolumetricCloud', 'SkyAtmosphere')) for name in classes):
                omitted_visuals.append(actor.get_actor_label())
        if len(actors) > 10000: raise RuntimeError('Scene actor limit reached.')
        matched_paths = {actor.get_path_name() for actor in actors} & expected_paths
        missing = sorted(expected_paths - matched_paths)
        result['actorInventory'] = {'expected': len(expected_paths), 'matched': len(matched_paths), 'missing': missing[:100], 'diagnostics': list(dict.fromkeys(inventory_errors))[:100]}
        result['actorInventoryComplete'] = not missing and not inventory_errors
        if omitted_visuals:
            result['diagnostics'].append('glTF cannot reproduce all Unreal landscape, atmosphere or effect rendering. Locations are retained for ' + str(len(omitted_visuals)) + ' affected actors: ' + ', '.join(omitted_visuals[:10]))
        # glTF enumerates only levels registered with the exported World. Register
        # deeper levels in this disposable preview world without saving packages.
        direct_worlds = {asset} | {stream.get_loaded_level().get_outer() for stream in unreal.ObjectIterator(unreal.LevelStreaming) if stream.get_outer() == asset and stream.get_loaded_level() is not None}
        nested_worlds = loaded_worlds - direct_worlds
        if nested_worlds:
            transforms = {actor: actor.get_actor_transform() for actor in actors}
            for world in sorted(nested_worlds, key=lambda world: world.get_path_name()):
                try:
                    stream = unreal.EditorLevelUtils.add_level_to_world(asset, world.get_path_name().split('.')[0], unreal.LevelStreamingAlwaysLoaded)
                    if stream is None or stream.get_loaded_level() is None:
                        raise RuntimeError('Preview level registration failed')
                except Exception as error:
                    result['diagnostics'].append('Nested level geometry unavailable: ' + world.get_path_name() + ': ' + str(error))
            # Keep engine-evaluated placement and attachment transforms; parent
            # restoration precedes child restoration when levels change owners.
            for actor in sorted(actors, key=attachment_depth):
                actor.set_actor_transform(transforms[actor], False, True)
        # Dynamic instance levels are not traversed by the editor glTF world
        # exporter. Stage only their mesh-bearing actors in the disposable root;
        # source identities and engine inventory remain tied to loaded copies.
        renderer_actors = set(actors)
        staged_components = {}
        animated_sources = set()
        subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
        for actor, owner in scoped:
            context = instance_contexts.get(owner)
            if not context or not context['identity']: continue
            renderer_actors.discard(actor)
            meshes = actor.get_components_by_class(unreal.MeshComponent)
            if not meshes and actor.get_components_by_class(unreal.LightComponent): result['diagnostics'].append('Instance light component staging is unavailable: ' + actor.get_path_name())
            for index,component in enumerate(meshes):
                skeletal = isinstance(component,unreal.SkeletalMeshComponent)
                if not skeletal and not isinstance(component,unreal.StaticMeshComponent):
                    result['diagnostics'].append('Instance mesh component profile unavailable: ' + component.get_path_name()); continue
                instanced = isinstance(component,unreal.InstancedStaticMeshComponent)
                count = component.get_instance_count() if instanced else 1
                if count < 0 or len(renderer_actors) + count > 10000:
                    result['diagnostics'].append('Instance geometry staging limit reached (10000): ' + component.get_path_name()); continue
                mesh = component.get_skeletal_mesh_asset() if skeletal else component.static_mesh
                if mesh is None: continue
                if instanced and (prop(component,'num_custom_data_floats') or 0) > 0:
                    result['diagnostics'].append('Instance custom material data is not reconstructed: ' + component.get_path_name())
                slots = component.get_num_materials()
                if slots > 128: result['diagnostics'].append('Instance material slot limit reached (128): ' + component.get_path_name())
                for instance in range(count):
                    transform = component.get_instance_transform(instance,world_space=True) if instanced else component.get_world_transform()
                    if transform is None:
                        result['diagnostics'].append('Instance geometry transform unavailable: ' + component.get_path_name()); continue
                    clone = subsystem.spawn_actor_from_class(unreal.SkeletalMeshActor if skeletal else unreal.StaticMeshActor,unreal.Vector(0,0,0))
                    if clone is None:
                        result['diagnostics'].append('Instance geometry staging failed: ' + actor.get_path_name()); continue
                    target = clone.skeletal_mesh_component if skeletal else clone.static_mesh_component
                    if skeletal:
                        target.set_skeletal_mesh_asset(mesh)
                        if copy_instance_animation(component,target): animated_sources.add(component)
                        else:
                            result['diagnostics'].append('Instance skeletal geometry uses reference pose; animation state is not reconstructed: ' + component.get_path_name())
                    else: target.set_static_mesh(mesh)
                    for slot in range(min(128,slots)): target.set_material(slot,component.get_material(slot))
                    clone.set_actor_transform(transform,False,True)
                    suffix = '__part_' + str(index) + '_instance_' + str(instance) if instanced else ('__part_' + str(index) if index else '')
                    clone.set_actor_label(actor.get_actor_label() + suffix,False)
                    if component in animated_sources:
                        playback=playback_record(component,target,actor.get_actor_label())
                        if playback: result.setdefault('playback',[]).append(playback)
                    renderer_actors.add(clone)
                    if not instanced: staged_components[component] = (clone,target)
        for source, (clone,target) in staged_components.items():
            chain, seen, cursor = [], set(), source
            parent = cursor.get_attach_parent()
            while parent is not None and not isinstance(parent,unreal.SkeletalMeshComponent):
                if cursor in seen or len(chain) >= 64: break
                seen.add(cursor); chain.append(cursor); cursor = parent
                parent = cursor.get_attach_parent()
            if cursor in seen or len(chain) >= 64:
                result['diagnostics'].append('Instance skeletal attachment chain limit/cycle: ' + source.get_path_name()); continue
            if not isinstance(parent,unreal.SkeletalMeshComponent) or parent not in staged_components: continue
            chain.append(cursor)
            if parent not in animated_sources and (prop(prop(parent,'animation_data'),'anim_to_play') is not None or prop(parent,'anim_class') is not None):
                result['diagnostics'].append('Instance skeletal attachment playback profile is unsupported: ' + source.get_path_name()); continue
            if any(prop(node,field) is not False for node in chain for field in ('absolute_location','absolute_rotation','absolute_scale')):
                result['diagnostics'].append('Instance skeletal attachment absolute flags are unsupported: ' + source.get_path_name()); continue
            intermediary_transforms, missing_socket = [], False
            for index,node in enumerate(chain[1:]):
                socket = chain[index].get_attach_socket_name()
                if str(socket) not in ('None',''):
                    if not node.does_socket_exist(socket):
                        missing_socket = True; break
                    intermediary_transforms.append(node.get_socket_transform(socket,unreal.RelativeTransformSpace.RTS_COMPONENT))
                intermediary_transforms.append(node.get_relative_transform())
            if missing_socket:
                result['diagnostics'].append('Instance skeletal attachment intermediary socket is unavailable: ' + source.get_path_name()); continue
            # Flatten only uniform intermediary scales: FTransform composition
            # cannot preserve shear from rotated nonuniform component chains.
            scales = [transform.scale3d for transform in intermediary_transforms]
            if any(not all(math.isfinite(value) for value in (scale.x,scale.y,scale.z)) or min(scale.x,scale.y,scale.z) <= 0 or max(scale.x,scale.y,scale.z)-min(scale.x,scale.y,scale.z) > 0.000001 for scale in scales):
                result['diagnostics'].append('Instance skeletal attachment intermediary scale is unsupported: ' + source.get_path_name()); continue
            relative = source.get_relative_transform()
            for transform in intermediary_transforms: relative = relative * transform
            target.set_mobility(unreal.ComponentMobility.MOVABLE)
            if not clone.attach_to_component(staged_components[parent][1],cursor.get_attach_socket_name(),unreal.AttachmentRule.KEEP_WORLD,unreal.AttachmentRule.KEEP_WORLD,unreal.AttachmentRule.KEEP_WORLD,False):
                result['diagnostics'].append('Instance skeletal attachment staging failed: ' + source.get_path_name()); continue
            target.set_relative_transform(relative,False,True)
        actors = renderer_actors
    if request.get('renderOnly'):
        visual_actors = set()
        unavailable_meshes = []
        expected_visuals = set(request.get('visualActors', []))
        for actor in actors:
            components = actor.get_components_by_class(unreal.MeshComponent)
            environment = False
            for component in components:
                mesh = prop(component, 'static_mesh') if isinstance(component, unreal.StaticMeshComponent) else prop(component, 'skeletal_mesh_asset') if isinstance(component, unreal.SkeletalMeshComponent) else None
                # Engine sky meshes become opaque enclosing geometry in glTF and
                # dominate camera bounds. Their saved actors remain inspectable.
                if mesh is not None and mesh.get_path_name().startswith('/Engine/EngineSky/'):
                    environment = True
                    continue
                if mesh is None or prop(component, 'visible') is False:
                    continue
                visual_actors.add(actor)
            if actor.get_path_name() in expected_visuals and actor not in visual_actors and not environment:
                unavailable_meshes.append(actor.get_actor_label())
        actors = visual_actors
        if not actors: raise RuntimeError('No supported visible mesh geometry was captured. Saved positions remain available.')
        if unavailable_meshes:
            result['diagnostics'].append('Mesh geometry unavailable after loading the render-only dependency subset: ' + ', '.join(unavailable_meshes[:20]) + '. Blueprint-defined visuals may require excluded gameplay dependencies.')
        result['diagnostics'].append('Geometry-only export: visible static/skeletal meshes; engine sky domes and non-mesh world effects are omitted. Saved actor records are retained for inspection.')
    options = unreal.GLTFExportOptions()
    options.set_editor_property('default_level_of_detail', lod)
    options.set_editor_property('export_uniform_scale', 0.01)
    options.set_editor_property('export_vertex_skin_weights', True)
    options.set_editor_property('export_animation_sequences', True)
    options.set_editor_property('export_preview_mesh', True)
    options.set_editor_property('export_source_model', False)
    options.set_editor_property('export_hidden_in_game', not request.get('renderOnly', False))
    options.set_editor_property('texture_image_format', unreal.GLTFTextureImageFormat.PNG)
    options.set_editor_property('bake_material_inputs', unreal.GLTFMaterialBakeMode.USE_MESH_DATA if request['bakeMaterials'] else unreal.GLTFMaterialBakeMode.DISABLED)
    if not request['bakeMaterials']:
        result['diagnostics'].append('Material baking disabled: direct glTF material/texture inputs are exported; complex shader inputs require the GPU baking profile.')
    options.set_editor_property('default_material_bake_size', unreal.GLTFMaterialBakeSize(x=512, y=512, auto_detect=False))
    messages = unreal.GLTFExporter.export_to_gltf(asset, os.path.join(base, 'scene.glb'), options, actors)
    if messages is None: raise RuntimeError('glTF export failed.')
    if isinstance(messages, tuple): messages = messages[-1]
    for kind in ('errors', 'warnings'):
        for message in prop(messages, kind) or []:
            result['diagnostics'].append(kind + ': ' + str(message))
if len(result['diagnostics']) > 100: result['diagnostics'] = result['diagnostics'][:99] + ['Further exporter diagnostics omitted.']
with open(os.path.join(base, 'scene.json'), 'w', encoding='utf-8') as stream:
    json.dump(result, stream, allow_nan=False, separators=(',', ':'))
`
