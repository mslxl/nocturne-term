/*
 * Test content:
 *
 * Feature:
 * Verifies Rust-side Resource Monitor settings parsing.
 *
 * Operation:
 * Parses empty, valid, invalid, and wrongly typed TOML config values through
 * the Resource Monitor settings parser without launching a Tauri WebView.
 *
 * Expected:
 * Resource Monitor settings default to a 2s refresh interval, accept only
 * 1s, 2s, 5s, and 10s string values, and reject unsupported or non-string
 * `resources.default_refresh_interval` values with visible errors.
 */
use nocturne_lib::{resource_settings_from_config_for_test, ResourceRefreshInterval};

#[test]
fn resource_settings_default_to_two_seconds() {
    let config = toml::from_str("").expect("empty TOML config");
    let settings = resource_settings_from_config_for_test(&config).expect("resource settings");

    assert_eq!(
        settings.default_refresh_interval,
        ResourceRefreshInterval::TwoSeconds
    );
}

#[test]
fn resource_settings_accept_fixed_refresh_intervals() {
    for (value, expected) in [
        ("1s", ResourceRefreshInterval::OneSecond),
        ("2s", ResourceRefreshInterval::TwoSeconds),
        ("5s", ResourceRefreshInterval::FiveSeconds),
        ("10s", ResourceRefreshInterval::TenSeconds),
    ] {
        let config = toml::from_str(&format!(
            r#"
            [resources]
            default_refresh_interval = "{value}"
            "#
        ))
        .expect("resource TOML config");

        let settings = resource_settings_from_config_for_test(&config).expect("resource settings");

        assert_eq!(settings.default_refresh_interval, expected);
    }
}

#[test]
fn resource_settings_reject_invalid_refresh_interval_values() {
    let config = toml::from_str(
        r#"
        [resources]
        default_refresh_interval = "3s"
        "#,
    )
    .expect("resource TOML config");

    let error = resource_settings_from_config_for_test(&config)
        .expect_err("invalid refresh interval should fail");

    assert!(
        error
            .to_string()
            .contains("resources.default_refresh_interval must be 1s, 2s, 5s, or 10s"),
        "unexpected error: {error}"
    );
}

#[test]
fn resource_settings_reject_non_string_refresh_interval_values() {
    let config = toml::from_str(
        r#"
        [resources]
        default_refresh_interval = 2
        "#,
    )
    .expect("resource TOML config");

    let error = resource_settings_from_config_for_test(&config)
        .expect_err("typed refresh interval should fail");

    assert!(
        error
            .to_string()
            .contains("resources.default_refresh_interval must be a string"),
        "unexpected error: {error}"
    );
}
