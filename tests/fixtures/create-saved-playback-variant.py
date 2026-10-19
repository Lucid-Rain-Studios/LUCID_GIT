"""Edit only an owned fixture copy, preserving actor IDs and animation payloads."""
import os,unreal
if '.blueprint-build' not in os.path.abspath(unreal.Paths.project_dir()).replace('\\','/').split('/'):
    raise RuntimeError('Owned fixture project required')
levels=unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
if not levels.load_level('/Game/SkeletalSocketMap'):raise RuntimeError('Fixture source map unavailable')
for actor in unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors():
    for component in actor.get_components_by_class(unreal.SkeletalMeshComponent):
        sequence=component.get_editor_property('animation_data').get_editor_property('anim_to_play')
        if sequence is None:continue
        component.override_animation_data(sequence,False,False,.75,-1)
        component.set_position(.75,False)
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
if not unreal.EditorLoadingAndSavingUtils.save_map(world,'/Game/SkeletalSocketMap'):raise RuntimeError('Fixture variant save failed')
