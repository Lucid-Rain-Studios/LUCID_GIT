// Shared by LFS suggestions/size checks and renderer diff routing.
export const BINARY_EXTENSIONS = new Set([
  'uasset', 'umap', 'udk', 'ubulk', 'upk', 'pak', 'uexp', 'ucas',
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tga', 'psd', 'tiff', 'tif', 'ico', 'dds', 'exr', 'hdr', 'xcf',
  'wav', 'mp3', 'ogg', 'flac', 'aif', 'aiff', 'wem',
  'ttf', 'otf', 'woff', 'woff2',
  'exe', 'dll', 'so', 'dylib', 'lib', 'pdb', 'a',
  'zip', '7z', 'rar', 'tar', 'gz', 'bz2',
  'pdf', 'doc', 'docx', 'xls', 'xlsx',
  'mp4', 'avi', 'mov', 'mkv', 'webm', 'wmv',
  'fbx', 'obj', 'dae', 'abc', 'ma', 'mb', 'blend', '3ds', 'max', 'ztl',
])
export function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(filePath.split('.').pop()?.toLowerCase() ?? '')
}
