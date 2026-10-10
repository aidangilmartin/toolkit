//! Loadout core: everything that touches GTA V / FiveM files lives here, with no UI
//! or Tauri dependency, so it can be tested on any OS against fake game folders.

pub mod app;
pub mod backup;
pub mod deploy;
pub mod error;
pub mod fivem_cfg;
pub mod fsutil;
pub mod launch;
pub mod model;
pub mod packs;
pub mod paths;
pub mod process;
pub mod schema;
pub mod server_list;
pub mod servers;
pub mod settings_xml;
pub mod store;
#[cfg(test)]
mod test_http;

pub use app::Loadout;
pub use error::{Error, Result};
