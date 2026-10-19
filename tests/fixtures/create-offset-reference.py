"""Engine ground truth: load the leaf directly using composed streaming offsets."""
import json
import os
import unreal

project = os.path.abspath(unreal.Paths.project_dir())
if '.blueprint-build' not in project.replace('\\', '/').split('/'):
    raise RuntimeError('Reference generation requires an isolated fixture project.')
if os.path.exists(os.path.join(project, 'Content', 'OffsetReference.umap')):
    raise RuntimeError('Existing reference map will not be overwritten.')
levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
if not levels.new_level('/Game/OffsetReference'): raise RuntimeError('Reference map creation failed')
world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
profile_file = os.path.join(project,'streaming-profile.json')
profile = json.load(open(profile_file,encoding='utf-8')) if os.path.exists(profile_file) else {'innerScale':[1,1,1],'outerScale':[1,1,1]}
def offset(position, scale):
    return unreal.Transform(location=unreal.Vector(*position), rotation=unreal.Rotator(yaw=90), scale=unreal.Vector(*scale))
transform = unreal.MathLibrary.compose_transforms(offset([100,200,30],profile['innerScale']), offset([500,-200,50],profile['outerScale']))
stream = unreal.EditorLevelUtils.add_level_to_world_with_transform(world, '/Game/NestedLeaf', unreal.LevelStreamingAlwaysLoaded, transform)
if stream is None: raise RuntimeError('Reference streaming load failed')
positions = {}
transforms = {}
for actor in unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors():
    if actor.get_actor_label() in ('Captured Nested Actor', 'Captured Nested Child'):
        position = actor.get_actor_location()
        positions[actor.get_actor_label()] = [position.x,position.y,position.z]
        pose = actor.get_actor_transform()
        scale = actor.get_actor_scale3d()
        transforms[actor.get_actor_label()] = {'rotation':[pose.rotation.x,pose.rotation.y,pose.rotation.z,pose.rotation.w], 'scale':[scale.x,scale.y,scale.z]}
if 'Captured Nested Actor' not in positions: raise RuntimeError('Reference actor unavailable')
with open(os.path.join(project, 'offset-reference.json'), 'w', encoding='utf-8') as out:
    json.dump({'actors':positions,'transforms':transforms}, out)
print('OFFSET REFERENCE', positions)
