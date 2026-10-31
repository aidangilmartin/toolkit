using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using CodeWalker.GameFiles;

namespace GunpackBridge;

/// <summary>
/// Vanilla packs: the original sounds the app works from instead of the player's live (possibly
/// modded) install. Two kinds:
/// <list type="bullet">
/// <item>Self-contained: made by <c>make-vanilla-pack</c> from a GTA V install. OPEN archives whose
/// banks are AWC-decrypted, plus the gun data (weapon index, sound map), so it needs no keys and no
/// GTA V.</item>
/// <item>Plain: original WEAPONS_PLAYER.rpf / RESIDENT.rpf (a backup). They replace the install's
/// archives, while the install still supplies the keys and the gun data.</item>
/// </list>
/// </summary>
public static class Vanilla
{
    public const string ManifestName = "gunpack-vanilla.json";
    const string SfxDir = @"x64\audio\sfx\";

    /// <summary>Archives a plain pack can hold.</summary>
    static readonly string[] PlainArchives = ["WEAPONS_PLAYER.rpf", "RESIDENT.rpf"];

    /// <summary>
    /// Where the original sound archives come from. <see cref="Archives"/> maps archive file names
    /// ("WEAPONS_PLAYER.rpf") to paths: every sfx archive of a self-contained pack, or the archives of
    /// a plain pack that replace the install's.
    /// </summary>
    public sealed record Source(Commands.GameInfo Info, string Root, bool SelfContained, Dictionary<string, string> Archives);

    /// <summary>Opens --vanilla (a self-contained pack, or plain archives over --gta) or the --gta install alone.</summary>
    public static Source Open(Options o)
    {
        var dir = o.Get("vanilla") is { } v ? Path.GetFullPath(v) : null;
        if (dir != null && !Directory.Exists(dir)) throw new BridgeException("no-vanilla", $"The vanilla pack folder \"{dir}\" does not exist.");
        if (dir != null && File.Exists(Path.Combine(dir, ManifestName)))
        {
            if (o.Get("test-awc-key") is { } testKey) Commands.UseTestAwcKey(testKey);
            var sfx = Path.Combine(dir, "x64", "audio", "sfx");
            var archives = Directory.Exists(sfx)
                ? Directory.EnumerateFiles(sfx, "*.rpf").ToDictionary(p => Path.GetFileName(p), p => p, StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            var info = new Commands.GameInfo(dir, "vanilla pack", false, typeof(GTA5Keys).Assembly.GetName().Version?.ToString(), false);
            return new Source(info, dir, true, archives);
        }
        var root = Path.GetFullPath(o.Get("gta") ?? throw new BridgeException("usage", "Missing --gta (or --vanilla with a self-contained pack)."));
        var game = Commands.OpenGameInfo(o, root);
        var plain = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (dir != null)
        {
            plain = PlainArchivesIn(dir);
            if (plain.Count == 0)
                throw new BridgeException("no-vanilla", $"No {ManifestName}, WEAPONS_PLAYER.rpf or RESIDENT.rpf was found in \"{dir}\".");
        }
        return new Source(game, root, false, plain);
    }

    /// <summary>WEAPONS_PLAYER.rpf / RESIDENT.rpf anywhere under dir (first found by path order).</summary>
    static Dictionary<string, string> PlainArchivesIn(string dir)
    {
        var found = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in Directory.EnumerateFiles(dir, "*.rpf", SearchOption.AllDirectories).OrderBy(p => p.Length).ThenBy(p => p, StringComparer.Ordinal))
        {
            var name = PlainArchives.FirstOrDefault(n => string.Equals(n, Path.GetFileName(path), StringComparison.OrdinalIgnoreCase));
            if (name != null && !found.ContainsKey(name)) found[name] = path;
        }
        return found;
    }

    /// <summary>The source's own copy of an archive, opened as x64\audio\sfx\&lt;name&gt;, or null to use the install's.</summary>
    public static RpfFile? OpenArchive(Source source, string archiveName) =>
        source.Archives.TryGetValue(archiveName, out var path) ? Commands.Scan(path, SfxDir + archiveName) : null;

    /// <summary>A warning when an archive isn't encrypted the way Rockstar ships it (a sign it was rebuilt by a mod tool).</summary>
    public static string? ModdedWarning(string archiveName, RpfEncryption encryption) =>
        encryption is RpfEncryption.OPEN or RpfEncryption.NONE
            ? $"{archiveName} isn't encrypted the way Rockstar ships it, so a mod tool probably rebuilt it: check that its sounds are original."
            : null;

    static RpfEncryption EncryptionOf(string path)
    {
        using var br = new BinaryReader(File.OpenRead(path));
        if (br.BaseStream.Length < 16 || br.ReadUInt32() != 0x52504637) return RpfEncryption.NONE;
        br.ReadUInt32();
        br.ReadUInt32();
        return (RpfEncryption)br.ReadUInt32();
    }

    /// <summary>
    /// make-vanilla-pack --gta &lt;root&gt; [--vanilla &lt;plain archives&gt;] --out &lt;dir&gt;: scans the game, then writes
    /// OPEN copies of WEAPONS_PLAYER.rpf and RESIDENT.rpf with every bank AWC-decrypted, an archive of
    /// gun banks for each other wave pack (DLC guns), the weapon index, the sound map and a manifest.
    /// </summary>
    public static object Make(Options o)
    {
        var outDir = Path.GetFullPath(o.Require("out"));
        var source = Open(o);
        if (source.SelfContained) throw new BridgeException("usage", "This is already a vanilla pack.");
        var tmp = Directory.CreateTempSubdirectory("gunpack-vanilla-").FullName;
        try
        {
            var scan = GameScan.Run(o, tmp, source);
            if (scan.Weapons == 0) throw new BridgeException("no-weapons", "No guns were found in this GTA V folder. Is it a complete install?");
            var sfx = Path.Combine(outDir, "x64", "audio", "sfx");
            Directory.CreateDirectory(sfx);

            var warnings = new List<string>();
            var stillEncrypted = new List<string>();
            var archives = new List<object>();
            foreach (var pack in SoundUsage.MapPacks)
            {
                var name = Commands.ArchiveName(pack);
                var original = RpfBuild.FindSourceArchive(source, pack);
                if (ModdedWarning(name, original.Encryption) is { } w) warnings.Add(w);
                var built = RpfBuild.Rebuild(original, Path.Combine(sfx, name), pack, [], stillEncrypted);
                archives.Add(new { name, files = built.Files, size = built.Size });
            }
            // DLC guns keep their banks in their own wave packs: one archive each, with just those banks
            foreach (var group in scan.Extracted.Where(b => !SoundUsage.MapPacks.Contains(b.Pack)).GroupBy(b => b.Pack))
            {
                var name = Commands.ArchiveName(group.Key);
                Output.Progress($"Writing {name}");
                var path = Path.Combine(sfx, name);
                var rpf = RpfBuild.CreateArchive(path, SfxDir + name);
                foreach (var bank in group) RpfFile.CreateFile(rpf.Root, bank.File, File.ReadAllBytes(bank.Path));
                archives.Add(new { name, files = group.Count(), size = new FileInfo(path).Length });
            }

            Output.Progress("Writing the gun data");
            var index = JsonNode.Parse(File.ReadAllText(scan.IndexPath))!.AsObject();
            if (index["game"] is JsonObject game) game["gtaPath"] = "";
            File.WriteAllText(Path.Combine(outDir, "weapon-index.json"), index.ToJsonString());
            File.Copy(scan.MapPath, Path.Combine(outDir, "sound-map.json"), true);
            var manifest = new
            {
                format = 1,
                madeAt = DateTime.UtcNow.ToString("o"),
                madeWith = o.Get("app-version"),
                from = new { exe = source.Info.Exe, gen9 = source.Info.Gen9, plainArchives = source.Archives.Keys.ToList() },
                weapons = scan.Weapons,
                banks = scan.Extracted.Count,
                archives,
                warnings,
                encryptedBanks = stillEncrypted
            };
            File.WriteAllText(Path.Combine(outDir, ManifestName), Output.Serialize(manifest));
            File.WriteAllText(Path.Combine(outDir, "README.txt"), Readme);
            return new { root = outDir, manifest };
        }
        finally
        {
            try
            {
                Directory.Delete(tmp, true);
            }
            catch (IOException)
            {
                // a leftover temp folder isn't worth failing for
            }
        }
    }

    const string Readme = """
        Vanilla pack for Gun Soundpack Maker
        ====================================

        The original GTA V gun sounds the app works from, made from a GTA V install:

          x64/audio/sfx/*.rpf    the game's sound archives (unencrypted copies)
          weapon-index.json      every gun and how its sounds are put together
          sound-map.json         what every sound in the archives is for
          gunpack-vanilla.json   what this pack is and where it came from

        In the app: first launch (or "Change vanilla pack...") > Use a vanilla pack, and pick this
        folder or a .zip of it. GTA V doesn't need to be installed on that PC.

        These are Rockstar Games' files, copied from your own game: keep them for your own use and
        don't upload them publicly.
        """;

    /// <summary>inspect-vanilla --in &lt;dir&gt;: what kind of pack a folder holds, and whether its archives look original.</summary>
    public static object Inspect(Options o)
    {
        var dir = Path.GetFullPath(o.Require("in"));
        if (!Directory.Exists(dir)) throw new BridgeException("no-vanilla", $"The folder \"{dir}\" does not exist.");
        var manifest = FindManifest(dir);
        if (manifest != null)
        {
            var root = Path.GetDirectoryName(manifest)!;
            var data = JsonNode.Parse(File.ReadAllText(manifest));
            foreach (var needed in new[] { "weapon-index.json", "sound-map.json" })
            {
                if (!File.Exists(Path.Combine(root, needed)))
                    throw new BridgeException("no-vanilla", $"This vanilla pack is incomplete: {needed} is missing.");
            }
            return new { kind = "self-contained", root, manifest = data, archives = Archives(root), warnings = new List<string>() };
        }
        var plain = PlainArchivesIn(dir);
        if (plain.Count == 0)
            throw new BridgeException("no-vanilla", $"No vanilla pack here: expected {ManifestName} (a pack the app made) or WEAPONS_PLAYER.rpf / RESIDENT.rpf.");
        var warnings = new List<string>();
        var found = plain.Select(kv =>
        {
            var encryption = EncryptionOf(kv.Value);
            if (ModdedWarning(kv.Key, encryption) is { } w) warnings.Add(w);
            return new { name = kv.Key, path = kv.Value, size = new FileInfo(kv.Value).Length, encryption = encryption.ToString() };
        }).ToList();
        foreach (var missing in PlainArchives.Where(n => !plain.ContainsKey(n)))
            warnings.Add($"There's no {missing} here: the app uses the one in your GTA V install.");
        return new { kind = "archives", root = dir, manifest = (JsonNode?)null, archives = found, warnings };
    }

    static List<object> Archives(string root)
    {
        var sfx = Path.Combine(root, "x64", "audio", "sfx");
        if (!Directory.Exists(sfx)) return [];
        return Directory.EnumerateFiles(sfx, "*.rpf")
            .Select(p => (object)new { name = Path.GetFileName(p), path = p, size = new FileInfo(p).Length, encryption = EncryptionOf(p).ToString() })
            .ToList();
    }

    /// <summary>The manifest in dir or one folder down (a zip often wraps the pack in a folder).</summary>
    static string? FindManifest(string dir)
    {
        var direct = Path.Combine(dir, ManifestName);
        if (File.Exists(direct)) return direct;
        return Directory.EnumerateDirectories(dir)
            .Select(d => Path.Combine(d, ManifestName))
            .Where(File.Exists)
            .OrderBy(p => p, StringComparer.Ordinal)
            .FirstOrDefault();
    }

    /// <summary>zip --in &lt;dir&gt; --out &lt;file.zip&gt;: the folder's contents in a zip (sound banks barely compress, so fast).</summary>
    public static object Zip(Options o)
    {
        var dir = Path.GetFullPath(o.Require("in"));
        var zip = Path.GetFullPath(o.Require("out"));
        if (!Directory.Exists(dir)) throw new BridgeException("usage", $"The folder \"{dir}\" does not exist.");
        var files = Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).OrderBy(p => p, StringComparer.Ordinal).ToList();
        if (File.Exists(zip)) File.Delete(zip);
        using (var archive = ZipFile.Open(zip, ZipArchiveMode.Create))
        {
            for (var i = 0; i < files.Count; i++)
            {
                var rel = Path.GetRelativePath(dir, files[i]).Replace('\\', '/');
                Output.Progress($"Zipping {rel} ({i + 1}/{files.Count})");
                archive.CreateEntryFromFile(files[i], rel, CompressionLevel.Fastest);
            }
        }
        return new { path = zip, files = files.Count, size = new FileInfo(zip).Length };
    }

    /// <summary>unzip --in &lt;file.zip&gt; --out &lt;dir&gt;: extracts a zip, refusing entries that would land outside dir.</summary>
    public static object Unzip(Options o)
    {
        var zip = Path.GetFullPath(o.Require("in"));
        var dir = Path.GetFullPath(o.Require("out"));
        if (!File.Exists(zip)) throw new BridgeException("usage", $"The file \"{zip}\" does not exist.");
        Directory.CreateDirectory(dir);
        var prefix = dir.EndsWith(Path.DirectorySeparatorChar) ? dir : dir + Path.DirectorySeparatorChar;
        using var archive = ZipFile.OpenRead(zip);
        var entries = archive.Entries.Where(e => !string.IsNullOrEmpty(e.Name)).ToList();
        for (var i = 0; i < entries.Count; i++)
        {
            var target = Path.GetFullPath(Path.Combine(dir, entries[i].FullName));
            if (!target.StartsWith(prefix, StringComparison.Ordinal))
                throw new BridgeException("zip", $"The zip has a file outside its folder: {entries[i].FullName}");
            Output.Progress($"Unzipping {entries[i].FullName} ({i + 1}/{entries.Count})");
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entries[i].ExtractToFile(target, true);
        }
        return new { path = dir, files = entries.Count };
    }
}
