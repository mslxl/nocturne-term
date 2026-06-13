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

The Tauri build script embeds two diagnostic values into the binary:

- `NOCTURNE_BUILD_COMMIT`: the current Git commit id
- `NOCTURNE_BUILD_TAG`: the exact current Git tag, or empty for untagged builds

Resource Monitor helper downloads rely on `NOCTURNE_BUILD_TAG`. If the app is not built from an exact release tag, missing Resource Monitor helper binaries are reported as unavailable instead of downloading from GitHub. Files ripgrep helper downloads do not use Nocturne release tags; they use the locked `RIPGREP_VERSION` and download from the official `BurntSushi/ripgrep` release for that exact version.

## Build Matrix

The release builds the common desktop installer formats:

- macOS Apple Silicon: `dmg`
- macOS Intel: `dmg`
- Windows x64: `msi`, `exe` through NSIS
- Linux x64: `AppImage`, `deb`, `rpm`

Tauri's bundle target is set to `all` in `src-tauri/tauri.conf.json`, while the workflow passes platform-specific `--bundles` arguments so each runner only builds formats supported for its OS.

Each generated installer file is uploaded as its own GitHub Release asset. Asset names include the app name, version, platform, architecture, and setup marker when applicable.

Resource Monitor agent binaries are built before the app bundle and are uploaded twice: first as workflow artifacts so every app build can bundle all helper targets, then as GitHub Release assets so an installed app can ask the user to download a missing helper from the same release tag. Helper release assets use this naming scheme:

```text
nocturne-resource-monitor-agent-<tag>-<os>-<arch>[.exe]
```

Files ripgrep helper binaries are prepared before the app bundle by one Ubuntu job because this step downloads upstream prebuilt archives instead of compiling target-specific code. The job prepares every supported target and uploads one workflow artifact containing all flat `rg-*` resource files for app bundle jobs to download. Nocturne does not upload `rg` binaries to its own GitHub Release because they are third-party versioned artifacts.

If a bundled `rg` helper is missing at runtime, Nocturne may ask the user to download the official ripgrep archive from `BurntSushi/ripgrep` for the locked `RIPGREP_VERSION`, extract `rg` or `rg.exe`, then upload that extracted binary to the target Host according to the normal remote helper policy. The runtime downloader never uses `latest`, a Nocturne app tag, or a guessed ripgrep version.

Before Tauri packaging starts, release CI runs `pnpm validate:helper-resources` against `src-tauri/resources`. The validation fails the build if any supported Resource Monitor agent or ripgrep helper is missing or empty, so an installer cannot be published with helper resources that would immediately fall back to runtime downloads.

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
