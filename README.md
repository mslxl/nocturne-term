# Nocturne

Nocturne is a cross-platform terminal app for macOS, Linux, Windows, Android, and iOS.
It is built to feel native on each platform, with a clean interface, smooth motion, and a focus on fast everyday use.

## Install

### From source

1. Install the prerequisites for [Tauri](https://tauri.app/start/prerequisites/), plus `pnpm` and Rust.
2. Install JavaScript dependencies:

```bash
pnpm install
```

3. Build the app:

```bash
pnpm tauri build
```

The installable app package is written to `src-tauri/target/release/bundle/`.

## Build for development

To run Nocturne locally while developing:

```bash
pnpm tauri dev
```

Development Tauri runs use the app identifier `com.mslxl.nocturne.dev`, so they do not share the production macOS bundle identity.

For frontend checks only:

```bash
pnpm check
```

For the Rust backend check:

```bash
cd src-tauri
cargo check
```

## Notes

- Settings, profiles, and host data are stored in the platform app config directory.
- The app uses native menu entries for settings and profile actions.
- Terminal color schemes can be switched from the settings window.

## License

GNU Affero General Public License v3.0
