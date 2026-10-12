using UAssetAPI;
using UAssetAPI.UnrealTypes;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

if (args.Length is < 1 or > 2 || args.Length == 2 && args[1] != "--packages") { Console.Error.WriteLine("Usage: BlueprintExtractor <asset.uasset> [--packages]"); return 2; }
try
{
    if (new FileInfo(args[0]).Length > 256 * 1024 * 1024) throw new InvalidDataException("Asset exceeds the 256 MB limit.");
    var packagesOnly = args.Length == 2;
    var asset = new UAsset(args[0], EngineVersion.UNKNOWN, customSerializationFlags: packagesOnly ? CustomSerializationFlags.SkipLoadingExports | CustomSerializationFlags.SkipPreloadDependencyLoading : CustomSerializationFlags.SkipPreloadDependencyLoading);
    if (!packagesOnly) TaggedExportRecovery.Apply(asset);
    var document = JObject.FromObject(GraphExtractor.Extract(asset));
    document["assetReview"] = packagesOnly ? new JObject { ["family"] = "asset", ["objects"] = new JArray(), ["cooked"] = asset.IsFilterEditorOnly, ["coverage"] = new JArray("Header-only package dependency manifest."), ["packages"] = AssetExtractor.Packages(asset), ["actorNames"] = AssetExtractor.ActorNames(asset), ["actorCandidates"] = AssetExtractor.ActorCandidates(asset), ["actorCandidatesComplete"] = AssetExtractor.ActorCandidatesComplete(asset), ["packageReferencesComplete"] = AssetExtractor.PackagesComplete(asset) } : AssetExtractor.Extract(asset, document.Value<string>("assetClass") ?? "");
    Console.Write(document.ToString(Formatting.None));
    return 0;
}
catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
