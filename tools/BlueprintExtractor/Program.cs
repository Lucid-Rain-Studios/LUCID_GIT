using UAssetAPI;
using UAssetAPI.UnrealTypes;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

static JObject Extract(string file, bool packagesOnly)
{
    if (new FileInfo(file).Length > 256 * 1024 * 1024) throw new InvalidDataException("Asset exceeds the 256 MB limit.");
    var asset = new UAsset(file, EngineVersion.UNKNOWN, customSerializationFlags: packagesOnly ? CustomSerializationFlags.SkipLoadingExports | CustomSerializationFlags.SkipPreloadDependencyLoading : CustomSerializationFlags.SkipPreloadDependencyLoading);
    if (!packagesOnly) TaggedExportRecovery.Apply(asset);
    var document = JObject.FromObject(GraphExtractor.Extract(asset));
    document["assetReview"] = packagesOnly ? new JObject { ["family"] = "asset", ["objects"] = new JArray(), ["cooked"] = asset.IsFilterEditorOnly, ["coverage"] = new JArray("Header-only package dependency manifest."), ["packages"] = AssetExtractor.Packages(asset), ["renderPackages"] = AssetExtractor.RenderPackages(asset), ["actorNames"] = AssetExtractor.ActorNames(asset), ["actorCandidates"] = AssetExtractor.ActorCandidates(asset), ["actorCandidatesComplete"] = AssetExtractor.ActorCandidatesComplete(asset), ["packageReferencesComplete"] = AssetExtractor.PackagesComplete(asset) } : AssetExtractor.Extract(asset, document.Value<string>("assetClass") ?? "");
    return document;
}

if (args.Length == 1 && args[0] == "--worker")
{
    string? line;
    while ((line = Console.ReadLine()) != null)
    {
        string? id = null;
        JObject response;
        try
        {
            if (line.Length > 65536) throw new InvalidDataException("Reader request exceeds the input limit.");
            var request = JObject.Parse(line);
            id = request.Value<string>("id") ?? throw new InvalidDataException("Missing request identity.");
            response = new JObject { ["id"] = id, ["document"] = Extract(request.Value<string>("file") ?? throw new InvalidDataException("Missing asset path."), request.Value<bool>("packagesOnly")) };
        }
        catch (Exception e) { response = new JObject { ["id"] = id, ["error"] = e.Message }; }
        Console.WriteLine(response.ToString(Formatting.None));
        Console.Out.Flush();
    }
    return 0;
}
if (args.Length is < 1 or > 2 || args.Length == 2 && args[1] != "--packages") { Console.Error.WriteLine("Usage: BlueprintExtractor <asset.uasset> [--packages] or --worker"); return 2; }
try { Console.Write(Extract(args[0], args.Length == 2).ToString(Formatting.None)); return 0; }
catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
