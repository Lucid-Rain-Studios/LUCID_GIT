using Newtonsoft.Json.Linq;
using UAssetAPI;
using UAssetAPI.CustomVersions;
using UAssetAPI.ExportTypes;
using UAssetAPI.PropertyTypes.Objects;
using UAssetAPI.UnrealTypes;

// Independent read-only decoder for editor graph data left in UAssetAPI's Extras.
// Wire-format reference: UE 5.6 EdGraphPin/EdGraphNode serialization. No engine
// source is embedded or required at runtime. Unsupported versions/tails are explicit.
static class GraphExtractor
{
    const int ReaderVersion = 6;
    static string Name(UAsset a, int index) => index switch {
        > 0 when index <= a.Exports.Count => a.Exports[index - 1].ObjectName.ToString(),
        < 0 when -index <= a.Imports.Count => a.Imports[-index - 1].ObjectName.ToString(),
        0 => "None", _ => throw new InvalidDataException("Invalid object reference.")
    };
    static string ObjectPath(UAsset a, int index, int depth = 0) {
        if (index == 0) return "None";
        if (index > a.Exports.Count || index < -a.Imports.Count) throw new InvalidDataException("Invalid object reference.");
        if (depth > 32) throw new InvalidDataException("Cyclic object reference.");
        var outer = index > 0 ? a.Exports[index - 1].OuterIndex.Index : a.Imports[-index - 1].OuterIndex.Index;
        return outer == 0 ? Name(a, index) : ObjectPath(a, outer, depth + 1) + "." + Name(a, index);
    }
    static JToken Simplify(UAsset a, JToken token) {
        if (token is JArray array) {
            if (array.All(p => p["Name"] != null)) {
                var obj = new JObject();
                foreach (var p in array) obj[p.Value<string>("Name")!] = Simplify(a, p);
                return obj;
            }
            return new JArray(array.Select(p => Simplify(a, p)));
        }
        if (token is JObject o && o["Value"] != null) {
            if ((o.Value<string>("$type") ?? "").Contains("ObjectPropertyData"))
                return ObjectPath(a, o.Value<int>("Value"));
            return Simplify(a, o["Value"]!);
        }
        if (token is JObject dict) {
            var result = new JObject();
            foreach (var p in dict.Properties().Where(p => !p.Name.StartsWith('$'))) result[p.Name] = Simplify(a, p.Value);
            return result;
        }
        return token.DeepClone();
    }
    static JObject Props(UAsset a, NormalExport e) => (JObject)Simplify(a, JToken.Parse(a.SerializeJsonObject(e.Data)));
    static string GuidOf(JObject p, string key) => p[key]?[key]?.ToString().Replace("{", "").Replace("}", "").Replace("-", "").ToUpperInvariant() ?? "";
    static int Count(AssetBinaryReader r) { var n = r.ReadInt32(); if (n < 0 || n > 100000) throw new InvalidDataException("Invalid graph array size."); return n; }
    static string Guid(AssetBinaryReader r) => r.ReadGuid().ConvertToString().Replace("{", "").Replace("}", "").Replace("-", "");
    static string Text(AssetBinaryReader r, int depth = 0) {
        if (depth > 16) throw new InvalidDataException("Text history nesting exceeds the review limit.");
        var start = r.BaseStream.Position;
        r.ReadUInt32(); var history = r.ReadSByte();
        if (history == 0) {
            r.ReadFString(); // Namespace
            r.ReadFString(); // Localization key
            var source = r.ReadFString()?.Value ?? "";
            // AddDevNotesToFText (Fortnite main custom version 260): editor-only
            // localized base histories append translator notes after their source.
            if (!r.Asset.IsFilterEditorOnly && (int)r.Asset.GetCustomVersion<FFortniteMainBranchObjectVersion>() >= 260) r.ReadFString();
            return source;
        }
        if (history == 1) {
            var format = Text(r, depth + 1); var args = new SortedDictionary<string, string>(); var count = Count(r);
            for (var i = 0; i < count; i++) {
                var name = r.ReadFString()?.Value ?? "";
                args[name] = r.ReadByte() switch {
                    0 => r.ReadInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
                    1 or 5 => r.ReadUInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
                    2 => r.ReadSingle().ToString(System.Globalization.CultureInfo.InvariantCulture),
                    3 => r.ReadDouble().ToString(System.Globalization.CultureInfo.InvariantCulture),
                    4 => Text(r, depth + 1),
                    _ => throw new InvalidDataException("Unsupported formatted text argument.")
                };
            }
            // Preserve source format and arguments rather than invent localized text.
            return Newtonsoft.Json.JsonConvert.SerializeObject(new { format, arguments = args });
        }
        r.BaseStream.Position = start;
        var p = new TextPropertyData(); p.Read(r, false, 0);
        return p.CultureInvariantString?.Value ?? p.Value?.Value ?? "";
    }
    static JObject? Reference(AssetBinaryReader r) {
        if (r.ReadBooleanInt()) return null;
        return new JObject { ["export"] = r.ReadInt32(), ["pin"] = Guid(r) };
    }
    static JArray References(AssetBinaryReader r) {
        var result = new JArray(); var count = Count(r);
        for (var i = 0; i < count; i++) { var p = Reference(r); if (p != null) result.Add(p); }
        return result;
    }
    static JObject PinType(AssetBinaryReader r) {
        var a = r.Asset;
        if (a.GetCustomVersion<FFrameworkObjectVersion>() < FFrameworkObjectVersion.PinsStoreFName)
            throw new InvalidDataException("Graph pin serialization before UE 4.19 is unsupported.");
        var category = r.ReadFName().ToString(); var subcategory = r.ReadFName().ToString(); var objIndex = r.ReadInt32();
        if (objIndex > a.Exports.Count || objIndex < -a.Imports.Count) throw new InvalidDataException($"Pin type {category}/{subcategory} object index {objIndex} at {r.BaseStream.Position}.");
        var p = new JObject { ["category"] = category, ["subcategory"] = subcategory, ["object"] = ObjectPath(a, objIndex) };
        var container = r.ReadByte(); if (container > 3) throw new InvalidDataException("Invalid pin container.");
        p["container"] = new[] { "None", "Array", "Set", "Map" }[container];
        if (container == 3) {
            var value = new JObject { ["category"] = r.ReadFName().ToString(), ["subcategory"] = r.ReadFName().ToString(), ["object"] = ObjectPath(a, r.ReadInt32()), ["const"] = r.ReadBooleanInt(), ["weak"] = r.ReadBooleanInt() };
            if (a.GetCustomVersion<FReleaseObjectVersion>() >= FReleaseObjectVersion.PinTypeIncludesUObjectWrapperFlag) value["wrapper"] = r.ReadBooleanInt();
            p["valueType"] = value;
        }
        p["reference"] = r.ReadBooleanInt(); p["weak"] = r.ReadBooleanInt();
        p["memberParent"] = ObjectPath(a, r.ReadInt32()); p["memberName"] = r.ReadFName().ToString(); p["memberGuid"] = Guid(r);
        p["const"] = r.ReadBooleanInt();
        if (a.GetCustomVersion<FReleaseObjectVersion>() >= FReleaseObjectVersion.PinTypeIncludesUObjectWrapperFlag) p["wrapper"] = r.ReadBooleanInt();
        if (a.GetCustomVersion<FUE5ReleaseStreamObjectVersion>() >= FUE5ReleaseStreamObjectVersion.SerializeFloatPinDefaultValuesAsSinglePrecision) p["singlePrecision"] = r.ReadBooleanInt();
        return p;
    }
    static void Pins(UAsset a, Export e, int exportIndex, JArray result, JObject properties) {
        using var stream = new MemoryStream(e.Extras ?? []);
        using var r = new AssetBinaryReader(stream, a);
        var count = Count(r);
        for (var i = 0; i < count; i++) {
            var header = Reference(r); if (header == null) throw new InvalidDataException("Null owning pin.");
            var owner = r.ReadInt32(); var id = Guid(r);
            if (owner != exportIndex || header.Value<int>("export") != owner || header.Value<string>("pin") != id) throw new InvalidDataException("Pin identity mismatch.");
            var p = new JObject { ["id"] = id, ["name"] = r.ReadFName().ToString(), ["friendlyName"] = Text(r) };
            // Stable custom version value from UE5MainStreamObjectVersions.inl.
            if (a.GetCustomVersion(new Guid("697dd581-41ab-e64f-ec51-4aaa28b6b7be")) >= 50) p["sourceIndex"] = r.ReadInt32();
            p["tooltip"] = r.ReadFString()?.Value ?? "";
            var direction = r.ReadByte(); if (direction > 1) throw new InvalidDataException("Invalid pin direction.");
            p["direction"] = direction == 0 ? "input" : "output"; p["type"] = PinType(r);
            p["defaultValue"] = r.ReadFString()?.Value ?? ""; p["autogeneratedDefault"] = r.ReadFString()?.Value ?? "";
            p["defaultObject"] = ObjectPath(a, r.ReadInt32()); p["defaultText"] = Text(r);
            p["links"] = References(r); p["subPins"] = References(r); p["parent"] = Reference(r); p["passThrough"] = Reference(r);
            p["persistentGuid"] = Guid(r); p["flags"] = r.ReadUInt32(); result.Add(p);
        }
        // Editable entry/result/event nodes append user-defined signature metadata.
        var cls = Name(a, e.ClassIndex.Index);
        if (new[] { "K2Node_Event", "K2Node_FunctionEntry", "K2Node_FunctionResult", "K2Node_CustomEvent", "K2Node_Tunnel", "K2Node_MacroInstance" }.Contains(cls)) {
            var declared = Count(r);
            for (var i = 0; i < declared; i++) { r.ReadFName(); PinType(r); r.ReadByte(); r.ReadFString(); }
        }
        if ((cls == "K2Node_DynamicCast" || cls == "K2Node_ClassDynamicCast") &&
            (int)a.GetCustomVersion<FFortniteMainBranchObjectVersion>() >= 85) {
            var pureState = r.ReadByte();
            if (pureState > 2) throw new InvalidDataException("Invalid DynamicCast purity state.");
            properties["NativePureState"] = new[] { "Pure", "Impure", "UseDefault" }[pureState];
            if (pureState < 2) properties["bIsPureCast"] = pureState == 0;
        }
        if (stream.Position != stream.Length) throw new InvalidDataException($"Unparsed native node data ({stream.Length - stream.Position} bytes).");
    }
    public static object Extract(UAsset a) {
        var graphs = new JArray(); var diagnostics = new List<string>();
        if (a.IsFilterEditorOnly) return new { schemaVersion = 1, readerVersion = ReaderVersion, status = "unsupported", engineVersion = a.GetEngineVersion().ToString(), graphs, diagnostics = new[] { "Cooked assets have stripped editor graph data." } };
        var blueprint = a.Exports.FirstOrDefault(e => Name(a, e.ClassIndex.Index) is "Blueprint" or "WidgetBlueprint" or "AnimBlueprint");
        if (blueprint == null) return new { schemaVersion = 1, readerVersion = ReaderVersion, status = "unsupported", engineVersion = a.GetEngineVersion().ToString(), graphs, diagnostics = new[] { "This asset does not contain an editor Blueprint." } };
        var totalNodes = 0;
        for (var gi = 0; gi < a.Exports.Count; gi++) {
            if (a.Exports[gi] is not NormalExport graph || Name(a, graph.ClassIndex.Index) != "EdGraph") continue;
            var gp = Props(a, graph);
            if (!(gp.Value<string>("Schema") ?? "").EndsWith("EdGraphSchema_K2")) continue;
            var graphNodes = new JArray(); var graphDiagnostics = new List<string>();
            // Graph membership uses the explicit Nodes array, not an outer-index guess.
            var rawData = JArray.Parse(a.SerializeJsonObject(graph.Data));
            var indices = rawData.FirstOrDefault(p => p.Value<string>("Name") == "Nodes")?["Value"] as JArray;
            // An omitted tagged array has its default empty value.
            indices ??= [];
            foreach (var member in indices) {
                if (++totalNodes > 20000) throw new InvalidDataException("Blueprint exceeds the 20,000 node review limit.");
                var index = member.Value<int>("Value");
                if (index <= 0 || index > a.Exports.Count || a.Exports[index - 1] is not NormalExport n) { graphDiagnostics.Add("An unparsed node export is present."); continue; }
                var properties = Props(a, n); var cls = Name(a, n.ClassIndex.Index); var pins = new JArray();
                var complete = true;
                if (cls != "EdGraphNode_Comment" || (n.Extras?.Length ?? 0) > 0) {
                    try { Pins(a, n, index, pins, properties); }
                    catch (Exception ex) { complete = false; graphDiagnostics.Add(n.ObjectName + ": " + ex.Message); }
                }
                var title = properties["FunctionReference"]?["MemberName"]?.ToString() ?? properties["EventReference"]?["MemberName"]?.ToString() ?? properties.Value<string>("CustomFunctionName") ?? properties["VariableReference"]?["MemberName"]?.ToString() ?? (cls == "EdGraphNode_Comment" ? properties.Value<string>("NodeComment") : null) ?? cls.Replace("K2Node_", "");
                graphNodes.Add(new JObject { ["id"] = GuidOf(properties, "NodeGuid"), ["exportIndex"] = index, ["name"] = n.ObjectName.ToString(), ["classPath"] = ObjectPath(a, n.ClassIndex.Index), ["title"] = title, ["x"] = properties.Value<int?>("NodePosX") ?? 0, ["y"] = properties.Value<int?>("NodePosY") ?? 0, ["width"] = properties.Value<int?>("NodeWidth") ?? 0, ["height"] = properties.Value<int?>("NodeHeight") ?? 0, ["comment"] = properties.Value<string>("NodeComment") ?? "", ["properties"] = properties, ["pins"] = pins, ["complete"] = complete });
            }
            var duplicateIds = graphNodes.GroupBy(n => n.Value<string>("id")).Where(g => string.IsNullOrEmpty(g.Key) || g.Key == new string('0', 32) || g.Count() > 1).Select(g => g.Key).ToHashSet();
            foreach (var n in graphNodes.Where(n => duplicateIds.Contains(n.Value<string>("id")))) {
                n["id"] = ""; n["complete"] = false;
                graphDiagnostics.Add(n.Value<string>("name") + ": missing or ambiguous node identity; excluded from change matching.");
            }
            // Resolve native export references only after every node has been decoded.
            var byExport = graphNodes.ToDictionary(n => n.Value<int>("exportIndex"));
            foreach (var n in graphNodes) foreach (var p in (JArray)n["pins"]!) foreach (var link in (JArray)p["links"]!) {
                if (!byExport.TryGetValue(link.Value<int>("export"), out var target) || !((JArray)target["pins"]!).Any(tp => tp.Value<string>("id") == link.Value<string>("pin"))) { n["complete"] = false; graphDiagnostics.Add(n.Value<string>("name") + ": unresolved pin connection."); continue; }
                link["node"] = target.Value<string>("id"); link["nodeName"] = target.Value<string>("name"); link["export"]?.Parent?.Remove();
            }
            graphs.Add(new JObject { ["id"] = GuidOf(gp, "GraphGuid"), ["name"] = graph.ObjectName.ToString(), ["path"] = ObjectPath(a, gi + 1), ["nodes"] = graphNodes, ["complete"] = graphDiagnostics.Count == 0, ["diagnostics"] = JArray.FromObject(graphDiagnostics) });
            diagnostics.AddRange(graphDiagnostics);
        }
        return new { schemaVersion = 1, readerVersion = ReaderVersion, status = graphs.Count == 0 ? "unsupported" : diagnostics.Count == 0 ? "complete" : "partial", engineVersion = $"{a.RecordedEngineVersion.Major}.{a.RecordedEngineVersion.Minor}.{a.RecordedEngineVersion.Patch}", graphs, diagnostics = graphs.Count == 0 ? new[] { "No supported K2 Blueprint graphs are stored in this asset." } : diagnostics.ToArray() };
    }
}

