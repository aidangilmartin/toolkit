using System.Reflection;
using CodeWalker.GameFiles;

namespace GunpackBridge;

/// <summary>
/// CodeWalker types whose names changed between the builds players download. Looked up by name so
/// the bridge works with either: e.g. Dat151WeaponAudioSettings (dev48, March 2025) was renamed
/// Dat151WeaponSettings in April 2025.
/// </summary>
public static class CodeWalkerCompat
{
    public static readonly Type WeaponSettings = Find("Dat151WeaponSettings", "Dat151WeaponAudioSettings");

    public static bool IsWeaponSettings(RelData? rd) => rd is not null && WeaponSettings.IsInstanceOfType(rd);

    static Type Find(params string[] names)
    {
        var asm = typeof(RelData).Assembly;
        foreach (var n in names)
            if (asm.GetType($"CodeWalker.GameFiles.{n}") is { } t) return t;
        throw new TypeLoadException(
            $"This CodeWalker build has none of {string.Join(", ", names)}. Download a newer CodeWalker build.");
    }
}
