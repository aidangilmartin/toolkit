//! Known GTA V (Legacy) `settings.xml` keys, how to present them, and presets.
//!
//! Keys are `section/Element` paths, e.g. `graphics/ShadowQuality`. Anything not
//! listed here still works: it's captured and applied verbatim through the "Raw"
//! editor. Value maps marked `verified: false` are best-effort and flagged in the UI.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SettingGroup {
    Display,
    Graphics,
    Advanced,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Control {
    Select {
        options: Vec<SelectOption>,
    },
    /// Stored as `true` / `false`.
    Toggle,
    /// Stored with six decimals, like the game does.
    Slider {
        min: f64,
        max: f64,
        step: f64,
    },
    /// Whole numbers (resolution, refresh rate).
    Number {
        min: i64,
        max: i64,
    },
}

/// Whether "capture current settings" includes the key by default.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CaptureRule {
    Default,
    /// Only when the user ticks it (resolution, DirectX version…).
    OptIn,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SettingDef {
    pub key: String,
    pub label: String,
    pub description: String,
    pub group: SettingGroup,
    pub control: Control,
    pub capture: CaptureRule,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub values: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GraphicsSchema {
    pub settings: Vec<SettingDef>,
    pub presets: Vec<Preset>,
    /// Keys that are never captured or applied (hardware identity, replay buffers…).
    pub excluded: Vec<String>,
}

/// Keys tied to the PC rather than to a play style. Never captured, never written.
const EXCLUDED: &[&str] = &[
    "version",
    "configSource",
    "VideoCardDescription",
    "video/AdapterIndex",
    "video/OutputIndex",
    "video/Stereo",
    "video/Convergence",
    "video/Separation",
];
const EXCLUDED_SECTIONS: &[&str] = &["system/", "audio/"];

pub fn is_excluded(key: &str) -> bool {
    EXCLUDED.contains(&key) || EXCLUDED_SECTIONS.iter().any(|s| key.starts_with(s))
}

fn opts(pairs: &[(&str, &str)]) -> Control {
    Control::Select {
        options: pairs
            .iter()
            .map(|(value, label)| SelectOption {
                value: (*value).into(),
                label: (*label).into(),
            })
            .collect(),
    }
}

const QUALITY_3: &[(&str, &str)] = &[("0", "Normal"), ("1", "High"), ("2", "Very High")];
const QUALITY_4: &[(&str, &str)] = &[
    ("0", "Normal"),
    ("1", "High"),
    ("2", "Very High"),
    ("3", "Ultra"),
];
const MSAA: &[(&str, &str)] = &[("0", "Off"), ("2", "2x"), ("4", "4x"), ("8", "8x")];

struct Def {
    key: &'static str,
    label: &'static str,
    description: &'static str,
    group: SettingGroup,
    control: Control,
    capture: CaptureRule,
    verified: bool,
}

fn def(
    key: &'static str,
    label: &'static str,
    description: &'static str,
    group: SettingGroup,
    control: Control,
) -> Def {
    Def {
        key,
        label,
        description,
        group,
        control,
        capture: CaptureRule::Default,
        verified: true,
    }
}

fn slider() -> Control {
    Control::Slider {
        min: 0.0,
        max: 1.0,
        step: 0.1,
    }
}

fn definitions() -> Vec<Def> {
    use SettingGroup::*;
    let mut defs = vec![
        // ---- Display -------------------------------------------------------
        def(
            "video/Windowed",
            "Screen type",
            "Fullscreen gives the most FPS; borderless makes alt-tabbing to Discord painless.",
            Display,
            opts(&[
                ("0", "Fullscreen"),
                ("1", "Windowed"),
                ("2", "Windowed borderless"),
            ]),
        ),
        def(
            "video/VSync",
            "VSync",
            "Off for lowest input lag in PvP.",
            Display,
            opts(&[("0", "Off"), ("1", "On"), ("2", "Half")]),
        ),
        def(
            "video/PauseOnFocusLoss",
            "Pause game on focus loss",
            "",
            Display,
            opts(&[("0", "Off"), ("1", "On")]),
        ),
        Def {
            capture: CaptureRule::OptIn,
            ..def(
                "video/ScreenWidth",
                "Resolution width",
                "Opt-in so profiles work on any monitor. Use with height for stretched res.",
                Display,
                Control::Number {
                    min: 640,
                    max: 7680,
                },
            )
        },
        Def {
            capture: CaptureRule::OptIn,
            ..def(
                "video/ScreenHeight",
                "Resolution height",
                "",
                Display,
                Control::Number {
                    min: 480,
                    max: 4320,
                },
            )
        },
        Def {
            capture: CaptureRule::OptIn,
            ..def(
                "video/RefreshRate",
                "Refresh rate",
                "Must be a rate your monitor supports at that resolution.",
                Display,
                Control::Number { min: 30, max: 500 },
            )
        },
        Def {
            capture: CaptureRule::OptIn,
            verified: false,
            ..def(
                "video/AspectRatio",
                "Aspect ratio",
                "",
                Display,
                opts(&[
                    ("0", "Auto"),
                    ("1", "3:2"),
                    ("2", "4:3"),
                    ("3", "5:3"),
                    ("4", "5:4"),
                    ("5", "16:9"),
                    ("6", "16:10"),
                ]),
            )
        },
        // ---- Graphics ------------------------------------------------------
        Def {
            capture: CaptureRule::OptIn,
            ..def(
                "graphics/DX_Version",
                "DirectX version",
                "Leave on DirectX 11 unless you know you need something else.",
                Graphics,
                opts(&[
                    ("0", "DirectX 10"),
                    ("1", "DirectX 10.1"),
                    ("2", "DirectX 11"),
                ]),
            )
        },
        def(
            "graphics/FXAA_Enabled",
            "FXAA",
            "Cheap anti-aliasing; slightly blurs the image.",
            Graphics,
            Control::Toggle,
        ),
        def(
            "graphics/MSAA",
            "MSAA",
            "Very expensive. Off for FPS.",
            Graphics,
            opts(MSAA),
        ),
        def(
            "graphics/TXAA_Enabled",
            "NVIDIA TXAA",
            "Only works with MSAA on an NVIDIA card.",
            Graphics,
            Control::Toggle,
        ),
        def(
            "graphics/CityDensity",
            "Population density",
            "Fewer peds and cars: big CPU win in busy servers.",
            Graphics,
            slider(),
        ),
        def(
            "graphics/PedVarietyMultiplier",
            "Ped variety",
            "",
            Graphics,
            slider(),
        ),
        def(
            "graphics/VehicleVarietyMultiplier",
            "Vehicle variety",
            "",
            Graphics,
            slider(),
        ),
        def(
            "graphics/LodScale",
            "Distance scaling",
            "How far detailed models are drawn.",
            Graphics,
            slider(),
        ),
        def(
            "graphics/TextureQuality",
            "Texture quality",
            "Mostly uses VRAM rather than FPS.",
            Graphics,
            opts(QUALITY_3),
        ),
        def(
            "graphics/ShaderQuality",
            "Shader quality",
            "",
            Graphics,
            opts(QUALITY_3),
        ),
        def(
            "graphics/ShadowQuality",
            "Shadow quality",
            "",
            Graphics,
            opts(&[("1", "Normal"), ("2", "High"), ("3", "Very High")]),
        ),
        def(
            "graphics/ReflectionQuality",
            "Reflection quality",
            "",
            Graphics,
            opts(QUALITY_4),
        ),
        def(
            "graphics/ReflectionMSAA",
            "Reflection MSAA",
            "",
            Graphics,
            opts(MSAA),
        ),
        def(
            "graphics/WaterQuality",
            "Water quality",
            "",
            Graphics,
            opts(QUALITY_3),
        ),
        def(
            "graphics/ParticleQuality",
            "Particles quality",
            "Explosions, smoke and muzzle flashes.",
            Graphics,
            opts(QUALITY_3),
        ),
        def(
            "graphics/GrassQuality",
            "Grass quality",
            "Normal draws far less grass, so players can't hide in it, and it's a big FPS win.",
            Graphics,
            opts(QUALITY_4),
        ),
        def(
            "graphics/Shadow_SoftShadows",
            "Soft shadows",
            "Sharp is cheapest. AMD CHS / NVIDIA PCSS need the matching GPU.",
            Graphics,
            opts(&[
                ("0", "Sharp"),
                ("1", "Soft"),
                ("2", "Softer"),
                ("3", "Softest"),
                ("4", "AMD CHS"),
                ("5", "NVIDIA PCSS"),
            ]),
        ),
        def(
            "graphics/PostFX",
            "Post FX",
            "Bloom, lens effects and motion blur quality.",
            Graphics,
            opts(QUALITY_4),
        ),
        def(
            "graphics/MotionBlurStrength",
            "Motion blur strength",
            "",
            Graphics,
            slider(),
        ),
        def(
            "graphics/DoF",
            "In-game depth of field",
            "",
            Graphics,
            Control::Toggle,
        ),
        def(
            "graphics/AnisotropicFiltering",
            "Anisotropic filtering",
            "Sharper textures at angles; very cheap on modern GPUs.",
            Graphics,
            opts(&[
                ("0", "Off"),
                ("2", "2x"),
                ("4", "4x"),
                ("8", "8x"),
                ("16", "16x"),
            ]),
        ),
        def(
            "graphics/SSAO",
            "Ambient occlusion",
            "",
            Graphics,
            opts(&[("0", "Off"), ("1", "Normal"), ("2", "High")]),
        ),
        def(
            "graphics/Tessellation",
            "Tessellation",
            "",
            Graphics,
            opts(&[
                ("0", "Off"),
                ("1", "Normal"),
                ("2", "High"),
                ("3", "Very High"),
            ]),
        ),
        // ---- Advanced ------------------------------------------------------
        def(
            "graphics/UltraShadows_Enabled",
            "High resolution shadows",
            "",
            Advanced,
            Control::Toggle,
        ),
        def(
            "graphics/Shadow_LongShadows",
            "Long shadows",
            "",
            Advanced,
            Control::Toggle,
        ),
        def(
            "graphics/HdStreamingInFlight",
            "High detail streaming while flying",
            "",
            Advanced,
            Control::Toggle,
        ),
        def(
            "graphics/MaxLodScale",
            "Extended distance scaling",
            "Very heavy on CPU and GPU.",
            Advanced,
            slider(),
        ),
        def(
            "graphics/Shadow_ParticleShadows",
            "Particle shadows",
            "",
            Advanced,
            Control::Toggle,
        ),
        def(
            "graphics/Reflection_MipBlur",
            "Reflection mip blur",
            "",
            Advanced,
            Control::Toggle,
        ),
        def(
            "graphics/Lighting_FogVolumes",
            "Fog volumes",
            "",
            Advanced,
            Control::Toggle,
        ),
        Def {
            verified: false,
            ..def(
                "graphics/SamplingMode",
                "Frame scaling mode",
                "Renders below/above your resolution. Check the result in-game.",
                Advanced,
                opts(&[
                    ("0", "Off"),
                    ("1", "1/2"),
                    ("2", "2/3"),
                    ("3", "3/4"),
                    ("4", "5/6"),
                    ("5", "5/4"),
                    ("6", "3/2"),
                    ("7", "7/4"),
                    ("8", "2/1"),
                    ("9", "5/2"),
                ]),
            )
        },
    ];
    defs.shrink_to_fit();
    defs
}

/// Values shared by the presets, in `(key, max_fps, balanced, high, ultra)` form.
const PRESET_TABLE: &[(&str, [&str; 4])] = &[
    ("graphics/TextureQuality", ["0", "1", "2", "2"]),
    ("graphics/ShaderQuality", ["0", "1", "2", "2"]),
    ("graphics/ShadowQuality", ["1", "2", "3", "3"]),
    ("graphics/ReflectionQuality", ["0", "1", "2", "3"]),
    ("graphics/ReflectionMSAA", ["0", "0", "2", "4"]),
    ("graphics/WaterQuality", ["0", "1", "2", "2"]),
    ("graphics/ParticleQuality", ["0", "1", "2", "2"]),
    ("graphics/GrassQuality", ["0", "1", "2", "3"]),
    ("graphics/Shadow_SoftShadows", ["0", "1", "2", "3"]),
    ("graphics/PostFX", ["0", "1", "2", "3"]),
    ("graphics/MotionBlurStrength", ["0", "0", "0", "0"]),
    ("graphics/DoF", ["false", "false", "true", "true"]),
    ("graphics/AnisotropicFiltering", ["16", "16", "16", "16"]),
    ("graphics/SSAO", ["0", "1", "2", "2"]),
    ("graphics/Tessellation", ["0", "1", "2", "3"]),
    ("graphics/FXAA_Enabled", ["false", "true", "true", "true"]),
    ("graphics/MSAA", ["0", "0", "0", "2"]),
    (
        "graphics/TXAA_Enabled",
        ["false", "false", "false", "false"],
    ),
    ("graphics/CityDensity", ["0", "0.5", "0.8", "1"]),
    ("graphics/PedVarietyMultiplier", ["0", "0.5", "0.8", "1"]),
    (
        "graphics/VehicleVarietyMultiplier",
        ["0", "0.5", "0.8", "1"],
    ),
    ("graphics/LodScale", ["0", "0.5", "0.8", "1"]),
    ("graphics/MaxLodScale", ["0", "0", "0.3", "0.5"]),
    (
        "graphics/HdStreamingInFlight",
        ["false", "false", "true", "true"],
    ),
    (
        "graphics/Shadow_LongShadows",
        ["false", "false", "true", "true"],
    ),
    (
        "graphics/UltraShadows_Enabled",
        ["false", "false", "false", "true"],
    ),
    (
        "graphics/Shadow_ParticleShadows",
        ["false", "true", "true", "true"],
    ),
    (
        "graphics/Reflection_MipBlur",
        ["false", "true", "true", "true"],
    ),
    (
        "graphics/Lighting_FogVolumes",
        ["false", "true", "true", "true"],
    ),
];

fn presets(settings: &[SettingDef]) -> Vec<Preset> {
    let meta = [
        (
            "max-fps",
            "Max FPS (PvP)",
            "Everything low, grass on Normal, no blur. For arena and PvP servers.",
        ),
        (
            "balanced",
            "Balanced",
            "Decent looks with steady frame rates in busy cities.",
        ),
        (
            "high",
            "High (RP)",
            "Good-looking roleplay on a mid/high-end PC.",
        ),
        (
            "ultra",
            "Ultra (cinematic)",
            "Maximum quality for screenshots and slow-paced RP.",
        ),
    ];
    meta.iter()
        .enumerate()
        .map(|(i, (id, name, description))| Preset {
            id: (*id).into(),
            name: (*name).into(),
            description: (*description).into(),
            values: PRESET_TABLE
                .iter()
                .map(|(key, values)| {
                    let canonical = canonicalize_with(settings, key, values[i])
                        .expect("preset values are valid");
                    ((*key).to_string(), canonical)
                })
                .collect(),
        })
        .collect()
}

static SCHEMA: OnceLock<GraphicsSchema> = OnceLock::new();

pub fn schema() -> &'static GraphicsSchema {
    SCHEMA.get_or_init(|| {
        let settings: Vec<SettingDef> = definitions()
            .into_iter()
            .map(|d| SettingDef {
                key: d.key.into(),
                label: d.label.into(),
                description: d.description.into(),
                group: d.group,
                control: d.control,
                capture: d.capture,
                verified: d.verified,
            })
            .collect();
        // Presets are validated against the local list: calling `schema()` here
        // would re-enter this OnceLock and deadlock.
        let presets = presets(&settings);
        GraphicsSchema {
            settings,
            presets,
            excluded: EXCLUDED.iter().map(|s| (*s).to_string()).collect(),
        }
    })
}

pub fn find(key: &str) -> Option<&'static SettingDef> {
    schema().settings.iter().find(|s| s.key == key)
}

/// Element-path syntax: `Element` or `section/Element`, XML-name characters only.
pub fn is_valid_key(key: &str) -> bool {
    let parts: Vec<&str> = key.split('/').collect();
    !key.is_empty()
        && parts.len() <= 2
        && parts.iter().all(|p| {
            let mut chars = p.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        })
}

/// Validate a value and return it in the exact form the game writes.
pub fn canonicalize(key: &str, value: &str) -> Result<String, String> {
    canonicalize_with(&schema().settings, key, value)
}

fn canonicalize_with(settings: &[SettingDef], key: &str, value: &str) -> Result<String, String> {
    if !is_valid_key(key) {
        return Err(format!("\"{key}\" isn't a valid setting name"));
    }
    if is_excluded(key) {
        return Err(format!(
            "{key} is tied to your PC and can't be part of a profile"
        ));
    }
    let value = value.trim();
    let Some(def) = settings.iter().find(|s| s.key == key) else {
        // Raw key: accept anything that's safe to put in an XML attribute.
        if value.is_empty() || value.len() > 120 || value.chars().any(|c| c.is_control()) {
            return Err(format!("{key}: \"{value}\" isn't a valid value"));
        }
        return Ok(value.to_string());
    };
    match &def.control {
        Control::Select { options } => options
            .iter()
            .find(|o| o.value == value)
            .map(|o| o.value.clone())
            .ok_or_else(|| {
                format!(
                    "{}: \"{value}\" isn't one of the allowed options",
                    def.label
                )
            }),
        Control::Toggle => match value.to_ascii_lowercase().as_str() {
            "true" | "1" => Ok("true".into()),
            "false" | "0" => Ok("false".into()),
            _ => Err(format!("{}: expected true or false", def.label)),
        },
        Control::Slider { min, max, .. } => {
            let v: f64 = value
                .parse()
                .map_err(|_| format!("{}: \"{value}\" isn't a number", def.label))?;
            if !v.is_finite() || v < *min - 1e-9 || v > *max + 1e-9 {
                return Err(format!("{}: must be between {min} and {max}", def.label));
            }
            Ok(format!("{v:.6}"))
        }
        Control::Number { min, max } => {
            let v: i64 = value
                .parse()
                .map_err(|_| format!("{}: \"{value}\" isn't a whole number", def.label))?;
            if v < *min || v > *max {
                return Err(format!("{}: must be between {min} and {max}", def.label));
            }
            Ok(v.to_string())
        }
    }
}

/// The values "capture current settings" puts in a new profile: every graphics
/// key plus the display keys that aren't opt-in. Hardware keys are skipped.
pub fn capture_defaults(all: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    all.iter()
        .filter(|(key, _)| !is_excluded(key))
        .filter(|(key, _)| match find(key) {
            Some(def) => def.capture == CaptureRule::Default,
            None => key.starts_with("graphics/"),
        })
        .filter_map(|(key, value)| {
            canonicalize(key, value)
                .ok()
                .map(|canonical| (key.clone(), canonical))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_cover_the_same_keys_and_are_valid() {
        let schema = schema();
        assert_eq!(schema.presets.len(), 4);
        for preset in &schema.presets {
            assert_eq!(preset.values.len(), PRESET_TABLE.len(), "{}", preset.id);
            for (key, value) in &preset.values {
                assert!(find(key).is_some(), "{key} must be in the schema");
                assert_eq!(&canonicalize(key, value).unwrap(), value);
            }
        }
    }

    #[test]
    fn schema_keys_are_unique_and_valid() {
        let mut seen = std::collections::BTreeSet::new();
        for def in &schema().settings {
            assert!(is_valid_key(&def.key), "{}", def.key);
            assert!(seen.insert(def.key.clone()), "duplicate {}", def.key);
            assert!(!is_excluded(&def.key));
        }
    }

    #[test]
    fn canonicalize_formats_like_the_game() {
        assert_eq!(
            canonicalize("graphics/LodScale", "0.5").unwrap(),
            "0.500000"
        );
        assert_eq!(canonicalize("graphics/DoF", "1").unwrap(), "true");
        assert_eq!(canonicalize("graphics/ShadowQuality", "3").unwrap(), "3");
        assert!(canonicalize("graphics/ShadowQuality", "7").is_err());
        assert!(canonicalize("graphics/LodScale", "1.5").is_err());
        assert!(canonicalize("video/ScreenWidth", "1440").is_ok());
        assert!(canonicalize("VideoCardDescription", "x").is_err());
        assert_eq!(
            canonicalize("graphics/PedLodBias", "0.200000").unwrap(),
            "0.200000"
        );
        assert!(canonicalize("graphics/<bad>", "1").is_err());
        assert!(canonicalize("a/b/c", "1").is_err());
    }

    #[test]
    fn capture_skips_hardware_and_opt_in_keys() {
        let all: BTreeMap<String, String> = [
            ("version", "27"),
            ("configSource", "SMC_AUTO"),
            ("VideoCardDescription", "GPU"),
            ("video/AdapterIndex", "0"),
            ("video/ScreenWidth", "1920"),
            ("video/Windowed", "2"),
            ("graphics/ShadowQuality", "3"),
            ("graphics/PedLodBias", "0.200000"),
            ("system/numReplayBlocks", "36"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let captured = capture_defaults(&all);
        let keys: Vec<&str> = captured.keys().map(|k| k.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                "graphics/PedLodBias",
                "graphics/ShadowQuality",
                "video/Windowed"
            ]
        );
    }
}
