using System.Reflection;
using CodeWalker.GameFiles;

namespace GunpackBridge;

/// <summary>Game access through CodeWalker.Core.</summary>
public static class Commands
{
    /// <summary>Wave packs gun sound packs replace, and where the game keeps them.</summary>
    static readonly (string Pack, string Archive)[] Archives =
    [
        ("weapons_player", "weapons_player.rpf"),
        ("resident", "resident.rpf")
    ];

    const string SfxDir = @"x64\audio\sfx\";

    /// <summary>"weapons_player" → "WEAPONS_PLAYER.rpf".</summary>
    public static string ArchiveName(string pack) => pack.ToUpperInvariant() + ".rpf";

    public sealed record GameInfo(string GtaPath, string Exe, bool Gen9, string? CodeWalkerVersion, bool KeysLoaded);
    public sealed record BankEntry(string Pack, string File, long Size, string Archive);
    public sealed record ExtractedBank(string Pack, string File, string Path, int Streams, bool WasEncrypted, Dictionary<string, string> Names);
    public sealed record BankError(string Pack, string File, string Error);

    public static GameInfo Probe(Options o)
    {
        var game = OpenGame(o);
        return game.Info;
    }

    public static object List(Options o)
    {
        var game = OpenGame(o);
        var banks = FindBanks(game).Select(b => new BankEntry(b.Pack, b.Entry.NameLower, b.Entry.GetFileSize(), b.Rpf.Path)).ToList();
        return new { game = game.Info, banks };
    }

    public static object Extract(Options o)
    {
        var outDir = Path.GetFullPath(o.Require("out"));
        var wanted = o.All("bank").Select(b => b.ToLowerInvariant().Replace('\\', '/')).ToHashSet();
        var game = OpenGame(o);
        EnsureNames();

        var extracted = new List<ExtractedBank>();
        var errors = new List<BankError>();
        var found = FindBanks(game).Where(b => wanted.Count == 0 || wanted.Contains($"{b.Pack}/{b.Entry.NameLower}")).ToList();
        foreach (var missing in wanted.Where(w => !found.Any(b => $"{b.Pack}/{b.Entry.NameLower}" == w)))
        {
            var parts = missing.Split('/', 2);
            errors.Add(new BankError(parts[0], parts.Length > 1 ? parts[1] : "", "Not found in the game files."));
        }

        foreach (var (pack, rpf, entry) in found)
        {
            try
            {
                extracted.Add(ExtractBank(pack, rpf, entry, outDir));
            }
            catch (Exception e)
            {
                var ex = e is TargetInvocationException { InnerException: not null } t ? t.InnerException! : e;
                if (ex is MissingMethodException or TypeLoadException) throw ex;
                errors.Add(new BankError(pack, entry.NameLower, ex.Message));
            }
        }
        return new { game = game.Info, extracted, errors };
    }

    /// <summary>Writes one bank from the game as an unencrypted .awc under outDir/pack/.</summary>
    internal static ExtractedBank ExtractBank(string pack, RpfFile rpf, RpfFileEntry entry, string outDir)
    {
        Output.Progress($"Extracting {pack}/{entry.NameLower}");
        var data = rpf.ExtractFile(entry) ?? throw new BridgeException("error", "Could not read the file from the archive.");
        var awc = new AwcFile();
        awc.Load(data, entry);
        if (!string.IsNullOrEmpty(awc.ErrorMessage)) throw new BridgeException("error", awc.ErrorMessage);
        if (awc.MultiChannelFlag) throw new BridgeException("error", "Multi-channel stream banks are not supported.");

        var encrypted = awc.WholeFileEncrypted || awc.SingleChannelEncryptFlag;
        var bytes = encrypted ? SaveDecrypted(awc) : data;
        var dir = Path.Combine(outDir, pack);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, entry.NameLower);
        File.WriteAllBytes(path, bytes);
        return new ExtractedBank(pack, entry.NameLower, path, awc.Streams?.Length ?? 0, encrypted, StreamNames(awc));
    }

    /// <summary>Re-saves a bank without CodeWalker's AWC encryption (data was decrypted on load).</summary>
    public static byte[] SaveDecrypted(AwcFile awc)
    {
        awc.WholeFileEncrypted = false;
        awc.SingleChannelEncryptFlag = false;
        awc.MultiChannelEncryptFlag = false;
        awc.BuildStreamInfos();
        return awc.Save();
    }

    internal static Dictionary<string, string> StreamNames(AwcFile awc)
    {
        var names = new Dictionary<string, string>();
        foreach (var s in awc.Streams ?? [])
        {
            var name = s.Name;
            if (!string.IsNullOrEmpty(name) && !name.StartsWith("0x")) names[((uint)s.Hash).ToString()] = name;
        }
        return names;
    }

    static bool namesLoaded;

    /// <summary>
    /// Feeds CodeWalker's known-strings list (plus an optional name list the user supplies with
    /// --names) into its hash index so streams and sounds get readable names.
    /// </summary>
    internal static void EnsureNames(string? extra = null)
    {
        if (namesLoaded) return;
        namesLoaded = true;
        foreach (var path in new[] { Path.Combine(AppContext.BaseDirectory, "strings.txt"), extra })
        {
            if (path == null || !File.Exists(path)) continue;
            foreach (var line in File.ReadLines(path))
            {
                var s = line.Trim();
                if (s.Length == 0 || s.StartsWith("//")) continue;
                JenkIndex.Ensure(s);
                JenkIndex.Ensure(s.ToLowerInvariant());
            }
        }
    }

    /// <summary>The game (or vanilla pack) and the archive each wave pack's banks come from.</summary>
    sealed record Game(GameInfo Info, string Root, List<(string Pack, RpfFile Rpf)> Packs);

    /// <summary>Validates the GTA V folder and loads the decryption keys from its exe.</summary>
    internal static GameInfo OpenGameInfo(Options o, string root)
    {
        if (!Directory.Exists(root)) throw new BridgeException("no-gta", $"The GTA V folder \"{root}\" does not exist.");
        var legacy = FindPath(root, "gta5.exe") != null;
        var enhanced = FindPath(root, "gta5_enhanced.exe") != null;
        if (!legacy && !enhanced)
        {
            throw new BridgeException("no-gta", $"gta5.exe was not found in \"{root}\". Select your Grand Theft Auto V install folder.");
        }
        var gen9 = !legacy || o.Flag("gen9");
        var keys = false;
        if (!o.Flag("no-keys"))
        {
            Output.Progress("Loading decryption keys from the game");
            LoadKeys(root, gen9);
            keys = true;
        }
        if (o.Get("test-awc-key") is { } testKey) UseTestAwcKey(testKey);
        return new GameInfo(root, legacy ? "gta5.exe" : "gta5_enhanced.exe", gen9, typeof(GTA5Keys).Assembly.GetName().Version?.ToString(), keys);
    }

    /// <summary>
    /// The archives to read banks from: every sfx archive of a self-contained vanilla pack; otherwise
    /// WEAPONS_PLAYER and RESIDENT, from a plain vanilla pack when it has them, else from the install
    /// (a copy inside update.rpf wins over x64\audio\sfx).
    /// </summary>
    static Game OpenGame(Options o)
    {
        var source = Vanilla.Open(o);
        var packs = new List<(string, RpfFile)>();
        if (source.SelfContained)
        {
            foreach (var name in source.Archives.Keys.OrderBy(n => n, StringComparer.OrdinalIgnoreCase))
                packs.Add((Path.GetFileNameWithoutExtension(name).ToLowerInvariant(), Vanilla.OpenArchive(source, name)!));
            return new Game(source.Info, source.Root, packs);
        }
        List<RpfFile>? installed = null;
        foreach (var (pack, archive) in Archives)
        {
            if (Vanilla.OpenArchive(source, ArchiveName(pack)) is { } own)
            {
                packs.Add((pack, own));
                continue;
            }
            installed ??= InstalledArchives(source.Root);
            var suffix = SfxDir + archive;
            var candidates = installed.SelectMany(Flatten).Where(r => r.Path.Replace('/', '\\').EndsWith(suffix, StringComparison.OrdinalIgnoreCase)).ToList();
            var rpf = candidates.FirstOrDefault(r => r.Path.StartsWith("update", StringComparison.OrdinalIgnoreCase)) ?? candidates.FirstOrDefault();
            if (rpf?.AllEntries != null) packs.Add((pack, rpf));
        }
        return new Game(source.Info, source.Root, packs);
    }

    /// <summary>update.rpf and the two sfx archives of an install.</summary>
    static List<RpfFile> InstalledArchives(string root)
    {
        var archives = new List<RpfFile>();
        if (FindPath(root, "update", "update.rpf") is { } update) archives.Add(Scan(update, @"update\update.rpf"));
        foreach (var (_, archive) in Archives)
        {
            if (FindPath(root, "x64", "audio", "sfx", archive) is { } path) archives.Add(Scan(path, SfxDir + archive));
        }
        return archives;
    }

    /// <summary>Case-insensitive path lookup (game files are mixed case; Linux/Proton file systems are not forgiving).</summary>
    internal static string? FindPath(string root, params string[] parts)
    {
        var current = root;
        foreach (var part in parts)
        {
            if (!Directory.Exists(current)) return null;
            var match = Directory.EnumerateFileSystemEntries(current)
                .FirstOrDefault(p => string.Equals(Path.GetFileName(p), part, StringComparison.OrdinalIgnoreCase));
            if (match == null) return null;
            current = match;
        }
        return File.Exists(current) ? current : null;
    }

    internal static RpfFile Scan(string path, string relPath)
    {
        Output.Progress($"Reading {relPath}");
        var rpf = new RpfFile(path, relPath);
        string? error = null;
        rpf.ScanStructure(_ => { }, e => error ??= e);
        if (rpf.AllEntries == null)
        {
            throw new BridgeException("rpf", $"Could not read {relPath}: {FirstLine(error) ?? "unknown error"}. Check that the decryption keys match this game version.");
        }
        return rpf;
    }

    static string? FirstLine(string? s) => s?.Split('\n')[0].Trim();

    internal static string FirstLineOf(string? s) => FirstLine(s) ?? "unknown error";

    /// <summary>All archives, including ones nested in update.rpf, as a flat list.</summary>
    internal static IEnumerable<RpfFile> Flatten(RpfFile rpf)
    {
        yield return rpf;
        foreach (var child in rpf.Children ?? [])
            foreach (var c in Flatten(child)) yield return c;
    }

    /// <summary>Sound banks per wave pack.</summary>
    static List<(string Pack, RpfFile Rpf, RpfFileEntry Entry)> FindBanks(Game game)
    {
        var result = new List<(string, RpfFile, RpfFileEntry)>();
        foreach (var (pack, rpf) in game.Packs)
        {
            foreach (var entry in rpf.AllEntries!.OfType<RpfFileEntry>())
            {
                if (entry.NameLower.EndsWith(".awc")) result.Add((pack, rpf, entry));
            }
        }
        if (result.Count == 0)
        {
            throw new BridgeException("no-banks", @"No weapon sound banks found under x64\audio\sfx. Is this a complete GTA V install?");
        }
        return result;
    }

    /// <summary>Calls GTA5Keys.LoadFromPath with whichever signature this CodeWalker version has.</summary>
    internal static void LoadKeys(string gtaRoot, bool gen9)
    {
        var method = typeof(GTA5Keys).GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Where(m => m.Name == "LoadFromPath")
            .OrderByDescending(m => m.GetParameters().Length)
            .FirstOrDefault() ?? throw new MissingMethodException("GTA5Keys.LoadFromPath");
        var args = method.GetParameters().Select(p => p.Name switch
        {
            "path" => gtaRoot,
            "gen9" => (object?)gen9,
            _ => p.HasDefaultValue ? p.DefaultValue : null
        }).ToArray();
        try
        {
            method.Invoke(null, args);
        }
        catch (TargetInvocationException e) when (e.InnerException is not (MissingMethodException or TypeLoadException))
        {
            throw new BridgeException("keys", $"Could not load the decryption keys from {(gen9 ? "gta5_enhanced.exe" : "gta5.exe")}: {e.InnerException?.Message}");
        }
    }

    /// <summary>Test hook: a known AWC key so encrypted fixture banks can be read without the game.</summary>
    public static void UseTestAwcKey(string base64)
    {
        var bytes = Convert.FromBase64String(base64);
        if (bytes.Length != 16) throw new BridgeException("usage", "--test-awc-key must be 16 bytes.");
        var key = new uint[4];
        Buffer.BlockCopy(bytes, 0, key, 0, 16);
        GTA5Keys.PC_AWC_KEY = key;
    }
}
