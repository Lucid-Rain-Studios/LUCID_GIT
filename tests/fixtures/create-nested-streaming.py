"""Run with UnrealEditor-Cmd in an empty .blueprint-build fixture project.

Enable PythonScriptPlugin in that project; never run against a user project.
Use Content/FixtureMap.umap as UNREAL_SCENE_NESTED for native-scene.spec.js.
"""
import os
import json
import unreal

project = os.path.abspath(unreal.Paths.project_dir())
if '.blueprint-build' not in project.replace('\\', '/').split('/'):
    raise RuntimeError('Fixture generation requires an isolated .blueprint-build project.')
content = os.path.join(project, 'Content')
if os.path.isdir(content) and any(name.endswith(('.umap', '.uasset')) for _, _, names in os.walk(content) for name in names):
    raise RuntimeError('Fixture generation requires empty Content; existing assets will not be overwritten.')

levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
def world(): return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
def create(package):
    if not levels.new_level(package): raise RuntimeError('Level creation failed: ' + package)
def save(package):
    if not unreal.EditorLoadingAndSavingUtils.save_map(world(), package): raise RuntimeError('Level save failed: ' + package)
def mesh(label, position, shape='Cube'):
    actor = actors.spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(*position))
    actor.set_actor_label(label)
    actor.static_mesh_component.set_static_mesh(unreal.load_asset('/Engine/BasicShapes/' + shape))
    return actor
def link(package, offset=None, scale=(1,1,1)):
    stream = unreal.EditorLevelUtils.add_level_to_world(world(), package, unreal.LevelStreamingAlwaysLoaded)
    if stream is None:
        raise RuntimeError('Sublevel linking failed: ' + package)
    if offset is not None:
        stream.set_editor_property('level_transform', unreal.Transform(location=unreal.Vector(*offset), rotation=unreal.Rotator(yaw=90), scale=unreal.Vector(*scale)))

offsets = os.environ.get('UNREAL_FIXTURE_STREAMING_OFFSETS') == '1'
profile = os.environ.get('UNREAL_FIXTURE_STREAMING_SCALE', '')
outer_scale = (2,3,1.5) if profile == 'nonuniform' else (2,2,2) if profile == 'uniform' else (1,1,1)
inner_scale = (.5,.5,.5) if profile else (1,1,1)
with open(os.path.join(project,'streaming-profile.json'),'w',encoding='utf-8') as out:
    json.dump({'outerScale':outer_scale,'innerScale':inner_scale},out)
create('/Game/NestedLeaf')
leaf = mesh('Captured Nested Actor', [2000,3000,400])
if offsets:
    child = mesh('Captured Nested Child', [0,0,0], 'Sphere')
    child.attach_to_actor(leaf, '', unreal.AttachmentRule.KEEP_RELATIVE, unreal.AttachmentRule.KEEP_RELATIVE, unreal.AttachmentRule.KEEP_RELATIVE, False)
    child.set_actor_relative_location(unreal.Vector(10,0,0),False,False)
save('/Game/NestedLeaf')
create('/Game/SubFixture')
mesh('Captured Sublevel Actor', [1000,0,0])
link('/Game/NestedLeaf', [100,200,30] if offsets else None, inner_scale)
save('/Game/SubFixture')
create('/Game/FixtureMap')
parent = mesh('Captured Parent', [100,200,30])
parent.set_actor_rotation(unreal.Rotator(0,90,0), False)
parent.set_actor_scale3d(unreal.Vector(2,2,2))
child = mesh('Captured Child', [0,0,0], 'Sphere')
child.attach_to_actor(parent, '', unreal.AttachmentRule.KEEP_RELATIVE, unreal.AttachmentRule.KEEP_RELATIVE, unreal.AttachmentRule.KEEP_RELATIVE, False)
child.set_actor_relative_location(unreal.Vector(10,0,0),False,False)
link('/Game/SubFixture', [500,-200,50] if offsets else None, outer_scale)
save('/Game/FixtureMap')
print('Nested streaming fixture ready: ' + project)
