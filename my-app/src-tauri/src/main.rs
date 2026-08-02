#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if lunerylab_desktop_lib::run_keychain_read_helper_if_requested() {
        return;
    }
    lunerylab_desktop_lib::run()
}
