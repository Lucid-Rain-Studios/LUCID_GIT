"""Exercise the shipped traversal with a controlled engine-object boundary."""
import json
import sys
from types import SimpleNamespace

class World:
    def __init__(self, name): self.name = name
    def get_path_name(self): return self.name

class Level:
    def __init__(self, owner): self.owner = owner
    def get_outer(self): return self.owner
    def get_path_name(self): return str(self.owner)

class Stream:
    def __init__(self, owner, target, broken=False):
        self.owner, self.target, self.broken = owner, target, broken
        self.level, self.requests = None, []
    def get_outer(self): return self.owner
    def get_world_asset_package_f_name(self): return 'Missing' if self.target is None else self.target.name
    def set_editor_property(self, key, value):
        if self.broken: raise RuntimeError('request denied')
        self.requests.append((key, value))
    def get_loaded_level(self): return self.level

streams, flushed = [], []
def flush(world):
    flushed.append(world.name)
    for stream in list(streams):
        if stream.owner == world and stream.target is not None:
            stream.level = Level(stream.target)
    if world == root and not any(stream.owner == sub for stream in streams):
        # Engine objects for nested tables become visible only after root flush.
        streams.extend([Stream(sub, leaf), Stream(sub, leaf), Stream(leaf, root)])

unreal = SimpleNamespace(World=World, LevelStreaming=Stream,
    ObjectIterator=lambda cls: iter(list(streams)), GameplayStatics=SimpleNamespace(flush_level_streaming=flush))
exec(sys.stdin.read(), globals())
root, sub, leaf, unrelated = [World(name) for name in ['root', 'sub', 'leaf', 'unrelated']]
streams.extend([Stream(root, sub), Stream(unrelated, World('foreign'))])
worlds, levels, errors = load_streamed_worlds(root)
assert worlds == {root, sub, leaf} and not errors
assert flushed == ['root', 'sub', 'leaf'], flushed
assert all(len(stream.requests) == 2 for stream in streams if stream.owner != unrelated)
assert not streams[1].requests

streams[:] = [Stream(root, None), Stream(root, sub, broken=True)]
flushed.clear()
worlds, levels, errors = load_streamed_worlds(root)
assert any('Sublevel unavailable' in error for error in errors)
assert any('request failed' in error for error in errors)

streams[:] = [Stream(root, World('target' + str(i))) for i in range(257)]
worlds, levels, errors = load_streamed_worlds(root)
assert worlds == {root} and not levels and any('256-level budget' in error for error in errors)

streams[:] = [Stream(root, World('target' + str(i))) for i in range(256)]
worlds, levels, errors = load_streamed_worlds(root)
assert len(worlds) == 256 and any('256-world budget' in error for error in errors)

def failed_flush(world): raise RuntimeError('flush denied')
unreal.GameplayStatics.flush_level_streaming = failed_flush
streams[:] = [Stream(root, sub)]
worlds, levels, errors = load_streamed_worlds(root)
assert any('flush failed' in error for error in errors)
assert any('Sublevel unavailable' in error for error in errors)

streams[:] = [Stream(root, None)]
streams[0].level = Level(object())
unreal.GameplayStatics.flush_level_streaming = lambda world: None
worlds, levels, errors = load_streamed_worlds(root)
assert any('ownership unavailable' in error for error in errors)
print(json.dumps({'depth': 3, 'cycles': True, 'duplicateTargets': True, 'unrelatedWorld': True,
    'missing': True, 'requestFailure': True, 'flushFailure': True, 'invalidOwner': True, 'budget': 256}))
