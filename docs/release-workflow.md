# Release Workflow

Nocturne publishes desktop installers from GitHub tags through `.github/workflows/release.yml`.

## Trigger

The workflow runs when a pushed tag has at least three dot-separated segments, then validates the tag with a strict semver check. Supported release tags are:

- `v1.2.3`
- `1.2.3`
- `v1.2.3-beta.1`
- `1.2.3-beta.1`

Tags that match the broad GitHub glob but fail semver validation stop before any release is created.

## Version Source

The tag is the release version source. During CI, the workflow strips an optional leading `v` and updates these checked-out files before building:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

This keeps local development versions stable while ensuring generated installer metadata and filenames match the pushed tag.

The base Tauri config keeps the production app identifier `com.mslxl.nocturne` so build artifacts and release asset discovery agree on production filenames. Development Tauri runs merge `src-tauri/tauri.dev.conf.json`, which overrides the identifier to `com.mslxl.nocturne.dev`.

## Build Matrix

The release builds the common desktop installer formats:

- macOS Apple Silicon: `dmg`
- macOS Intel: `dmg`
- Windows x64: `msi`, `exe` through NSIS
- Linux x64: `AppImage`, `deb`, `rpm`

Tauri's bundle target is set to `all` in `src-tauri/tauri.conf.json`, while the workflow passes platform-specific `--bundles` arguments so each runner only builds formats supported for its OS.

Each generated installer file is uploaded as its own GitHub Release asset. Asset names include the app name, version, platform, architecture, and setup marker when applicable.

macOS DMG builds pass Tauri's `--ci` flag and set `CI=true` explicitly. The DMG bundler generates and runs `bundle_dmg.sh`; CI mode keeps that script non-interactive and avoids CI-unsafe Finder scripting during DMG layout. If a macOS DMG job fails, the workflow prints the generated DMG directory and `bundle_dmg.sh` contents so the failing `hdiutil` or packaging command is visible in the GitHub Actions log instead of only reporting `failed to run bundle_dmg.sh`.

MSI packages require a numeric-only WiX `ProductVersion`. For prerelease semver tags, CI keeps the app version as the tag version but maps the MSI-only version to `major.minor.patch.build`, with prerelease channels using reserved build ranges:

- `alpha.N` -> `10000 + N`
- `beta.N` -> `20000 + N`
- `rc.N` -> `30000 + N`
- other prerelease labels -> `40000 + N`

For example, `v0.0.1-alpha.1` builds the app as `0.0.1-alpha.1` and the MSI package as `0.0.1.10001`.

## Changelog

Release notes are generated from the previous non-draft GitHub Release tag to the current tag using first-parent commit subjects. If there is no previous release tag, the workflow lists the current tag's first-parent history as the initial release notes.

Prerelease tags, such as `v1.2.3-beta.1`, are marked as GitHub prereleases automatically.

The same changelog content is uploaded as `CHANGELOG-<tag>.md` to the tag's release assets.

## Build Optimization

Release builds use the Cargo release profile in `src-tauri/Cargo.toml` with Thin LTO, a single codegen unit, size-oriented optimization, symbol stripping, and abort-on-panic. These settings keep installer size down without requiring a custom build command outside Tauri.
