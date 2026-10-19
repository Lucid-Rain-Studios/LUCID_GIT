// Isolated engine reconstruction of captured traditional LevelInstance sources.
export const INSTANCE_SCRIPT = String.raw`
def actor_world(actor):
    outer = actor.get_outer()
    for depth in range(32):
        if outer is None or isinstance(outer, unreal.World): return outer
        outer = outer.get_outer()
    return None

def guid_text(actor):
    value = prop(actor, 'actor_guid')
    try:
        text = ''.join(format(int(prop(value, part)) & 0xffffffff, '08x') for part in ('a','b','c','d'))
        return text if text != '0' * 32 else None
    except Exception: return None

def load_instances(root, worlds, frames, parents):
    contexts = {world: {'source':world.get_path_name(), 'identity':'', 'owner':'', 'label':'', 'ancestors':{world.get_path_name().split('.')[0]}} for world in worlds}
    levels, seen, errors = set(), set(), []
    captured = {candidate['path'].split('.')[0] for candidate in request.get('actorCandidates', [])}
    counts = {}
    for candidate in request.get('actorCandidates', []):
        source_root = candidate['path'].split(':')[0]
        counts[source_root] = counts.get(source_root,0) + 1
    projected = sum(counts.get(context['source'],0) for context in contexts.values())
    native = getattr(unreal,'LucidPreviewLibrary',None)
    reserved_worlds = len(worlds)
    def native_cost(actor, ancestors, depth=0):
        if depth>=32: raise RuntimeError('Nested level instance depth limit reached (32)')
        source=actor.get_world_asset()
        if source is None: raise RuntimeError('Source world unavailable')
        package=source.get_path_name().split('.')[0]
        if package not in captured or package in ancestors: raise RuntimeError('Nested source is absent or recursive')
        if isinstance(actor,unreal.PackedLevelActor) or prop(actor,'property_overrides') is not None: raise RuntimeError('Packed/override instance profile is unavailable')
        if any(partition.get_outer()==source for partition in unreal.ObjectIterator(unreal.WorldPartition)): raise RuntimeError('World Partition instance sources are not reconstructed')
        for settings in unreal.ObjectIterator(unreal.WorldSettings):
            pivot=prop(settings,'level_instance_pivot_offset') if actor_world(settings)==source else None
            if pivot is not None and any(abs(value)>.0001 for value in (pivot.x,pivot.y,pivot.z)): raise RuntimeError('Nonzero instance pivot requires separate reconstruction')
        cost=counts.get(source.get_path_name(),0)
        world_count=1
        for child in unreal.ObjectIterator(unreal.LevelInstance):
            if actor_world(child)==source:
                child_cost,child_worlds=native_cost(child,ancestors|{package},depth+1)
                cost+=child_cost;world_count+=child_worlds
            if cost>10000: raise RuntimeError('Expanded actor manifest would exceed 10000 before loading')
            if world_count>256: raise RuntimeError('Loaded world limit reached (256) before loading')
        return cost,world_count
    for depth in range(32):
        pending = [actor for actor in unreal.ObjectIterator(unreal.LevelInstance) if actor not in seen and actor_world(actor) in contexts]
        if not pending: break
        for actor in pending:
            seen.add(actor)
            if len(seen) > 256: raise RuntimeError('Level instance limit reached (256).')
            context = contexts[actor_world(actor)]
            try:
                identity = guid_text(actor)
                if not identity: raise RuntimeError('Saved instance actor GUID unavailable')
                chain = '/'.join(filter(None,(context['identity'],identity)))
                source = actor.get_world_asset()
                if source is None: raise RuntimeError('Source world unavailable')
                source_path = source.get_path_name()
                package = source_path.split('.')[0]
                if package not in captured: raise RuntimeError('Source world is absent from the captured manifest')
                if projected + counts.get(source_path,0) > 10000: raise RuntimeError('Expanded actor manifest would exceed 10000 before loading')
                if package in context['ancestors']: raise RuntimeError('Recursive source world reference')
                # Generic dynamic streaming does not remap native LevelInstance IDs.
                # Reject before duplicating: repeated nested containers assert in UE's registry.
                if native is None and any(actor_world(child) == source for child in unreal.ObjectIterator(unreal.LevelInstance)):
                    raise RuntimeError('Nested LevelInstance sources require native instance GUID remapping; source duplication was skipped')
                if hasattr(unreal,'PackedLevelActor') and isinstance(actor,unreal.PackedLevelActor): raise RuntimeError('Packed level instances require a separate reconstruction profile')
                if prop(actor,'property_overrides') is not None: raise RuntimeError('Instance property overrides are not reconstructed')
                if any(partition.get_outer() == source for partition in unreal.ObjectIterator(unreal.WorldPartition)): raise RuntimeError('World Partition instance sources are not reconstructed')
                for settings in unreal.ObjectIterator(unreal.WorldSettings):
                    if actor_world(settings) == source:
                        pivot = prop(settings,'level_instance_pivot_offset')
                        if pivot is not None and any(abs(value) > .0001 for value in (pivot.x,pivot.y,pivot.z)): raise RuntimeError('Nonzero instance pivot requires native pivot reconstruction')
                transform = actor.get_actor_transform()
                owner = actor_world(actor)
                if owner in parents and not unreal.MathLibrary.nearly_equal_transform_transform(parents[owner],parents[root]):
                    local, global_frame = frames[owner]
                    transform = unreal.MathLibrary.compose_transforms(unreal.MathLibrary.make_relative_transform(transform,local),global_frame)
                level = actor.get_loaded_level() if actor.is_loaded() else None
                if level is None and native is not None:
                    cost,world_count=native_cost(actor,context['ancestors'])
                    if projected+cost>10000: raise RuntimeError('Expanded actor manifest would exceed 10000 before loading')
                    if reserved_worlds+world_count>256: raise RuntimeError('Loaded world limit reached (256) before loading')
                    level=native.load_instance(actor)
                    if level is None: raise RuntimeError('Native instance level did not load; unsafe dynamic fallback skipped')
                    projected+=cost;reserved_worlds+=world_count
                if level is None:
                    name = 'LGI_' + hashlib.sha256(chain.encode('utf-8')).hexdigest()[:32]
                    stream, success = unreal.LevelStreamingDynamic.load_level_instance(root,package,unreal.Vector(0,0,0),unreal.Rotator(0,0,0),optional_level_name_override=name)
                    if not success or stream is None: raise RuntimeError('Engine instance stream creation failed')
                    stream.set_editor_property('level_transform',transform)
                    stream.set_editor_property('should_be_loaded',True)
                    stream.set_editor_property('should_be_visible',True)
                    unreal.GameplayStatics.flush_level_streaming(root)
                    level = stream.get_loaded_level()
                if level is None: raise RuntimeError('Engine instance level did not load')
                unreal.EditorLevelUtils.set_level_visibility(level,True,False)
                world = level.get_outer()
                if world in contexts: raise RuntimeError('Instance world aliases an existing world')
                if len(worlds) >= 256: raise RuntimeError('Loaded world limit reached (256)')
                contexts[world] = {'source':source_path,'identity':chain,'owner':context['owner'] or actor.get_path_name(),'label':' / '.join(filter(None,(context['label'],actor.get_actor_label())))[:512],'ancestors':context['ancestors'] | {package}}
                if native is None: projected += counts.get(source_path,0)
                worlds.add(world); levels.add(level)
                if any(stream.get_outer() == world for stream in unreal.ObjectIterator(unreal.LevelStreaming)):
                    errors.append('Streaming sublevels inside a level instance are not independently reconstructed: ' + source_path)
            except Exception as error:
                errors.append('Level instance unavailable: ' + actor.get_path_name() + ': ' + str(error))
    else: errors.append('Nested level instance depth limit reached (32).')
    return contexts, levels, errors
`
