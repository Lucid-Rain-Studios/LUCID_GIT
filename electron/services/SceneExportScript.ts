// Engine APIs only; generated projects never import repository Python/configuration.
export const SCENE_SCRIPT = String.raw`
import unreal, json, os
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
def bag(obj, name, owner):
    value = prop(obj, name)
    if value is not None:
        try:
            text = value.export_text()
            if len(text) > 65536: raise RuntimeError('Native bag text exceeds 64 KB.')
            result['bags'].append({'object': owner, 'property': name, 'text': text})
        except Exception as error:
            result['diagnostics'].append('Native bag unavailable: ' + owner + '.' + name + ': ' + str(error))
if request['class'] == '/Script/StateTreeModule.StateTree':
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
        streaming_levels = [streaming for streaming in unreal.ObjectIterator(unreal.LevelStreaming) if streaming.get_outer() == asset]
        for streaming in streaming_levels:
            streaming.set_editor_property('should_be_loaded', True)
            streaming.set_editor_property('should_be_visible', True)
        if streaming_levels: unreal.GameplayStatics.flush_level_streaming(asset)
        loaded_levels = {streaming.get_loaded_level() for streaming in streaming_levels if streaming.get_loaded_level() is not None}
        inventory_errors = []
        for streaming in streaming_levels:
            if streaming.get_loaded_level() is None:
                result['diagnostics'].append('Sublevel unavailable: ' + str(streaming.get_world_asset_package_f_name()))
                inventory_errors.append('A streaming level failed to load.')
        loaded_worlds = {asset} | {level.get_outer() for level in loaded_levels}
        # Nested streaming is not yet independently enumerated by this provider.
        if any(streaming.get_outer() in loaded_worlds and streaming.get_outer() != asset for streaming in unreal.ObjectIterator(unreal.LevelStreaming)):
            inventory_errors.append('Nested streaming level enumeration is unverified.')
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
        for candidate in request.get('actorCandidates', []):
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
        for description in descriptions:
            if str(description.actor_package) not in actor_packages:
                inventory_errors.append('World Partition descriptor has no captured actor export: ' + str(description.actor_package))
        if not request.get('actorManifestComplete', False): inventory_errors.append('Captured actor manifest is missing or truncated.')
        omitted_visuals = []
        for actor in unreal.ObjectIterator(unreal.Actor):
            outer = actor.get_outer()
            for depth in range(32):
                if outer is None or isinstance(outer, unreal.World): break
                outer = outer.get_outer()
            if outer != asset and actor.get_outer() not in loaded_levels: continue
            actors.add(actor)
            location = actor.get_actor_location()
            result['actors'].append({'name': actor.get_actor_label(), 'path': actor.get_path_name(), 'location': [location.x, location.y, location.z], 'saved': actor.get_path_name() in expected_paths})
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
    options = unreal.GLTFExportOptions()
    options.set_editor_property('default_level_of_detail', lod)
    options.set_editor_property('export_uniform_scale', 0.01)
    options.set_editor_property('export_vertex_skin_weights', True)
    options.set_editor_property('export_animation_sequences', True)
    options.set_editor_property('export_preview_mesh', True)
    options.set_editor_property('export_source_model', False)
    options.set_editor_property('export_hidden_in_game', True)
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
