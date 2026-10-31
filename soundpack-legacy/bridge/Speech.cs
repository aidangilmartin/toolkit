using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Text.Json;

namespace GunpackBridge;

/// <summary>
/// Speaks short phrases to WAV files with the Windows voices, for the ID pack that replaces each
/// game sound with its spoken code. Other platforms have no voices: the app falls back to tones.
/// </summary>
public static class Speech
{
    public sealed record Phrase(string Id, string Text);

    public static object Run(Options o)
    {
        var phrases = JsonSerializer.Deserialize<List<Phrase>>(File.ReadAllText(o.Require("in")),
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
        var outDir = Path.GetFullPath(o.Require("out"));
        if (!OperatingSystem.IsWindows()) throw new BridgeException("no-tts", "Spoken labels need the Windows voices.");
        Directory.CreateDirectory(outDir);
        return Speak(phrases, outDir);
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    static object Speak(List<Phrase> phrases, string outDir)
    {
        using var synth = new SpeechSynthesizer();
        string voice;
        try
        {
            voice = synth.Voice.Name;
        }
        catch (Exception e)
        {
            throw new BridgeException("no-tts", $"No Windows voice is installed: {e.Message}");
        }
        synth.Rate = 2;
        var format = new SpeechAudioFormatInfo(22050, AudioBitsPerSample.Sixteen, AudioChannel.Mono);
        var files = new List<object>();
        var i = 0;
        foreach (var p in phrases)
        {
            if (++i % 25 == 0) Output.Progress($"Speaking labels ({i}/{phrases.Count})");
            var path = Path.Combine(outDir, $"{Safe(p.Id)}.wav");
            synth.SetOutputToWaveFile(path, format);
            synth.Speak(p.Text);
            synth.SetOutputToNull(); // closes the file
            files.Add(new { id = p.Id, path });
        }
        return new { voice, files };
    }

    static string Safe(string id) => string.Concat(id.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_'));
}
