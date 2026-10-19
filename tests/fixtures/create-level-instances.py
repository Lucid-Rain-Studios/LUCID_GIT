import os, json, unreal
if '.blueprint-build' not in os.path.abspath(unreal.Paths.project_dir()).replace('\\','/').split('/'):
    raise RuntimeError('Fixture project required')
if any(name.endswith(('.umap','.uasset')) for _,_,names in os.walk(os.path.join(unreal.Paths.project_dir(),'Content')) for name in names):
    raise RuntimeError('Empty fixture Content required; existing assets will not be overwritten')
levels=unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
actors=unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
levels.new_level('/Game/InstanceLeaf')
leaf=actors.spawn_actor_from_class(unreal.StaticMeshActor,unreal.Vector(10,20,30))
leaf.set_actor_label('Repeated Cube')
leaf.static_mesh_component.set_static_mesh(unreal.load_asset('/Engine/BasicShapes/Cube'))
if os.environ.get('UNREAL_FIXTURE_INSTANCED_MESHES') == '1':
    tools=unreal.AssetToolsHelpers.get_asset_tools()
    subsystem=unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    for kind,component_class,x in [('ISM',unreal.InstancedStaticMeshComponent,30),('HISM',unreal.HierarchicalInstancedStaticMeshComponent,60)]:
        factory=unreal.BlueprintFactory(); factory.set_editor_property('parent_class',unreal.Actor)
        bp=tools.create_asset('BP_'+kind,'/Game',unreal.Blueprint,factory)
        handles=subsystem.k2_gather_subobject_data_for_blueprint(bp)
        handle,reason=subsystem.add_new_subobject(unreal.AddNewSubobjectParams(parent_handle=handles[0],new_class=component_class,blueprint_context=bp))
        if str(reason): raise RuntimeError(str(reason))
        component=unreal.SubobjectDataBlueprintFunctionLibrary.get_object(unreal.SubobjectDataBlueprintFunctionLibrary.get_data(handle))
        component.set_editor_property('static_mesh',unreal.load_asset('/Engine/BasicShapes/Cube'))
        component.set_editor_property('relative_location',unreal.Vector(5,0,0))
        for offset in [0,40]: component.add_instance(unreal.Transform(location=unreal.Vector(offset,0,0)))
        unreal.BlueprintEditorLibrary.compile_blueprint(bp); unreal.EditorAssetLibrary.save_loaded_asset(bp)
        actor=actors.spawn_actor_from_class(bp.generated_class(),unreal.Vector(x,0,0))
        actor.set_actor_label('Repeated '+kind)
        if kind=='ISM':
            actor.set_actor_rotation(unreal.Rotator(yaw=90),False)
            actor.set_actor_scale3d(unreal.Vector(2,2,2))
    reference={}
    for actor in actors.get_all_level_actors():
        if actor.get_actor_label() not in ('Repeated ISM','Repeated HISM'): continue
        components=actor.get_components_by_class(unreal.InstancedStaticMeshComponent)
        if len(components)!=1 or components[0].get_instance_count()!=2: raise RuntimeError('Expected two saved mesh instances')
        reference[actor.get_actor_label()]=[]
        for index in range(2):
            value=components[0].get_instance_transform(index,world_space=True).translation
            reference[actor.get_actor_label()].append([value.x,value.y,value.z])
    with open(os.path.join(unreal.Paths.project_dir(),'instance-mesh-reference.json'),'w') as file: json.dump(reference,file)
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
unreal.EditorLoadingAndSavingUtils.save_map(world,'/Game/InstanceLeaf')
source='/Game/InstanceLeaf'
if os.environ.get('UNREAL_FIXTURE_NESTED_INSTANCES') == '1':
    levels.new_level('/Game/InstanceBranch')
    actor=actors.spawn_actor_from_class(unreal.LevelInstance,unreal.Vector(50,0,0))
    actor.set_actor_label('Nested Instance')
    actor.set_editor_property('world_asset',unreal.load_asset(source))
    world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    unreal.EditorLoadingAndSavingUtils.save_map(world,'/Game/InstanceBranch')
    source='/Game/InstanceBranch'
levels.new_level('/Game/InstanceMap')
for label,position in [('Instance One',[100,0,0]),('Instance Two',[1000,0,0])]:
    actor=actors.spawn_actor_from_class(unreal.LevelInstance,unreal.Vector(*position))
    actor.set_actor_label(label)
    actor.set_editor_property('world_asset',unreal.load_asset(source))
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
unreal.EditorLoadingAndSavingUtils.save_map(world,'/Game/InstanceMap')
levels.load_level('/Game/InstanceMap')
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
unreal.GameplayStatics.flush_level_streaming(world)
for actor in unreal.ObjectIterator(unreal.Actor):
    if actor.get_actor_label() in ('Repeated Cube','Instance One','Instance Two'):
        print('INSTANCE ACTOR',actor.get_path_name(),actor.get_actor_location(),actor.get_editor_property('actor_guid'),actor.get_editor_property('actor_instance_guid'))
for stream in unreal.ObjectIterator(unreal.LevelStreaming):
    print('INSTANCE STREAM',stream.get_class().get_name(),stream.get_path_name(),stream.get_world_asset_package_f_name(),stream.get_loaded_level())
