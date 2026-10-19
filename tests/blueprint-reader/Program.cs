using System.Reflection;
using System.Text;
using UAssetAPI;
using UAssetAPI.UnrealTypes;

var text = typeof(GraphExtractor).GetMethod("Text", BindingFlags.Static | BindingFlags.NonPublic)!;
void Verify(int version, bool named, bool truncated = false) {
    var asset = new UAsset(EngineVersion.VER_UE5_4);
    asset.CustomVersionContainer.First(v => v.FriendlyName == "FFortniteMainBranchObjectVersion").Version = version;
    using var stream = new MemoryStream();
    using (var writer = new AssetBinaryWriter(stream, Encoding.UTF8, true, asset)) {
        void Base(string value) {
            writer.Write((uint)8); writer.Write((sbyte)0);
            writer.Write(new FString("K2Node")); writer.Write(new FString("key")); writer.Write(new FString(value));
            if (version >= 260) writer.Write(new FString("Translator context"));
        }
        if (named) {
            writer.Write((uint)0); writer.Write((sbyte)1); Base("{target}");
            writer.Write(1); writer.Write(new FString("target")); writer.Write((byte)4); Base("Target");
        } else Base("Target");
        writer.Write(-1); // Next pin's SourceIndex must stay aligned.
    }
    if (truncated) stream.SetLength(stream.Length - 8);
    stream.Position = 0;
    using var reader = new AssetBinaryReader(stream, asset);
    try {
        var value = (string)text.Invoke(null, [reader, 0])!;
        if (truncated) throw new Exception("Truncated notes were accepted.");
        if (!value.Contains("Target") || reader.ReadInt32() != -1 || stream.Position != stream.Length) throw new Exception("Text shifted the following pin fields.");
    } catch (TargetInvocationException ex) when (truncated && ex.InnerException is EndOfStreamException) { }
}
Verify(259, false); Verify(260, false); Verify(270, false); Verify(260, true); Verify(260, false, true);
Console.WriteLine("5 localized-text alignment checks passed.");


var pinsMethod = typeof(GraphExtractor).GetMethod("Pins", BindingFlags.Static | BindingFlags.NonPublic)!;
void Cast(int version, byte[] extras, string? state, bool fails = false) {
    var asset = new UAsset(EngineVersion.VER_UE5_4);
    asset.CustomVersionContainer.First(v => v.FriendlyName == "FFortniteMainBranchObjectVersion").Version = version;
    asset.Imports = new();
    asset.Imports.Add(new UAssetAPI.Import { ObjectName = FName.DefineDummy(asset, "K2Node_DynamicCast") });
    var node = new UAssetAPI.ExportTypes.NormalExport { ClassIndex = new FPackageIndex(-1), Extras = extras };
    var props = new Newtonsoft.Json.Linq.JObject(); var pins = new Newtonsoft.Json.Linq.JArray();
    try {
        pinsMethod.Invoke(null, [asset, node, 1, pins, props]);
        if (fails || props.Value<string>("NativePureState") != state) throw new Exception("Cast tail was decoded incorrectly.");
    } catch (TargetInvocationException ex) when (fails && ex.InnerException is InvalidDataException or EndOfStreamException) { }
}
Cast(84, [0,0,0,0], null);
Cast(85, [0,0,0,0,0], "Pure");
Cast(260, [0,0,0,0,1], "Impure");
Cast(260, [0,0,0,0,2], "UseDefault");
Cast(260, [0,0,0,0,3], null, true);
Cast(260, [0,0,0,0], null, true);
Cast(260, [0,0,0,0,1,99], null, true);
// Fully decoded pins survive an unknown native suffix, while callers still mark
// that node incomplete and suppress claims that its logical data is unchanged.
var fixture = new UAsset(args[0], EngineVersion.UNKNOWN);
var original = fixture.Exports.OfType<UAssetAPI.ExportTypes.NormalExport>().First(n => n.ObjectName.ToString().StartsWith("K2Node_") && n.Extras?.Length > 4);
var position = fixture.Exports.IndexOf(original) + 1;
var decoded = new Newtonsoft.Json.Linq.JArray();
pinsMethod.Invoke(null, [fixture, original, position, decoded, new Newtonsoft.Json.Linq.JObject()]);
if (decoded.Count == 0) throw new Exception("Fixture has no pins.");
original.Extras = original.Extras.Concat(new byte[] { 99 }).ToArray();
var retained = new Newtonsoft.Json.Linq.JArray();
try { pinsMethod.Invoke(null, [fixture, original, position, retained, new Newtonsoft.Json.Linq.JObject()]); throw new Exception("Unknown suffix was accepted."); }
catch (TargetInvocationException ex) when (ex.InnerException is InvalidDataException) { }
if (retained.Count != decoded.Count) throw new Exception("Unknown suffix discarded decoded pins.");
Console.WriteLine("8 native cast/pin retention checks passed.");

// Package name-table indexes are storage details, not a Select type change.
var simplify = typeof(GraphExtractor).GetMethod("Simplify", BindingFlags.Static | BindingFlags.NonPublic)!;
(UAsset asset, Newtonsoft.Json.Linq.JObject property) TypeProperty(string category, bool padding) {
    var asset = new UAsset(EngineVersion.VER_UE5_4);
    asset.ClearNameIndexList(); asset.Exports = new(); asset.Imports = new();
    if (padding) asset.AddNameReference(new FString("UnrelatedAddedName"));
    var categoryIndex = asset.AddNameReference(new FString(category));
    var noneIndex = asset.AddNameReference(new FString("None"));
    using var stream = new MemoryStream();
    using (var writer = new AssetBinaryWriter(stream, Encoding.UTF8, true, asset)) {
        writer.Write(categoryIndex); writer.Write(0); writer.Write(noneIndex); writer.Write(0);
        writer.Write(0); writer.Write((byte)0); // Object and container.
        writer.WriteBooleanInt(false); writer.WriteBooleanInt(false);
        writer.Write(0); writer.Write(noneIndex); writer.Write(0); writer.Write(Guid.Empty);
        writer.WriteBooleanInt(false);
        if (asset.GetCustomVersion<UAssetAPI.CustomVersions.FReleaseObjectVersion>() >= UAssetAPI.CustomVersions.FReleaseObjectVersion.PinTypeIncludesUObjectWrapperFlag) writer.WriteBooleanInt(false);
        if (asset.GetCustomVersion<UAssetAPI.CustomVersions.FUE5ReleaseStreamObjectVersion>() >= UAssetAPI.CustomVersions.FUE5ReleaseStreamObjectVersion.SerializeFloatPinDefaultValuesAsSinglePrecision) writer.WriteBooleanInt(false);
    }
    return (asset, new Newtonsoft.Json.Linq.JObject { ["$type"] = "UAssetAPI.PropertyTypes.Structs.RawStructPropertyData, UAssetAPI", ["StructType"] = "EdGraphPinType", ["Name"] = "IndexPinType", ["Value"] = Convert.ToBase64String(stream.ToArray()) });
}
Newtonsoft.Json.Linq.JToken Normalize((UAsset asset, Newtonsoft.Json.Linq.JObject property) value) => (Newtonsoft.Json.Linq.JToken)simplify.Invoke(null, [value.asset, value.property])!;
var firstType = TypeProperty("bool", false); var shiftedType = TypeProperty("bool", true);
if (firstType.property.Value<string>("Value") == shiftedType.property.Value<string>("Value")) throw new Exception("Fixture indexes did not shift.");
if (!Newtonsoft.Json.Linq.JToken.DeepEquals(Normalize(firstType), Normalize(shiftedType))) throw new Exception("Name indexes became a type change.");
if (Newtonsoft.Json.Linq.JToken.DeepEquals(Normalize(firstType), Normalize(TypeProperty("int", true)))) throw new Exception("Actual type change was lost.");
shiftedType.property["Value"] = Convert.ToBase64String(Convert.FromBase64String(shiftedType.property.Value<string>("Value")!).Concat(new byte[] { 99 }).ToArray());
try { Normalize(shiftedType); throw new Exception("Unknown type suffix was silently accepted."); }
catch (TargetInvocationException ex) when (ex.InnerException is InvalidDataException) { }
Console.WriteLine("3 native pin-type property normalization checks passed.");

// Component-bound events inherit the editable event signature, even when empty.
// Parse its structure; never accept arbitrary four-byte tails as padding.
void BoundEvent(string mode) {
    var (asset, type) = TypeProperty("bool", false);
    var cls = mode == "unrelated" ? "K2Node_VariableGet" : "K2Node_ComponentBoundEvent";
    asset.Imports.Add(new UAssetAPI.Import { ObjectName = FName.DefineDummy(asset, cls) });
    using var stream = new MemoryStream();
    using (var writer = new AssetBinaryWriter(stream, Encoding.UTF8, true, asset)) {
        writer.Write(0); // No graph pins in this controlled signature fixture.
        if (mode != "missing") writer.Write(mode == "negative" ? -1 : mode == "oversized" ? 100001 : mode is "entry" or "truncated" ? 1 : 0);
        if (mode is "entry" or "truncated") {
            writer.Write(new FName(asset, "Argument"));
            writer.Write(Convert.FromBase64String(type.Value<string>("Value")!));
            writer.Write((byte)1); writer.Write(new FString("true"));
        }
        if (mode == "suffix") writer.Write((byte)99);
    }
    if (mode == "truncated") stream.SetLength(stream.Length - 2);
    var node = new UAssetAPI.ExportTypes.NormalExport { ClassIndex = new FPackageIndex(-1), Extras = stream.ToArray() };
    var succeeds = mode is "empty" or "entry";
    try {
        pinsMethod.Invoke(null, [asset, node, 1, new Newtonsoft.Json.Linq.JArray(), new Newtonsoft.Json.Linq.JObject()]);
        if (!succeeds) throw new Exception($"Malformed bound event {mode} was accepted.");
    } catch (TargetInvocationException ex) when (!succeeds && ex.InnerException is InvalidDataException or EndOfStreamException or ArgumentOutOfRangeException) { }
}
foreach (var mode in new[] { "empty", "entry", "missing", "negative", "oversized", "truncated", "suffix", "unrelated" }) BoundEvent(mode);
Console.WriteLine("8 component-bound event signature checks passed.");



var inventoryAsset = new UAsset(EngineVersion.VER_UE5_4);
Newtonsoft.Json.Linq.JObject Field(string name, int index, string value) => new() { ["Name"] = name, ["ArrayIndex"] = index, ["Value"] = value };
var indexedFields = new Newtonsoft.Json.Linq.JArray(Field("Axis", 0, "first"), Field("Axis", 2, "third"), Field("Single", 0, "saved"));
var rawFields = new Newtonsoft.Json.Linq.JArray(); var fieldDiagnostics = new Newtonsoft.Json.Linq.JArray();
var savedFields = AssetExtractor.SavedProperties(inventoryAsset, indexedFields, rawFields, fieldDiagnostics);
if (savedFields.Value<string>("Axis[0]") != "first" || savedFields.Value<string>("Axis[2]") != "third" || savedFields.Value<string>("Single") != "saved" || savedFields.ContainsKey("Axis[1]")) throw new Exception("Static indexes were collapsed or defaults invented.");
if (AssetExtractor.SavedProperties(inventoryAsset, new(), rawFields, fieldDiagnostics).Count != 0) throw new Exception("Empty export fields became an array.");
var ambiguousFields = AssetExtractor.SavedProperties(inventoryAsset, new(Field("Axis", 0, "one"), Field("Axis", 0, "two"), Field("Other", 0, "kept")), rawFields, fieldDiagnostics);
if (ambiguousFields["Axis"] is not Newtonsoft.Json.Linq.JArray duplicates || duplicates.Count != 2 || ambiguousFields.Value<string>("Other") != "kept" || rawFields.Count != 1 || fieldDiagnostics.Count != 1) throw new Exception("Ambiguous indexes were treated as unique or other fields were lost.");
Console.WriteLine("3 tagged export static-index/empty/ambiguity checks passed.");

// Exercise the compiled upstream overlay, not only GraphExtractor's pin reader.
void TaggedText(int version, bool cooked, bool truncated = false) {
    var asset = new UAsset(EngineVersion.VER_UE5_4);
    asset.CustomVersionContainer.First(v => v.FriendlyName == "FFortniteMainBranchObjectVersion").Version = version;
    if (cooked) asset.PackageFlags |= EPackageFlags.PKG_FilterEditorOnly;
    using var stream = new MemoryStream();
    using (var writer = new AssetBinaryWriter(stream, Encoding.UTF8, true, asset)) {
        writer.Write((uint)8); writer.Write((sbyte)0);
        writer.Write(new FString("Tooltip")); writer.Write(new FString("Key")); writer.Write(new FString("Saved tooltip"));
        if (version >= 260 && !cooked) writer.Write(new FString("Developer notes"));
        writer.Write(123456);
    }
    if (truncated) stream.SetLength(stream.Length - 8);
    stream.Position = 0;
    using var reader = new AssetBinaryReader(stream, asset);
    try {
        var property = new UAssetAPI.PropertyTypes.Objects.TextPropertyData(FName.DefineDummy(asset, "Tooltip"));
        property.Read(reader, false, 0);
        if (truncated || property.CultureInvariantString.ToString() != "Saved tooltip" || reader.ReadInt32() != 123456 || stream.Position != stream.Length) throw new Exception("Tagged text consumed the wrong boundary.");
    } catch (EndOfStreamException) when (truncated) { }
}
TaggedText(259, false); TaggedText(260, false); TaggedText(270, false); TaggedText(260, true); TaggedText(260, false, true);
Console.WriteLine("5 compiled tagged-text overlay checks passed.");

void Recovery(string mode) {
    var asset = new UAsset(EngineVersion.VER_UE5_4) { Imports = new(), Exports = new() };
    asset.ClearNameIndexList();
    var normal = new UAssetAPI.ExportTypes.NormalExport { Asset = asset, ClassIndex = new FPackageIndex(0), ObjectFlags = EObjectFlags.RF_ClassDefaultObject };
    using var stream = new MemoryStream();
    using (var writer = new AssetBinaryWriter(stream, Encoding.UTF8, true, asset)) {
        if (asset.ObjectVersionUE5 >= ObjectVersionUE5.PROPERTY_TAG_EXTENSION_AND_OVERRIDABLE_SERIALIZATION) writer.Write((byte)(mode == "control" ? 1 : 0));
        void Type(string name, int children) { writer.Write(new FName(asset, name)); writer.Write(children); }
        writer.Write(new FName(asset, "UnsupportedEditorArray"));
        if (mode == "other") Type("IntProperty", 0);
        else { Type("ArrayProperty", 1); Type("StructProperty", 1); Type("UnknownEditorStruct", 0); }
        writer.Write(mode == "overflow" ? int.MaxValue : mode == "other" ? 1 : 4); writer.Write((byte)0);
        writer.Write(1); // One struct element, but no struct tag: must stay opaque.
        writer.Write(new FName(asset, "FollowingField")); Type("IntProperty", 0);
        writer.Write(4); writer.Write((byte)0); writer.Write(42);
        writer.Write(new FName(asset, "None")); writer.Write(987654); // Untouched native extras.
    }
    var bytes = stream.ToArray(); stream.Position = 0;
    using var reader = new AssetBinaryReader(stream, asset);
    try {
        TaggedExportRecovery.ReadFields(reader, normal);
        if (mode != "valid") throw new Exception($"Invalid recovery {mode} was accepted.");
        if (normal.Data.Count != 2 || normal.Data[0] is not UAssetAPI.PropertyTypes.Objects.UnknownPropertyData raw || !raw.Value.SequenceEqual(BitConverter.GetBytes(1)) || normal.Data[1] is not UAssetAPI.PropertyTypes.Objects.IntPropertyData integer || integer.Value != 42 || reader.ReadInt32() != 987654 || !bytes.SequenceEqual(stream.ToArray())) throw new Exception("Recovery shifted another field, consumed extras or changed saved bytes.");
    } catch (Exception ex) when (mode != "valid" && ex is InvalidDataException or EndOfStreamException or IndexOutOfRangeException or ArgumentOutOfRangeException) { }
    asset.Imports.Add(new UAssetAPI.Import { ObjectName = new FName(asset, "/Script/AnimGraph"), OuterIndex = new FPackageIndex(0) });
    asset.Imports.Add(new UAssetAPI.Import { ObjectName = new FName(asset, "AnimGraphNode_SequencePlayer"), OuterIndex = new FPackageIndex(-1) });
    var original = new UAssetAPI.ExportTypes.RawExport { Asset = asset, ClassIndex = new FPackageIndex(-2), ObjectName = new FName(asset, "Node"), ObjectFlags = EObjectFlags.RF_ClassDefaultObject, Data = bytes };
    asset.Exports.Add(original);
    TaggedExportRecovery.Apply(asset);
    if (mode == "valid") {
        if (asset.Exports[0] is not UAssetAPI.ExportTypes.NormalExport recovered || recovered.Data.Count != 2 || !recovered.Extras.SequenceEqual(BitConverter.GetBytes(987654))) throw new Exception("Valid raw node did not recover independently bounded fields.");
    } else if (!ReferenceEquals(asset.Exports[0], original)) throw new Exception("Failed recovery replaced its original raw export.");
    if (!original.Data.SequenceEqual(bytes)) throw new Exception("Recovery mutated raw input.");
}
Recovery("valid"); Recovery("overflow"); Recovery("other"); Recovery("control");
Console.WriteLine("4 tagged-recovery boundary/profile checks passed.");
