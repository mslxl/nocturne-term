/*
 * Test content:
 *
 * Feature:
 * Verifies Files recursive search behavior that is backed by ripgrep.
 *
 * Operation:
 * Builds remote ripgrep commands for name and content search with hidden,
 * no-ignore, and symlink options enabled, then parses representative
 * `rg --json` match output containing a content line and submatch ranges.
 *
 * Expected:
 * Name search uses `rg --files`, content search uses `rg --json`, every search
 * option is mapped to the correct ripgrep flag, shell arguments are quoted
 * safely, and JSON matches preserve the file path, file name, line number,
 * line text, and highlight ranges for the Files result view.
 */

use nocturne_lib::{
    build_remote_ripgrep_command_for_test, parse_remote_ripgrep_json_matches_for_test,
    FileEntryKind, FileSearchMode,
};

#[test]
fn remote_ripgrep_name_search_uses_files_command_with_options() {
    let command = build_remote_ripgrep_command_for_test(
        FileSearchMode::Name,
        "/home/me/project's files",
        "server",
        true,
        true,
        true,
    );

    assert_eq!(
        command,
        "rg --files --hidden --no-ignore --follow -- '/home/me/project'\"'\"'s files'"
    );
}

#[test]
fn remote_ripgrep_content_search_uses_json_command_with_quoted_query_and_root() {
    let command = build_remote_ripgrep_command_for_test(
        FileSearchMode::Content,
        "/home/me/project",
        "needle's value",
        true,
        true,
        true,
    );

    assert_eq!(
        command,
        "rg --json --hidden --no-ignore --follow -- 'needle'\"'\"'s value' '/home/me/project'"
    );
}

#[test]
fn remote_ripgrep_json_parser_preserves_content_match_details() {
    let json_lines = r#"{"type":"begin","data":{"path":{"text":"/home/me/project/src/main.rs"}}}
{"type":"match","data":{"path":{"text":"/home/me/project/src/main.rs"},"lines":{"text":"let needle = value;\n"},"line_number":42,"absolute_offset":128,"submatches":[{"match":{"text":"needle"},"start":4,"end":10}]}}
{"type":"end","data":{"path":{"text":"/home/me/project/src/main.rs"},"binary_offset":null,"stats":{"elapsed":{"secs":0,"nanos":1000,"human":"0.000001s"},"searches":1,"searches_with_match":1,"bytes_searched":19,"bytes_printed":252,"matched_lines":1,"matches":1}}}
"#;

    let (matches, truncated, diagnostics) =
        parse_remote_ripgrep_json_matches_for_test(json_lines, 20);

    assert!(!truncated);
    assert!(diagnostics.is_empty());
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].path, "/home/me/project/src/main.rs");
    assert_eq!(matches[0].name, "main.rs");
    assert_eq!(matches[0].kind, FileEntryKind::File);
    assert_eq!(matches[0].line_number, Some(42));
    assert_eq!(matches[0].line_text.as_deref(), Some("let needle = value;"));
    assert_eq!(matches[0].ranges.len(), 1);
    assert_eq!(matches[0].ranges[0].start, 4);
    assert_eq!(matches[0].ranges[0].end, 10);
}

#[test]
fn remote_ripgrep_json_parser_reports_truncation_at_limit() {
    let json_lines = r#"{"type":"match","data":{"path":{"text":"/tmp/a.txt"},"lines":{"text":"a\n"},"line_number":1,"submatches":[{"match":{"text":"a"},"start":0,"end":1}]}}
{"type":"match","data":{"path":{"text":"/tmp/b.txt"},"lines":{"text":"b\n"},"line_number":1,"submatches":[{"match":{"text":"b"},"start":0,"end":1}]}}
"#;

    let (matches, truncated, diagnostics) =
        parse_remote_ripgrep_json_matches_for_test(json_lines, 1);

    assert!(truncated);
    assert!(diagnostics.is_empty());
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].path, "/tmp/a.txt");
}
