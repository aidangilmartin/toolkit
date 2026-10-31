using System.Reflection;
using System.Text;
using System.Xml;
using CodeWalker.GameFiles;

namespace GunpackBridge;

/// <summary>
/// One pass over the game that builds the weapon index: every gun from weapons.meta, its audio
/// settings (player and NPC variants) and the full sound graph behind each part, plus the banks those
/// sounds live in, which are extracted unencrypted for the template library. It also writes the sound
/// usage map (see <see cref="SoundUsage"/>): what every stream in WEAPONS_PLAYER and RESIDENT is for.
/// </summary>
public static class GameScan
{
    /// <summary>weapons.meta groups that are guns.</summary>
    static readonly HashSet<string> GunGroups =
    [
        "GROUP_PISTOL", "GROUP_SMG", "GROUP_RIFLE", "GROUP_MG", "GROUP_SHOTGUN", "GROUP_SNIPER", "GROUP_HEAVY", "GROUP_STUNGUN"
    ];

    /// <summary>Known ItemAudioSettings category names, to label variants when the hash matches.</summary>
    static readonly string[] CategoryNames =
        ["player", "npc", "default", "ped", "mp", "multiplayer", "sp", "singleplayer", "fps", "player_fps", "cop", "army", "ai", "driveby"];

    /// <summary>WeaponSettings fields that keep the short role keys the app has always used.</summary>
    static readonly Dictionary<string, string> ShortRoles = new()
    {
        ["FireSound"] = "fire",
        ["AutoSound"] = "auto",
        ["SuppressedFireSound"] = "suppressed",
        ["ReportSound"] = "report",
        ["EchoSound"] = "echo",
        ["SuppressedEchoSound"] = "suppressedEcho",
        ["ShellCasingSound"] = "shellCasing",
        ["InteriorShotSound"] = "interior"
    };

    static readonly PropertyInfo[] WeaponSoundFields = typeof(Dat151WeaponSettings)
        .GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
        .Where(p => p.PropertyType == typeof(MetaHash))
        .ToArray();

    public sealed record ScanResult(Commands.GameInfo Game, string IndexPath, string MapPath, List<Commands.ExtractedBank> Extracted,
        List<Commands.BankError> Errors, int Weapons, List<string> Warnings);

    sealed record Container(string Pack, string Bank, RpfFile Rpf, RpfFileEntry Entry);
    sealed record WeaponInfo(string Name, string Group, string Audio, string HumanName, float TimeBetweenShots, string FireType, bool Automatic);

    /// <summary>The audio metadata the scan uses: game objects, sounds, curves and categories.</summary>
    sealed record AudioData(Dictionary<uint, RelData> Game, Dictionary<uint, RelData> Sounds, Dictionary<uint, RelData> Curves,
        Dictionary<uint, RelData> Categories);

    /// <summary>
    /// Scans the install (--gta). With a plain vanilla pack (--vanilla), WEAPONS_PLAYER and RESIDENT
    /// come from the pack instead: the install's own copies, including those in update.rpf, are ignored.
    /// </summary>
    public static ScanResult Run(Options o, string? outPath = null, Vanilla.Source? source = null)
    {
        source ??= Vanilla.Open(o);
        if (source.SelfContained)
            throw new BridgeException("usage", "This vanilla pack already holds the gun data: load it instead of scanning.");
        var root = source.Root;
        var outDir = Path.GetFullPath(outPath ?? o.Require("out"));
        var info = source.Info;
        Commands.EnsureNames(o.Get("names"));
        var warnings = new List<string>();

        var replaced = source.Archives.Keys.Select(n => @"x64\audio\sfx\" + n.ToLowerInvariant()).ToList();
        bool Shadowed(string path) => replaced.Any(suffix => path.Replace('/', '\\').EndsWith(suffix, StringComparison.OrdinalIgnoreCase));
        var archives = OpenArchives(root, Shadowed);
        var own = source.Archives.Keys.Select(n => Vanilla.OpenArchive(source, n)!).ToList();
        // the vanilla pack's archives come last, so their banks win
        var all = archives.SelectMany(Commands.Flatten).Where(r => !Shadowed(r.Path)).Concat(own).ToList();

        Output.Progress("Indexing sound banks");
        var containers = new Dictionary<uint, Container>();
        foreach (var rpf in all)
        {
            // banks live directly in ...\sfx\<pack>.rpf
            var parent = Path.GetFileName(Path.GetDirectoryName(rpf.Path.Replace('\\', '/')) ?? "");
            if (!string.Equals(parent, "sfx", StringComparison.OrdinalIgnoreCase) || rpf.AllEntries == null) continue;
            var pack = Path.GetFileNameWithoutExtension(rpf.NameLower);
            foreach (var entry in rpf.AllEntries.OfType<RpfFileEntry>().Where(e => e.NameLower.EndsWith(".awc")))
            {
                var bank = entry.NameLower;
                containers[Hash($"{pack}/{bank[..^4]}")] = new Container(pack, bank, rpf, entry);
            }
        }

        Output.Progress("Reading weapon definitions");
        var allWeapons = ReadWeapons(all, warnings);
        var weapons = allWeapons.Values.Where(w => GunGroups.Contains(w.Group)).ToDictionary(w => w.Name, StringComparer.OrdinalIgnoreCase);
        Output.Progress("Reading weapon names");
        var text = ReadText(all, allWeapons.Values.Select(w => w.HumanName).Where(n => n.Length > 0).ToHashSet());

        Output.Progress("Reading audio metadata");
        var audio = ReadRel(all, warnings);
        var (game, sounds) = (audio.Game, audio.Sounds);

        Output.Progress("Resolving weapon sounds");
        var nodes = new Dictionary<uint, object>();
        var usedContainers = new HashSet<uint>();
        var missingContainers = new HashSet<uint>();
        var weaponList = new List<object>();
        foreach (var w in weapons.Values.OrderBy(w => w.Group).ThenBy(w => w.Name))
        {
            if (!game.TryGetValue(Hash(w.Audio), out var item) || item is not Dat151ItemAudioSettings audioItem)
            {
                warnings.Add($"{w.Name}: audio item {w.Audio} not found.");
                continue;
            }
            var variants = new List<object>();
            var seen = new HashSet<uint>();
            void AddVariant(uint category, uint settingsHash)
            {
                if (settingsHash == 0 || !seen.Add(settingsHash)) return;
                if (!game.TryGetValue(settingsHash, out var sd) || sd is not Dat151WeaponSettings ws) return;
                var roles = RolesOf(ws, sounds);
                foreach (var h in roles.Values) Walk(h, sounds, nodes, containers, usedContainers, missingContainers);
                variants.Add(new
                {
                    category = CategoryName(category),
                    settings = settingsHash,
                    roles,
                    reportVolumeDelta = ws.ReportVolumeDelta,
                    reportPredelayDelta = ws.ReportPredelayDelta,
                    tailEnergy = ws.TailEnergyValue
                });
            }
            foreach (var it in audioItem.Weapons ?? []) AddVariant(it.Category, it.Weapon);
            AddVariant(0, audioItem.FallBackWeapon);
            if (variants.Count == 0)
            {
                warnings.Add($"{w.Name}: no weapon audio settings found.");
                continue;
            }
            weaponList.Add(new
            {
                name = w.Name,
                displayName = text.TryGetValue(w.HumanName, out var dn) ? dn : null,
                group = w.Group,
                audio = w.Audio,
                timeBetweenShots = w.TimeBetweenShots,
                fireType = w.FireType,
                automatic = w.Automatic,
                variants
            });
        }
        if (missingContainers.Count > 0) warnings.Add($"{missingContainers.Count} sound containers referenced by guns were not found in the game files.");

        Output.Progress("Extracting sound banks");
        var extracted = new List<Commands.ExtractedBank>();
        var errors = new List<Commands.BankError>();
        foreach (var c in usedContainers.Select(h => containers[h]).DistinctBy(c => $"{c.Pack}/{c.Bank}"))
        {
            try
            {
                extracted.Add(Commands.ExtractBank(c.Pack, c.Rpf, c.Entry, outDir));
            }
            catch (Exception e)
            {
                errors.Add(new Commands.BankError(c.Pack, c.Bank, e.Message));
            }
        }

        Output.Progress("Reading mix categories and curves");
        var (categories, curves) = PlaybackData(nodes.Keys, audio);
        var index = new
        {
            version = 3,
            game = info,
            weapons = weaponList,
            nodes,
            containers = usedContainers.ToDictionary(h => h.ToString(), h => new { pack = containers[h].Pack, bank = containers[h].Bank }),
            categories,
            curves,
            environment = EnvironmentPresets(game),
            warnings
        };
        Directory.CreateDirectory(outDir);
        var indexPath = Path.Combine(outDir, "weapon-index.json");
        File.WriteAllText(indexPath, Output.Serialize(index));

        var weaponsByAudio = new Dictionary<uint, List<(string, string?)>>();
        foreach (var w in allWeapons.Values)
        {
            var h = Hash(w.Audio);
            if (!weaponsByAudio.TryGetValue(h, out var list)) weaponsByAudio[h] = list = [];
            list.Add((w.Name, text.TryGetValue(w.HumanName, out var dn) ? dn : null));
        }
        var mapBanks = SoundUsage.MapPacks.SelectMany(pack => BanksOf(all, pack)).ToList();
        var mapWarnings = new List<string>();
        var mapPath = SoundUsage.Write(new SoundUsage.Context
        {
            Sounds = sounds,
            Game = game,
            Banks = mapBanks,
            Archives = all,
            WeaponsByAudio = weaponsByAudio,
            CategoryName = CategoryName
        }, outDir, mapWarnings);
        warnings.AddRange(mapWarnings);
        return new ScanResult(info, indexPath, mapPath, extracted, errors, weaponList.Count, warnings);
    }

    /// <summary>
    /// The banks of a wave pack, from the same archive the export rebuilds: the copy in update.rpf
    /// when there is one, otherwise x64\audio\sfx\&lt;PACK&gt;.rpf.
    /// </summary>
    static IEnumerable<SoundUsage.BankRef> BanksOf(List<RpfFile> all, string pack)
    {
        var suffix = @"x64\audio\sfx\" + Commands.ArchiveName(pack).ToLowerInvariant();
        var candidates = all.Where(r => r.AllEntries != null && r.Path.Replace('/', '\\').EndsWith(suffix, StringComparison.OrdinalIgnoreCase)).ToList();
        var rpf = candidates.FirstOrDefault(r => r.Path.StartsWith("update", StringComparison.OrdinalIgnoreCase))
            ?? candidates.FirstOrDefault(r => r.Path.StartsWith("x64", StringComparison.OrdinalIgnoreCase));
        if (rpf == null) yield break;
        foreach (var entry in rpf.AllEntries!.OfType<RpfFileEntry>().Where(e => e.NameLower.EndsWith(".awc")))
            yield return new SoundUsage.BankRef(pack, entry.NameLower, rpf, entry);
    }

    /// <summary>Every sound field a weapon setting fills in: the 8 shot parts plus handling, slow motion, melee…</summary>
    static Dictionary<string, uint> RolesOf(Dat151WeaponSettings ws, Dictionary<uint, RelData> sounds)
    {
        var roles = new Dictionary<string, uint>();
        foreach (var p in WeaponSoundFields)
        {
            var h = ((MetaHash)p.GetValue(ws)!).Hash;
            if (h == 0) continue;
            if (ShortRoles.TryGetValue(p.Name, out var key)) roles[key] = h;
            else if (sounds.ContainsKey(h)) roles[char.ToLowerInvariant(p.Name[0]) + p.Name[1..]] = h;
        }
        return roles;
    }

    static uint Hash(string s) => JenkHash.GenHash(s.ToLowerInvariant());

    static string CategoryName(uint hash)
    {
        if (hash == 0) return "fallback";
        foreach (var n in CategoryNames) if (Hash(n) == hash) return n;
        return "0x" + hash.ToString("X8");
    }

    /// <summary>The archives that hold audio, weapon definitions and text. Skips the OpenIV mods folder.</summary>
    static List<RpfFile> OpenArchives(string root, Func<string, bool> skip)
    {
        var list = new List<(int Order, string Path, string Rel)>();
        foreach (var path in Directory.EnumerateFiles(root, "*.rpf", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(root, path).Replace('/', '\\');
            var lower = rel.ToLowerInvariant();
            if (lower.StartsWith(@"mods\")) continue;
            int order;
            // x64?.rpf hold the animations whose tags trigger some weapon sounds (reloads, handling)
            if (lower == "common.rpf" || IsX64Archive(lower) || lower.StartsWith(@"x64\audio\")) order = 0;
            else if (lower == @"update\update.rpf") order = 1;
            else if (lower.Contains(@"dlcpacks\") && lower.EndsWith(@"\dlc.rpf")) order = 2;
            else continue;
            if (skip(rel)) continue;
            list.Add((order, path, rel));
        }
        var result = new List<RpfFile>();
        foreach (var (_, path, rel) in list.OrderBy(x => x.Order).ThenBy(x => x.Rel, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                result.Add(Commands.Scan(path, rel));
            }
            catch (BridgeException) when (!rel.StartsWith(@"x64\audio", StringComparison.OrdinalIgnoreCase))
            {
                // an unreadable DLC archive shouldn't stop the scan
            }
        }
        return result;
    }

    static bool IsX64Archive(string lower) => lower.Length == 8 && lower.StartsWith("x64") && char.IsLetter(lower[3]) && lower.EndsWith(".rpf");

    static Dictionary<string, WeaponInfo> ReadWeapons(List<RpfFile> archives, List<string> warnings)
    {
        var weapons = new Dictionary<string, WeaponInfo>(StringComparer.OrdinalIgnoreCase);
        foreach (var rpf in archives)
        {
            foreach (var entry in rpf.AllEntries?.OfType<RpfFileEntry>() ?? [])
            {
                var n = entry.NameLower;
                if (!n.StartsWith("weapon") || !n.EndsWith(".meta") || n.Contains("component") || n.Contains("archetype") || n.Contains("anim"))
                    continue;
                try
                {
                    var data = rpf.ExtractFile(entry);
                    if (data == null) continue;
                    var xml = MetaText(entry, data);
                    if (xml == null || !xml.Contains("CWeaponInfoBlob")) continue;
                    var doc = new XmlDocument();
                    doc.LoadXml(xml);
                    foreach (XmlNode node in doc.SelectNodes("//Item[@type='CWeaponInfo']")!)
                    {
                        var name = node["Name"]?.InnerText.Trim() ?? "";
                        var group = node["Group"]?.InnerText.Trim() ?? "";
                        var audio = node["Audio"]?.InnerText.Trim() ?? "";
                        if (name.Length == 0 || audio.Length == 0) continue;
                        float.TryParse(node["TimeBetweenShots"]?.Attributes?["value"]?.Value, System.Globalization.NumberStyles.Float,
                            System.Globalization.CultureInfo.InvariantCulture, out var tbs);
                        var flags = (node["WeaponFlags"]?.InnerText ?? "").Split((char[])[' ', '\t', '\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
                        weapons[name] = new WeaponInfo(name, group, audio, node["HumanNameHash"]?.InnerText.Trim() ?? "", tbs,
                            node["FireType"]?.InnerText.Trim() ?? "", flags.Contains("Automatic"));
                    }
                }
                catch (Exception e)
                {
                    warnings.Add($"{entry.Path}: {e.Message}");
                }
            }
        }
        return weapons;
    }

    /// <summary>.meta files are usually XML text; binary (PSO/RBF) ones are converted with CodeWalker.</summary>
    static string? MetaText(RpfFileEntry entry, byte[] data)
    {
        var start = data.Length >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF ? 3 : 0;
        var firstChar = data.Skip(start).SkipWhile(b => b is (byte)' ' or (byte)'\r' or (byte)'\n' or (byte)'\t').FirstOrDefault();
        if (firstChar == (byte)'<') return Encoding.UTF8.GetString(data, start, data.Length - start);
        try
        {
            return MetaXml.GetXml(entry, data, out _);
        }
        catch
        {
            return null;
        }
    }

    static Dictionary<string, string> ReadText(List<RpfFile> archives, HashSet<string> labels)
    {
        var byHash = new Dictionary<uint, string>();
        foreach (var l in labels)
        {
            byHash[JenkHash.GenHash(l.ToLowerInvariant())] = l;
            byHash[JenkHash.GenHash(l)] = l;
        }
        var result = new Dictionary<string, string>();
        foreach (var rpf in archives)
        {
            if (!rpf.Path.Contains("american")) continue;
            foreach (var entry in rpf.AllEntries?.OfType<RpfFileEntry>() ?? [])
            {
                if (!entry.NameLower.EndsWith(".gxt2")) continue;
                try
                {
                    var gxt = new Gxt2File();
                    gxt.Load(rpf.ExtractFile(entry), entry);
                    foreach (var e in gxt.TextEntries ?? [])
                    {
                        if (byHash.TryGetValue(e.Hash, out var label) && !string.IsNullOrWhiteSpace(e.Text)) result[label] = e.Text;
                    }
                }
                catch
                {
                    // ignore unreadable text files
                }
            }
        }
        return result;
    }

    static AudioData ReadRel(List<RpfFile> archives, List<string> warnings)
    {
        // later archives (update, DLC) override earlier ones, as in CodeWalker's GameFileCache
        var files = new Dictionary<string, (RpfFile Rpf, RpfFileEntry Entry)>();
        foreach (var rpf in archives)
        {
            foreach (var entry in rpf.AllEntries?.OfType<RpfFileEntry>() ?? [])
            {
                var n = entry.NameLower;
                if (n.EndsWith(".rel") && (n.Contains(".dat54") || n.Contains(".dat151") || n.Contains(".dat16") || n.Contains(".dat22")))
                    files[n] = (rpf, entry);
            }
        }
        var game = new Dictionary<uint, RelData>();
        var sounds = new Dictionary<uint, RelData>();
        var curves = new Dictionary<uint, RelData>();
        var categories = new Dictionary<uint, RelData>();
        foreach (var (rpf, entry) in files.Values)
        {
            try
            {
                var rel = new RelFile();
                rel.Load(rpf.ExtractFile(entry), entry);
                var target = rel.RelType switch
                {
                    RelDatFileType.Dat54DataEntries => sounds,
                    RelDatFileType.Dat151 => game,
                    RelDatFileType.Dat16Curves => curves,
                    RelDatFileType.Dat22Categories => categories,
                    _ => null
                };
                if (target == null) continue;
                foreach (var rd in rel.RelDatas ?? []) target[rd.NameHash] = rd;
            }
            catch (Exception e)
            {
                warnings.Add($"{entry.Path}: {e.Message}");
            }
        }
        return new AudioData(game, sounds, curves, categories);
    }

    /// <summary>
    /// The mix categories (with their parent chain) and curves the weapon sounds use: category volume,
    /// pitch and filters, distance attenuation, crossfade and envelope shapes.
    /// </summary>
    static (Dictionary<string, object> Categories, Dictionary<string, object> Curves) PlaybackData(IEnumerable<uint> soundHashes, AudioData a)
    {
        // categories only list their children; find each one's parent
        var parentOf = new Dictionary<uint, uint>();
        foreach (var (h, rd) in a.Categories)
            if (rd is Dat22Category c)
                foreach (var sub in c.SubCategories ?? [])
                    if (sub != 0) parentOf.TryAdd(sub, h);

        var categories = new Dictionary<string, object>();
        var curveHashes = new HashSet<uint>();
        void AddCategory(uint h)
        {
            while (h != 0 && !categories.ContainsKey(h.ToString()) && a.Categories.GetValueOrDefault(h) is Dat22Category c)
            {
                uint? parent = parentOf.TryGetValue(h, out var p) ? p : null;
                categories[h.ToString()] = SoundUsage.CategoryJson(c, parent);
                if (c.LPFDistanceCurve != 0) curveHashes.Add(c.LPFDistanceCurve);
                if (c.HPFDistanceCurve != 0) curveHashes.Add(c.HPFDistanceCurve);
                h = parent ?? 0;
            }
        }
        foreach (var h in soundHashes)
        {
            if (a.Sounds.GetValueOrDefault(h) is not Dat54Sound s) continue;
            if (SoundUsage.Header(s.Header).TryGetValue("category", out var cat)) AddCategory((uint)cat);
            foreach (var c in SoundUsage.CurvesOf(s)) curveHashes.Add(c);
        }
        var curves = new Dictionary<string, object>();
        foreach (var h in curveHashes)
            if (a.Curves.GetValueOrDefault(h) is Dat16RelData c) curves[h.ToString()] = SoundUsage.CurveJson(c);
        return (categories, curves);
    }

    /// <summary>
    /// Typical indoor and outdoor values from the game data: the most common interior weapon metrics
    /// (wetness, filter, predelay) and the most common outdoor echo rule. Real values depend on where you are.
    /// </summary>
    static object EnvironmentPresets(Dictionary<uint, RelData> game)
    {
        var metrics = game.Values.OfType<Dat151InteriorWeaponMetrics>().ToList();
        var interior = metrics
            .GroupBy(m => (m.Wetness, m.Visability, m.LPFCutoff, m.PreDelay, m.Hold))
            .OrderByDescending(g => g.Count())
            .Select(g => new { wetness = g.Key.Wetness, visibility = g.Key.Visability, lpf = g.Key.LPFCutoff, preDelay = g.Key.PreDelay, hold = g.Key.Hold, count = g.Count(), of = metrics.Count })
            .FirstOrDefault();
        var rules = game.Values.OfType<Dat151EnvironmentRule>().Where(r => r.EchoNumber > 0).ToList();
        var echo = rules
            .GroupBy(r => (r.EchoDelay, r.EchoDelayVariance, r.EchoAttenuation, r.EchoNumber, r.BaseEchoVolumeModifier, r.ReverbSmall, r.ReverbMedium, r.ReverbLarge))
            .OrderByDescending(g => g.Count())
            .Select(g => new
            {
                delay = g.Key.EchoDelay, delayVariance = g.Key.EchoDelayVariance, attenuation = g.Key.EchoAttenuation, number = g.Key.EchoNumber,
                volume = g.Key.BaseEchoVolumeModifier, reverbSmall = g.Key.ReverbSmall, reverbMedium = g.Key.ReverbMedium, reverbLarge = g.Key.ReverbLarge,
                count = g.Count(), of = rules.Count
            })
            .FirstOrDefault();
        return new { interiorWeapon = interior, outdoorEcho = echo };
    }

    /// <summary>Emits the sound graph under `hash` (breadth-first, each node once).</summary>
    static void Walk(uint hash, Dictionary<uint, RelData> sounds, Dictionary<uint, object> nodes, Dictionary<uint, Container> containers,
        HashSet<uint> usedContainers, HashSet<uint> missingContainers)
    {
        var queue = new Queue<uint>([hash]);
        while (queue.Count > 0)
        {
            var h = queue.Dequeue();
            if (h == 0 || nodes.ContainsKey(h)) continue;
            if (!sounds.TryGetValue(h, out var rd) || rd is not Dat54Sound s)
            {
                nodes[h] = new { type = "Missing" };
                continue;
            }
            if (s is Dat54SimpleSound ss)
            {
                uint c = ss.ContainerName;
                if (containers.ContainsKey(c)) usedContainers.Add(c);
                else missingContainers.Add(c);
            }
            nodes[h] = SoundUsage.Node(s);
            var children = SoundUsage.ChildrenOf(s).Where(c => c != 0);
            foreach (var c in children) queue.Enqueue(c);
        }
    }
}
