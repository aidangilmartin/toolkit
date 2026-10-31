using System.Reflection;
using System.Text.Json;

namespace GunpackBridge;

/// <summary>
/// Command-line bridge between Gun Soundpack Maker and CodeWalker.Core: opens the user's GTA V
/// archives and extracts the weapon sound banks. Prints one JSON object on stdout; progress goes to
/// stderr as JSON lines.
/// </summary>
public static class Program
{
    public static int Main(string[] args)
    {
        Options opts;
        try
        {
            opts = Options.Parse(args);
        }
        catch (BridgeException e)
        {
            return Output.Fail(e.Code, e.Message);
        }

        try
        {
            if (opts.Command is "help" or "--help" or "")
            {
                Console.Error.WriteLine(Usage);
                return 0;
            }
            object result = opts.Command switch
            {
                "probe" => Commands.Probe(opts),
                "list" => Commands.List(opts),
                "extract" => Commands.Extract(opts),
                "scan" => GameScan.Run(opts),
                "build-rpf" => RpfBuild.Run(opts),
                "speak" => Speech.Run(opts),
                "make-test-game" => TestGame.Make(opts),
                "make-vanilla-pack" => Vanilla.Make(opts),
                "inspect-vanilla" => Vanilla.Inspect(opts),
                "zip" => Vanilla.Zip(opts),
                "unzip" => Vanilla.Unzip(opts),
                _ => throw new BridgeException("usage", $"Unknown command '{opts.Command}'.\n{Usage}")
            };
            Output.Write(new { ok = true, result });
            return 0;
        }
        catch (Exception e)
        {
            var ex = e is TargetInvocationException { InnerException: not null } t ? t.InnerException! : e;
            if (ex is BridgeException b) return Output.Fail(b.Code, b.Message);
            if (ex is MissingMethodException or MissingFieldException or TypeLoadException)
            {
                return Output.Fail("codewalker-incompatible", $"Internal CodeWalker error: {ex.Message}");
            }
            return Output.Fail("error", ex.Message);
        }
    }

    const string Usage = """
        Usage: gunpack-bridge <command> [options]
          probe   --gta <GTA V folder>                      check the game folder and decryption keys
          scan    --gta <GTA V folder> --out <dir> [--names <file>]
                                                            index every gun's sounds, map what every sound is for
                                                            and extract the gun banks
          build-rpf --gta <GTA V folder> --out <dir> --bank <pack>/<bank>=<file.awc>... [--bank-list <file>]
                                                            rebuild WEAPONS_PLAYER.rpf / RESIDENT.rpf (OPEN) with replaced banks
          speak   --in <phrases.json> --out <dir>           speak each phrase to a WAV file (Windows voices)
          list    --gta <GTA V folder>                      list weapon sound banks
          extract --gta <GTA V folder> --out <dir> [--bank <pack>/<file>]...
                                                            extract banks as unencrypted .awc files
          make-vanilla-pack --gta <GTA V folder> --out <dir>
                                                            write a self-contained vanilla pack (unencrypted
                                                            archives + gun data) that works without GTA V
          inspect-vanilla --in <dir>                        what kind of vanilla pack a folder holds
          zip     --in <dir> --out <file.zip>               zip a folder (a vanilla pack)
          unzip   --in <file.zip> --out <dir>               unzip a vanilla pack

        Instead of --gta, every command that reads sounds takes --vanilla <dir> with a self-contained
        pack. With --gta, --vanilla <dir> holding original WEAPONS_PLAYER.rpf / RESIDENT.rpf replaces
        the install's archives.
        """;
}

public sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

public static class Output
{
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static string Serialize(object value) => JsonSerializer.Serialize(value, Json);

    static readonly JsonSerializerOptions CompactJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    /// <summary>Like <see cref="Serialize"/> but leaves out null fields (for large files).</summary>
    public static string SerializeCompact(object value) => JsonSerializer.Serialize(value, CompactJson);

    public static void Write(object value) => Console.Out.WriteLine(Serialize(value));

    public static int Fail(string code, string message)
    {
        Write(new { ok = false, code, error = message });
        return 1;
    }

    public static void Progress(string message) =>
        Console.Error.WriteLine(JsonSerializer.Serialize(new { progress = message }, Json));
}

public sealed class Options
{
    public string Command { get; private init; } = "";
    readonly Dictionary<string, List<string>> values = new();
    readonly HashSet<string> flags = new();

    static readonly HashSet<string> FlagNames = ["no-keys", "gen9", "whole-file"];

    public static Options Parse(string[] args)
    {
        var o = new Options { Command = args.Length > 0 ? args[0] : "" };
        for (var i = 1; i < args.Length; i++)
        {
            var a = args[i];
            if (!a.StartsWith("--")) throw new BridgeException("usage", $"Unexpected argument '{a}'.");
            var name = a[2..];
            if (FlagNames.Contains(name))
            {
                o.flags.Add(name);
                continue;
            }
            if (i + 1 >= args.Length) throw new BridgeException("usage", $"Missing value for --{name}.");
            if (!o.values.TryGetValue(name, out var list)) o.values[name] = list = [];
            list.Add(args[++i]);
        }
        return o;
    }

    public string? Get(string name) => values.TryGetValue(name, out var v) ? v[^1] : null;
    public IReadOnlyList<string> All(string name) => values.TryGetValue(name, out var v) ? v : [];
    public bool Flag(string name) => flags.Contains(name);

    public string Require(string name) =>
        Get(name) ?? throw new BridgeException("usage", $"Missing --{name}.");
}
