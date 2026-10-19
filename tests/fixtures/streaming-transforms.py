"""Controlled ambiguity checks for the shipped streaming transform resolver."""
import json
import sys
from types import SimpleNamespace

class World:
    def __init__(self, name): self.name = name
    def get_path_name(self): return self.name
class Level:
    def __init__(self, owner): self.owner = owner
    def get_outer(self): return self.owner
class Stream:
    def __init__(self, owner, target, offset=(0,0,0)):
        self.owner, self.level, self.offset = owner, Level(target), offset
    def get_outer(self): return self.owner
    def get_loaded_level(self): return self.level
    def get_editor_property(self, name):
        if self.offset is None: raise RuntimeError('transform unavailable')
        return self.offset

root, sub, leaf, foreign = [World(name) for name in ['root','sub','leaf','foreign']]
streams = [Stream(root,sub,(500,-200,50)), Stream(sub,leaf,(100,200,30)), Stream(foreign,leaf,(900,0,0))]
unreal = SimpleNamespace(Transform=lambda **kwargs: (0,0,0),Vector=lambda *values: values,Rotator=lambda *values: values,
    LevelStreaming=Stream,ObjectIterator=lambda cls: iter(list(streams)),MathLibrary=SimpleNamespace(
        compose_transforms=lambda a,b: tuple(x+y for x,y in zip(a,b)), nearly_equal_transform_transform=lambda a,b: a==b))
exec(sys.stdin.read(),globals())
parents, errors, frames = streaming_parent_transforms(root,{root,sub,leaf})
assert not errors and parents[root] == parents[sub] == (0,0,0) and parents[leaf] == (500,-200,50)
streams.append(Stream(root,sub,(500,-200,50)))
assert not streaming_parent_transforms(root,{root,sub,leaf})[1]
streams.append(Stream(root,sub,(999,0,0)))
assert any('conflicting instance transforms' in error for error in streaming_parent_transforms(root,{root,sub,leaf})[1])
streams[:] = [Stream(root,sub,None)]
parents, errors, frames = streaming_parent_transforms(root,{root,sub})
assert sub not in parents and any('transform unavailable' in error for error in errors)
streams[:] = [Stream(root,sub),Stream(sub,root)]
assert not streaming_parent_transforms(root,{root,sub})[1]
streams[:] = [Stream(root,sub,(10,0,0)),Stream(sub,root)]
assert any('conflicting instance transforms' in error for error in streaming_parent_transforms(root,{root,sub})[1])
print(json.dumps({'ancestorOnly':True,'duplicate':True,'conflict':True,'missing':True,'cycle':True,'foreign':True}))
