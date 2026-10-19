"""Link an owned socket fixture as a streaming dependency and two instances."""
import os, unreal
project=os.path.abspath(unreal.Paths.project_dir())
if '.blueprint-build' not in project.replace('\\','/').split('/'):
    raise RuntimeError('Isolated fixture project required')
if os.path.exists(os.path.join(project,'Content','SocketHost.umap')):
    raise RuntimeError('Existing host fixture will not be overwritten')
if not os.path.exists(os.path.join(project,'socket-reference.json')):
    raise RuntimeError('Generate the owned socket fixture and authoring reference first')
levels=unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
actors=unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
if not levels.new_level('/Game/SocketHost'): raise RuntimeError('Host creation failed')
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
for label,x in [('Socket Instance One',100),('Socket Instance Two',1000)]:
    actor=actors.spawn_actor_from_class(unreal.LevelInstance,unreal.Vector(x,0,0))
    actor.set_actor_label(label)
    actor.set_editor_property('world_asset',unreal.load_asset('/Game/SocketMap'))
stream=unreal.EditorLevelUtils.add_level_to_world(world,'/Game/SocketMap',unreal.LevelStreamingAlwaysLoaded)
if stream is None: raise RuntimeError('Socket stream creation failed')
stream.set_editor_property('level_transform',unreal.Transform(location=unreal.Vector(2000,0,0)))
if not unreal.EditorLoadingAndSavingUtils.save_map(world,'/Game/SocketHost'):
    raise RuntimeError('Host save failed')
