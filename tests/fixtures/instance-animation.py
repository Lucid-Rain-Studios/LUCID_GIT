"""Exact single-sequence profile and notify-free initialization guards."""
import sys,math
from types import SimpleNamespace
class Sequence:
    def __init__(self,skeleton): self.skeleton=skeleton
    def get_play_length(self):return 1
class Source:
    def __init__(self):
        self.mode=1
        self.mesh=SimpleNamespace(skeleton='CapturedSkeleton')
        self.animation_data=SimpleNamespace(anim_to_play=Sequence('CapturedSkeleton'),saved_position=0,saved_play_rate=1,saved_looping=False,saved_playing=False)
    def get_animation_mode(self): return self.mode
    def get_skeletal_mesh_asset(self): return self.mesh
class Target:
    def __init__(self): self.calls=[]
    def override_animation_data(self,*args): self.calls.append(('override',args))
    def set_position(self,*args): self.calls.append(('position',args))
class Composite(Sequence): pass
unreal=SimpleNamespace(AnimSequence=Sequence,AnimComposite=Composite,AnimationMode=SimpleNamespace(ANIMATION_SINGLE_NODE=1))
result={'diagnostics':[]}
def prop(obj,key): return getattr(obj,key,None)
exec(sys.stdin.read())
source,target=Source(),Target()
assert copy_instance_animation(source,target)
assert target.calls==[('override',(source.animation_data.anim_to_play,False,False,0,1)),('position',(0,False))]
for edit in [lambda s:setattr(s,'mode',2),lambda s:setattr(s.animation_data,'anim_to_play',object()),
             lambda s:setattr(s.animation_data.anim_to_play,'skeleton','Other'),lambda s:setattr(s.mesh,'skeleton',None),
             lambda s:setattr(s.animation_data,'saved_position',float('nan')),lambda s:setattr(s.animation_data,'saved_play_rate',True),
             lambda s:setattr(s.animation_data,'saved_looping',None),lambda s:setattr(s.animation_data,'saved_playing',None)]:
    source,target=Source(),Target();edit(source)
    assert not copy_instance_animation(source,target) and target.calls==[]
baked=Sequence('CapturedSkeleton')
calls=[]
def bake_saved_animation(*args): calls.append(args);return baked
for position,rate,looping in ((.5,2,False),(.75,-1,False),(.25,0,False),(.25,2,True)):
    source,target=Source(),Target();source.animation_data.saved_position=position;source.animation_data.saved_play_rate=rate;source.animation_data.saved_looping=looping
    assert copy_instance_animation(source,target) and target.calls==[('override',(source.animation_data.anim_to_play,looping,False,position,rate)),('position',(position,False))]
assert calls==[]
source,target=Source(),Target();source.animation_data.anim_to_play=Composite('CapturedSkeleton')
assert copy_instance_animation(source,target) and calls[-1]==(source.animation_data.anim_to_play,source.mesh,0,1,False)
print('{"compatibleSequence":true,"notifyFree":true,"unsupportedProfiles":true}')
