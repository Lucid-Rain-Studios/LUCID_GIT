using Newtonsoft.Json.Linq;
using System.Security.Cryptography;
using UAssetAPI;
using UAssetAPI.ExportTypes;

// Read-only tagged-property inventory. Native bytes remain explicit opaque data;
// no current-project defaults or dependencies are used to fill a historical side.
static class AssetExtractor {
    static IEnumerable<string> PackageNames(UAsset asset) => asset.Imports.Where(import => import.ClassName.ToString() == "Package").Select(import => import.ObjectName.ToString())
        .Concat(asset.SoftPackageReferenceList?.Select(value => value.ToString()) ?? [])
        .Concat(asset.SoftObjectPathList?.Select(value => value.AssetPath.PackageName.ToString()) ?? [])
        .Where(value => value.StartsWith('/')).Distinct();
    internal static JArray Packages(UAsset asset) => new(PackageNames(asset).Order().Take(4096));
    internal static bool PackagesComplete(UAsset asset) => PackageNames(asset).Take(4097).Count() <= 4096;
    internal static JArray ActorNames(UAsset asset) => new(asset.Exports.Where(export => GraphExtractor.ObjectPath(asset, export.OuterIndex.Index).EndsWith(".PersistentLevel")).Select(export => export.ObjectName.ToString()).Distinct().Take(10000));
    internal static JArray ActorCandidates(UAsset asset) => new(asset.Exports.Select((export,index) => (export,index)).Where(value => GraphExtractor.ObjectPath(asset,value.export.OuterIndex.Index).EndsWith(".PersistentLevel")).Take(10000).Select(value => new JObject { ["path"] = GraphExtractor.ObjectPath(asset,value.index + 1), ["classPath"] = GraphExtractor.ObjectPath(asset,value.export.ClassIndex.Index) }));
    internal static bool ActorCandidatesComplete(UAsset asset) => asset.Exports.Count(export => GraphExtractor.ObjectPath(asset,export.OuterIndex.Index).EndsWith(".PersistentLevel")) <= 10000;
    // Keep typed object references separate from arbitrary saved text. Only the
    // resolved package indexes are used for navigation; never guess from labels.
    static JArray References(UAsset asset, JToken token, ref int remaining) {
        var references = new JArray();
        var budget = Math.Min(128, remaining);
        void Visit(JToken value, string path, int depth, bool element = false) {
            if (depth > 32 || references.Count >= budget) return;
            if (value is JArray array) { foreach (var item in array) Visit(item, path, depth + 1); return; }
            if (value is not JObject field) return;
            var type = (field.Value<string>("$type") ?? "").Split(',')[0];
            var name = field.Value<string>("Name");
            if (!element && name != null) path = path.Length == 0 ? name : path + "." + name;
            if (type.EndsWith("ObjectPropertyData") && field["Value"]?.Type == JTokenType.Integer) {
                var index = field.Value<int>("Value");
                if (index != 0) references.Add(new JObject {
                    ["propertyPath"] = path, ["target"] = GraphExtractor.ObjectPath(asset, index),
                    ["className"] = index > 0 ? GraphExtractor.ObjectPath(asset, asset.Exports[index - 1].ClassIndex.Index) : asset.Imports[-index - 1].ClassName.ToString()
                });
                return;
            }
            if (field["Value"] is JArray values && (type.EndsWith("ArrayPropertyData") || type.EndsWith("SetPropertyData"))) {
                for (var i = 0; i < values.Count && references.Count < budget; i++) Visit(values[i], path + "[" + i + "]", depth + 1, true);
            } else if (field["Value"] != null) Visit(field["Value"]!, path, depth + 1);
            else foreach (var child in field.Properties().Where(p => !p.Name.StartsWith('$'))) Visit(child.Value, path.Length == 0 ? child.Name : path + "." + child.Name, depth + 1);
        }
        if (token is JArray roots) {
            foreach (var group in roots.OfType<JObject>().GroupBy(field => field.Value<string>("Name"))) {
                var fields = group.ToArray();
                if (group.Key == null || fields.Any(field => field.Value<int>("ArrayIndex") < 0) || fields.Select(field => field.Value<int>("ArrayIndex")).Distinct().Count() != fields.Length) continue;
                foreach (var field in fields) {
                    var index = field.Value<int>("ArrayIndex");
                    Visit(field, fields.Length > 1 || index != 0 ? $"{group.Key}[{index}]" : group.Key, 1, true);
                }
            }
        } else Visit(token, "", 0);
        remaining -= references.Count;
        return references;
    }
    // Authored arrays and mesh collision arrays use repeated property names. Preserve entries and
    // instanced type identity instead of collapsing them into a property dictionary.
    internal static JToken SavedValue(UAsset asset, JToken token) {
        if (token is JArray array) {
            var names = array.OfType<JObject>().Select(p => p.Value<string>("Name")).ToArray();
            if (names.Length == array.Count && names.All(n => n != null) && names.Distinct().Count() == names.Length) {
                var fields = new JObject();
                foreach (var field in array) fields[field.Value<string>("Name")!] = SavedValue(asset, field);
                return fields;
            }
            return new JArray(array.Select(value => SavedValue(asset, value)));
        }
        if (token is JObject property && property["Value"] != null) {
            var type = property.Value<string>("$type") ?? "";
            if (type.Contains("ArrayPropertyData") || type.Contains("SetPropertyData"))
                return new JArray(((JArray)property["Value"]!).Select(value => SavedValue(asset, value)));
            if (type.Contains("ObjectPropertyData") && property["Value"]!.Type == JTokenType.Integer) return GraphExtractor.ObjectPath(asset, property.Value<int>("Value"));
            var value = SavedValue(asset, property["Value"]!);
            if (type.Contains("InstancedStructPropertyData")) {
                var index = property["Struct"] is JValue ? property.Value<int>("Struct") : property["Struct"]?.Value<int>("Index") ?? 0;
                return new JObject { ["structType"] = GraphExtractor.ObjectPath(asset, index), ["fields"] = value };
            }
            return value;
        }
        if (token is JObject dict) {
            var result = new JObject();
            foreach (var field in dict.Properties().Where(p => !p.Name.StartsWith('$'))) result[field.Name] = SavedValue(asset, field.Value);
            return result;
        }
        return token.DeepClone();
    }
    // A tagged export is a field list, unlike a dynamic array. Static array
    // elements share a name and carry explicit ArrayIndex values; never collapse them.
    internal static JObject SavedProperties(UAsset asset, JArray fields, JArray opaque, JArray diagnostics) {
        var result = new JObject();
        if (fields.OfType<JObject>().Count() != fields.Count) throw new InvalidDataException("Invalid tagged field list.");
        foreach (var group in fields.OfType<JObject>().GroupBy(field => field.Value<string>("Name"))) {
            if (group.Key == null) throw new InvalidDataException("Unnamed tagged field.");
            var values = group.ToArray();
            var indexes = values.Select(field => field.Value<int>("ArrayIndex")).ToArray();
            if (indexes.Any(index => index < 0) || indexes.Distinct().Count() != values.Length) {
                result[group.Key] = new JArray(values.Select(field => new JObject { ["savedArrayIndex"] = field["ArrayIndex"], ["value"] = SavedValue(asset, field) }));
                opaque.Add(group.Key); diagnostics.Add($"Ambiguous tagged field indexes: {group.Key}. Values retained without semantic interpretation.");
                continue;
            }
            foreach (var field in values) {
                var index = field.Value<int>("ArrayIndex");
                var key = values.Length > 1 || index != 0 ? $"{group.Key}[{index}]" : group.Key;
                if (result.ContainsKey(key)) throw new InvalidDataException("Tagged field key collision: " + key);
                result[key] = SavedValue(asset, field);
            }
        }
        return result;
    }
    internal static JObject Extract(UAsset asset, string assetClass) {
        if (asset.Exports.Count > 20000) throw new InvalidDataException("Asset exceeds the 20,000 object review limit.");
        var objects = new JArray();
        var referenceBudget = 8192;
        for (var i = 0; i < asset.Exports.Count; i++) {
            var export = asset.Exports[i];
            var diagnostics = new JArray();
            var properties = new JObject();
            var opaqueProperties = new JArray();
            var references = new JArray();
            var classPath = GraphExtractor.ObjectPath(asset, export.ClassIndex.Index);
            var objectPath = GraphExtractor.ObjectPath(asset, i + 1);
            if (export is NormalExport normal) {
                try {
                    var saved = JToken.Parse(asset.SerializeJsonObject(normal.Data));
                    properties = new[] { "/Script/Engine.Blueprint", "/Script/Engine.AnimBlueprint", "/Script/UMG.WidgetBlueprint" }.Contains(assetClass)
                        ? GraphExtractor.Props(asset, normal)
                        : SavedProperties(asset, (JArray)saved, opaqueProperties, diagnostics);
                    references = References(asset, saved, ref referenceBudget);
                    var fieldCounts = ((JArray)saved).OfType<JObject>().GroupBy(field => field.Value<string>("Name") ?? "").ToDictionary(group => group.Key, group => group.Count());
                    foreach (var property in (JArray)saved) {
                        if (property is JContainer container && container.DescendantsAndSelf().OfType<JObject>().Any(value =>
                            ((value.Value<string>("$type") ?? "").Contains("UnknownPropertyData") || (value.Value<string>("$type") ?? "").Contains("RawStructPropertyData") && value.Value<string>("StructType") != "EdGraphPinType"))) {
                            var name = property.Value<string>("Name");
                            var index = property.Value<int>("ArrayIndex");
                            var repeated = fieldCounts.GetValueOrDefault(name ?? "") > 1;
                            opaqueProperties.Add(repeated || index != 0 ? $"{name}[{index}]" : name);
                        }
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
                ["properties"] = properties, ["references"] = references, ["opaqueProperties"] = opaqueProperties, ["decoded"] = export is NormalExport && diagnostics.Count == 0,
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
            ["packages"] = Packages(asset), ["packageReferencesComplete"] = PackagesComplete(asset),
            ["actorNames"] = ActorNames(asset),
            ["actorCandidates"] = ActorCandidates(asset),
            ["actorCandidatesComplete"] = ActorCandidatesComplete(asset),
            ["coverage"] = new JArray("Serialized package objects and tagged properties only. Typed object-reference links are bounded to 128 per object and 8,192 per package; soft/native references and custom mounts are unresolved.",
                "Native payloads are fingerprinted, not interpreted. Raw tagged fields are labeled and excluded from decoded property edits. Omitted defaults and external dependencies are unresolved.",
                family == "mesh" ? "Saved collision arrays are preserved. Explicit convex vertices, triangle indices and transforms support a collision-only preview; native render/source geometry, materials, LODs and skin data remain unresolved." : family == "statetree" ? "Saved editor arrays and instanced struct types are preserved. Compiled runtime fields are separate; opaque property bags and custom native payloads are unresolved." : family == "map" ? "External actor packages, sublevels and generated world data are not included in this package inventory." : "Geometry, textures and runtime behavior are not reconstructed."),
            ["cooked"] = asset.IsFilterEditorOnly
        };
    }
}
