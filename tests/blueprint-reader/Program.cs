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


