import sys
from types import SimpleNamespace
class World:
    def __init__(self,name):self.name=name
    def get_path_name(self):return '/Game/'+self.name+'.'+self.name
class Actor:
    def __init__(self,world,source):self.world,self.source=world,source;self.actor_guid=SimpleNamespace(a=1,b=0,c=0,d=0)
    def get_outer(self):return self.world
    def get_path_name(self):return self.world.get_path_name()+':PersistentLevel.Instance'
    def get_world_asset(self):return self.source
    def get_actor_transform(self):return object()
    def is_loaded(self):return False
class Packed:pass
class Partition:pass
class Settings:pass
class Streaming:pass
root,branch,leaf=World('Root'),World('Branch'),World('Leaf')
calls=[]
unreal=SimpleNamespace(World=World,LevelInstance=Actor,PackedLevelActor=Packed,WorldPartition=Partition,WorldSettings=Settings,LevelStreaming=Streaming,LucidPreviewLibrary=SimpleNamespace(load_instance=lambda actor:calls.append(actor)))
def prop(obj,key):return getattr(obj,key,None)
exec(sys.stdin.read())
def run(counts,children,missing=False):
    global request
    nodes=[Actor(root,branch)]+[Actor(branch,leaf) for _ in range(children)]
    unreal.ObjectIterator=lambda cls:nodes if cls is Actor else []
    if missing:del unreal.LucidPreviewLibrary
    request={'actorCandidates':[{'path':world.get_path_name()+':PersistentLevel.Actor'+str(index)} for world,count in zip((root,branch,leaf),counts) for index in range(count)]}
    contexts,levels,errors=load_instances(root,{root},{},{})
    assert not calls and len(contexts)==1 and not levels
    return ' '.join(errors)
assert '10000 before loading' in run((9995,3,2),2)
assert '256' in run((1,258,2),257)
assert 'native instance GUID remapping' in run((1,3,2),2,True)
print('{"actors":true,"worlds":true,"missingBridge":true}')
