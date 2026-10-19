export const ANIMATION_SCRIPT = String.raw`
import math
_preview_animation_cache = {}
_preview_animation_keys = 0
_preview_source_profiles = {}

def playback_record(source,target,actor):
    data=_preview_source_profiles.get(source)
    sequence=prop(prop(target,'animation_data'),'anim_to_play')
    if data is None or sequence is None: return None
    return {'actor':actor,'clip':sequence.get_name(),'position':data['position'],'rate':data['rate'],'looping':data['looping'],'playing':data['playing']}

def bake_saved_animation(sequence, mesh, position, rate, looping):
    global _preview_animation_keys
    length = sequence.get_play_length()
    if not math.isfinite(length) or not 0 < length <= 600 or not 0 <= position <= length or abs(rate) > 16:
        raise RuntimeError('Saved animation duration/position/rate exceeds the preview profile')
    key = (sequence,mesh,position,rate,looping)
    if key in _preview_animation_cache:
        if _preview_animation_cache[key] is None: raise RuntimeError('An earlier bake of this playback profile failed')
        return _preview_animation_cache[key]
    duration = length/abs(rate) if looping and rate else ((length-position)/rate if rate > 0 else position/-rate if rate < 0 else 0)
    frames = max(1,math.ceil(duration*30))
    if frames > 18000: raise RuntimeError('Saved animation frame budget exceeded (18000)')
    options = unreal.AnimPoseEvaluationOptions()
    options.set_editor_property('optional_skeletal_mesh',mesh)
    options.set_editor_property('evaluate_curves',False)
    times = []
    for frame in range(frames+1):
        time = position + min(frame/30,duration)*rate
        times.append(time % length if looping else max(0,min(length,time)))
    pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(sequence,times[0],options)
    bones = unreal.AnimPoseExtensions.get_bone_names(pose)
    keys = len(bones)*(frames+1)
    if not bones or len(bones)>256 or _preview_animation_keys+keys>1000000:
        raise RuntimeError('Saved animation bone/key budget exceeded (256/1000000)')
    _preview_animation_keys += keys
    _preview_animation_cache[key] = None
    tracks = {bone:[] for bone in bones}
    for time in times:
        pose = unreal.AnimPoseExtensions.get_anim_pose_at_time(sequence,time,options)
        for bone in bones: tracks[bone].append(unreal.AnimPoseExtensions.get_bone_pose(pose,bone,unreal.AnimPoseSpaces.LOCAL))
    factory = unreal.AnimSequenceFactory()
    factory.set_editor_property('target_skeleton',prop(mesh,'skeleton'))
    factory.set_editor_property('preview_skeletal_mesh',mesh)
    name = 'Saved_'+str(len(_preview_animation_cache))+'_'+sequence.get_name()+'_Start'+str(round(position,3)).replace('.','_')+'_Rate'+str(round(rate,3)).replace('.','_').replace('-','Reverse')
    baked = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name,'/Game/__LucidPreview',unreal.AnimSequence,factory)
    if baked is None: raise RuntimeError('Disposable animation creation failed')
    baked.set_editor_property('bone_compression_settings',unreal.load_asset('/Engine/Animation/DefaultAnimBoneCompressionSettings'))
    baked.set_editor_property('curve_compression_settings',unreal.load_asset('/Engine/Animation/DefaultAnimCurveCompressionSettings'))
    controller = prop(baked,'controller')
    controller.set_frame_rate(unreal.FrameRate(30,1))
    controller.set_number_of_frames(unreal.FrameNumber(frames))
    for bone,poses in tracks.items():
        if not controller.add_bone_curve(bone) or not controller.set_bone_track_keys(bone,[pose.translation for pose in poses],[pose.rotation for pose in poses],[pose.scale3d for pose in poses]):
            raise RuntimeError('Disposable animation keys rejected')
    _preview_animation_cache[key] = baked
    result['diagnostics'].append('Saved animation baked at 30 Hz (bone poses only; duration quantized to 1/30 s; curves/morphs/notifies/runtime logic excluded): '+sequence.get_path_name()+'; position='+str(position)+'; rate='+str(rate)+'; looping='+str(looping))
    return baked

def copy_instance_animation(source, target):
    data = prop(source,'animation_data')
    sequence = prop(data,'anim_to_play')
    if sequence is None or not isinstance(sequence,(unreal.AnimSequence,unreal.AnimComposite)): return False
    if source.get_animation_mode() != unreal.AnimationMode.ANIMATION_SINGLE_NODE: return False
    skeleton = prop(source.get_skeletal_mesh_asset(),'skeleton')
    if skeleton is None or prop(sequence,'skeleton') != skeleton: return False
    position, rate = prop(data,'saved_position'), prop(data,'saved_play_rate')
    looping, playing = prop(data,'saved_looping'), prop(data,'saved_playing')
    if any(isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) for value in (position,rate)) or not isinstance(looping,bool) or not isinstance(playing,bool): return False
    if position<0 or position>sequence.get_play_length() or abs(rate)>16: return False
    if isinstance(sequence,unreal.AnimComposite):
        try: sequence = bake_saved_animation(sequence,source.get_skeletal_mesh_asset(),0,1,False)
        except Exception as error:
            result['diagnostics'].append('Saved animation baking unavailable: '+str(error)); return False
    _preview_source_profiles.setdefault(source,{'position':position,'rate':rate,'looping':looping,'playing':playing})
    target.override_animation_data(sequence,looping,playing,position,rate)
    target.set_position(position,False) # Never dispatch animation notifies during capture.
    return True
`
