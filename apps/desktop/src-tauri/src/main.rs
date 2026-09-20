#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 启动桌面宿主，生命周期与通信逻辑集中在库入口。
fn main() {
    tilot_desktop::run();
}
