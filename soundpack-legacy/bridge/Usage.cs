using System.Collections.Concurrent;
using System.Reflection;
using CodeWalker.GameFiles;

namespace GunpackBridge;

/// <summary>
/// The sound usage map: every stream in every WEAPONS_PLAYER / RESIDENT bank, and every way the game
/// data can play it. From each stream it walks up the sound graph (with the slot each step goes
/// through, e.g. a crossfade's "far" side) to whatever triggers it: a game object field (a weapon's
/// FireSound, an explosion…), a sound set entry, an animation tag, or nothing (game code / scripts).
/// </summary>
public static class SoundUsage
{
    /// <summary>The wave packs whose archives the app rebuilds.</summary>
    public static readonly string[] MapPacks = ["weapons_player", "resident"];

    public sealed record Root(string Kind, uint Owner = 0, string? Field = null, uint Set = 0, uint Entry = 0, string? Dict = null,
        string? Clip = null, float? Phase = null, uint Tag = 0);

    public sealed record Edge(uint Parent, int Slot);

    public sealed record BankRef(string Pack, string Bank, RpfFile Rpf, RpfFileEntry Entry);

    public sealed class Context
    {
        public required Dictionary<uint, RelData> Sounds { get; init; }
        public required Dictionary<uint, RelData> Game { get; init; }
        public required List<BankRef> Banks { get; init; }
        public required List<RpfFile> Archives { get; init; }

        /// <summary>weapons.meta: audio item hash → weapons that use it.</summary>
        public required Dictionary<uint, List<(string Weapon, string? DisplayName)>> WeaponsByAudio { get; init; }

        public required Func<uint, string> CategoryName { get; init; }
    }

    public static string Write(Context ctx, string outDir, List<string> warnings)
    {
        var parents = new Dictionary<uint, List<Edge>>();
        var leaves = new Dictionary<(uint Container, uint File), List<(uint Sound, int Slot)>>();
        Output.Progress("Linking sounds");
        foreach (var (h, rd) in ctx.Sounds)
        {
            if (rd is not Dat54Sound s) continue;
            var kids = ChildrenOf(s);
            for (var i = 0; i < kids.Length; i++)
            {
                if (kids[i] == 0 || kids[i] == h) continue;
                Add(parents, kids[i], new Edge(h, i));
            }
            foreach (var (container, file, slot) in Waves(s)) Add(leaves, (container, file), (h, slot));
        }

        Output.Progress("Finding what triggers each sound");
        var consumers = new Dictionary<uint, List<Root>>();
        var gameRefs = new Dictionary<uint, List<(uint Owner, string Field)>>();
        foreach (var (h, rd) in ctx.Game)
        {
            var seen = new HashSet<uint>();
            foreach (var (field, value) in HashFields(rd, "", 0))
            {
                if (value == h) continue;
                seen.Add(value);
                // a hash can name both a sound and a game object
                if (ctx.Sounds.ContainsKey(value)) Add(consumers, value, new Root("game", h, field));
                if (ctx.Game.ContainsKey(value)) Add(gameRefs, value, (h, field));
            }
            // types whose sound references aren't plain properties
            foreach (var value in Safe(rd.GetSoundHashes).Select(x => x.Hash))
            {
                if (value != 0 && seen.Add(value) && ctx.Sounds.ContainsKey(value)) Add(consumers, value, new Root("game", h, "(sound)"));
            }
        }

        var animTags = AnimationTags(ctx, consumers, warnings);

        // every stream of every bank, with the sounds that play it
        var banks = new Dictionary<string, object>();
        var mappedLeaves = new HashSet<(uint, uint)>();
        var usedLeafSounds = new HashSet<uint>();
        var n = 0;
        foreach (var bank in ctx.Banks.OrderBy(b => b.Pack).ThenBy(b => b.Bank))
        {
            n++;
            Output.Progress($"Mapping {Commands.ArchiveName(bank.Pack)} ({n}/{ctx.Banks.Count}): {bank.Bank}");
            var container = Hash($"{bank.Pack}/{bank.Bank[..^4]}");
            var streams = new List<object>();
            AwcFile awc;
            try
            {
                var data = bank.Rpf.ExtractFile(bank.Entry) ?? throw new Exception("could not read the file");
                awc = new AwcFile();
                awc.Load(data, bank.Entry);
                if (!string.IsNullOrEmpty(awc.ErrorMessage)) throw new Exception(awc.ErrorMessage);
            }
            catch (Exception e)
            {
                warnings.Add($"{bank.Pack}/{bank.Bank}: {e.Message}");
                banks[$"{bank.Pack}/{bank.Bank}"] = new { archive = Commands.ArchiveName(bank.Pack), error = e.Message, streams };
                continue;
            }
            foreach (var s in awc.Streams ?? [])
            {
                // the multichannel source block and data-only streams (gestures…) aren't playable waves
                if (s == awc.MultiChannelSource || (uint)s.Hash == 0 || (s.FormatChunk == null && s.StreamFormat == null)) continue;
                var id = (uint)s.Hash & 0x1FFFFFFF;
                var refs = leaves.GetValueOrDefault((container, id)) ?? [];
                if (refs.Count > 0) mappedLeaves.Add((container, id));
                foreach (var (sound, _) in refs) usedLeafSounds.Add(sound);
                var name = s.Name;
                streams.Add(new
                {
                    id,
                    name = string.IsNullOrEmpty(name) || name.StartsWith("0x") ? null : name,
                    samples = s.SampleCount,
                    rate = s.SamplesPerSecond,
                    kind = s.MidiChunk != null ? "midi" : s.GranularGrainsChunk != null || s.GranularLoopsChunk != null ? "granular" : null,
                    leaves = refs.Select(r => new object[] { r.Sound, r.Slot }).ToArray()
                });
            }
            banks[$"{bank.Pack}/{bank.Bank}"] = new
            {
                archive = Commands.ArchiveName(bank.Pack),
                mc = awc.MultiChannelFlag ? true : (bool?)null,
                size = bank.Entry.GetFileSize(),
                streams
            };
        }

        var bankContainers = ctx.Banks.Select(b => Hash($"{b.Pack}/{b.Bank[..^4]}")).ToHashSet();
        var missing = leaves.Keys.Count(k => bankContainers.Contains(k.Container) && !mappedLeaves.Contains(k));
        if (missing > 0) warnings.Add($"{missing} sounds point at streams that are not in their bank.");

        // the sound graph above those streams: every ancestor, with its parents and what triggers it
        Output.Progress("Writing the sound map");
        var nodes = new Dictionary<string, object>();
        var mapConsumers = new Dictionary<string, object>();
        var owners = new HashSet<uint>();
        var queue = new Queue<uint>(usedLeafSounds);
        var visited = new HashSet<uint>(usedLeafSounds);
        while (queue.Count > 0)
        {
            var h = queue.Dequeue();
            var ps = parents.GetValueOrDefault(h) ?? [];
            var node = ctx.Sounds.TryGetValue(h, out var rd) && rd is Dat54Sound s ? Node(s, ps) : new { type = "Missing" };
            nodes[h.ToString()] = node;
            if (consumers.TryGetValue(h, out var cs))
            {
                mapConsumers[h.ToString()] = cs.Select(RootJson).ToArray();
                foreach (var c in cs.Where(c => c.Kind == "game")) owners.Add(c.Owner);
            }
            foreach (var p in ps)
                if (visited.Add(p.Parent)) queue.Enqueue(p.Parent);
        }

        var map = new
        {
            version = 1,
            banks,
            nodes,
            consumers = mapConsumers,
            owners = owners.ToDictionary(h => h.ToString(), h => Owner(h, ctx, gameRefs)),
            names = Names(visited.Concat(owners).Concat(visited.SelectMany(h => consumers.GetValueOrDefault(h) ?? [])
                .SelectMany(r => new[] { r.Set, r.Entry, r.Tag })), ctx),
            animationTags = animTags,
            warnings
        };
        var path = Path.Combine(outDir, "sound-map.json");
        File.WriteAllText(path, Output.SerializeCompact(map));
        return path;
    }

    /// <summary>The waves a sound plays directly: (container, stream id, slot).</summary>
    static IEnumerable<(uint Container, uint File, int Slot)> Waves(Dat54Sound s)
    {
        switch (s)
        {
            case Dat54SimpleSound ss:
                yield return (ss.ContainerName, (uint)ss.FileName & 0x1FFFFFFF, -1);
                break;
            case Dat54GranularSound g:
                var channels = GranularChannels(g);
                for (var c = 0; c < channels.Length; c++)
                    if (channels[c] is { } f && f.ContainerName != 0) yield return (f.ContainerName, (uint)f.FileName & 0x1FFFFFFF, c);
                break;
            case Dat54AutomationSound a when a.ContainerName != 0:
                // a MIDI stream that drives the note map
                yield return (a.ContainerName, (uint)a.FileName & 0x1FFFFFFF, -2);
                break;
        }
    }

    static object RootJson(Root r) => r.Kind switch
    {
        "game" => new { kind = r.Kind, owner = r.Owner, field = r.Field },
        _ => (object)new { kind = r.Kind, dict = r.Dict, clip = r.Clip, phase = r.Phase, tag = r.Tag, set = r.Set, entry = r.Entry }
    };

    /// <summary>The children of a sound, in slot order (CodeWalker keeps each type's slot layout).</summary>
    public static uint[] ChildrenOf(Dat54Sound s)
    {
        var own = Safe(s.GetSoundHashes);
        var kids = (own.Length > 0 ? own : s.ChildSoundsHashes ?? []).Select(c => (uint)c).ToList();
        if (s is Dat54EnvelopeSound env && env.ChildSound != 0 && !kids.Contains(env.ChildSound)) kids.Add(env.ChildSound);
        return kids.ToArray();
    }

    static Dat54GranularSoundFile?[] GranularChannels(Dat54GranularSound g) => [g.Channel0, g.Channel1, g.Channel2, g.Channel3, g.Channel4, g.Channel5];

    /// <summary>A sound graph node as stored in the index and the usage map (which adds its parents).</summary>
    public static object Node(Dat54Sound s, List<Edge>? parents = null)
    {
        var children = ChildrenOf(s);
        object? simple = s is Dat54SimpleSound ss ? new { container = (uint)ss.ContainerName, file = (uint)ss.FileName & 0x1FFFFFFF } : null;
        object? envelope = s is Dat54EnvelopeSound e
            ? new
            {
                attack = (int)e.Attack, decay = (int)e.Decay, sustain = (int)e.Sustain, hold = e.Hold, release = e.Release,
                attackVariance = (int)e.AttackVariance, decayVariance = (int)e.DecayVariance, sustainVariance = (int)e.SustainVariance,
                holdVariance = (int)e.HoldVariance, releaseVariance = e.ReleaseVariance,
                // what the envelope shapes: 0 volume, 1 pitch, 2 pan, 3 LPF, 4 HPF, 5 a variable, 6/7 log LPF/HPF
                mode = e.Mode, attackCurve = Opt(e.AttackCurve), decayCurve = Opt(e.DecayCurve), releaseCurve = Opt(e.ReleaseCurve),
                outputVariable = Opt(e.OutputVariable), outputMin = e.OutputRangeMin, outputMax = e.OutputRangeMax
            }
            : null;
        return new
        {
            type = s.Type.ToString(),
            header = Header(s.Header),
            children,
            weights = s is Dat54RandomizedSound r ? r.VariationsValues : null,
            envelope,
            simple,
            cond = Cond(s),
            parents = parents?.Select(p => new object[] { p.Parent, p.Slot }).ToArray()
        };
    }

    /// <summary>The settings that decide when each child plays.</summary>
    static object? Cond(Dat54Sound s) => s switch
    {
        Dat54CrossfadeSound c => new
        {
            mode = (int)c.Mode, minDistance = c.MinDistance, maxDistance = c.MaxDistance, hysteresis = c.Hysteresis,
            crossfadeCurve = Opt(c.CrossfadeCurve), distanceVariable = Opt(c.DistanceVariable), crossfadeVariable = Opt(c.CrossfadeVariable),
            minDistanceVariable = Opt(c.MinDistanceVariable), maxDistanceVariable = Opt(c.MaxDistanceVariable)
        },
        Dat54CollapsingStereoSound c => new
        {
            mode = (int)c.Mode, minDistance = c.MinDistance, maxDistance = c.MaxDistance, crossfadeOverrideVariable = Opt(c.CrossfadeOverrideVariable)
        },
        Dat54IfSound i => new { variable = (uint)i.ConditionVariable, conditionType = (int)i.ConditionType, value = i.ConditionValue, rhs = Opt(i.RHS) },
        Dat54SwitchSound w => new { variable = (uint)w.Variable },
        Dat54RetriggeredOverlappedSound r => new
        {
            loopCount = (int)r.LoopCount, loopCountVariance = (int)r.LoopCountVariance, delay = (int)r.DelayTime, delayVariance = (int)r.DelayTimeVariance,
            loopCountVariable = Opt(r.LoopCountVariable), delayVariable = Opt(r.DelayTimeVariable)
        },
        Dat54LoopingSound l => new { loopCount = (int)l.LoopCount, loopCountVariance = (int)l.LoopCountVariance },
        Dat54DirectionalSound d => new
        {
            innerAngle = d.InnerAngle, outerAngle = d.OuterAngle, rearAttenuation = d.RearAttenuation, yaw = d.YawAngle, pitch = d.PitchAngle
        },
        Dat54VariableBlockSound v => new
        {
            variables = (v.Variables ?? []).Select(x => new { name = (uint)x.Name, value = x.Value, variance = x.ValueVariance, type = (int)x.VariableType }).ToArray()
        },
        Dat54SequentialOverlapSound o => new { delay = (int)o.DelayTime, delayVariable = Opt(o.DelayTimeVariable) },
        Dat54SoundSet set => new { entries = (set.SoundSets ?? []).Select(x => (uint)x.ScriptName).ToArray() },
        Dat54WrapperSound w => new { minRepeatTime = (int)w.MinRepeatTime },
        Dat54GranularSound g => new
        {
            files = GranularChannels(g).Select(f => f == null ? null : new { container = (uint)f.ContainerName, file = (uint)f.FileName & 0x1FFFFFFF }).ToArray()
        },
        _ => null
    };

    static uint? Opt(MetaHash h) => h.Hash == 0 ? null : h.Hash;

    /// <summary>The curves (dat16) a sound refers to: distance attenuation, crossfade and envelope shapes.</summary>
    public static IEnumerable<uint> CurvesOf(Dat54Sound s)
    {
        var h = Header(s.Header);
        if (h.TryGetValue("volumeCurve", out var vc)) yield return (uint)vc;
        if (s is Dat54CrossfadeSound c && c.CrossfadeCurve != 0) yield return c.CrossfadeCurve;
        if (s is Dat54EnvelopeSound e)
            foreach (var x in new[] { e.AttackCurve, e.DecayCurve, e.ReleaseCurve })
                if (x != 0) yield return x;
    }

    /// <summary>A curve's type and parameters, as written in curves.dat16.</summary>
    public static object CurveJson(Dat16RelData c)
    {
        var d = new Dictionary<string, object> { ["type"] = c.Type.ToString() };
        foreach (var p in c.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
        {
            var key = char.ToLowerInvariant(p.Name[0]) + p.Name[1..];
            switch (TryGet(p, c))
            {
                case float f:
                    d[key] = f;
                    break;
                case int i:
                    d[key] = i;
                    break;
                case uint u when p.Name != "NumPoints":
                    d[key] = u;
                    break;
                case float[] fa:
                    d[key] = fa;
                    break;
                case SharpDX.Vector2[] pts:
                    d[key] = pts.Select(v => new[] { v.X, v.Y }).ToArray();
                    break;
            }
        }
        d.Remove("valueCount");
        return d;
    }

    /// <summary>A sound category (dat22): its mix settings and its parent (categories only list their children).</summary>
    public static object CategoryJson(Dat22Category c, uint? parent) => new
    {
        parent,
        volume = (int)c.Volume,
        pitch = (int)c.Pitch,
        lpf = (int)c.LPFCutoff,
        hpf = (int)c.HPFCutoff,
        lpfDistanceCurve = Opt(c.LPFDistanceCurve),
        hpfDistanceCurve = Opt(c.HPFDistanceCurve),
        distanceRollOffScale = (int)c.DistanceRollOffScale,
        plateauRollOffScale = (int)c.PlateauRollOffScale,
        parentOverrides = (int)c.ParentOverrides
    };

    /// <summary>Only the header fields the game data actually sets (absent fields use engine defaults).</summary>
    public static Dictionary<string, long> Header(RelSoundHeader? h)
    {
        var d = new Dictionary<string, long>();
        if (h == null) return d;
        uint f = h.Flags;
        bool Has(int bit) => ((f >> (bit / 8 * 8)) & 0xFF) != 0xAA && ((f >> bit) & 1) != 0;
        if (Has(2)) d["volume"] = h.Volume;
        if (Has(3)) d["volumeVariance"] = h.VolumeVariance;
        if (Has(4)) d["pitch"] = h.Pitch;
        if (Has(5)) d["pitchVariance"] = h.PitchVariance;
        if (Has(6)) d["pan"] = h.Pan;
        if (Has(7)) d["panVariance"] = h.PanVariance;
        if (Has(8)) d["preDelay"] = h.PreDelay;
        if (Has(9)) d["preDelayVariance"] = h.PreDelayVariance;
        if (Has(10)) d["startOffset"] = h.StartOffset;
        if (Has(11)) d["startOffsetVariance"] = h.StartOffsetVariance;
        if (Has(12)) d["attack"] = h.AttackTime;
        if (Has(13)) d["release"] = h.ReleaseTime;
        if (Has(14)) d["dopplerFactor"] = h.DopplerFactor;
        if (Has(15)) d["category"] = (uint)h.Category;
        if (Has(16)) d["lpf"] = h.LPFCutoff;
        if (Has(17)) d["lpfVariance"] = h.LPFCutoffVariance;
        if (Has(18)) d["hpf"] = h.HPFCutoff;
        if (Has(19)) d["hpfVariance"] = h.HPFCutoffVariance;
        if (Has(20)) d["volumeCurve"] = (uint)h.VolumeCurve;
        if (Has(21)) d["volumeCurveScale"] = h.VolumeCurveScale;
        if (Has(22)) d["volumeCurvePlateau"] = h.VolumeCurvePlateau;
        if (Has(23)) d["speakerMask"] = h.SpeakerMask;
        if (Has(24)) d["effectRoute"] = h.EffectRoute;
        if (Has(25)) d["preDelayVariable"] = (uint)h.PreDelayVariable;
        if (Has(26)) d["startOffsetVariable"] = (uint)h.StartOffsetVariable;
        if (Has(27)) d["smallReverb"] = h.SmallReverbSend;
        if (Has(28)) d["mediumReverb"] = h.MediumReverbSend;
        if (Has(29)) d["largeReverb"] = h.LargeReverbSend;
        return d;
    }

    /// <summary>A game object that triggers sounds, with the guns that use it when it's a weapon setting.</summary>
    static object Owner(uint h, Context ctx, Dictionary<uint, List<(uint Owner, string Field)>> gameRefs)
    {
        var rd = ctx.Game.GetValueOrDefault(h);
        var type = rd is Dat151RelData d ? d.Type.ToString() : rd?.GetType().Name ?? "Missing";
        List<object>? weapons = null;
        if (rd is Dat151WeaponSettings)
        {
            weapons = [];
            foreach (var (owner, _) in gameRefs.GetValueOrDefault(h) ?? [])
            {
                if (ctx.Game.GetValueOrDefault(owner) is not Dat151ItemAudioSettings item) continue;
                var categories = new List<string>();
                foreach (var it in item.Weapons ?? [])
                    if (it.Weapon == h) categories.Add(ctx.CategoryName(it.Category));
                if (item.FallBackWeapon == h) categories.Add("fallback");
                foreach (var (weapon, display) in ctx.WeaponsByAudio.GetValueOrDefault(owner) ?? [])
                    foreach (var category in categories.Distinct())
                        weapons.Add(new { weapon, displayName = display, category });
            }
        }
        var usedBy = (gameRefs.GetValueOrDefault(h) ?? []).Take(16).Select(r => new object[] { r.Owner, r.Field }).ToArray();
        return new { type, weapons, usedBy = usedBy.Length > 0 ? usedBy : null };
    }

    /// <summary>Readable names for every hash in the map that CodeWalker's name index knows.</summary>
    static Dictionary<string, string> Names(IEnumerable<uint> hashes, Context ctx)
    {
        var names = new Dictionary<string, string>();
        void Try(uint h)
        {
            if (h == 0 || names.ContainsKey(h.ToString())) return;
            var s = JenkIndex.TryGetString(h);
            if (!string.IsNullOrEmpty(s)) names[h.ToString()] = s;
        }
        foreach (var h in hashes)
        {
            Try(h);
            if (ctx.Sounds.GetValueOrDefault(h) is not Dat54Sound s) continue;
            switch (s)
            {
                case Dat54SoundSet set:
                    foreach (var e in set.SoundSets ?? []) Try(e.ScriptName);
                    break;
                case Dat54SwitchSound w:
                    Try(w.Variable);
                    break;
                case Dat54IfSound i:
                    Try(i.ConditionVariable);
                    break;
                case Dat54CrossfadeSound c:
                    Try(c.DistanceVariable);
                    Try(c.CrossfadeVariable);
                    break;
                case Dat54VariableBlockSound v:
                    foreach (var x in v.Variables ?? []) Try(x.Name);
                    break;
            }
        }
        return names;
    }

    /// <summary>
    /// Best effort: animation clip tags in weapon clip dictionaries whose values name a sound (or a sound
    /// set entry together with its set). Such sounds are played by the animation, e.g. reload clicks.
    /// </summary>
    static int AnimationTags(Context ctx, Dictionary<uint, List<Root>> consumers, List<string> warnings)
    {
        var scriptNames = new Dictionary<uint, List<(uint Set, uint Child)>>();
        foreach (var (h, rd) in ctx.Sounds)
        {
            if (rd is not Dat54SoundSet set) continue;
            foreach (var item in set.SoundSets ?? [])
                if (item.ChildSound != 0) Add(scriptNames, (uint)item.ScriptName, (h, (uint)item.ChildSound));
        }

        var found = 0;
        var entries = ctx.Archives
            .SelectMany(r => (r.AllEntries ?? []).OfType<RpfResourceFileEntry>().Select(e => (Rpf: r, Entry: e)))
            .Where(x => x.Entry.NameLower.EndsWith(".ycd") && x.Entry.Path.Contains("weapon", StringComparison.OrdinalIgnoreCase))
            .ToList();
        if (entries.Count == 0) return 0;
        Output.Progress($"Reading weapon animation tags ({entries.Count} clip dictionaries)");
        var failed = 0;
        var done = 0;
        foreach (var (rpf, entry) in entries)
        {
            if (++done % 100 == 0) Output.Progress($"Reading weapon animation tags ({done}/{entries.Count})");
            try
            {
                var data = rpf.ExtractFile(entry);
                if (data == null) continue;
                var ycd = new YcdFile();
                ycd.Load(data, entry);
                var dict = entry.NameLower[..^4];
                foreach (var cme in ycd.ClipMapEntries ?? [])
                {
                    var clip = cme?.Clip;
                    if (clip?.Tags?.Tags?.data_items == null) continue;
                    var clipName = string.IsNullOrEmpty(clip.Name) ? $"0x{(uint)cme!.Hash:X8}" : clip.Name;
                    foreach (var tag in clip.Tags.Tags.data_items)
                    {
                        if (tag?.Attributes?.data_items == null) continue;
                        var values = tag.Attributes.data_items.OfType<ClipPropertyAttributeHashString>().Select(a => (uint)a.Value).Where(v => v != 0).ToList();
                        foreach (var v in values)
                        {
                            Root R(uint set = 0, uint entry = 0) => new("anim", Dict: dict, Clip: clipName, Phase: tag.StartPhase, Tag: (uint)tag.NameHash, Set: set, Entry: entry);
                            if (ctx.Sounds.GetValueOrDefault(v) is Dat54Sound s && s is not Dat54SoundSet)
                            {
                                Add(consumers, v, R());
                                found++;
                            }
                            else if (scriptNames.TryGetValue(v, out var sets))
                            {
                                var inTag = sets.Where(x => values.Contains(x.Set)).ToList();
                                var matches = inTag.Count > 0 ? inTag : sets.Count == 1 ? sets : [];
                                foreach (var (set, child) in matches)
                                {
                                    Add(consumers, child, R(set, v));
                                    found++;
                                }
                            }
                        }
                    }
                }
            }
            catch
            {
                failed++;
            }
        }
        if (failed > 0) warnings.Add($"{failed} weapon animation files could not be read; sounds they trigger show as played by game code.");
        return found;
    }

    /// <summary>Every non-zero hash a game object holds, with the field it sits in (e.g. "Weapons[1].Weapon").</summary>
    static IEnumerable<(string Field, uint Value)> HashFields(object o, string prefix, int depth)
    {
        foreach (var p in PropsOf(o.GetType(), depth == 0))
        {
            var v = TryGet(p, o);
            switch (v)
            {
                case MetaHash mh:
                    if (mh.Hash != 0) yield return (prefix + p.Name, mh.Hash);
                    break;
                case MetaHash[] arr:
                    for (var i = 0; i < arr.Length; i++)
                        if (arr[i].Hash != 0) yield return ($"{prefix}{p.Name}[{i}]", arr[i].Hash);
                    break;
                case Array arr when depth < 2 && arr.GetType().GetElementType() is { } et && typeof(IMetaXmlItem).IsAssignableFrom(et):
                    for (var i = 0; i < arr.Length; i++)
                    {
                        if (arr.GetValue(i) is not { } item) continue;
                        foreach (var x in HashFields(item, $"{prefix}{p.Name}[{i}].", depth + 1)) yield return x;
                    }
                    break;
            }
        }
    }

    static readonly ConcurrentDictionary<(Type, bool), PropertyInfo[]> Props = new();

    static PropertyInfo[] PropsOf(Type t, bool relData) => Props.GetOrAdd((t, relData), k =>
        k.Item1.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.CanRead && p.GetIndexParameters().Length == 0)
            // on game objects, only the type's own fields (not RelData's bookkeeping)
            .Where(p => !k.Item2 || (p.DeclaringType != typeof(RelData) && p.DeclaringType != typeof(Dat151RelData)))
            .ToArray());

    static object? TryGet(PropertyInfo p, object o)
    {
        try
        {
            return p.GetValue(o);
        }
        catch
        {
            return null;
        }
    }

    static MetaHash[] Safe(Func<MetaHash[]> f)
    {
        try
        {
            return f() ?? [];
        }
        catch
        {
            return [];
        }
    }

    static void Add<TK, TV>(Dictionary<TK, List<TV>> d, TK key, TV value) where TK : notnull
    {
        if (!d.TryGetValue(key, out var list)) d[key] = list = [];
        list.Add(value);
    }

    static uint Hash(string s) => JenkHash.GenHash(s.ToLowerInvariant());
}
