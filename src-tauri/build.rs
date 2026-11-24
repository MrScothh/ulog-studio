fn main() {
    // Repository that publishes the releases used by the auto-updater ("owner/name").
    // Set ULOG_UPDATE_REPO at build time or put it in ../update-repo.txt.
    println!("cargo:rerun-if-env-changed=ULOG_UPDATE_REPO");
    println!("cargo:rerun-if-changed=../update-repo.txt");
    let repo = std::env::var("ULOG_UPDATE_REPO")
        .ok()
        .or_else(|| std::fs::read_to_string("../update-repo.txt").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| s.contains('/'))
        .unwrap_or_else(|| "OWNER/REPO".to_string());
    println!("cargo:rustc-env=ULOG_UPDATE_REPO={repo}");
    tauri_build::build()
}
