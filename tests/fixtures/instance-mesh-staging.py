"""Bounded staging checks against the exact generated exporter block."""
import sys, textwrap, math
from types import SimpleNamespace

class Mesh:
    static_mesh = 'CapturedMesh'
    def get_path_name(self): return 'Component'
    def get_num_materials(self): return 1
    def get_material(self, index): return 'CapturedMaterial'
    def get_world_transform(self): return 'ComponentWorld'
    def get_attach_parent(self): return None

class Instanced(Mesh):
    def __init__(self, count): self.count, self.queries = count, []
    def get_instance_count(self): return self.count
    def get_instance_transform(self, index, world_space=False):
        assert world_space
        self.queries.append(index)
        return 'World_'+str(index)

class Skeletal(Mesh):
    def get_skeletal_mesh_asset(self): return 'CapturedSkeletalMesh'

class Actor:
    def __init__(self, component): self.component = component
    def get_components_by_class(self, cls): return [] if cls is Light else self.component if isinstance(self.component,list) else [self.component]
    def get_path_name(self): return 'Actor'
    def get_actor_label(self): return 'Alias'

class Light: pass
class Clone:
    def __init__(self):
        self.static_mesh_component = SimpleNamespace(set_static_mesh=lambda mesh: setattr(self,'mesh',mesh), set_material=lambda *args: None,
                                                    set_mobility=lambda value: None,set_relative_transform=lambda value,*args: setattr(self,'relative',value))
        self.skeletal_mesh_component = SimpleNamespace(set_skeletal_mesh_asset=lambda mesh: setattr(self,'mesh',mesh), set_material=lambda *args: None,
                                                       set_mobility=lambda value: None,set_relative_transform=lambda value,*args: setattr(self,'relative',value))
    def set_actor_transform(self, value, *args): self.transform = value
    def set_actor_label(self, value, *args): self.label = value
    def attach_to_component(self, target, socket, *args): self.attachment=(target,socket); return True

spawned = []
class SkeletalClone(Clone): pass
def spawn(*args):
    clone = args[0](); spawned.append(clone); return clone
unreal = SimpleNamespace(EditorActorSubsystem=object, MeshComponent=Mesh, LightComponent=Light,
                         StaticMeshComponent=Mesh, InstancedStaticMeshComponent=Instanced,
                         SkeletalMeshComponent=Skeletal, SkeletalMeshActor=SkeletalClone,
                         StaticMeshActor=Clone, Vector=lambda *args: args,
                         ComponentMobility=SimpleNamespace(MOVABLE=1),AttachmentRule=SimpleNamespace(KEEP_WORLD=1),
                         RelativeTransformSpace=SimpleNamespace(RTS_COMPONENT=1),
                         get_editor_subsystem=lambda cls: SimpleNamespace(spawn_actor_from_class=spawn))
def prop(obj, key): return getattr(obj,key,None)
def copy_instance_animation(source,target): return False
script = textwrap.dedent(sys.stdin.read())
def run(component, extra=0):
    global actors, scoped, instance_contexts, result
    spawned.clear()
    actor = Actor(component)
    actors = {actor} | {object() for _ in range(extra)}
    scoped = [(actor,'World')]
    instance_contexts = {'World':{'identity':'Captured'}}
    result = {'diagnostics':[]}
    exec(script,globals())

component = Instanced(2); run(component)
assert component.queries == [0,1]
assert [clone.transform for clone in spawned] == ['World_0','World_1']
assert [clone.label for clone in spawned] == ['Alias__part_0_instance_0','Alias__part_0_instance_1']
for count,extra in [(10001,0),(2,9999),(-1,0)]:
    component = Instanced(count); run(component,extra)
    assert not spawned and not component.queries and 'limit reached' in result['diagnostics'][0]
run(Instanced(0)); assert not spawned
run(Mesh()); assert len(spawned)==1 and spawned[0].transform=='ComponentWorld' and spawned[0].label=='Alias'
component=Instanced(2); component.static_mesh=None; run(component); assert not spawned and not component.queries
component=Instanced(2); component.num_custom_data_floats=1; run(component)
assert any('custom material data' in message for message in result['diagnostics'])
run(Skeletal()); assert len(spawned)==1 and spawned[0].transform=='ComponentWorld'
assert isinstance(spawned[0],SkeletalClone) and spawned[0].mesh=='CapturedSkeletalMesh'
assert 'reference pose' in result['diagnostics'][0]
component=Skeletal(); component.get_skeletal_mesh_asset=lambda: None; run(component); assert not spawned
parent_component,child_component=Skeletal(),Mesh()
child_component.get_attach_parent=lambda: parent_component; child_component.get_attach_socket_name=lambda: 'ProbeSocket'; child_component.get_relative_transform=lambda: 'SavedRelative'
child_component.absolute_location=child_component.absolute_rotation=child_component.absolute_scale=False
run([parent_component,child_component]); assert spawned[1].attachment==(spawned[0].skeletal_mesh_component,'ProbeSocket') and spawned[1].relative=='SavedRelative'
child_component.absolute_location=True; run([parent_component,child_component]); assert not hasattr(spawned[1],'attachment') and any('absolute flags' in message for message in result['diagnostics'])
child_component.absolute_location=False;parent_component.animation_data=SimpleNamespace(anim_to_play=object())
run([parent_component,child_component]); assert not hasattr(spawned[1],'attachment') and any('playback profile' in message for message in result['diagnostics'])
parent_component.animation_data=None
class Transform:
    def __init__(self, value, scale=(1,1,1)): self.value=value; self.scale3d=SimpleNamespace(x=scale[0],y=scale[1],z=scale[2])
    def __mul__(self, other): return Transform(self.value+'*'+other.value)
middle=Mesh();middle.absolute_location=middle.absolute_rotation=middle.absolute_scale=False
middle.get_attach_parent=lambda: parent_component;middle.get_attach_socket_name=lambda:'AncestorSocket';middle.get_relative_transform=lambda:Transform('Middle')
child_component.get_attach_parent=lambda:middle;child_component.get_relative_transform=lambda:Transform('Child')
middle.does_socket_exist=lambda name:False
run([parent_component,child_component]);assert not hasattr(spawned[1],'attachment') and any('intermediary socket' in message for message in result['diagnostics'])
middle.does_socket_exist=lambda name: name=='ProbeSocket'
def socket_transform(name,space):
    assert name=='ProbeSocket' and space==unreal.RelativeTransformSpace.RTS_COMPONENT
    return Transform('Socket')
middle.get_socket_transform=socket_transform
run([parent_component,child_component]);assert spawned[1].relative.value=='Child*Socket*Middle' and spawned[1].attachment[1]=='AncestorSocket'
middle.get_socket_transform=lambda *args:Transform('Socket',(1,2,1))
run([parent_component,child_component]);assert not hasattr(spawned[1],'attachment') and any('intermediary scale' in message for message in result['diagnostics'])
middle.get_socket_transform=socket_transform
child_component.get_attach_socket_name=lambda:'None'
run([parent_component,child_component]);assert spawned[1].attachment[1]=='AncestorSocket' and spawned[1].relative.value=='Child*Middle'
middle.absolute_scale=True;run([parent_component,child_component]);assert not hasattr(spawned[1],'attachment') and any('absolute flags' in message for message in result['diagnostics']);middle.absolute_scale=False
for scale in ((1,2,1),(0,0,0),(-1,-1,-1),(float('nan'),1,1)):
    middle.get_relative_transform=lambda:Transform('Middle',scale)
    run([parent_component,child_component]);assert not hasattr(spawned[1],'attachment') and any('intermediary scale' in message for message in result['diagnostics'])
middle.get_relative_transform=lambda:Transform('Middle');middle.get_attach_parent=lambda:child_component
run([parent_component,child_component]);assert not hasattr(spawned[1],'attachment') and any('limit/cycle' in message for message in result['diagnostics'])
deep=[Mesh() for _ in range(64)]
for index,node in enumerate(deep): node.get_attach_parent=lambda index=index:deep[index+1] if index+1<len(deep) else parent_component
child_component.get_attach_parent=lambda:deep[0]
run([parent_component,child_component]);assert not hasattr(spawned[1],'attachment') and any('limit/cycle' in message for message in result['diagnostics'])
print('{"worldTransforms":true,"preflightBudget":true,"zeroAndMissing":true,"customDataDiagnostic":true,"skeletalReferencePose":true,"skeletalAttachments":true}')
