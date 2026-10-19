"""Controlled checks for saved-field correction at the engine boundary."""
import sys
from types import SimpleNamespace

class Component:
    def __init__(self, parent='Parent', socket='Socket'):
        self.parent, self.socket, self.calls = parent, socket, []
    def get_attach_parent(self):
        return SimpleNamespace(get_path_name=lambda: self.parent) if self.parent else None
    def get_attach_socket_name(self): return self.socket
    def set_relative_location(self, value, *args): self.calls.append(('location', value))
    def set_relative_rotation(self, value, *args): self.calls.append(('rotation', value))
    def set_relative_scale3d(self, value): self.calls.append(('scale', value))

component = Component()
unreal = SimpleNamespace(SceneComponent=Component, load_object=lambda *args: component,
                         Vector=lambda *values: values, Rotator=lambda **values: values)
exec(sys.stdin.read())
saved = {'path':'Child', 'parent':'Parent', 'socket':'Socket', 'location':[5,0,0]}
request = {'components':[saved]}
assert restore_saved_attachments() == []
assert component.calls == [('location',(5,0,0))]
component.calls = []
request = {'components':[{key:value for key,value in saved.items() if key != 'location'}]}
assert restore_saved_attachments() == [] and component.calls == []
for parent, socket in [('Wrong','Socket'), ('Parent','Wrong'), (None,'Socket')]:
    component = Component(parent, socket)
    request = {'components':[saved]}
    assert 'does not match' in restore_saved_attachments()[0] and component.calls == []
component = None
assert 'unavailable' in restore_saved_attachments()[0]
request = {'components':[], 'componentsComplete':False}
assert 'truncated' in restore_saved_attachments()[0]
class World:
    def __init__(self, path): self.path=path
    def get_path_name(self): return self.path
source='/Game/Source.Source'
request={'components':[{'path':source+':PersistentLevel.Child','parent':source+':PersistentLevel.Parent','socket':'Socket','location':[5,0,0]},
                       {'path':'/Game/Other.Other:PersistentLevel.Child','parent':'Unused','socket':'Socket','location':[9,0,0]}]}
contexts={World('/Game/LGI_One.Source'):{'source':source},World('/Game/LGI_Two.Source'):{'source':source}}
loaded={}
def load(_,path):
    assert path.startswith('/Game/LGI_')
    value=Component(path.replace('.Child','.Parent'))
    loaded[path]=value
    return value
unreal.load_object=load
assert restore_saved_attachments(contexts)==[]
assert len(loaded)==2 and all(value.calls==[('location',(5,0,0))] for value in loaded.values())
# External parents stay external; an instance-local parent must never be guessed.
request['components'][0]['parent']='ForeignParent'
assert all('does not match' in message for message in restore_saved_attachments(contexts))
request={'components':[dict(request['components'][0],path=source+':PersistentLevel.Child_'+str(index)) for index in range(10000)]}
unreal.load_object=lambda *args: None
assert 'Expanded attachment correction limit reached' in restore_saved_attachments(contexts)[0]
print('{"explicitOnly":true,"parentSocketGuard":true,"missing":true,"truncated":true,"instanceRemap":true,"expansionBudget":true}')
