// Build-only read overlay. The pinned upstream checkout stays clean.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'third_party/UAssetAPI/UAssetAPI/PropertyTypes/Objects/TextPropertyData.cs'), 'utf8').replace(/\r\n/g, '\n')
if (crypto.createHash('sha256').update(source).digest('hex') !== 'c3a6bfa18455b18404cc6631cbfff0bb91d0751b42e64a8372c75fd398c68e0f') throw new Error('Pinned TextPropertyData source changed; reader overlay requires review.')
const original = '                    CultureInvariantString = reader.ReadFString(); // SourceString\n                    break;'
if (source.split(original).length !== 2) throw new Error('Text reader overlay anchor is ambiguous.')
const patched = source.replace(original, '                    CultureInvariantString = reader.ReadFString(); // SourceString\n                    // Lucid Git read overlay: UE5.8 editor localization developer notes.\n                    if (!reader.Asset.IsFilterEditorOnly && (int)reader.Asset.GetCustomVersion<FFortniteMainBranchObjectVersion>() >= 260) reader.ReadFString();\n                    break;')
const file = path.join(root, '.blueprint-build/UAssetAPI/TextPropertyData.Reader.cs')
fs.mkdirSync(path.dirname(file), { recursive: true })
if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== patched) fs.writeFileSync(file, patched)
