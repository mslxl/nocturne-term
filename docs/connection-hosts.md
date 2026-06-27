# Connection Hosts

This document defines Nocturne's host/session model, SSH behavior, storage contract, security rules, and terminal transport abstraction.

Hosts are reusable workspace targets. A host can be local, SSH, or a future protocol such as Telnet. Local shells are first-class hosts. SSH uses libssh2.

## Goals

- Manage reusable session targets from Nocturne.
- Read configured OpenSSH config files as read-only sources.
- Store user-created hosts as one TOML file per host in configured host directories.
- Keep credentials out of TOML and use the system keyring when available.
- Maintain a private host-key trust store instead of writing to OpenSSH files.
- Expose hosts as the identity behind Host Workspaces. Terminal, Files, and Transfers tools use the workspace's host.
- Keep protocol-specific connection code behind a transport abstraction.

## Terminology

- Connection host: a saved workspace target. UI may call this a host. Code should prefer `ConnectionHost` or `connection_host` to avoid confusing it with DNS host names or OpenSSH `Host` blocks.
- Host directory: a configured directory containing user-created connection host TOML files.
- OpenSSH source: entries resolved from the configured OpenSSH config file list and files included from those configs.
- User source: editable connection host files in Nocturne host directories.
- Virtual source: Nocturne's default local shell host. It exists even when no user host files have been created, unless the user removes it.
- Trust store: Nocturne's private SSH host-key record, stored separately from connection host files.
- Transport: a backend that presents terminal-like byte input, byte output, resize, close, and status events to Terminal tool tabs.
- File provider: a backend that presents list, stat, read, write, rename, delete, chmod, preview, and search behavior to Files tool tabs. Local and SFTP are file providers.

## Sources

Connection hosts come from three sources.

### Default Local Host

Nocturne exposes a virtual default local host on first launch. It opens the platform default shell and is used as the default host until the user chooses another default.

The virtual default local host is not written to a host TOML file and is read-only. Users may set it as default or remove it from the host list. Removing it writes `default_local_host_removed = true` to `state.toml`; Nocturne must not show it again while that state flag is set.

Local hosts use the same workspace, command palette, default-host, Terminal, and Files lifecycle paths as SSH hosts.

### OpenSSH Config Files

Nocturne reads an ordered list of OpenSSH config files as read-only sources. The default list is:

```toml
openssh_config_files = ["~/.ssh/config"]
```

Users can add or remove config files from settings. Missing files should be reported as diagnostics but should not prevent other configured files from loading.

OpenSSH entries are read-only because the file is shared by other tools such as OpenSSH, Git, rsync, and shell scripts. Nocturne must not rewrite it or reformat it. The UI should explain that reason near disabled edit controls and offer a copy action that creates an editable Nocturne host in a selected host directory.

Only concrete `Host` aliases are displayed as connection hosts. Pattern-only blocks such as `Host *` participate in effective config resolution but are not shown as connectable entries.

Supported OpenSSH directives for the first implementation:

- `Host`
- `HostName`
- `User`
- `Port`
- `IdentityFile`
- `ProxyJump`
- `ForwardAgent`
- `ServerAliveInterval`
- `Include`
- `Match all`
- `Match host`
- `Match originalhost`
- `Match user`
- `Match localuser`

`Host` and supported `Match` patterns must support OpenSSH-style wildcards. Unsupported directives can be ignored for connection behavior, but the parser should keep enough diagnostics to explain when a host may be only partially supported.

`Match exec` must not execute commands in the first implementation. Treat it as unsupported and report a diagnostic instead of running arbitrary commands while reading config.

Include behavior:

- expand `~`
- support relative paths according to OpenSSH config location
- support glob patterns
- tolerate missing include files with a warning
- detect include cycles
- limit include depth, for example to 16 nested files

### User Host Directories

User-created connection hosts are stored as TOML, one file per host, inside configured host directories. The existing host directory setting supplies these directories.

Each user host has a stable UUID. The UUID is the host identity. Display names, hostnames, usernames, protocols, and authentication settings can change without changing the UUID.

Duplicate UUIDs are configuration errors. They must be detected at startup and after file changes. Before repair, duplicate-UUID hosts should be visible but disabled for connection. Startup diagnostics should use the OS notification mechanism and the settings UI should also show a persistent warning because the user can miss a system notification.

If a duplicate UUID is repaired, Nocturne must warn and ask before regenerating an ID. ID repair changes references such as recent connections and keyring entries.

Multiple hosts with the same display name are allowed. Rows and menus distinguish them with the connection address only, not storage paths or source labels. Only duplicate UUIDs are conflicts.

When creating a user host, choose the first writable host directory by default and let the user pick another writable directory. Read-only directories should be visible but disabled. If no configured host directory is writable, show a settings-facing error and do not silently fall back elsewhere.

## Folders And Icons

Hosts can be grouped by folders. Folders are organizational metadata and do not affect connection behavior.

For Nocturne user hosts, folders are derived from the host TOML file's relative path inside whichever configured host directory contains it. Do not store `folder` in the host TOML document.

Examples:

- `<host_dir_1>/path/to/a.toml` appears in folder `path/to`
- `<host_dir_2>/path/to/b.toml` also appears in folder `path/to`
- `<host_dir>/c.toml` appears in the default ungrouped area

Changing a Nocturne host's folder in Host Manager moves the TOML file to the matching subdirectory below the same configured host directory. The app should automatically create missing folder directories. Folder values must be relative paths; absolute paths and `..` segments are invalid.

For OpenSSH-derived hosts, `folder` is derived from the OpenSSH config file name and is read-only. For example, hosts read from `~/.ssh/config` appear in a `config` folder, and hosts read from `~/.ssh/work` appear in a `work` folder. Users must not be able to modify this folder directly because OpenSSH hosts remain projections of external read-only config files.

Folder editing is a virtual directory operation. The editor should provide completion or a picker based on existing Nocturne/OpenSSH folder paths; it must not open the OS filesystem picker because folders here are logical host groups, not arbitrary directories.

Host icons are defined in [Host Icons](host-icons.md). Nocturne user hosts may store an explicit `[icon]` table in their TOML file. OpenSSH-derived and virtual hosts use app-assigned read-only icons. The `icon_pack` field is discarded and must not be read, written, migrated, or preserved.

## Host Row Display

Every host row shown in Host Manager, the new-workspace picker, and command surfaces should use the same two-line shape:

- first line: host display name
- second line: connection address

Address formatting:

- SSH: `user@host:port` when a username exists, otherwise `host:port`
- Telnet: `host:port`
- Local: configured command label, or `System shell`

Do not show storage location, host source, folder path, OpenSSH file path, protocol prose, or other metadata in the row subtitle. Source/read-only/default/error state can be represented through restrained badges, disabled state, tooltips, or inspector details when needed.

## User Host TOML

User host files should be protocol-aware.

Example SSH host:

```toml
version = 1
id = "018f6eb3-6f91-7410-bc43-f927b2236d94"
name = "Production API"
protocol = "ssh"

[icon]
type = "catalog"
name = "devicon:amazonwebservices"

[ssh]
hostname = "prod.example.com"
port = 22
username = "deploy"
identity_file = "~/.ssh/id_ed25519"
proxy_jump = "bastion"
forward_agent = true
server_alive_interval = 30

[files]
default_path = "/var/www"

[resources]
target_os = "linux"       # optional: linux | macos | windows
target_arch = "x86_64"    # optional: x86_64 | aarch64 | armv7 | i686
remote_provider = "auto"  # optional: auto | agent | system_commands

[terminal]
agent_mode = "enabled"    # optional: enabled | disabled
```

`[resources].target_os` and `[resources].target_arch` are optional hints for Resource Monitor helper selection. Leave both unset to let Nocturne detect the remote target at runtime. If only one is set, Nocturne treats the resource target config as incomplete and asks the Workspace to choose rather than guessing.

`[resources].remote_provider` is the Host-scoped Resource Monitor provider mode
for SSH Workspaces. It defaults to `auto` when omitted. `agent` uses the managed
Resource Monitor helper according to the remote helper policy, and
`system_commands` only runs commands already present on the target Host. The
Resource Monitor ToolTab exposes a compact control that edits this Host field
for editable Nocturne user hosts.

`[terminal].agent_mode` controls whether new Terminal ToolTabs for the host use
`nocturne-terminal-agent`. Editable Nocturne user hosts default to `enabled`
when the field is omitted. Setting `agent_mode = "disabled"` keeps the current
direct PTY/SSH terminal transport and does not upload or start
`nocturne-terminal-agent`. The virtual default local host is read-only because
there is no host TOML to edit, but it still uses Terminal Agent mode by default
through Nocturne's bundled same-machine helper. Other read-only hosts, including
OpenSSH-derived hosts, cannot enable Terminal Agent mode in the first
implementation and behave as disabled.

The runtime supports editable local hosts through a same-machine Terminal Agent
daemon launched from Nocturne. Editable SSH hosts use a packaged target-platform
`nocturne-terminal-agent` helper. Nocturne detects or uses the host's configured
target OS/architecture, uploads the helper through SFTP according to the remote
helper policy, starts it on the remote Host, and then uses SSH exec channels to
run helper client commands on that same remote Host. Local and remote control
paths both go through the helper client with `--session-id`; the helper reads
the daemon registry, connects to the recorded Unix socket or Windows named pipe
on the same Host, and proxies request_id-correlated NDJSON. If Terminal Agent
mode is enabled and the helper cannot be selected, uploaded, verified, started,
or probed through its registry, session creation fails fast instead of silently
falling back to direct SSH PTY mode.

The Go rewrite makes the agent a host-level persistent daemon. Nocturne is the
client that creates launch specs, probes the registry, and reconnects to an
existing session instead of assuming a one-shot PTY child process. Registry
files are keyed by `session_id`, and the daemon keeps exited sessions visible
until the user deletes them.

Example local host:

```toml
version = 1
id = "018f6eb4-3da8-73c8-9b2d-fca30a256196"
name = "Project Shell"
protocol = "local"

[icon]
type = "catalog"
name = "lucide:terminal"

[local]
command = "zsh"
args = ["-l"]
cwd = "~/Projects/nocturne"

[files]
default_path = "~/Projects"

[terminal]
agent_mode = "disabled"
```

Future Telnet example:

```toml
version = 1
id = "018f6eb5-c33d-7c69-aafe-b74eae0a8041"
name = "Office Router"
protocol = "telnet"

[telnet]
hostname = "192.168.1.1"
port = 23
```

Passwords, private-key passphrases, and other secrets must never be written to host TOML.

## Display Options

The settings UI may expose an option to show the configured host address next to the display name. This means the configured `HostName` or `hostname` value and port. Do not perform DNS resolution just to display a current IP address; DNS lookups can be slow, flaky, and network-dependent.

## Conflict Rules

- Duplicate UUIDs in user host files are errors.
- Duplicate display names are allowed.
- A user host and an OpenSSH config host with the same name are both displayed.
- Nocturne should not silently merge OpenSSH and user hosts that only share a name.
- Pattern blocks such as `Host *` affect effective OpenSSH values but do not become visible hosts.
- The virtual default local host has a reserved stable UUID and must not conflict with user UUIDs.

## Default Host And New Workspace

Nocturne has one default host. The default host drives:

- app startup workspace creation
- left-clicking the workspace bar's New Workspace button
- command palette default workspace actions

If the configured default host is missing, Nocturne falls back to the virtual local host when it has not been removed; otherwise it reports the missing default and requires the user to choose another host. Users can set any connectable host as default from Host Manager. Host Manager treats default-host changes as editor changes: checking Default only marks the selected host as the pending default, and the configuration is updated when the user saves.

The new-workspace UI should be unified:

- left-clicking the New Workspace button creates a workspace for the default host
- the adjacent picker button, right-clicking New Workspace, and command palette host results are explicit Workspace creation entry points
- the picker lists local, SSH, OpenSSH-derived SSH, and future protocol hosts
- folders are displayed as nested SubMenus that mirror slash-separated folder paths
- SubMenus should behave like desktop menus: open beside the parent row, keep stable fixed dimensions, clamp to viewport edges, and use OverlayScrollbars when content overflows
- overflowing host lists and submenus use OverlayScrollbars rather than native web scrollbars
- disabled hosts remain visible with terse reasons

Do not keep a separate local-shell entry point once local shells are modeled as hosts. Creating a workspace from the virtual local host is the local entry point.

## Host Workspaces And Files

Every Host Workspace binds to exactly one connection host. Local hosts are valid workspace hosts.

By default, creating a workspace for a host opens:

- a Files tool tab
- a Terminal tool tab
- a Resource Monitor tool tab
- a Transfers tool tab

For SSH hosts, Files uses an SFTP provider. For local hosts, Files uses a local filesystem provider. The UI above the provider is shared and is defined in [Files ToolTab](files-tooltab.md).

Host TOML may include:

```toml
[files]
default_path = "~/Projects"
```

This path is the initial Files path for the host. Empty or missing values mean the user's home directory: local home for local hosts, remote home for SSH hosts. The path is not a jail.

## SSH Backend

SSH connections use libssh2 through a Rust backend. libssh2 must be wrapped behind Nocturne's protocol transport abstraction rather than being called directly from UI-facing terminal code.

The SSH backend must support:

- host key verification through Nocturne's private trust store
- ssh-agent authentication
- identity-file authentication
- password authentication
- key passphrases from keyring or prompt
- password values from keyring or prompt
- `ProxyJump`
- remote PTY allocation
- terminal resize
- clean close and failure reporting

## Session Lifecycle

Opening a Terminal tool tab for a host should create a terminal session immediately when restore policy allows it. The tool tab shows connection status while the backend resolves, connects, verifies trust, authenticates, and opens the shell. On success, the status surface disappears and normal terminal output takes over. On failure, the tool tab remains open and shows the error plus retry/close actions.

Connection work must not block the UI or Tauri command thread. Commands should return quickly with a session id, and background workers should emit transport state updates and output events. Trust prompts and credential prompts are session-scoped interactions.

If a remote connection drops unexpectedly after it was connected, the terminal should show a clear disconnected message and offer keyboard reconnect from the same Terminal ToolTab. The keypress or paste that triggers the reconnect prompt is discarded and must not be replayed into the restarted run. Do not surface internal backend errors such as "terminal session not found" to the terminal. Late keypresses, writes, and resize events aimed at a removed backend session should be ignored or translated into the disconnected state.

Be especially careful with SSH startup failures. The UI creates a Terminal ToolTab as soon as the backend returns a session id, but the SSH worker may fail on another thread before the frontend finishes mounting xterm, taking output backlog, or sending the first resize. In that race the backend session may already have been removed. Commands such as backlog, write, and resize must treat the missing session as a tool-local disconnected or failed state, not as an application-level configuration error. A stale `terminal session term-x not found` must never be written into the global page error state, because it can obscure unrelated Workspaces and future local sessions.

Authentication order should be:

1. ssh-agent
2. configured identity file with keyring passphrase when available
3. configured password from keyring when available
4. interactive prompt for password or passphrase

The user should be able to disable authentication methods where the UI exposes that level of control.

libssh2 operations must not block the UI or Tauri command thread. Use background workers or equivalent isolation for connection, authentication, read, write, resize, and close behavior. Terminal output should still flow through the same event shape used by local terminal sessions.

## ProxyJump

`ProxyJump` is part of the first SSH implementation.

libssh2 does not make `ProxyJump` a single command-line-style option. Nocturne must establish the jump host connection, verify the jump host key, authenticate to the jump host, and then open a direct TCP channel to the target before establishing the target SSH session.

Every hop must have independent host-key verification. A target reached through a jump host still records trust against the target's configured `hostname:port`, and the jump host records trust against its own configured `hostname:port`.

## Keyring

Nocturne stores password and private-key passphrase secrets in the system keyring when available:

- macOS: Keychain
- Windows: Credential Manager
- Linux: Secret Service or the available desktop keyring provider

If the system keyring is unavailable, unsupported, locked, or fails, Nocturne must not persist the secret in TOML or any local fallback file. Prompt for the secret each time.

Keyring records should be scoped under a Nocturne namespace and tied to:

- connection host UUID
- username
- identity file, for key passphrases
- secret kind, such as password or key passphrase

Deleting a user host must delete all Nocturne keyring secrets associated with that host UUID. Host edits must synchronize keyring records carefully. If username or identity file changes, stale secrets for the previous value must be removed or migrated only through an explicit user-confirmed flow.

## Workspace Encrypted Temporary Credentials

When a Workspace prompt supplies an SSH password or private-key passphrase and
the user does not save it to the system keyring, Nocturne still keeps the
authenticated Workspace usable for Files, Terminal, Transfers, and ProxyJump
hops without repeatedly asking for the same secret.

This is handled through Workspace encrypted temporary credentials:

- the credential belongs to exactly one Workspace
- a new Workspace for the same Host must prompt again
- each Workspace scope has its own AEAD key generated by the Rust backend
- the AEAD key, nonce, ciphertext, and credential index stay only in Rust memory
- the key is not exposed to the frontend, not exported through Specta, and not
  written to disk
- plaintext exists only while a prompt response or authentication attempt is in
  progress
- successful prompt authentication stores the credential as ciphertext in that
  Workspace scope
- failed prompt authentication never writes the credential to the Workspace
  scope or keyring
- if an existing Workspace encrypted temporary credential fails authentication,
  Nocturne immediately deletes that credential and returns a credential
  required challenge for the Workspace to prompt again
- an automatic authentication path uses Workspace encrypted temporary
  credentials first; if none exists, it may use keyring; a successful keyring
  secret is then copied into the current Workspace as a Workspace encrypted
  temporary credential for subsequent operations
- a failed Workspace encrypted temporary credential must not silently fall back
  to keyring because that can hide stale or wrong in-memory credentials
- closing a Workspace destroys that Workspace's encrypted credentials, nonces,
  key material, and index entries; app exit naturally drops every scope

ProxyJump secrets are separate Workspace encrypted temporary credentials. A jump
host password or key passphrase must never be reused for the final target, and a
final target credential must never be reused for a jump host. Keyring records use
the same auth-target namespace for both user connection hosts and ProxyJump
targets.

## Workspace SSH Verification Coordinator

SSH credential prompts and host-key trust decisions are Workspace-owned
verification challenges. Terminal, Files, Transfers, and helper/search code may
encounter a challenge, but the Workspace owns the user interaction and the
resulting Workspace encrypted temporary credential or trust decision.

The backend exposes structured SSH challenges rather than requiring the frontend
to parse error strings. Credential challenges include the concrete SSH auth
target: target kind, label, username, hostname, and port. Host-key trust
challenges include the auth target, trust target, algorithm, fingerprint, and
whether the key is unknown or changed. Prompt UI must show the auth target so
the user can tell whether they are entering a jump-host secret or the final
server secret.

The coordinator behavior is:

- one active Workspace verification at a time
- identical concurrent verification requests share the same backend request and
  consume the same successful Workspace result
- different verification requests are coordinated by the backend instead of
  racing multiple frontend prompts
- Terminal sessions waiting for Workspace verification stay in a waiting or
  authenticating state rather than closing as a normal process exit
- Files commands waiting for Workspace verification should show loading or a
  prompt state rather than a final provider failure

The current implementation stores and reuses Workspace encrypted temporary
credentials in the backend, returns structured credential and host-key
challenges, queues one active verification per Workspace, deduplicates
identical concurrent challenges, and emits a Workspace verification event for
Terminal and Files/SFTP workers. Transfer SFTP operations must carry the
initiator Workspace scope so they can use only that Workspace's encrypted
temporary credentials.

## Private SSH Trust Store

Nocturne maintains a private SSH trust store under the app config directory. Do not write to `~/.ssh/known_hosts`.

The trust target uses the configured final connection value, not a DNS-resolved IP address. Format targets as `hostname:port`; IPv6 targets should use bracket form such as `[2001:db8::1]:22`.

The trust store should be minimal because its only job is detecting first use and host-key changes.

```toml
version = 1

[[ssh]]
target = "prod.example.com:22"
keys = [
  "ssh-ed25519 SHA256:abc123",
  "rsa-sha2-512 SHA256:def456",
]
```

On first connection to a target and algorithm, show a native warning/confirmation that includes:

- host display name
- target
- algorithm
- SHA256 fingerprint

The fingerprint must be copyable.

If an existing target and algorithm have a different fingerprint, block the connection by default and show a strong warning. The user must explicitly choose to update the trust record before the connection can continue.

## Transport Abstraction

The terminal layer should not assume every session is a local child process. It should depend on a transport abstraction that supports local PTY, SSH, and future protocols.

A transport must provide:

- terminal input writes
- terminal output events
- resize events
- close/kill behavior
- lifecycle status
- final exit or disconnect information

Recommended connection states:

- `resolving`
- `connecting`
- `verifying_host_key`
- `authenticating`
- `connected`
- `disconnected`
- `failed`

Local PTY sessions may skip several network-specific states. Telnet can reuse the transport surface without host-key verification.

Terminal tool tab code should treat a remote SSH session as a normal terminal session once connected. Closing a connected remote session follows the existing running-session confirmation rules.

## Command Palette

Connection hosts should become dynamic command palette results that create Workspace tabs. They must not create Terminal sessions directly because Terminal ToolTabs inherit their Workspace host.

Result examples:

```text
Open Workspace: Production API     SSH
Open Workspace: prod               ~/.ssh/config
```

Search should index:

- host display name
- configured hostname
- username
- protocol
- icon catalog id or inferred icon name
- folder path
- tags, if added later

Duplicate display names must remain distinguishable by their address line or folder scope. Duplicate UUID errors should appear disabled with a terse reason when found by search.

## Host Manager UX

Connection host CRUD belongs in a dedicated Host Manager window, not in the Settings window. Settings should only expose host-directory, OpenSSH config file, and display preferences.

The Host Manager window should use native-feeling list/detail behavior:

- a TreeView in the left sidebar, not independent folder sections
- folder nodes are expandable/collapsible and host rows are leaf nodes
- compact host rows, not card grids
- restrained default/error/read-only indicators
- read-only state for OpenSSH config entries
- copy-to-Nocturne action for OpenSSH entries
- directory selector when creating a new user host
- virtual folder completion or picker in the Folder field
- icon picker for editable Nocturne user hosts
- read-only app-assigned icon display for OpenSSH-derived hosts
- a single Default switch for connectable hosts; enabling it for one host clears default from every other host because `default_host` stores one host ID
- protocol selection through a dropdown menu inside the editor, not separate New Local/New SSH buttons
- visible duplicate UUID warnings
- no web-style modal overlays for destructive confirmation

Deleting a user host must warn that the host file and associated Nocturne keyring secrets will be removed.

The Host Manager can be opened from the command palette. It should also be available from the host picker shown when creating a new workspace, as a final action row or footer button.

## Diagnostics

Startup and config refresh should detect:

- duplicate UUIDs
- unreadable host directories
- unwritable host directories
- unreadable configured OpenSSH config files
- missing configured default host
- unsupported OpenSSH config directives that affect displayed entries
- include cycles
- include depth overflow
- malformed TOML host files
- malformed known-hosts trust store entries
- unavailable system keyring

High-impact diagnostics such as duplicate UUIDs should trigger an OS notification and also remain visible in settings.

## Validation

Implementation should include focused tests for:

- OpenSSH `Include`, include cycles, missing includes, and depth limit
- supported `Match` clauses with wildcard behavior
- effective OpenSSH config resolution
- duplicate UUID detection
- user host TOML parsing and validation
- trust target formatting, including IPv6
- first-use host-key trust
- host-key mismatch blocking
- keyring key derivation and cleanup on delete/edit
- transport state transitions
- SSH ProxyJump success and failure paths

Manual validation should cover:

- connecting from command palette
- connecting from settings
- creating in each writable host directory
- configuring multiple OpenSSH config files
- setting and using a default host
- read-only explanation for `~/.ssh/config`
- copying an OpenSSH entry into a user host directory
- password prompt fallback when keyring is unavailable
- closing a connected SSH Terminal ToolTab
- dark mode, light mode, keyboard navigation, and narrow settings windows
