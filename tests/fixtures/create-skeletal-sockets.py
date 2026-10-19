"""Owned saved-pose skeletal socket, bone and inherited-component fixtures."""
import os, json, unreal
project=os.path.abspath(unreal.Paths.project_dir())
if '.blueprint-build' not in project.replace('\\','/').split('/'):
    raise RuntimeError('Isolated fixture project required')
if any(name.endswith(('.umap','.uasset')) for _,_,names in os.walk(os.path.join(project,'Content')) for name in names):
    raise RuntimeError('Empty fixture Content required')
lib=unreal.EditorAssetLibrary
source=unreal.load_asset('/Engine/EngineMeshes/SkeletalCube')
if source is None: raise RuntimeError('Installed reference skeletal mesh unavailable')
mesh=lib.duplicate_loaded_asset(source,'/Game/SocketSkeletalMesh')
if mesh is None: raise RuntimeError('Owned skeletal mesh copy failed')
skeleton_socket=os.environ.get('UNREAL_FIXTURE_SKELETON_SOCKET') == '1'
inherited_animation=os.environ.get('UNREAL_FIXTURE_INHERITED_ANIMATION') == '1'
if inherited_animation and os.environ.get('UNREAL_FIXTURE_SKELETAL_ANIMATION') != '1':
    raise RuntimeError('Inherited animation requires the sequence fixture profile')
if skeleton_socket:
    # Skeleton reassignment is not exposed by UE's Python bindings. Importing an
    # owned FBX creates its own skeleton without mutating the engine reference.
    export=unreal.AssetExportTask()
    export.object=source; export.filename=os.path.join(project,'skeletal-source.fbx')
    export.automated=True; export.prompt=False; export.exporter=unreal.SkeletalMeshExporterFBX()
    if not unreal.Exporter.run_asset_export_task(export): raise RuntimeError('Owned skeletal FBX export failed')
    options=unreal.FbxImportUI()
    options.set_editor_property('automated_import_should_detect_type',False)
    options.set_editor_property('mesh_type_to_import',unreal.FBXImportType.FBXIT_SKELETAL_MESH)
    options.set_editor_property('import_as_skeletal',True)
    options.set_editor_property('import_animations',False)
    options.set_editor_property('import_materials',False)
    options.set_editor_property('import_textures',False)
    task=unreal.AssetImportTask()
    task.filename=export.filename; task.destination_path='/Game'; task.destination_name='OwnedSocketMesh'
    task.automated=True; task.save=True; task.options=options
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    mesh=lib.load_asset('/Game/OwnedSocketMesh')
    if mesh is None: raise RuntimeError('Owned skeletal FBX import failed')
    materials=mesh.get_editor_property('materials')
    for material in materials:
        material.set_editor_property('material_interface',unreal.load_asset('/Engine/BasicShapes/BasicShapeMaterial'))
    mesh.set_editor_property('materials',materials)
    skeleton=mesh.get_editor_property('skeleton')
    if skeleton is None or not skeleton.get_path_name().startswith('/Game/'):
        raise RuntimeError('Skeleton socket fixture requires an owned skeleton')
levels=unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
actors=unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
if not levels.new_level('/Game/SkeletalSocketMap'): raise RuntimeError('Map creation failed')
parent=actors.spawn_actor_from_class(unreal.SkeletalMeshActor,unreal.Vector(100,200,30))
parent.set_actor_label('Skeletal Parent')
component=parent.skeletal_mesh_component
component.set_skeletal_mesh_asset(mesh)
bone=str(component.get_bone_name(0))
if bone=='None': raise RuntimeError('Reference bone unavailable')
socket=unreal.SkeletalMeshSocket(outer=mesh)
socket.set_socket_parent(mesh,bone)
socket.set_socket_local_transform(unreal.Transform(location=unreal.Vector(25,0,10),rotation=unreal.Rotator(yaw=90)))
mesh.add_socket(socket,skeleton_socket)
if not unreal.SkeletalMeshEditorSubsystem.rename_socket(mesh,str(socket.get_editor_property('socket_name')),'SkeletalProbeSocket'):
    raise RuntimeError('Skeletal socket rename failed')
lib.save_loaded_asset(mesh)
if skeleton_socket: lib.save_loaded_asset(skeleton)
if os.environ.get('UNREAL_FIXTURE_SKELETAL_ANIMATION') == '1':
    factory=unreal.AnimSequenceFactory()
    factory.set_editor_property('target_skeleton',mesh.get_editor_property('skeleton'))
    factory.set_editor_property('preview_skeletal_mesh',mesh)
    sequence=unreal.AssetToolsHelpers.get_asset_tools().create_asset('SocketMotion','/Game',unreal.AnimSequence,factory)
    sequence.set_editor_property('bone_compression_settings',unreal.load_asset('/Engine/Animation/DefaultAnimBoneCompressionSettings'))
    sequence.set_editor_property('curve_compression_settings',unreal.load_asset('/Engine/Animation/DefaultAnimCurveCompressionSettings'))
    controller=sequence.get_editor_property('controller')
    controller.set_frame_rate(unreal.FrameRate(30,1))
    controller.set_number_of_frames(unreal.FrameNumber(30))
    if not controller.add_bone_curve(bone): raise RuntimeError('Animation bone curve creation failed')
    pose=component.get_socket_transform(bone,unreal.RelativeTransformSpace.RTS_COMPONENT)
    positions=[unreal.Vector(pose.translation.x+20*index/30,pose.translation.y,pose.translation.z) for index in range(31)]
    if not controller.set_bone_track_keys(bone,positions,[pose.rotation]*31,[pose.scale3d]*31): raise RuntimeError('Animation keys rejected')
    lib.save_loaded_asset(sequence)
    if os.environ.get('UNREAL_FIXTURE_COMPOSITE') == '1':
        sequence=unreal.LucidPreviewLibrary.create_composite_fixture(sequence,sequence)
        if sequence is None: raise RuntimeError('Native composite fixture creation failed')
        lib.save_loaded_asset(sequence)
    saved_position=float(os.environ.get('UNREAL_FIXTURE_ANIMATION_POSITION','0'))
    saved_rate=float(os.environ.get('UNREAL_FIXTURE_ANIMATION_RATE','1'))
    component.override_animation_data(sequence,False,False,saved_position,saved_rate)
    component.set_position(saved_position,False)
parent.set_actor_rotation(unreal.Rotator(yaw=90),False)
parent.set_actor_scale3d(unreal.Vector(2,2,2))
def child(label, target, socket_name):
    actor=actors.spawn_actor_from_class(unreal.StaticMeshActor,unreal.Vector(0,0,0))
    actor.set_actor_label(label)
    actor.static_mesh_component.set_static_mesh(unreal.load_asset('/Engine/BasicShapes/Sphere'))
    actor.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    if not actor.attach_to_component(target,socket_name,unreal.AttachmentRule.KEEP_RELATIVE,unreal.AttachmentRule.KEEP_RELATIVE,unreal.AttachmentRule.KEEP_RELATIVE,False):
        raise RuntimeError('Skeletal attachment failed')
    actor.set_actor_relative_location(unreal.Vector(5,0,0),False,False)
    return actor
socket_child=child('Skeletal Socket Child',component,'SkeletalProbeSocket')
bone_child=child('Skeletal Bone Child',component,bone)
factory=unreal.BlueprintFactory(); factory.set_editor_property('parent_class',unreal.Actor)
bp=unreal.AssetToolsHelpers.get_asset_tools().create_asset('BP_SkeletalBase','/Game',unreal.Blueprint,factory)
subsystem=unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
handles=subsystem.k2_gather_subobject_data_for_blueprint(bp)
handle,reason=subsystem.add_new_subobject(unreal.AddNewSubobjectParams(parent_handle=handles[0],new_class=unreal.SkeletalMeshComponent,blueprint_context=bp))
if str(reason): raise RuntimeError(str(reason))
template=unreal.SubobjectDataBlueprintFunctionLibrary.get_object(unreal.SubobjectDataBlueprintFunctionLibrary.get_data(handle))
subsystem.rename_subobject(handle,unreal.Text('InheritedSkeletalMesh'))
template.set_skeletal_mesh_asset(mesh)
template.set_editor_property('relative_location',unreal.Vector(40,0,0))
if inherited_animation: template.override_animation_data(sequence,False,False,saved_position,saved_rate)
unreal.BlueprintEditorLibrary.compile_blueprint(bp); lib.save_loaded_asset(bp)
factory=unreal.BlueprintFactory(); factory.set_editor_property('parent_class',bp.generated_class())
derived=unreal.AssetToolsHelpers.get_asset_tools().create_asset('BP_SkeletalChild','/Game',unreal.Blueprint,factory)
unreal.BlueprintEditorLibrary.compile_blueprint(derived); lib.save_loaded_asset(derived)
inherited=actors.spawn_actor_from_class(derived.generated_class(),unreal.Vector(400,100,0))
inherited.set_actor_label('Inherited Skeletal Parent')
inherited.set_actor_rotation(unreal.Rotator(yaw=90),False)
attachment_chain=os.environ.get('UNREAL_FIXTURE_SKELETAL_CHAIN') == '1'
intermediary_socket=os.environ.get('UNREAL_FIXTURE_INTERMEDIARY_SOCKET') == '1'
if intermediary_socket and not attachment_chain: raise RuntimeError('Intermediary socket requires the chain fixture profile')
intermediary=None
if attachment_chain:
    attachment_target,attachment_socket=component,'SkeletalProbeSocket'
    if intermediary_socket:
        intermediary_mesh=lib.duplicate_loaded_asset(unreal.load_asset('/Engine/BasicShapes/Cube'),'/Game/IntermediarySocketMesh')
        static_socket=unreal.StaticMeshSocket(outer=intermediary_mesh)
        static_socket.set_editor_property('socket_name','ChainSocket')
        static_socket.set_editor_property('relative_location',unreal.Vector(25,-15,10))
        static_socket.set_editor_property('relative_rotation',unreal.Rotator(yaw=30))
        static_socket.set_editor_property('relative_scale',unreal.Vector(1.25,1.25,1.25))
        intermediary_mesh.add_socket(static_socket);lib.save_loaded_asset(intermediary_mesh)
        intermediary=actors.spawn_actor_from_class(unreal.StaticMeshActor,unreal.Vector(200,250,50))
        intermediary.set_actor_label('Socket Intermediary')
        intermediary.static_mesh_component.set_static_mesh(intermediary_mesh)
        intermediary.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
        intermediary.set_actor_rotation(unreal.Rotator(yaw=25),False)
        intermediary.set_actor_scale3d(unreal.Vector(.75,.75,.75))
        if not intermediary.attach_to_component(component,'SkeletalProbeSocket',unreal.AttachmentRule.KEEP_WORLD,unreal.AttachmentRule.KEEP_WORLD,unreal.AttachmentRule.KEEP_WORLD,False):
            raise RuntimeError('Intermediary skeletal socket attachment failed')
        attachment_target,attachment_socket=intermediary.static_mesh_component,'ChainSocket'
    inherited.root_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    if not inherited.attach_to_component(attachment_target,attachment_socket,unreal.AttachmentRule.KEEP_WORLD,unreal.AttachmentRule.KEEP_WORLD,unreal.AttachmentRule.KEEP_WORLD,False):
        raise RuntimeError('Inherited actor root attachment failed')
inherited_child=child('Inherited Skeletal Socket Child',inherited.get_components_by_class(unreal.SkeletalMeshComponent)[0],'SkeletalProbeSocket')
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
if not unreal.EditorLoadingAndSavingUtils.save_map(world,'/Game/SkeletalSocketMap'): raise RuntimeError('Source map save failed')
reference={actor.get_actor_label():list((actor.get_actor_location().x,actor.get_actor_location().y,actor.get_actor_location().z)) for actor in (parent,socket_child,bone_child,inherited,inherited_child)}
if intermediary is not None: reference[intermediary.get_actor_label()]=list((intermediary.get_actor_location().x,intermediary.get_actor_location().y,intermediary.get_actor_location().z))
with open(os.path.join(project,'skeletal-socket-reference.json'),'w') as file: json.dump({'bone':bone,'actors':reference,'inheritedAnimation':inherited_animation,'skeletonSocket':skeleton_socket,'attachmentChain':attachment_chain,'intermediarySocket':intermediary_socket,'savedProfile':os.environ.get('UNREAL_FIXTURE_ANIMATION_POSITION') is not None,'composite':os.environ.get('UNREAL_FIXTURE_COMPOSITE')=='1'},file)
if not levels.new_level('/Game/SkeletalSocketHost'): raise RuntimeError('Host creation failed')
for label,x in [('Skeletal Instance One',100),('Skeletal Instance Two',1000)]:
    actor=actors.spawn_actor_from_class(unreal.LevelInstance,unreal.Vector(x,0,0))
    actor.set_actor_label(label); actor.set_editor_property('world_asset',unreal.load_asset('/Game/SkeletalSocketMap'))
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
if not unreal.EditorLoadingAndSavingUtils.save_map(world,'/Game/SkeletalSocketHost'): raise RuntimeError('Host save failed')

