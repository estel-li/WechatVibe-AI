fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_set_theme",
            "desktop_copy_draft",
            "desktop_save_assistant_export",
            "desktop_exit_app",
            "desktop_get_app_version",
            "desktop_get_model_download_state",
            "desktop_download_laya_model",
            "desktop_choose_model_directory",
            "desktop_choose_data_root",
            "desktop_check_for_updates",
            "desktop_get_update_state",
            "desktop_begin_update",
            "desktop_rollback_update",
            "desktop_report_ui_ready",
            "desktop_open_doc",
            "desktop_window_action",
        ]),
    ))
    .expect("failed to build Tauri resources");
}
