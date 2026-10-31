using System.Reflection;
using CodeWalker.GameFiles;

namespace GunpackBridge;

/// <summary>
/// Builds a fake GTA V folder with unencrypted ("OPEN") archives holding the given banks, so the
/// extraction path can be tested without game files. Optionally AWC-encrypts banks with a test key.
/// </summary>
public static class TestGame
{
    public static object Make(Options o)
    {
        var root = Path.GetFullPath(o.Require("out"));
        var sfx = Path.Combine(root, "x64", "audio", "sfx");
        Directory.CreateDirectory(sfx);
        File.WriteAllBytes(Path.Combine(root, "gta5.exe"), [0x4d, 0x5a]);
        if (o.Get("test-awc-key") is { } key) Commands.UseTestAwcKey(key);

        var made = new List<string>();
        foreach (var (pack, option) in new[] { ("weapons_player", "weapons-player-awc"), ("resident", "resident-awc") })
        {
            var files = o.All(option);
            if (files.Count == 0) continue;
            var path = Path.Combine(sfx, pack.ToUpperInvariant() + ".rpf");
            var rpf = RpfBuild.CreateArchive(path, @"x64\audio\sfx\" + pack.ToUpperInvariant() + ".rpf");
            foreach (var file in files)
            {
                var data = File.ReadAllBytes(file);
                if (o.Get("test-awc-key") != null) data = Encrypt(data, Path.GetFileName(file), o.Flag("whole-file"));
                RpfFile.CreateFile(rpf.Root, Path.GetFileName(file).ToLowerInvariant(), data);
                made.Add($"{pack}/{Path.GetFileName(file).ToLowerInvariant()}");
            }
        }
        // audio metadata (.rel) from CodeWalker rel XML, as in x64\audio\audio_rel.rpf
        var rels = o.All("rel");
        if (rels.Count > 0)
        {
            var rpf = RpfBuild.CreateArchive(Path.Combine(root, "x64", "audio", "audio_rel.rpf"), @"x64\audio\audio_rel.rpf");
            foreach (var file in rels)
            {
                var rel = XmlRel.GetRel(File.ReadAllText(file));
                var name = Path.GetFileName(file);
                if (name.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
                RpfFile.CreateFile(rpf.Root, name, rel.Save());
                made.Add($"audio_rel/{name}");
            }
        }
        // weapon definitions, as in common.rpf\data\ai\weapons.meta
        if (o.Get("weapons-meta") is { } meta)
        {
            var rpf = RpfBuild.CreateArchive(Path.Combine(root, "common.rpf"), "common.rpf");
            var dir = RpfFile.CreateDirectory(RpfFile.CreateDirectory(rpf.Root, "data"), "ai");
            RpfFile.CreateFile(dir, "weapons.meta", File.ReadAllBytes(meta));
            made.Add("common/weapons.meta");
        }
        // animation clip dictionaries from CodeWalker YCD XML, as in x64c.rpf\anim\
        var ycds = o.All("ycd-xml");
        if (ycds.Count > 0)
        {
            var rpf = RpfBuild.CreateArchive(Path.Combine(root, "x64c.rpf"), "x64c.rpf");
            var dir = RpfFile.CreateDirectory(rpf.Root, "anim");
            foreach (var file in ycds)
            {
                var ycd = XmlYcd.GetYcd(File.ReadAllText(file));
                var name = Path.GetFileName(file);
                if (name.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)) name = name[..^4];
                RpfFile.CreateFile(dir, name, ycd.Save());
                made.Add($"anim/{name}");
            }
        }
        return new { root, banks = made };
    }

    static byte[] Encrypt(byte[] data, string name, bool wholeFile)
    {
        var awc = new AwcFile();
        awc.Load(data, new RpfBinaryFileEntry { Name = name, NameLower = name.ToLowerInvariant() });
        if (wholeFile) awc.WholeFileEncrypted = true;
        else awc.SingleChannelEncryptFlag = true;
        awc.BuildStreamInfos();
        return awc.Save();
    }
}
