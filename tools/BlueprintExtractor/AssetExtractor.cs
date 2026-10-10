using Newtonsoft.Json.Linq;
using System.Security.Cryptography;
using UAssetAPI;
using UAssetAPI.ExportTypes;

// Read-only tagged-property inventory. Native bytes remain explicit opaque data;
// no current-project defaults or dependencies are used to fill a historical side.
static class AssetExtractor {
    // StateTree authored arrays use repeated property names. Preserve entries and
    // instanced type identity instead of collapsing them into a property dictionary.
    internal static JToken StateTreeValue(UAsset asset, JToken token) {
        if (token is JArray array) {
            var names = array.OfType<JObject>().Select(p => p.Value<string>("Name")).ToArray();
            if (names.Length == array.Count && names.All(n => n != null) && names.Distinct().Count() == names.Length) {
                var fields = new JObject();
                foreach (var field in array) fields[field.Value<string>("Name")!] = StateTreeValue(asset, field);
                return fields;
            }
            return new JArray(array.Select(value => StateTreeValue(asset, value)));
        }
        if (token is JObject property && property["Value"] != null) {
            var type = property.Value<string>("$type") ?? "";
            if (type.Contains("ArrayPropertyData") || type.Contains("SetPropertyData"))
                return new JArray(((JArray)property["Value"]!).Select(value => StateTreeValue(asset, value)));
            if (type.Contains("ObjectPropertyData")) return GraphExtractor.ObjectPath(asset, property.Value<int>("Value"));
            var value = StateTreeValue(asset, property["Value"]!);
            if (type.Contains("InstancedStructPropertyData")) {
                var index = property["Struct"] is JValue ? property.Value<int>("Struct") : property["Struct"]?.Value<int>("Index") ?? 0;
                return new JObject { ["structType"] = GraphExtractor.ObjectPath(asset, index), ["fields"] = value };
            }
            return value;
        }
        if (token is JObject dict) {
            var result = new JObject();
            foreach (var field in dict.Properties().Where(p => !p.Name.StartsWith('$'))) result[field.Name] = StateTreeValue(asset, field.Value);
            return result;
        }
        return token.DeepClone();
    }
    internal static JObject Extract(UAsset asset, string assetClass) {
        if (asset.Exports.Count > 20000) throw new InvalidDataException("Asset exceeds the 20,000 object review limit.");
        var objects = new JArray();
        for (var i = 0; i < asset.Exports.Count; i++) {
            var export = asset.Exports[i];
            var diagnostics = new JArray();
            var properties = new JObject();
            var opaqueProperties = new JArray();
            var classPath = GraphExtractor.ObjectPath(asset, export.ClassIndex.Index);
            var objectPath = GraphExtractor.ObjectPath(asset, i + 1);
            if (export is NormalExport normal) {
                try {
                    properties = assetClass == "/Script/StateTreeModule.StateTree"
                        ? (JObject)StateTreeValue(asset, JToken.Parse(asset.SerializeJsonObject(normal.Data)))
                        : GraphExtractor.Props(asset, normal);
                    foreach (var property in JArray.Parse(asset.SerializeJsonObject(normal.Data))) {
                        if (property is JContainer container && container.DescendantsAndSelf().OfType<JObject>().Any(value =>
                            (value.Value<string>("$type") ?? "").Contains("RawStructPropertyData") && value.Value<string>("StructType") != "EdGraphPinType"))
                            opaqueProperties.Add(property.Value<string>("Name"));
                    }
                }
                catch (Exception ex) { diagnostics.Add("Property decoding: " + ex.Message); }
            } else diagnostics.Add("This export does not expose tagged properties.");
            // Actors are referenced explicitly by the level, not guessed from names.
            if (export is LevelExport level) {
                properties["Actors"] = new JArray(level.Actors.Select(actor => GraphExtractor.ObjectPath(asset, actor.Index)));
                properties["LevelScriptActor"] = GraphExtractor.ObjectPath(asset, level.LevelScriptActor.Index);
            }
            var native = export is RawExport raw ? (raw.Data ?? []).Concat(export.Extras ?? []).ToArray() : export.Extras ?? [];
            var actorGuid = properties["ActorGuid"] ?? properties["NodeGuid"] ?? properties["ID"];
            if (actorGuid is JObject guidObject) actorGuid = guidObject.Properties().FirstOrDefault()?.Value;
            var identity = actorGuid?.Type == JTokenType.String ? actorGuid.Value<string>() : null;
            if (identity != null) identity = identity.Replace("{", "").Replace("}", "").Replace("-", "").ToUpperInvariant();
            if (identity?.Length != 32 || identity.All(c => c == '0') || !identity.All(Uri.IsHexDigit)) identity = null;
            objects.Add(new JObject {
                ["id"] = identity ?? "", ["path"] = objectPath, ["name"] = export.ObjectName.ToString(),
                ["classPath"] = classPath, ["outer"] = GraphExtractor.ObjectPath(asset, export.OuterIndex.Index),
                ["properties"] = properties, ["opaqueProperties"] = opaqueProperties, ["decoded"] = export is NormalExport && diagnostics.Count == 0,
                ["opaqueBytes"] = native.Length, ["opaqueHash"] = native.Length == 0 ? "" : Convert.ToHexString(SHA256.HashData(native)),
                ["diagnostics"] = diagnostics
            });
        }
        var kind = assetClass.Split('.').Last();
        var family = kind switch {
            "World" => "map", "StaticMesh" or "SkeletalMesh" => "mesh", "StateTree" => "statetree",
            "AnimBlueprint" => "animation", "Blueprint" or "WidgetBlueprint" => "blueprint",
            "Texture2D" or "TextureCube" => "texture", "AnimSequence" or "AnimMontage" => "animation-sequence",
            _ => "asset"
        };
        return new JObject {
            ["family"] = family, ["objects"] = objects,
            ["coverage"] = new JArray("Serialized package objects and tagged properties only.",
                "Native payloads are fingerprinted, not interpreted. Raw tagged fields are labeled and excluded from decoded property edits. Omitted defaults and external dependencies are unresolved.",
                family == "statetree" ? "Saved editor arrays and instanced struct types are preserved. Compiled runtime fields are separate; opaque property bags and custom native payloads are unresolved." : family == "map" ? "External actor packages, sublevels and generated world data are not included in this package inventory." : "Geometry, textures and runtime behavior are not reconstructed."),
            ["cooked"] = asset.IsFilterEditorOnly
        };
    }
}
