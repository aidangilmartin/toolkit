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

    /// <summary>
    /// A property read by reflection, under its current name or the older names earlier builds used
    /// (dev48 still calls some category fields Unk01, Unk03…).
    /// </summary>
    public static object? Get(object o, params string[] names)
    {
        foreach (var n in names)
            if (o.GetType().GetProperty(n, BindingFlags.Public | BindingFlags.Instance) is { } p) return p.GetValue(o);
        foreach (var n in names)
            if (o.GetType().GetField(n, BindingFlags.Public | BindingFlags.Instance) is { } f) return f.GetValue(o);
        throw new MissingFieldException(o.GetType().Name, names[0]);
    }

    public static int GetInt(object o, params string[] names) => Convert.ToInt32(Get(o, names));

    public static uint GetHash(object o, params string[] names) =>
        Get(o, names) switch { MetaHash h => h.Hash, var v => Convert.ToUInt32(v) };

    // Dat22Category fields: current name, then dev48's
    public static uint LpfCurve(Dat22Category c) => GetHash(c, "LPFDistanceCurve", "LPFCutoffCurve");
    public static uint HpfCurve(Dat22Category c) => GetHash(c, "HPFDistanceCurve", "HPFCutoffCurve");

    static Type Find(params string[] names)
    {
        var asm = typeof(RelData).Assembly;
        foreach (var n in names)
            if (asm.GetType($"CodeWalker.GameFiles.{n}") is { } t) return t;
        throw new TypeLoadException(
            $"This CodeWalker build has none of {string.Join(", ", names)}. Download a newer CodeWalker build.");
    }
}
