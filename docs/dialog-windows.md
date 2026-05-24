# Dialog Windows

Nocturne prefers native dialogs when the platform can provide the required interaction. Simple confirmations can use native OS dialogs later. Form dialogs, such as creating a profile with a typed name, use small Tauri windows because the cross-platform native dialog API does not provide a standard text-input sheet.

## Current Dialogs

- `dialog-profile-new`: creates a profile, switches to it, and closes.
- `dialog-profile-delete`: deletes a non-default profile and closes.

Both are opened from `File -> Profile`.

## Window Behavior

Dialog windows should:

- use a stable label so repeated menu actions focus the existing dialog
- be small, non-resizable, non-maximizable, and non-minimizable
- set the settings window as parent when it exists, otherwise the main window
- close on Cancel or successful completion
- use compact native-feeling layout and controls

The Rust entry point is `open_dialog` in `src-tauri/src/app_shell.rs`. Add new dialog kinds there instead of duplicating window creation code.

## Frontend Pattern

Dialog routes live under `src/routes/dialog/`.

Shared styling lives in:

```text
src/routes/dialog/dialog.css
```

Each dialog page should:

- load the config snapshot through TanStack Query
- apply app theme and language from the effective config
- call typed Tauri commands
- show explicit errors instead of silently closing
- avoid autofocus attributes; focus the first useful control from `onMount`

## Reuse Contract

For a new reusable dialog:

1. Add a new label and route to `DialogKind` in `src-tauri/src/app_shell.rs`.
2. Create a route under `src/routes/dialog/<name>/+page.svelte`.
3. Reuse `dialog.css`.
4. Keep dialog-specific business logic in the dialog page or a feature helper under `src/lib/`.
5. Add any new Tauri command/type to Rust and regenerate `src/lib/bindings.ts` through the debug dev flow.

Dialogs should not become in-page modal overlays. A separate window is intentional: it preserves desktop focus behavior and keeps the main settings page usable.
