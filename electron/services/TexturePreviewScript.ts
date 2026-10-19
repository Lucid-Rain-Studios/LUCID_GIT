// Runs only in the isolated revision project. Keep the image embedded in the
// validated scene payload so the renderer never receives arbitrary file URLs.
export const TEXTURE_PREVIEW_SCRIPT = String.raw`
def export_texture_preview(texture):
    import struct
    if not isinstance(texture, unreal.Texture2D):
        raise RuntimeError('Only Texture2D source images are supported; cube, array, volume and render-target textures are unavailable.')
    filename = os.path.join(base, 'texture.png')
    task = unreal.AssetExportTask()
    task.object = texture
    task.filename = filename
    task.exporter = unreal.TextureExporterPNG()
    task.automated = True
    task.prompt = False
    task.replace_identical = True
    if not unreal.Exporter.run_asset_export_task(task):
        raise RuntimeError('Texture source image export failed; source data may be unavailable.')
    if os.path.getsize(filename) > 60 * 1024 * 1024:
        raise RuntimeError('Texture source PNG exceeds the 60 MB preview budget.')
    with open(filename, 'rb') as stream: image = stream.read()
    if image[:8] != b'\x89PNG\r\n\x1a\n' or len(image) < 24:
        raise RuntimeError('Texture exporter did not produce a PNG image.')
    width, height = struct.unpack('>II', image[16:24])
    if min(width,height) < 1 or max(width,height) > 4096 or width * height > 32000000:
        raise RuntimeError('Texture source image exceeds the dimension/pixel preview budget.')
    x, y = width / max(width,height), height / max(width,height)
    positions = struct.pack('<12f', -x,-y,0, x,-y,0, x,y,0, -x,y,0)
    uv = struct.pack('<8f', 0,1, 1,1, 1,0, 0,0)
    indices = struct.pack('<6H', 0,1,2, 0,2,3)
    binary = positions + uv + indices + image
    document = {
        'asset': {'version':'2.0'}, 'scene':0, 'scenes':[{'nodes':[0]}],
        'nodes':[{'name':texture.get_name(), 'mesh':0}],
        'meshes':[{'primitives':[{'attributes':{'POSITION':0,'TEXCOORD_0':1},'indices':2,'material':0}]}],
        'extensionsUsed':['KHR_materials_unlit'],
        'materials':[{'name':texture.get_name(),'doubleSided':True,'alphaMode':'BLEND','pbrMetallicRoughness':{'baseColorTexture':{'index':0}},'extensions':{'KHR_materials_unlit':{}}}],
        'textures':[{'source':0,'sampler':0}], 'samplers':[{'magFilter':9728,'minFilter':9728,'wrapS':33071,'wrapT':33071}],
        'images':[{'mimeType':'image/png','bufferView':3}],
        'buffers':[{'byteLength':len(binary)}],
        'bufferViews':[{'buffer':0,'byteOffset':0,'byteLength':48},{'buffer':0,'byteOffset':48,'byteLength':32},{'buffer':0,'byteOffset':80,'byteLength':12},{'buffer':0,'byteOffset':92,'byteLength':len(image)}],
        'accessors':[{'bufferView':0,'componentType':5126,'count':4,'type':'VEC3','min':[-x,-y,0],'max':[x,y,0]},{'bufferView':1,'componentType':5126,'count':4,'type':'VEC2'},{'bufferView':2,'componentType':5123,'count':6,'type':'SCALAR'}]
    }
    metadata = json.dumps(document, separators=(',',':')).encode('utf-8')
    metadata += b' ' * (-len(metadata) % 4)
    binary += b'\x00' * (-len(binary) % 4)
    with open(os.path.join(base,'scene.glb'), 'wb') as stream:
        stream.write(struct.pack('<III',0x46546c67,2,28+len(metadata)+len(binary)))
        stream.write(struct.pack('<II',len(metadata),0x4e4f534a)); stream.write(metadata)
        stream.write(struct.pack('<II',len(binary),0x004e4942)); stream.write(binary)
    result['diagnostics'].append('Texture2D source image: ' + str(width) + ' x ' + str(height) + ' pixels, unlit with alpha and nearest filtering. Source PNG is an 8-bit display preview; HDR precision, compression, mipmaps and runtime streaming are not reproduced.')
`
