use std::path::Path;

fn main() {
    embed_bridge();
    tauri_build::build()
}

/// Builds the CodeWalker bridge into the exe when `pnpm build:bridge` has put it in
/// `src-tauri/bridge/`. Without it the app still builds; the sound maker then says the
/// bridge is missing.
fn embed_bridge() {
    println!("cargo::rustc-check-cfg=cfg(embedded_bridge)");
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("bridge");
    let target_windows = std::env::var("CARGO_CFG_WINDOWS").is_ok();
    let exe = dir.join(if target_windows {
        "gunpack-bridge.exe"
    } else {
        "gunpack-bridge"
    });
    let strings = dir.join("strings.txt");
    println!("cargo::rerun-if-changed={}", exe.display());
    println!("cargo::rerun-if-changed={}", strings.display());
    if exe.is_file() && strings.is_file() {
        println!("cargo::rustc-cfg=embedded_bridge");
        println!("cargo::rustc-env=LOADOUT_BRIDGE_EXE={}", exe.display());
        println!(
            "cargo::rustc-env=LOADOUT_BRIDGE_STRINGS={}",
            strings.display()
        );
    } else if std::env::var("LOADOUT_REQUIRE_BRIDGE").is_ok() {
        panic!(
            "LOADOUT_REQUIRE_BRIDGE is set but {} or strings.txt is missing. Run `pnpm build:bridge` first.",
            exe.display()
        );
    }
}
