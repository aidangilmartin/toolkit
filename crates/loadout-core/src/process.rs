//! Detect (and, on request, close) running FiveM / GTA V processes.
//! Settings and mods are read when the game starts and FiveM rewrites its
//! settings when it exits, so nothing may be applied while they run.

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

pub trait ProcessProbe: Send + Sync {
    /// Names of running game processes (deduplicated, sorted).
    fn running_game_processes(&self) -> Vec<String>;
    /// Ask every game process to close. Returns how many were signalled.
    fn close_game_processes(&self) -> usize;
}

/// `FiveM.exe`, `FiveM_b3095_GTAProcess.exe`, `GTA5.exe`, `GTA5_Enhanced.exe`, `PlayGTAV.exe`…
pub fn is_game_process(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("fivem")
        || name.starts_with("gta5")
        || name.starts_with("playgtav")
        || name.starts_with("gtavlauncher")
}

/// Wait (up to `timeout`) for the process `pid` to exit. Used after an update,
/// so the new Loadout starts once the old one has closed. True if it exited.
pub fn wait_for_exit(pid: u32, timeout: std::time::Duration) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let deadline = std::time::Instant::now() + timeout;
    let mut system = System::new();
    loop {
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing(),
        );
        if system.process(pid).is_none() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

pub struct SystemProcesses;

impl SystemProcesses {
    fn snapshot() -> System {
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        system
    }
}

impl ProcessProbe for SystemProcesses {
    fn running_game_processes(&self) -> Vec<String> {
        let system = Self::snapshot();
        let mut names: Vec<String> = system
            .processes()
            .values()
            .map(|p| p.name().to_string_lossy().into_owned())
            .filter(|n| is_game_process(n))
            .collect();
        names.sort_by_key(|n| n.to_lowercase());
        names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        names
    }

    fn close_game_processes(&self) -> usize {
        let system = Self::snapshot();
        system
            .processes()
            .values()
            .filter(|p| is_game_process(&p.name().to_string_lossy()))
            .filter(|p| p.kill())
            .count()
    }
}

impl<T: ProcessProbe + ?Sized> ProcessProbe for std::sync::Arc<T> {
    fn running_game_processes(&self) -> Vec<String> {
        (**self).running_game_processes()
    }

    fn close_game_processes(&self) -> usize {
        (**self).close_game_processes()
    }
}

/// A fixed answer, for tests and the browser mock.
pub struct FakeProcesses(pub std::sync::Mutex<Vec<String>>);

impl FakeProcesses {
    pub fn none() -> Self {
        Self(std::sync::Mutex::new(Vec::new()))
    }

    pub fn set(&self, names: &[&str]) {
        *self.0.lock().unwrap() = names.iter().map(|n| n.to_string()).collect();
    }
}

impl ProcessProbe for FakeProcesses {
    fn running_game_processes(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    fn close_game_processes(&self) -> usize {
        let mut names = self.0.lock().unwrap();
        let n = names.len();
        names.clear();
        n
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn waits_for_a_process_to_exit() {
        let start = std::time::Instant::now();
        // This test's own process never exits while it waits.
        assert!(!super::wait_for_exit(
            std::process::id(),
            std::time::Duration::from_millis(250)
        ));
        assert!(start.elapsed() >= std::time::Duration::from_millis(250));
        // A process that doesn't exist has already exited.
        assert!(super::wait_for_exit(
            u32::MAX - 7,
            std::time::Duration::from_secs(5)
        ));
    }

    use super::*;

    #[test]
    fn matches_fivem_and_gta_processes_only() {
        for name in [
            "FiveM.exe",
            "FiveM_b3095_GTAProcess.exe",
            "FiveM_ChromeBrowser",
            "GTA5.exe",
            "GTA5_Enhanced.exe",
            "PlayGTAV.exe",
        ] {
            assert!(is_game_process(name), "{name}");
        }
        for name in [
            "Discord.exe",
            "RockstarService.exe",
            "Launcher.exe",
            "steam.exe",
        ] {
            assert!(!is_game_process(name), "{name}");
        }
    }

    #[test]
    fn system_probe_runs() {
        // The CI machine isn't running FiveM; this just exercises the code path.
        assert!(SystemProcesses.running_game_processes().is_empty());
    }
}
