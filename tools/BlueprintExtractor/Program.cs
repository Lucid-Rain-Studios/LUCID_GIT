using UAssetAPI;
using UAssetAPI.UnrealTypes;
using Newtonsoft.Json;

if (args.Length != 1) { Console.Error.WriteLine("Usage: BlueprintExtractor <asset.uasset>"); return 2; }
try
{
    if (new FileInfo(args[0]).Length > 256 * 1024 * 1024) throw new InvalidDataException("Asset exceeds the 256 MB limit.");
    var asset = new UAsset(args[0], EngineVersion.UNKNOWN);
    Console.Write(JsonConvert.SerializeObject(GraphExtractor.Extract(asset)));
    return 0;
}
catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
