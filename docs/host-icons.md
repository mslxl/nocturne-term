# Host Icons

This document defines Nocturne's connection-host icon model, picker behavior, display surfaces, icon catalog, and custom icon storage contract.

Host icons are identity markers for saved connection targets. They should help users distinguish systems, cloud providers, database hosts, protocols, and local shells at a glance. They are not decorative badges and should stay visually restrained.

## Goals

- Show recognizable host identity in host management, host launching, and command search.
- Support bundled catalog icons for common systems, cloud providers, databases, and generic terminal targets.
- Allow Nocturne user hosts to use custom image or SVG icons.
- Keep OpenSSH-derived hosts read-only, including their icon.
- Store user-selected catalog icon names in TOML.
- Store custom bitmap data in TOML as base64.
- Store custom SVG text in TOML without base64.
- Keep the icon renderer shared across all host surfaces.

## Non-Goals

- Do not show host icons in terminal tab bars by default.
- Do not show host icons in split-pane title bars.
- Do not render icons inside the xterm content surface.
- Do not import React or use `emoji-picker-react` directly.
- Do not keep compatibility with the old `icon_pack` field.

## Storage Model

User host TOML stores icons as an explicit `icon` table.

Catalog icon:

```toml
[icon]
type = "catalog"
name = "simple-icons:ubuntu"
```

Custom bitmap icon:

```toml
[icon]
type = "image"
mime = "image/png"
data_base64 = "..."
```

Custom SVG icon:

```toml
[icon]
type = "svg"
svg = '''<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">...</svg>'''
```

Rules:

- `type = "catalog"` stores a stable Iconify-style icon id, such as `lucide:server`, `simple-icons:nixos`, or `devicon:postgresql`.
- `type = "image"` stores `mime` and `data_base64`. Supported MIME types should start with `image/png`, `image/jpeg`, or `image/webp`.
- `type = "svg"` stores SVG text directly. SVG does not need base64 encoding.
- The old `icon_pack` field is discarded. Do not read it, write it, migrate it, or preserve it.
- If a user host has no `icon` table, the app should infer a catalog fallback from the protocol and host metadata.

## Source Rules

Nocturne user hosts:

- Icon is editable.
- Catalog, image, and SVG icon types are allowed.
- The selected icon is saved to that host's TOML file.

OpenSSH-derived hosts:

- Icon is app-assigned and read-only.
- Users must not be able to edit the icon until the host is copied into a Nocturne user host.
- Nocturne must not write icon metadata back to OpenSSH config files.

Virtual hosts:

- Icon is app-assigned and read-only unless a future feature creates an editable user host from the virtual host.

## Display Surfaces

Host icons must appear in exactly these host-facing surfaces:

1. Host Manager left-side host rows.
2. Host Manager detail header beside the selected host name.
3. Host Manager detail header icon for editable user hosts.
4. Main-window new-session host picker rows, including submenu rows.
5. Command palette `connection-host` results.

Terminal tab bar items may show host icons only when the user enables:

```toml
[terminal]
show_host_icons_in_tabs = true
```

This setting defaults to `false`. When enabled, each terminal tab shows the icon for its active pane's saved connection host. Tabs without host metadata remain text-only.

Do not add host icons to:

- split-pane title bars
- xterm content
- folder rows
- SSH trust or credential prompt copy

## Picker Behavior

The picker should use the selection pattern from emoji pickers without depending on a React emoji library or emoji data:

- the Host Manager form must not contain a separate icon field; the selected host's header icon is the editor entry point
- editable header icons should show an affordance on hover/focus and open a compact floating quick picker when clicked
- the quick picker should visually follow `emoji-picker-react` reaction pickers: compact bordered popover, dense square icon buttons, soft hover scale, and no layout push-down
- the quick picker's rightmost plus button opens the full picker
- the full picker should visually follow `emoji-picker-react`: a compact bordered panel, rounded search field at the top, category icon strip below search, dense square icon grid, sticky category/search label, and a bottom preview row
- categories are Generic, Operating Systems, Cloud Providers, Databases, and Custom
- search filters across all categories, not only the active tab
- icon grid uses stable 40px cells so hover, selection, and labels do not shift layout
- selected icon shows a restrained native-feeling selected state
- footer or preview area shows the icon, display name, and stored id such as `devicon:postgresql`
- keyboard navigation supports arrow keys, Enter, and Escape
- picker-only hover/focus motion may scale icon cells like `emoji-picker-react`, but ordinary host list rows and tab bars must keep native-feeling restrained motion
- catalog and SVG icons render as theme-monochrome symbols: white in dark app themes and black in light app themes, so vendor artwork with black or white source fills remains readable
- custom bitmap icons are also displayed through the same monochrome treatment in Nocturne chrome; the original base64 data remains unchanged in TOML
- OpenSSH-derived hosts show the assigned icon but disable editing with a terse reason

## Catalog Sources

Use bundled Iconify JSON packages and compile icons into the app. Do not fetch icon data from a CDN or Iconify API at runtime.

Recommended packages:

- `unplugin-icons`
- `@iconify-json/lucide`
- `@iconify-json/devicon`
- `@iconify-json/simple-icons`

Tencent Cloud is not available in the checked `devicon`, `simple-icons`, `logos`, `skill-icons`, or `vscode-icons` Iconify sets. Treat it as a local app-provided icon id:

```text
local:tencentcloud
```

If a suitable Tencent Cloud SVG is added locally, verify its license and trademark constraints before shipping it.

## Operating System Icons

The Operating Systems category should prefer `simple-icons` because it covers more OSes and Linux distributions than `devicon`.

Initial OS catalog:

```text
simple-icons:almalinux
simple-icons:alpinelinux
simple-icons:android
simple-icons:archlinux
simple-icons:artixlinux
simple-icons:asahilinux
simple-icons:bsd
simple-icons:centos
simple-icons:debian
simple-icons:deepin
simple-icons:endeavouros
simple-icons:fedora
simple-icons:freebsd
simple-icons:garudalinux
simple-icons:gentoo
simple-icons:harmonyos
simple-icons:ios
simple-icons:kalilinux
simple-icons:kubuntu
simple-icons:linux
simple-icons:linuxmint
simple-icons:lubuntu
simple-icons:manjaro
simple-icons:mxlinux
simple-icons:netbsd
simple-icons:nixos
simple-icons:nobaralinux
simple-icons:openbsd
simple-icons:opensuse
simple-icons:parrotsecurity
simple-icons:popos
simple-icons:raspberrypi
simple-icons:reactos
simple-icons:redhat
simple-icons:rockylinux
simple-icons:slackware
simple-icons:solus
simple-icons:suse
simple-icons:tails
simple-icons:ubuntu
simple-icons:ubuntumate
simple-icons:voidlinux
simple-icons:windows
simple-icons:windows10
simple-icons:windows95
simple-icons:windowsxp
simple-icons:xubuntu
simple-icons:zorin
```

## Cloud Provider Icons

Initial cloud provider catalog:

```text
devicon:amazonwebservices
devicon:azure
devicon:googlecloud
devicon:digitalocean
devicon:cloudflare
devicon:oracle
devicon:heroku
devicon:vercel
devicon:netlify
simple-icons:alibabacloud
simple-icons:hetzner
simple-icons:akamai
simple-icons:snowflake
simple-icons:opensearch
local:tencentcloud
```

## Database Icons

Initial database catalog:

```text
devicon:postgresql
devicon:redis
devicon:mysql
devicon:mariadb
devicon:mongodb
devicon:sqlite
devicon:microsoftsqlserver
devicon:cassandra
devicon:elasticsearch
devicon:clickhouse
simple-icons:snowflake
simple-icons:opensearch
```

## Fallback Inference

Fallbacks should be deterministic and should not require network access.

Suggested fallback order:

1. Use explicit `icon` from user host TOML.
2. For OpenSSH-derived hosts, infer from alias, `HostName`, `User`, and protocol.
3. For local hosts, use `lucide:terminal` or `lucide:square-terminal`.
4. For SSH hosts, use a recognized OS/cloud/database icon if metadata clearly matches.
5. Otherwise use `lucide:server`.

Do not perform DNS lookups, remote probes, or SSH handshakes just to infer an icon.

## Custom Icon Validation

Custom icons are user-provided data rendered inside a WebView, so validation should fail fast.

Bitmap image rules:

- Accept only PNG, JPEG, and WebP.
- Enforce a maximum decoded or encoded size before storing.
- Prefer square icons; crop or pad only with explicit user action.
- Store as base64 in TOML.

SVG rules:

- Store SVG text directly in TOML.
- Reject SVGs containing scripts, `foreignObject`, event handler attributes, external URLs, or remote resource references.
- Render sanitized SVG through the shared host icon renderer, not with ad hoc `{@html}` at call sites.

## Implementation Notes

- Add a single icon renderer component and reuse it in every display surface.
- Add a single picker component for Host Manager and keep its data model independent from host persistence.
- Extend command palette items with an optional icon field before rendering icons in command results.
- Keep folder icons separate from host icons; folder rows should remain structural navigation.
- Generated bindings must be updated through the Tauri debug dev flow if Rust/Specta types change.
