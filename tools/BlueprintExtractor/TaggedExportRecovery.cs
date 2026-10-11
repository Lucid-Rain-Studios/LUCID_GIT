using UAssetAPI;
using UAssetAPI.ExportTypes;
using UAssetAPI.PropertyTypes.Objects;
using UAssetAPI.UnrealTypes;

// Modern tagged AnimGraph nodes can contain an unsupported editor array. Keep
// independent fields/pins using declared byte boundaries, never decode that payload.
static class TaggedExportRecovery {
    internal static void Apply(UAsset asset) {
        if (asset.HasUnversionedProperties || asset.ObjectVersionUE5 < ObjectVersionUE5.PROPERTY_TAG_COMPLETE_TYPE_NAME) return;
        for (var index = 0; index < asset.Exports.Count; index++) {
            if (asset.Exports[index] is not RawExport raw || raw.Data.Length > 16 * 1024 * 1024) continue;
            var classPath = GraphExtractor.ObjectPath(asset, raw.ClassIndex.Index);
            if (!classPath.StartsWith("/Script/AnimGraph.AnimGraphNode_")) continue;
            try {
                var normal = raw.ConvertToChildExport<NormalExport>();
                using var stream = new MemoryStream(raw.Data);
                using var reader = new AssetBinaryReader(stream, asset);
                ReadFields(reader, normal);
                normal.Extras = raw.Data[(int)stream.Position..];
                asset.Exports[index] = normal;
            } catch { /* The original complete raw export remains the fallback. */ }
        }
    }

    internal static void ReadFields(AssetBinaryReader reader, NormalExport normal) {
        var asset = reader.Asset;
        if (asset.HasUnversionedProperties || asset.ObjectVersionUE5 < ObjectVersionUE5.PROPERTY_TAG_COMPLETE_TYPE_NAME) throw new InvalidDataException("Unsupported tagged recovery profile.");
        if (asset.ObjectVersionUE5 > ObjectVersionUE5.DATA_RESOURCES && asset.ObjectVersionUE5 < ObjectVersionUE5.ASSETREGISTRY_PACKAGEBUILDDEPENDENCIES && !normal.ObjectFlags.HasFlag(EObjectFlags.RF_ClassDefaultObject)) {
            var prefix = reader.ReadInt32();
            normal.HasLeadingFourNullBytes = prefix == 0;
            if (prefix != 0) reader.BaseStream.Position -= 4;
        }
        if (asset.ObjectVersionUE5 >= ObjectVersionUE5.PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION) {
            var control = reader.ReadByte();
            if (control != 0) throw new InvalidDataException("Unsupported class serialization control.");
            normal.SerializationControl = EClassSerializationControlExtension.NoExtension;
        }
        normal.Data = [];
        var parent = normal.GetClassTypeForAncestry(asset, out var module);
        for (var count = 0; count < 4096; count++) {
            var start = reader.BaseStream.Position;
            var name = reader.ReadFName();
            if (name.ToString() == "None") {
                normal.ObjectGuid = null;
                if (!normal.ObjectFlags.HasFlag(EObjectFlags.RF_ClassDefaultObject)) {
                    var hasGuid = reader.ReadInt32();
                    if (hasGuid is not 0 and not 1) throw new InvalidDataException("Invalid export GUID flag.");
                    if (hasGuid == 1) normal.ObjectGuid = reader.ReadGuid();
                }
                return;
            }
            var typeNodes = new List<FPropertyTypeNameNode>();
            var expected = 1;
            for (var nodeIndex = 0; nodeIndex < expected; nodeIndex++) {
                var node = new FPropertyTypeNameNode(reader);
                if (node.InnerCount < 0 || node.InnerCount > 64 - expected) throw new InvalidDataException("Property type exceeds recovery budget.");
                expected += node.InnerCount;
                typeNodes.Add(node);
            }
            var type = new FPropertyTypeName(typeNodes, true);
            var length = reader.ReadInt32();
            var flags = (EPropertyTagFlags)reader.ReadByte();
            var arrayIndex = flags.HasFlag(EPropertyTagFlags.HasArrayIndex) ? reader.ReadInt32() : 0;
            if (length < 0 || arrayIndex < 0) throw new InvalidDataException("Invalid property bounds.");
            var raw = new UnknownPropertyData(name) { PropertyTypeName = type, PropertyTagFlags = flags, ArrayIndex = arrayIndex };
            raw.SetSerializingPropertyType(new FString(type.GetName().ToString()));
            raw.Read(reader, true, 0); // Consume GUID/extensions exactly as the primary reader.
            var body = reader.BaseStream.Position;
            if (length > reader.BaseStream.Length - body) throw new InvalidDataException("Property exceeds export boundary.");
            var end = body + length;
            PropertyData property;
            try {
                reader.BaseStream.Position = start;
                property = MainSerializer.Read(reader, null, parent, module, null, true) ?? throw new InvalidDataException("Unexpected field terminator.");
                if (reader.BaseStream.Position != end) throw new InvalidDataException("Property did not consume its declared boundary.");
            } catch {
                // Only a declared struct array may recover. Other failures retain the
                // original raw export; corrupt name/header/pin data is never guessed.
                if (type.GetName().ToString() != "ArrayProperty" || type.GetParameter(0).GetName().ToString() != "StructProperty") throw;
                reader.BaseStream.Position = body;
                raw.Value = reader.ReadBytes(length);
                if (raw.Value.Length != length) throw new EndOfStreamException();
                property = raw;
            }
            normal.Data.Add(property);
        }
        throw new InvalidDataException("Tagged recovery exceeds field budget.");
    }
}
