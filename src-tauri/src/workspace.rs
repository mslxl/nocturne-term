use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::{
    config::{connection_host_by_id, default_connection_host_id, root_paths},
    error::{invalid_error, io_error, missing_error, parse_error, Result},
    port_forwarding::{close_host_port_forward_runtime, start_saved_port_forwards_for_host_open},
    types::{
        ConnectionProtocol, WorkspaceChangedEvent, WorkspaceDispatchInput, WorkspaceDockDirection,
        WorkspaceDockGroupRole, WorkspaceDockLayout, WorkspaceDockSide,
        WorkspaceFloatingWindowState, WorkspaceIntent, WorkspaceLayoutSnapshot, WorkspaceTabState,
        WorkspaceToolKind, WorkspaceToolSlot, WorkspaceToolTab,
    },
    workspace_ssh::workspace_ssh_coordinator,
};

const WORKSPACE_CHANGED_EVENT: &str = "workspace://changed";
const WORKSPACE_STATE_FILE: &str = "workspace-state.toml";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorkspaceStateFile {
    snapshot: WorkspaceLayoutSnapshot,
}

#[derive(Default)]
struct WorkspaceStore {
    snapshot: Option<WorkspaceLayoutSnapshot>,
}

static WORKSPACE_STORE: OnceLock<Arc<Mutex<WorkspaceStore>>> = OnceLock::new();

fn workspace_store() -> Arc<Mutex<WorkspaceStore>> {
    WORKSPACE_STORE
        .get_or_init(|| Arc::new(Mutex::new(WorkspaceStore::default())))
        .clone()
}

#[tauri::command]
#[specta::specta]
pub(crate) fn get_workspace_layout_snapshot(app: AppHandle) -> Result<WorkspaceLayoutSnapshot> {
    current_snapshot(&app)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn workspace_dispatch(
    app: AppHandle,
    input: WorkspaceDispatchInput,
) -> Result<WorkspaceLayoutSnapshot> {
    let mut snapshot = current_snapshot(&app)?;
    if snapshot.version != input.expected_version {
        return Err(invalid_error(format!(
            "workspace snapshot version mismatch: expected {}, current {}",
            input.expected_version, snapshot.version
        )));
    }
    let reason = intent_name(&input.intent).to_string();
    apply_intent(&app, &mut snapshot, input.intent)?;
    normalize_snapshot_group_roles(&mut snapshot);
    snapshot.version = snapshot
        .version
        .checked_add(1)
        .ok_or_else(|| invalid_error("workspace snapshot version overflow"))?;
    validate_snapshot(&snapshot)?;
    save_snapshot(&app, &snapshot)?;
    {
        let store = workspace_store();
        let mut guard = store
            .lock()
            .map_err(|_| invalid_error("workspace store lock poisoned"))?;
        guard.snapshot = Some(snapshot.clone());
    }
    app.emit(
        WORKSPACE_CHANGED_EVENT,
        WorkspaceChangedEvent {
            version: snapshot.version,
            reason,
            snapshot: snapshot.clone(),
        },
    )
    .map_err(io_error)?;
    Ok(snapshot)
}

pub(crate) fn close_floating_window_by_id(
    app: &AppHandle,
    floating_window_id: &str,
) -> Result<WorkspaceLayoutSnapshot> {
    let mut snapshot = current_snapshot(app)?;
    close_floating_window(&mut snapshot, floating_window_id)?;
    normalize_snapshot_group_roles(&mut snapshot);
    snapshot.version = snapshot
        .version
        .checked_add(1)
        .ok_or_else(|| invalid_error("workspace snapshot version overflow"))?;
    validate_snapshot(&snapshot)?;
    save_snapshot(app, &snapshot)?;
    {
        let store = workspace_store();
        let mut guard = store
            .lock()
            .map_err(|_| invalid_error("workspace store lock poisoned"))?;
        guard.snapshot = Some(snapshot.clone());
    }
    app.emit(
        WORKSPACE_CHANGED_EVENT,
        WorkspaceChangedEvent {
            version: snapshot.version,
            reason: "close_floating_window".to_string(),
            snapshot: snapshot.clone(),
        },
    )
    .map_err(io_error)?;
    Ok(snapshot)
}

pub(crate) fn owned_workspace_tool_host(
    app: &AppHandle,
    workspace_id: &str,
    tool_tab_id: &str,
    expected_kind: WorkspaceToolKind,
) -> Result<String> {
    let snapshot = current_snapshot(app)?;
    let workspace = require_workspace(&snapshot, workspace_id)?;
    if !workspace
        .owned_tool_tab_ids
        .iter()
        .any(|owned_id| owned_id == tool_tab_id)
    {
        return Err(invalid_error(format!(
            "tool tab {tool_tab_id} is not owned by workspace {workspace_id}"
        )));
    }
    let tool_tab = snapshot
        .tool_tabs
        .iter()
        .find(|tool_tab| tool_tab.id == tool_tab_id)
        .ok_or_else(|| missing_error(format!("tool tab {tool_tab_id} not found")))?;
    if tool_tab.owner_workspace_id != workspace_id {
        return Err(invalid_error(format!(
            "tool tab {tool_tab_id} owner does not match workspace {workspace_id}"
        )));
    }
    if tool_tab.kind != expected_kind {
        return Err(invalid_error(format!(
            "tool tab {tool_tab_id} is not a {:?} ToolTab",
            expected_kind
        )));
    }
    if tool_tab.host_id != workspace.host_id {
        return Err(invalid_error(format!(
            "tool tab {tool_tab_id} host does not match workspace {workspace_id}"
        )));
    }
    Ok(workspace.host_id.clone())
}

fn current_snapshot(app: &AppHandle) -> Result<WorkspaceLayoutSnapshot> {
    {
        let store = workspace_store();
        let guard = store
            .lock()
            .map_err(|_| invalid_error("workspace store lock poisoned"))?;
        if let Some(snapshot) = &guard.snapshot {
            return Ok(snapshot.clone());
        }
    }
    let snapshot = load_snapshot(app)?;
    {
        let store = workspace_store();
        let mut guard = store
            .lock()
            .map_err(|_| invalid_error("workspace store lock poisoned"))?;
        guard.snapshot = Some(snapshot.clone());
    }
    Ok(snapshot)
}

fn load_snapshot(app: &AppHandle) -> Result<WorkspaceLayoutSnapshot> {
    let snapshot = default_snapshot(app)?;
    save_snapshot(app, &snapshot)?;
    Ok(snapshot)
}

fn save_snapshot(app: &AppHandle, snapshot: &WorkspaceLayoutSnapshot) -> Result<()> {
    let path = workspace_state_path(app)?;
    ensure_parent(&path)?;
    write_atomic(
        &path,
        &toml::to_string_pretty(&WorkspaceStateFile {
            snapshot: snapshot.clone(),
        })
        .map_err(parse_error)?,
    )
}

fn workspace_state_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(PathBuf::from(root_paths(app)?.root_dir).join(WORKSPACE_STATE_FILE))
}

fn default_snapshot(app: &AppHandle) -> Result<WorkspaceLayoutSnapshot> {
    let host_id = default_connection_host_id(app)?;
    let host = connection_host_by_id(app, &host_id)?;
    start_saved_port_forwards_for_host_open(app, &host)?;
    let workspace_id = new_id("workspace");
    let files_tool_id = new_id("tool-files");
    let terminal_tool_id = new_id("tool-terminal");
    let resources_tool_id = new_id("tool-resources");
    let transfers_tool_id = new_id("tool-transfers");
    let ports_tool_id = new_id("tool-ports");
    let files_slot_id = new_id("slot-files");
    let terminal_slot_id = new_id("slot-terminal");
    let resources_slot_id = new_id("slot-resources");
    let transfers_slot_id = new_id("slot-transfers");
    let ports_slot_id = new_id("slot-ports");
    let files_group_id = new_id("group-files");
    let terminal_group_id = new_id("group-terminal");
    let right_group_id = new_id("group-resources-transfers");
    let ports_group_id = new_id("group-ports");
    let title = host.document.name.clone();
    let default_files_path = host
        .document
        .files
        .as_ref()
        .and_then(|files| files.default_path.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "~".to_string());
    Ok(WorkspaceLayoutSnapshot {
        version: 0,
        active_workspace_id: workspace_id.clone(),
        workspaces: vec![WorkspaceTabState {
            id: workspace_id.clone(),
            host_id: host_id.clone(),
            title: title.clone(),
            owned_tool_tab_ids: vec![
                files_tool_id.clone(),
                terminal_tool_id.clone(),
                resources_tool_id.clone(),
                transfers_tool_id.clone(),
                ports_tool_id.clone(),
            ],
            layout: WorkspaceDockLayout::Split {
                direction: WorkspaceDockDirection::Column,
                children: vec![
                    WorkspaceDockLayout::Split {
                        direction: WorkspaceDockDirection::Row,
                        children: vec![
                            WorkspaceDockLayout::Group {
                                id: files_group_id,
                                role: WorkspaceDockGroupRole::SidePanel,
                                slots: vec![WorkspaceToolSlot::Owned {
                                    id: files_slot_id.clone(),
                                    tool_tab_id: files_tool_id.clone(),
                                }],
                                active_slot_id: files_slot_id,
                            },
                            WorkspaceDockLayout::Group {
                                id: terminal_group_id,
                                role: WorkspaceDockGroupRole::Content,
                                slots: vec![WorkspaceToolSlot::Owned {
                                    id: terminal_slot_id.clone(),
                                    tool_tab_id: terminal_tool_id.clone(),
                                }],
                                active_slot_id: terminal_slot_id,
                            },
                            WorkspaceDockLayout::Group {
                                id: right_group_id,
                                role: WorkspaceDockGroupRole::SidePanel,
                                slots: vec![
                                    WorkspaceToolSlot::Owned {
                                        id: resources_slot_id.clone(),
                                        tool_tab_id: resources_tool_id.clone(),
                                    },
                                    WorkspaceToolSlot::Owned {
                                        id: transfers_slot_id.clone(),
                                        tool_tab_id: transfers_tool_id.clone(),
                                    },
                                ],
                                active_slot_id: resources_slot_id,
                            },
                        ],
                        ratios: vec![0.24, 0.52, 0.24],
                    },
                    WorkspaceDockLayout::Group {
                        id: ports_group_id,
                        role: WorkspaceDockGroupRole::SidePanel,
                        slots: vec![WorkspaceToolSlot::Owned {
                            id: ports_slot_id.clone(),
                            tool_tab_id: ports_tool_id.clone(),
                        }],
                        active_slot_id: ports_slot_id,
                    },
                ],
                ratios: vec![0.7, 0.3],
            },
        }],
        tool_tabs: vec![
            WorkspaceToolTab {
                id: files_tool_id,
                kind: WorkspaceToolKind::Files,
                owner_workspace_id: workspace_id.clone(),
                host_id: host_id.clone(),
                title: default_files_path,
            },
            WorkspaceToolTab {
                id: terminal_tool_id,
                kind: WorkspaceToolKind::Terminal,
                owner_workspace_id: workspace_id.clone(),
                host_id: host_id.clone(),
                title: default_terminal_title(host.document.protocol),
            },
            WorkspaceToolTab {
                id: resources_tool_id,
                kind: WorkspaceToolKind::Resources,
                owner_workspace_id: workspace_id.clone(),
                host_id: host_id.clone(),
                title: "Resources".to_string(),
            },
            WorkspaceToolTab {
                id: transfers_tool_id,
                kind: WorkspaceToolKind::Transfers,
                owner_workspace_id: workspace_id.clone(),
                host_id: host_id.clone(),
                title: "Transfers".to_string(),
            },
            WorkspaceToolTab {
                id: ports_tool_id,
                kind: WorkspaceToolKind::Ports,
                owner_workspace_id: workspace_id,
                host_id,
                title: "Ports".to_string(),
            },
        ],
        floating_windows: Vec::new(),
    })
}

fn apply_intent(
    app: &AppHandle,
    snapshot: &mut WorkspaceLayoutSnapshot,
    intent: WorkspaceIntent,
) -> Result<()> {
    match intent {
        WorkspaceIntent::CreateWorkspace { host_id } => create_workspace(app, snapshot, host_id),
        WorkspaceIntent::ActivateWorkspace { workspace_id } => {
            require_workspace(snapshot, &workspace_id)?;
            snapshot.active_workspace_id = workspace_id;
            Ok(())
        }
        WorkspaceIntent::RenameWorkspace {
            workspace_id,
            title,
        } => {
            let trimmed = title.trim();
            if trimmed.is_empty() {
                return Err(invalid_error("workspace title cannot be empty"));
            }
            require_workspace_mut(snapshot, &workspace_id)?.title = trimmed.to_string();
            Ok(())
        }
        WorkspaceIntent::CloseWorkspace { workspace_id } => {
            close_workspace(snapshot, &workspace_id)
        }
        WorkspaceIntent::CloseOtherWorkspaces { workspace_id } => {
            close_other_workspaces(snapshot, &workspace_id)
        }
        WorkspaceIntent::CloseWorkspacesToRight { workspace_id } => {
            close_workspaces_to_right(snapshot, &workspace_id)
        }
        WorkspaceIntent::ActivateToolSlot {
            workspace_id,
            slot_id,
        } => activate_tool_slot(snapshot, &workspace_id, &slot_id),
        WorkspaceIntent::CloseToolSlot {
            workspace_id,
            slot_id,
        } => close_tool_slot(snapshot, &workspace_id, &slot_id),
        WorkspaceIntent::CloseOtherToolSlots {
            workspace_id,
            slot_id,
        } => close_other_tool_slots(snapshot, &workspace_id, &slot_id),
        WorkspaceIntent::CloseToolSlotsToRight {
            workspace_id,
            slot_id,
        } => close_tool_slots_to_right(snapshot, &workspace_id, &slot_id),
        WorkspaceIntent::MirrorToolTab {
            source_tool_tab_id,
            target_workspace_id,
            target_group_id,
        } => mirror_tool_tab(
            snapshot,
            &source_tool_tab_id,
            &target_workspace_id,
            &target_group_id,
        ),
        WorkspaceIntent::FloatToolSlot {
            workspace_id,
            slot_id,
        } => float_tool_slot(snapshot, &workspace_id, &slot_id),
        WorkspaceIntent::CloseFloatingWindow { floating_window_id } => {
            close_floating_window(snapshot, &floating_window_id)
        }
        WorkspaceIntent::MoveToolSlotToGroup {
            workspace_id,
            slot_id,
            target_group_id,
        } => move_tool_slot_to_group(snapshot, &workspace_id, &slot_id, &target_group_id),
        WorkspaceIntent::MoveToolSlotToSplit {
            workspace_id,
            slot_id,
            target_slot_id,
            side,
        } => move_tool_slot_to_split(snapshot, &workspace_id, &slot_id, &target_slot_id, side),
        WorkspaceIntent::MoveToolSlotToWorkspaceEdge {
            workspace_id,
            slot_id,
            side,
        } => move_tool_slot_to_workspace_edge(snapshot, &workspace_id, &slot_id, side),
        WorkspaceIntent::SplitToolSlot {
            workspace_id,
            target_slot_id,
            tool_tab_id,
            side,
        } => split_tool_slot(snapshot, &workspace_id, &target_slot_id, &tool_tab_id, side),
        WorkspaceIntent::CreateTerminalToolTab {
            workspace_id,
            target_group_id,
        } => create_terminal_tool_tab(snapshot, &workspace_id, target_group_id.as_deref()),
        WorkspaceIntent::OpenResourceMonitorToolTab {
            workspace_id,
            target_group_id,
        } => open_resource_monitor_tool_tab(snapshot, &workspace_id, target_group_id.as_deref()),
    }
}

fn create_workspace(
    app: &AppHandle,
    snapshot: &mut WorkspaceLayoutSnapshot,
    host_id: String,
) -> Result<()> {
    let host = connection_host_by_id(app, &host_id)?;
    start_saved_port_forwards_for_host_open(app, &host)?;
    let workspace_id = new_id("workspace");
    let files_tool_id = new_id("tool-files");
    let terminal_tool_id = new_id("tool-terminal");
    let resources_tool_id = new_id("tool-resources");
    let transfers_tool_id = new_id("tool-transfers");
    let ports_tool_id = new_id("tool-ports");
    let files_slot_id = new_id("slot-files");
    let terminal_slot_id = new_id("slot-terminal");
    let resources_slot_id = new_id("slot-resources");
    let transfers_slot_id = new_id("slot-transfers");
    let ports_slot_id = new_id("slot-ports");
    let files_group_id = new_id("group-files");
    let terminal_group_id = new_id("group-terminal");
    let right_group_id = new_id("group-resources-transfers");
    let ports_group_id = new_id("group-ports");
    let title = unique_workspace_title(snapshot, &host.document.name);
    let default_files_path = host
        .document
        .files
        .as_ref()
        .and_then(|files| files.default_path.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "~".to_string());
    let tool_ids = NewWorkspaceToolIds {
        files_tool_id: files_tool_id.clone(),
        terminal_tool_id: terminal_tool_id.clone(),
        resources_tool_id: resources_tool_id.clone(),
        transfers_tool_id: transfers_tool_id.clone(),
        ports_tool_id: ports_tool_id.clone(),
        files_slot_id: files_slot_id.clone(),
        terminal_slot_id: terminal_slot_id.clone(),
        resources_slot_id: resources_slot_id.clone(),
        transfers_slot_id: transfers_slot_id.clone(),
        ports_slot_id: ports_slot_id.clone(),
    };
    let layout_plan =
        remembered_workspace_layout(snapshot, &snapshot.active_workspace_id, &tool_ids)?
            .unwrap_or_else(|| {
                default_new_workspace_layout(
                    files_group_id,
                    terminal_group_id,
                    right_group_id,
                    ports_group_id,
                    &tool_ids,
                )
            });
    snapshot.workspaces.push(WorkspaceTabState {
        id: workspace_id.clone(),
        host_id: host_id.clone(),
        title,
        owned_tool_tab_ids: layout_plan.owned_tool_tab_ids.clone(),
        layout: layout_plan.layout,
    });
    if layout_plan.used.files {
        snapshot.tool_tabs.push(WorkspaceToolTab {
            id: files_tool_id,
            kind: WorkspaceToolKind::Files,
            owner_workspace_id: workspace_id.clone(),
            host_id: host_id.clone(),
            title: default_files_path,
        });
    }
    snapshot.tool_tabs.push(WorkspaceToolTab {
        id: terminal_tool_id,
        kind: WorkspaceToolKind::Terminal,
        owner_workspace_id: workspace_id.clone(),
        host_id: host_id.clone(),
        title: default_terminal_title(host.document.protocol),
    });
    if layout_plan.used.resources {
        snapshot.tool_tabs.push(WorkspaceToolTab {
            id: resources_tool_id,
            kind: WorkspaceToolKind::Resources,
            owner_workspace_id: workspace_id.clone(),
            host_id: host_id.clone(),
            title: "Resources".to_string(),
        });
    }
    if layout_plan.used.transfers {
        snapshot.tool_tabs.push(WorkspaceToolTab {
            id: transfers_tool_id,
            kind: WorkspaceToolKind::Transfers,
            owner_workspace_id: workspace_id.clone(),
            host_id: host_id.clone(),
            title: "Transfers".to_string(),
        });
    }
    if layout_plan.used.ports {
        snapshot.tool_tabs.push(WorkspaceToolTab {
            id: ports_tool_id,
            kind: WorkspaceToolKind::Ports,
            owner_workspace_id: workspace_id.clone(),
            host_id,
            title: "Ports".to_string(),
        });
    }
    snapshot.active_workspace_id = workspace_id;
    Ok(())
}

struct NewWorkspaceToolIds {
    files_tool_id: String,
    terminal_tool_id: String,
    resources_tool_id: String,
    transfers_tool_id: String,
    ports_tool_id: String,
    files_slot_id: String,
    terminal_slot_id: String,
    resources_slot_id: String,
    transfers_slot_id: String,
    ports_slot_id: String,
}

#[derive(Clone, Copy, Default)]
struct NewWorkspaceToolUsage {
    files: bool,
    terminal: bool,
    resources: bool,
    transfers: bool,
    ports: bool,
}

struct NewWorkspaceLayoutPlan {
    owned_tool_tab_ids: Vec<String>,
    layout: WorkspaceDockLayout,
    used: NewWorkspaceToolUsage,
}

fn default_new_workspace_layout(
    files_group_id: String,
    terminal_group_id: String,
    right_group_id: String,
    ports_group_id: String,
    ids: &NewWorkspaceToolIds,
) -> NewWorkspaceLayoutPlan {
    NewWorkspaceLayoutPlan {
        owned_tool_tab_ids: vec![
            ids.files_tool_id.clone(),
            ids.terminal_tool_id.clone(),
            ids.resources_tool_id.clone(),
            ids.transfers_tool_id.clone(),
            ids.ports_tool_id.clone(),
        ],
        layout: WorkspaceDockLayout::Split {
            direction: WorkspaceDockDirection::Column,
            children: vec![
                WorkspaceDockLayout::Split {
                    direction: WorkspaceDockDirection::Row,
                    children: vec![
                        WorkspaceDockLayout::Group {
                            id: files_group_id,
                            role: WorkspaceDockGroupRole::SidePanel,
                            slots: vec![WorkspaceToolSlot::Owned {
                                id: ids.files_slot_id.clone(),
                                tool_tab_id: ids.files_tool_id.clone(),
                            }],
                            active_slot_id: ids.files_slot_id.clone(),
                        },
                        WorkspaceDockLayout::Group {
                            id: terminal_group_id,
                            role: WorkspaceDockGroupRole::Content,
                            slots: vec![WorkspaceToolSlot::Owned {
                                id: ids.terminal_slot_id.clone(),
                                tool_tab_id: ids.terminal_tool_id.clone(),
                            }],
                            active_slot_id: ids.terminal_slot_id.clone(),
                        },
                        WorkspaceDockLayout::Group {
                            id: right_group_id,
                            role: WorkspaceDockGroupRole::SidePanel,
                            slots: vec![
                                WorkspaceToolSlot::Owned {
                                    id: ids.resources_slot_id.clone(),
                                    tool_tab_id: ids.resources_tool_id.clone(),
                                },
                                WorkspaceToolSlot::Owned {
                                    id: ids.transfers_slot_id.clone(),
                                    tool_tab_id: ids.transfers_tool_id.clone(),
                                },
                            ],
                            active_slot_id: ids.resources_slot_id.clone(),
                        },
                    ],
                    ratios: vec![0.24, 0.52, 0.24],
                },
                WorkspaceDockLayout::Group {
                    id: ports_group_id,
                    role: WorkspaceDockGroupRole::SidePanel,
                    slots: vec![WorkspaceToolSlot::Owned {
                        id: ids.ports_slot_id.clone(),
                        tool_tab_id: ids.ports_tool_id.clone(),
                    }],
                    active_slot_id: ids.ports_slot_id.clone(),
                },
            ],
            ratios: vec![0.7, 0.3],
        },
        used: NewWorkspaceToolUsage {
            files: true,
            terminal: true,
            resources: true,
            transfers: true,
            ports: true,
        },
    }
}

fn remembered_workspace_layout(
    snapshot: &WorkspaceLayoutSnapshot,
    source_workspace_id: &str,
    ids: &NewWorkspaceToolIds,
) -> Result<Option<NewWorkspaceLayoutPlan>> {
    let source = match snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.id == source_workspace_id)
    {
        Some(workspace) => workspace,
        None => return Ok(None),
    };
    let mut used = NewWorkspaceToolUsage::default();
    let Some(layout) = remap_remembered_layout(
        &source.layout,
        snapshot,
        source_workspace_id,
        ids,
        &mut used,
    )?
    else {
        return Ok(None);
    };
    let layout = if used.terminal {
        layout
    } else {
        add_slot_to_first_content_group(
            layout,
            WorkspaceToolSlot::Owned {
                id: ids.terminal_slot_id.clone(),
                tool_tab_id: ids.terminal_tool_id.clone(),
            },
            &mut used,
        )?
    };
    let Some(layout) = cleanup_dock_layout(Some(layout))? else {
        return Ok(None);
    };
    if !has_group_role(&layout, WorkspaceDockGroupRole::Content) {
        return Ok(None);
    }
    Ok(Some(NewWorkspaceLayoutPlan {
        owned_tool_tab_ids: remembered_owned_tool_tab_ids(ids, used),
        layout,
        used,
    }))
}

fn remap_remembered_layout(
    layout: &WorkspaceDockLayout,
    snapshot: &WorkspaceLayoutSnapshot,
    source_workspace_id: &str,
    ids: &NewWorkspaceToolIds,
    used: &mut NewWorkspaceToolUsage,
) -> Result<Option<WorkspaceDockLayout>> {
    match layout {
        WorkspaceDockLayout::Group {
            role,
            slots,
            active_slot_id,
            ..
        } => {
            let mut remapped_slots = Vec::new();
            let mut active = String::new();
            for slot in slots {
                let old_slot_id = workspace_slot_id(slot);
                if let Some(remapped) =
                    remap_remembered_slot(slot, snapshot, source_workspace_id, ids, used)?
                {
                    if old_slot_id == active_slot_id {
                        active = workspace_slot_id(&remapped).to_string();
                    }
                    remapped_slots.push(remapped);
                }
            }
            if remapped_slots.is_empty() {
                return if *role == WorkspaceDockGroupRole::Content {
                    Ok(Some(WorkspaceDockLayout::Group {
                        id: new_id("group-content"),
                        role: *role,
                        slots: Vec::new(),
                        active_slot_id: String::new(),
                    }))
                } else {
                    Ok(None)
                };
            }
            if active.is_empty() {
                active = workspace_slot_id(&remapped_slots[0]).to_string();
            }
            Ok(Some(WorkspaceDockLayout::Group {
                id: new_id("group"),
                role: *role,
                slots: remapped_slots,
                active_slot_id: active,
            }))
        }
        WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        } => {
            let mut remapped_children = Vec::new();
            let mut remapped_ratios = Vec::new();
            for (index, child) in children.iter().enumerate() {
                if let Some(remapped) =
                    remap_remembered_layout(child, snapshot, source_workspace_id, ids, used)?
                {
                    remapped_children.push(remapped);
                    remapped_ratios.push(ratios.get(index).copied().unwrap_or(1.0));
                }
            }
            match remapped_children.len() {
                0 => Ok(None),
                1 => Ok(remapped_children.into_iter().next()),
                _ => Ok(Some(WorkspaceDockLayout::Split {
                    direction: direction.clone(),
                    ratios: normalize_ratios(&remapped_ratios)?,
                    children: remapped_children,
                })),
            }
        }
    }
}

fn remap_remembered_slot(
    slot: &WorkspaceToolSlot,
    snapshot: &WorkspaceLayoutSnapshot,
    source_workspace_id: &str,
    ids: &NewWorkspaceToolIds,
    used: &mut NewWorkspaceToolUsage,
) -> Result<Option<WorkspaceToolSlot>> {
    let WorkspaceToolSlot::Owned { tool_tab_id, .. } = slot else {
        return Ok(None);
    };
    let Some(kind) = snapshot
        .tool_tabs
        .iter()
        .find(|tool_tab| {
            tool_tab.id == *tool_tab_id && tool_tab.owner_workspace_id == source_workspace_id
        })
        .map(|tool_tab| tool_tab.kind.clone())
    else {
        return Ok(None);
    };
    let next = match kind {
        WorkspaceToolKind::Files if !used.files => {
            used.files = true;
            Some((ids.files_slot_id.clone(), ids.files_tool_id.clone()))
        }
        WorkspaceToolKind::Terminal if !used.terminal => {
            used.terminal = true;
            Some((ids.terminal_slot_id.clone(), ids.terminal_tool_id.clone()))
        }
        WorkspaceToolKind::Resources if !used.resources => {
            used.resources = true;
            Some((ids.resources_slot_id.clone(), ids.resources_tool_id.clone()))
        }
        WorkspaceToolKind::Transfers if !used.transfers => {
            used.transfers = true;
            Some((ids.transfers_slot_id.clone(), ids.transfers_tool_id.clone()))
        }
        WorkspaceToolKind::Ports if !used.ports => {
            used.ports = true;
            Some((ids.ports_slot_id.clone(), ids.ports_tool_id.clone()))
        }
        _ => None,
    };
    Ok(next.map(|(id, tool_tab_id)| WorkspaceToolSlot::Owned { id, tool_tab_id }))
}

fn add_slot_to_first_content_group(
    layout: WorkspaceDockLayout,
    slot: WorkspaceToolSlot,
    used: &mut NewWorkspaceToolUsage,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            mut slots,
            active_slot_id,
        } if role == WorkspaceDockGroupRole::Content => {
            let slot_id = workspace_slot_id(&slot).to_string();
            slots.push(slot);
            used.terminal = true;
            Ok(WorkspaceDockLayout::Group {
                id,
                role,
                slots,
                active_slot_id: if active_slot_id.is_empty() {
                    slot_id
                } else {
                    active_slot_id
                },
            })
        }
        WorkspaceDockLayout::Group { .. } => Ok(layout),
        WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        } => {
            let mut inserted = false;
            let mut next_children = Vec::new();
            for child in children {
                if inserted {
                    next_children.push(child);
                    continue;
                }
                let next = add_slot_to_first_content_group(child, slot.clone(), used)?;
                inserted = used.terminal;
                next_children.push(next);
            }
            if !inserted {
                return Err(invalid_error(
                    "remembered layout has no content group for Terminal",
                ));
            }
            Ok(WorkspaceDockLayout::Split {
                direction,
                children: next_children,
                ratios,
            })
        }
    }
}

fn remembered_owned_tool_tab_ids(
    ids: &NewWorkspaceToolIds,
    used: NewWorkspaceToolUsage,
) -> Vec<String> {
    let mut tool_ids = Vec::new();
    if used.files {
        tool_ids.push(ids.files_tool_id.clone());
    }
    tool_ids.push(ids.terminal_tool_id.clone());
    if used.resources {
        tool_ids.push(ids.resources_tool_id.clone());
    }
    if used.transfers {
        tool_ids.push(ids.transfers_tool_id.clone());
    }
    if used.ports {
        tool_ids.push(ids.ports_tool_id.clone());
    }
    tool_ids
}

fn unique_workspace_title(snapshot: &WorkspaceLayoutSnapshot, base_title: &str) -> String {
    let fallback = "Workspace";
    let base = base_title.trim();
    let base = if base.is_empty() { fallback } else { base };
    let existing = snapshot
        .workspaces
        .iter()
        .map(|workspace| workspace.title.trim())
        .collect::<HashSet<_>>();
    if !existing.contains(base) {
        return base.to_string();
    }
    for suffix in 2u32.. {
        let candidate = format!("{base} {suffix}");
        if !existing.contains(candidate.as_str()) {
            return candidate;
        }
    }
    unreachable!("u32 suffix space should be sufficient for Workspace titles")
}

fn close_workspace(snapshot: &mut WorkspaceLayoutSnapshot, workspace_id: &str) -> Result<()> {
    require_workspace(snapshot, workspace_id)?;
    if snapshot.workspaces.len() == 1 {
        return Err(invalid_error("cannot close the last workspace"));
    }
    let closing = require_workspace(snapshot, workspace_id)?;
    let closing_host_id = closing.host_id.clone();
    let closing_workspace_title = closing.title.clone();
    let owned_tool_tab_ids = closing.owned_tool_tab_ids.clone();
    let closing_tool_titles = snapshot
        .tool_tabs
        .iter()
        .filter(|tool_tab| tool_tab.owner_workspace_id == workspace_id)
        .map(|tool_tab| (tool_tab.id.clone(), tool_tab.title.clone()))
        .collect::<HashMap<_, _>>();
    snapshot
        .workspaces
        .retain(|workspace| workspace.id != workspace_id);
    snapshot
        .tool_tabs
        .retain(|tool_tab| tool_tab.owner_workspace_id != workspace_id);
    for workspace in &mut snapshot.workspaces {
        workspace.layout = close_mirrors_for_tool_tabs(
            workspace.layout.clone(),
            &owned_tool_tab_ids,
            &closing_tool_titles,
            &closing_workspace_title,
        )?;
    }
    for window in &mut snapshot.floating_windows {
        window.layout = close_mirrors_for_tool_tabs(
            window.layout.clone(),
            &owned_tool_tab_ids,
            &closing_tool_titles,
            &closing_workspace_title,
        )?;
    }
    if snapshot.active_workspace_id == workspace_id {
        let next = snapshot
            .workspaces
            .first()
            .ok_or_else(|| invalid_error("workspace list is empty after close"))?;
        snapshot.active_workspace_id = next.id.clone();
    }
    after_workspace_closed(snapshot, workspace_id, &closing_host_id)?;
    Ok(())
}

fn close_other_workspaces(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
) -> Result<()> {
    require_workspace(snapshot, workspace_id)?;
    let closing_ids = snapshot
        .workspaces
        .iter()
        .filter(|workspace| workspace.id != workspace_id)
        .map(|workspace| workspace.id.clone())
        .collect::<Vec<_>>();
    for closing_id in closing_ids {
        close_workspace_without_last_guard(snapshot, &closing_id)?;
    }
    snapshot.active_workspace_id = workspace_id.to_string();
    Ok(())
}

fn close_workspaces_to_right(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
) -> Result<()> {
    let index = snapshot
        .workspaces
        .iter()
        .position(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| missing_error(format!("workspace {workspace_id} not found")))?;
    let closing_ids = snapshot
        .workspaces
        .iter()
        .skip(index + 1)
        .map(|workspace| workspace.id.clone())
        .collect::<Vec<_>>();
    for closing_id in closing_ids {
        close_workspace_without_last_guard(snapshot, &closing_id)?;
    }
    Ok(())
}

fn close_workspace_without_last_guard(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
) -> Result<()> {
    if snapshot.workspaces.len() == 1 {
        return Err(invalid_error("cannot close the last workspace"));
    }
    let closing = require_workspace(snapshot, workspace_id)?;
    let closing_host_id = closing.host_id.clone();
    let closing_workspace_title = closing.title.clone();
    let owned_tool_tab_ids = require_workspace(snapshot, workspace_id)?
        .owned_tool_tab_ids
        .clone();
    let closing_tool_titles = snapshot
        .tool_tabs
        .iter()
        .filter(|tool_tab| tool_tab.owner_workspace_id == workspace_id)
        .map(|tool_tab| (tool_tab.id.clone(), tool_tab.title.clone()))
        .collect::<HashMap<_, _>>();
    snapshot
        .workspaces
        .retain(|workspace| workspace.id != workspace_id);
    snapshot
        .tool_tabs
        .retain(|tool_tab| tool_tab.owner_workspace_id != workspace_id);
    for workspace in &mut snapshot.workspaces {
        workspace.layout = close_mirrors_for_tool_tabs(
            workspace.layout.clone(),
            &owned_tool_tab_ids,
            &closing_tool_titles,
            &closing_workspace_title,
        )?;
    }
    for window in &mut snapshot.floating_windows {
        window.layout = close_mirrors_for_tool_tabs(
            window.layout.clone(),
            &owned_tool_tab_ids,
            &closing_tool_titles,
            &closing_workspace_title,
        )?;
    }
    if snapshot.active_workspace_id == workspace_id {
        let next = snapshot
            .workspaces
            .first()
            .ok_or_else(|| invalid_error("workspace list is empty after close"))?;
        snapshot.active_workspace_id = next.id.clone();
    }
    after_workspace_closed(snapshot, workspace_id, &closing_host_id)?;
    Ok(())
}

fn after_workspace_closed(
    snapshot: &WorkspaceLayoutSnapshot,
    workspace_id: &str,
    host_id: &str,
) -> Result<()> {
    workspace_ssh_coordinator().remove_workspace(workspace_id)?;
    if !snapshot
        .workspaces
        .iter()
        .any(|workspace| workspace.host_id == host_id)
    {
        close_host_port_forward_runtime(host_id)?;
    }
    Ok(())
}

fn activate_tool_slot(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    slot_id: &str,
) -> Result<()> {
    let workspace = require_workspace_mut(snapshot, workspace_id)?;
    workspace.layout = activate_slot(workspace.layout.clone(), slot_id)?;
    Ok(())
}

fn close_tool_slot(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    slot_id: &str,
) -> Result<()> {
    let workspace = require_workspace(snapshot, workspace_id)?;
    let slot = find_slot(&workspace.layout, slot_id)
        .ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?
        .clone();
    match slot {
        WorkspaceToolSlot::Owned { tool_tab_id, .. } => {
            close_owner_tool_tab(snapshot, &tool_tab_id)
        }
        WorkspaceToolSlot::Mirror { .. }
        | WorkspaceToolSlot::FloatingPlaceholder { .. }
        | WorkspaceToolSlot::ClosedSource { .. } => {
            let workspace = require_workspace_mut(snapshot, workspace_id)?;
            workspace.layout = remove_slot(workspace.layout.clone(), slot_id)?
                .ok_or_else(|| invalid_error("cannot close the last tool tab in a workspace"))?;
            Ok(())
        }
    }
}

fn close_other_tool_slots(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    slot_id: &str,
) -> Result<()> {
    require_workspace(snapshot, workspace_id)?;
    let slots = collect_slots(&require_workspace(snapshot, workspace_id)?.layout)
        .into_iter()
        .map(|slot| workspace_slot_id(slot).to_string())
        .filter(|id| id != slot_id)
        .collect::<Vec<_>>();
    for other_slot_id in slots {
        if require_workspace(snapshot, workspace_id)
            .map(|workspace| contains_slot(&workspace.layout, &other_slot_id))
            .unwrap_or(false)
        {
            close_tool_slot(snapshot, workspace_id, &other_slot_id)?;
        }
    }
    if require_workspace(snapshot, workspace_id)
        .map(|workspace| contains_slot(&workspace.layout, slot_id))
        .unwrap_or(false)
    {
        activate_tool_slot(snapshot, workspace_id, slot_id)?;
    }
    Ok(())
}

fn close_tool_slots_to_right(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    slot_id: &str,
) -> Result<()> {
    let workspace = require_workspace(snapshot, workspace_id)?;
    let group_slots = find_group_containing_slot(&workspace.layout, slot_id)
        .ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?;
    let index = group_slots
        .iter()
        .position(|slot| workspace_slot_id(slot) == slot_id)
        .ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?;
    let slots_to_close = group_slots
        .iter()
        .skip(index + 1)
        .map(|slot| workspace_slot_id(slot).to_string())
        .collect::<Vec<_>>();
    for closing_slot_id in slots_to_close {
        if require_workspace(snapshot, workspace_id)
            .map(|workspace| contains_slot(&workspace.layout, &closing_slot_id))
            .unwrap_or(false)
        {
            close_tool_slot(snapshot, workspace_id, &closing_slot_id)?;
        }
    }
    Ok(())
}

fn mirror_tool_tab(
    snapshot: &mut WorkspaceLayoutSnapshot,
    source_tool_tab_id: &str,
    target_workspace_id: &str,
    target_group_id: &str,
) -> Result<()> {
    let source_tool_tab = snapshot
        .tool_tabs
        .iter()
        .find(|tool_tab| tool_tab.id == source_tool_tab_id)
        .ok_or_else(|| missing_error(format!("tool tab {source_tool_tab_id} not found")))?
        .clone();
    if source_tool_tab.owner_workspace_id == target_workspace_id {
        return Err(invalid_error(
            "owned tool tabs should be moved inside their owner workspace, not mirrored",
        ));
    }
    let target_workspace = require_workspace(snapshot, target_workspace_id)?;
    if let Some(duplicate) = collect_slots(&target_workspace.layout)
        .into_iter()
        .find(|slot| match slot {
            WorkspaceToolSlot::Mirror { tool_tab_id, .. } => tool_tab_id == source_tool_tab_id,
            _ => false,
        })
    {
        let duplicate_id = workspace_slot_id(duplicate).to_string();
        return activate_tool_slot(snapshot, target_workspace_id, &duplicate_id);
    }
    let slot = WorkspaceToolSlot::Mirror {
        id: new_id("slot-mirror"),
        tool_tab_id: source_tool_tab_id.to_string(),
        owner_workspace_id: source_tool_tab.owner_workspace_id,
    };
    let target_workspace = require_workspace_mut(snapshot, target_workspace_id)?;
    target_workspace.layout =
        add_slot_to_group(target_workspace.layout.clone(), target_group_id, slot)?;
    Ok(())
}

fn float_tool_slot(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    slot_id: &str,
) -> Result<()> {
    let workspace = require_workspace(snapshot, workspace_id)?;
    let slot = find_slot(&workspace.layout, slot_id)
        .ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?
        .clone();
    if !matches!(slot, WorkspaceToolSlot::Owned { .. }) {
        return Err(invalid_error(
            "only owned tool tabs can be floated in the first implementation",
        ));
    }
    let WorkspaceToolSlot::Owned { tool_tab_id, .. } = slot else {
        return Err(invalid_error("display slot is not owned"));
    };
    let owner_workspace_id = snapshot
        .tool_tabs
        .iter()
        .find(|tool_tab| tool_tab.id == tool_tab_id)
        .ok_or_else(|| missing_error(format!("tool tab {tool_tab_id} not found")))?
        .owner_workspace_id
        .clone();
    let floating_window_id = new_id("floating-window");
    let floating_slot = WorkspaceToolSlot::Mirror {
        id: new_id("slot-floating"),
        tool_tab_id: tool_tab_id.clone(),
        owner_workspace_id,
    };
    snapshot
        .floating_windows
        .push(WorkspaceFloatingWindowState {
            id: floating_window_id,
            layout: WorkspaceDockLayout::Group {
                id: new_id("group-floating"),
                role: WorkspaceDockGroupRole::Content,
                active_slot_id: workspace_slot_id(&floating_slot).to_string(),
                slots: vec![floating_slot],
            },
        });
    Ok(())
}

fn close_floating_window(
    snapshot: &mut WorkspaceLayoutSnapshot,
    floating_window_id: &str,
) -> Result<()> {
    let Some(window_index) = snapshot
        .floating_windows
        .iter()
        .position(|window| window.id == floating_window_id)
    else {
        return Err(missing_error(format!(
            "floating window {floating_window_id} not found"
        )));
    };
    snapshot.floating_windows.remove(window_index);
    Ok(())
}

fn move_tool_slot_to_group(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    slot_id: &str,
    target_group_id: &str,
) -> Result<()> {
    let workspace = require_workspace(snapshot, workspace_id)?;
    if !contains_group(&workspace.layout, target_group_id) {
        return Err(missing_error(format!(
            "dock group {target_group_id} not found"
        )));
    }
    let (layout_without_slot, removed) = remove_slot_for_move(workspace.layout.clone(), slot_id)?;
    let removed =
        removed.ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?;
    if !contains_group(&layout_without_slot, target_group_id) {
        let workspace = require_workspace_mut(snapshot, workspace_id)?;
        workspace.layout = add_slot_to_first_group(layout_without_slot, removed)?;
        return Ok(());
    }
    let workspace = require_workspace_mut(snapshot, workspace_id)?;
    workspace.layout = add_slot_to_group(layout_without_slot, target_group_id, removed)?;
    Ok(())
}

fn move_tool_slot_to_split(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    slot_id: &str,
    target_slot_id: &str,
    side: WorkspaceDockSide,
) -> Result<()> {
    if slot_id == target_slot_id {
        return Ok(());
    }
    let workspace = require_workspace(snapshot, workspace_id)?;
    if !contains_slot(&workspace.layout, target_slot_id) {
        return Err(missing_error(format!(
            "target display slot {target_slot_id} not found"
        )));
    }
    let inserted_role = find_group_role_containing_slot(&workspace.layout, slot_id)
        .ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?;
    let (layout_without_slot, removed) = remove_slot_for_move(workspace.layout.clone(), slot_id)?;
    let removed =
        removed.ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?;
    if !contains_slot(&layout_without_slot, target_slot_id) {
        let workspace = require_workspace_mut(snapshot, workspace_id)?;
        workspace.layout = add_slot_to_first_group(layout_without_slot, removed)?;
        return Ok(());
    }
    let workspace = require_workspace_mut(snapshot, workspace_id)?;
    workspace.layout = cleanup_dock_layout(Some(split_slot_with_inserted_role(
        layout_without_slot,
        target_slot_id,
        removed,
        side,
        inserted_role,
    )?))?
    .ok_or_else(|| invalid_error("dock layout cleanup removed every group"))?;
    Ok(())
}

fn move_tool_slot_to_workspace_edge(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    slot_id: &str,
    side: WorkspaceDockSide,
) -> Result<()> {
    let workspace = require_workspace(snapshot, workspace_id)?;
    let (layout_without_slot, removed) = remove_slot_for_move(workspace.layout.clone(), slot_id)?;
    let removed =
        removed.ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?;
    let workspace = require_workspace_mut(snapshot, workspace_id)?;
    workspace.layout = split_workspace_edge(layout_without_slot, removed, side)?;
    Ok(())
}

fn split_tool_slot(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    target_slot_id: &str,
    tool_tab_id: &str,
    side: WorkspaceDockSide,
) -> Result<()> {
    let workspace = require_workspace(snapshot, workspace_id)?;
    if !workspace
        .owned_tool_tab_ids
        .iter()
        .any(|id| id == tool_tab_id)
    {
        return Err(invalid_error(format!(
            "tool tab {tool_tab_id} is not owned by workspace {workspace_id}"
        )));
    }
    let slot = WorkspaceToolSlot::Owned {
        id: new_id("slot"),
        tool_tab_id: tool_tab_id.to_string(),
    };
    let workspace = require_workspace_mut(snapshot, workspace_id)?;
    workspace.layout = split_slot(workspace.layout.clone(), target_slot_id, slot, side)?;
    Ok(())
}

fn create_terminal_tool_tab(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    target_group_id: Option<&str>,
) -> Result<()> {
    let workspace = require_workspace(snapshot, workspace_id)?.clone();
    let tool_tab_id = new_id("tool-terminal");
    let slot = WorkspaceToolSlot::Owned {
        id: new_id("slot-terminal"),
        tool_tab_id: tool_tab_id.clone(),
    };
    let title = snapshot
        .tool_tabs
        .iter()
        .find(|tool_tab| {
            tool_tab.owner_workspace_id == workspace_id
                && matches!(tool_tab.kind, WorkspaceToolKind::Terminal)
        })
        .map(|tool_tab| tool_tab.title.clone())
        .unwrap_or_else(|| "Shell".to_string());
    snapshot.tool_tabs.push(WorkspaceToolTab {
        id: tool_tab_id.clone(),
        kind: WorkspaceToolKind::Terminal,
        owner_workspace_id: workspace_id.to_string(),
        host_id: workspace.host_id.clone(),
        title,
    });
    let workspace = require_workspace_mut(snapshot, workspace_id)?;
    workspace.owned_tool_tab_ids.push(tool_tab_id);
    workspace.layout = match target_group_id {
        Some(group_id) if contains_group(&workspace.layout, group_id) => {
            add_slot_to_group(workspace.layout.clone(), group_id, slot)?
        }
        Some(group_id) => {
            return Err(missing_error(format!("dock group {group_id} not found")));
        }
        None => add_slot_to_first_group(workspace.layout.clone(), slot)?,
    };
    Ok(())
}

fn split_slot(
    layout: WorkspaceDockLayout,
    target_slot_id: &str,
    inserted_slot: WorkspaceToolSlot,
    side: WorkspaceDockSide,
) -> Result<WorkspaceDockLayout> {
    if !contains_slot(&layout, target_slot_id) {
        return Err(missing_error(format!(
            "target display slot {target_slot_id} not found"
        )));
    }
    if contains_slot(&layout, workspace_slot_id(&inserted_slot)) {
        return Err(invalid_error(format!(
            "display slot {} already exists",
            workspace_slot_id(&inserted_slot)
        )));
    }
    let target_role = find_group_role_containing_slot(&layout, target_slot_id)
        .ok_or_else(|| missing_error(format!("target display slot {target_slot_id} not found")))?;
    split_slot_with_inserted_role(layout, target_slot_id, inserted_slot, side, target_role)
}

fn split_slot_with_inserted_role(
    layout: WorkspaceDockLayout,
    target_slot_id: &str,
    inserted_slot: WorkspaceToolSlot,
    side: WorkspaceDockSide,
    inserted_role: WorkspaceDockGroupRole,
) -> Result<WorkspaceDockLayout> {
    split_slot_recursive(layout, target_slot_id, inserted_slot, side, inserted_role)
}

fn split_workspace_edge(
    layout: WorkspaceDockLayout,
    inserted_slot: WorkspaceToolSlot,
    side: WorkspaceDockSide,
) -> Result<WorkspaceDockLayout> {
    if contains_slot(&layout, workspace_slot_id(&inserted_slot)) {
        return Err(invalid_error(format!(
            "display slot {} already exists",
            workspace_slot_id(&inserted_slot)
        )));
    }
    let direction = match side {
        WorkspaceDockSide::Left | WorkspaceDockSide::Right => WorkspaceDockDirection::Row,
        WorkspaceDockSide::Up | WorkspaceDockSide::Down => WorkspaceDockDirection::Column,
    };
    let before = matches!(side, WorkspaceDockSide::Left | WorkspaceDockSide::Up);
    let inserted_id = workspace_slot_id(&inserted_slot).to_string();
    let inserted = WorkspaceDockLayout::Group {
        id: new_id("group"),
        role: WorkspaceDockGroupRole::SidePanel,
        slots: vec![inserted_slot],
        active_slot_id: inserted_id,
    };
    Ok(WorkspaceDockLayout::Split {
        direction,
        children: if before {
            vec![inserted, layout]
        } else {
            vec![layout, inserted]
        },
        ratios: if before {
            vec![0.28, 0.72]
        } else {
            vec![0.72, 0.28]
        },
    })
}

fn split_slot_recursive(
    layout: WorkspaceDockLayout,
    target_slot_id: &str,
    inserted_slot: WorkspaceToolSlot,
    side: WorkspaceDockSide,
    inserted_role: WorkspaceDockGroupRole,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            slots,
            active_slot_id,
        } => {
            if !slots
                .iter()
                .any(|slot| workspace_slot_id(slot) == target_slot_id)
            {
                return Ok(WorkspaceDockLayout::Group {
                    id,
                    role,
                    slots,
                    active_slot_id,
                });
            }
            let direction = match side {
                WorkspaceDockSide::Left | WorkspaceDockSide::Right => WorkspaceDockDirection::Row,
                WorkspaceDockSide::Up | WorkspaceDockSide::Down => WorkspaceDockDirection::Column,
            };
            let before = matches!(side, WorkspaceDockSide::Left | WorkspaceDockSide::Up);
            let existing = WorkspaceDockLayout::Group {
                id,
                role,
                slots,
                active_slot_id,
            };
            let inserted_id = workspace_slot_id(&inserted_slot).to_string();
            let inserted = WorkspaceDockLayout::Group {
                id: new_id("group"),
                role: inserted_role,
                slots: vec![inserted_slot],
                active_slot_id: inserted_id,
            };
            Ok(WorkspaceDockLayout::Split {
                direction,
                children: if before {
                    vec![inserted, existing]
                } else {
                    vec![existing, inserted]
                },
                ratios: vec![0.5, 0.5],
            })
        }
        WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        } => Ok(WorkspaceDockLayout::Split {
            direction,
            ratios,
            children: children
                .into_iter()
                .map(|child| {
                    if contains_slot(&child, target_slot_id) {
                        split_slot_recursive(
                            child,
                            target_slot_id,
                            inserted_slot.clone(),
                            side.clone(),
                            inserted_role,
                        )
                    } else {
                        Ok(child)
                    }
                })
                .collect::<Result<Vec<_>>>()?,
        }),
    }
}

fn activate_slot(layout: WorkspaceDockLayout, slot_id_value: &str) -> Result<WorkspaceDockLayout> {
    if !contains_slot(&layout, slot_id_value) {
        return Err(missing_error(format!(
            "display slot {slot_id_value} not found"
        )));
    }
    Ok(match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            slots,
            active_slot_id,
        } => {
            let active = if slots
                .iter()
                .any(|slot| workspace_slot_id(slot) == slot_id_value)
            {
                slot_id_value.to_string()
            } else {
                active_slot_id
            };
            WorkspaceDockLayout::Group {
                id,
                role,
                slots,
                active_slot_id: active,
            }
        }
        WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        } => WorkspaceDockLayout::Split {
            direction,
            ratios,
            children: children
                .into_iter()
                .map(|child| {
                    if contains_slot(&child, slot_id_value) {
                        activate_slot(child, slot_id_value)
                    } else {
                        Ok(child)
                    }
                })
                .collect::<Result<Vec<_>>>()?,
        },
    })
}

fn close_mirrors_for_tool_tabs(
    layout: WorkspaceDockLayout,
    tool_tab_ids: &[String],
    tool_titles: &HashMap<String, String>,
    owner_workspace_title: &str,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            slots,
            active_slot_id,
        } => {
            let slots = slots
                .into_iter()
                .map(|slot| match slot {
                    WorkspaceToolSlot::Mirror {
                        id,
                        tool_tab_id,
                        owner_workspace_id: _,
                    } if tool_tab_ids.iter().any(|item| item == &tool_tab_id) => {
                        WorkspaceToolSlot::ClosedSource {
                            id,
                            previous_title: tool_titles
                                .get(&tool_tab_id)
                                .cloned()
                                .unwrap_or(tool_tab_id),
                            owner_workspace_title: owner_workspace_title.to_string(),
                        }
                    }
                    other => other,
                })
                .collect::<Vec<_>>();
            let active = if slots
                .iter()
                .any(|slot| workspace_slot_id(slot) == active_slot_id)
            {
                active_slot_id
            } else {
                workspace_slot_id(
                    slots
                        .first()
                        .ok_or_else(|| invalid_error(format!("dock group {id} has no slots")))?,
                )
                .to_string()
            };
            Ok(WorkspaceDockLayout::Group {
                id,
                role,
                slots,
                active_slot_id: active,
            })
        }
        WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        } => Ok(WorkspaceDockLayout::Split {
            direction,
            ratios,
            children: children
                .into_iter()
                .map(|child| {
                    close_mirrors_for_tool_tabs(
                        child,
                        tool_tab_ids,
                        tool_titles,
                        owner_workspace_title,
                    )
                })
                .collect::<Result<Vec<_>>>()?,
        }),
    }
}

fn close_owner_tool_tab(
    snapshot: &mut WorkspaceLayoutSnapshot,
    tool_tab_id_value: &str,
) -> Result<()> {
    let tool_tab = snapshot
        .tool_tabs
        .iter()
        .find(|item| item.id == tool_tab_id_value)
        .ok_or_else(|| missing_error(format!("tool tab {tool_tab_id_value} not found")))?
        .clone();
    let owner_workspace_title = require_workspace(snapshot, &tool_tab.owner_workspace_id)?
        .title
        .clone();
    let previous_title = tool_tab.title.clone();
    let closed_source = |slot_id_value: &str| WorkspaceToolSlot::ClosedSource {
        id: slot_id_value.to_string(),
        previous_title: previous_title.clone(),
        owner_workspace_title: owner_workspace_title.clone(),
    };
    for workspace in &mut snapshot.workspaces {
        let remove_owned = workspace.id == tool_tab.owner_workspace_id;
        workspace
            .owned_tool_tab_ids
            .retain(|id| id != tool_tab_id_value);
        workspace.layout = cleanup_dock_layout(Some(remove_or_close_tool_slots(
            workspace.layout.clone(),
            tool_tab_id_value,
            &closed_source,
            remove_owned,
        )?))?
        .ok_or_else(|| invalid_error("dock layout cleanup removed every group"))?;
    }
    for window in &mut snapshot.floating_windows {
        window.layout = cleanup_dock_layout(Some(remove_or_close_tool_slots(
            window.layout.clone(),
            tool_tab_id_value,
            &closed_source,
            false,
        )?))?
        .ok_or_else(|| invalid_error("dock layout cleanup removed every group"))?;
    }
    snapshot
        .tool_tabs
        .retain(|item| item.id != tool_tab_id_value);
    Ok(())
}

fn open_resource_monitor_tool_tab(
    snapshot: &mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
    target_group_id: Option<&str>,
) -> Result<()> {
    let workspace = require_workspace(snapshot, workspace_id)?.clone();
    if let Some(existing) = snapshot
        .tool_tabs
        .iter()
        .find(|tool_tab| {
            tool_tab.owner_workspace_id == workspace_id
                && matches!(tool_tab.kind, WorkspaceToolKind::Resources)
        })
        .cloned()
    {
        if let Some(slot_id) = find_owned_slot_for_tool_tab(&workspace.layout, &existing.id) {
            return activate_tool_slot(snapshot, workspace_id, &slot_id);
        }
        let slot = WorkspaceToolSlot::Owned {
            id: new_id("slot-resources"),
            tool_tab_id: existing.id,
        };
        let workspace = require_workspace_mut(snapshot, workspace_id)?;
        workspace.layout =
            add_resource_monitor_slot(workspace.layout.clone(), target_group_id, slot)?;
        return Ok(());
    }

    let tool_tab_id = new_id("tool-resources");
    let slot = WorkspaceToolSlot::Owned {
        id: new_id("slot-resources"),
        tool_tab_id: tool_tab_id.clone(),
    };
    snapshot.tool_tabs.push(WorkspaceToolTab {
        id: tool_tab_id.clone(),
        kind: WorkspaceToolKind::Resources,
        owner_workspace_id: workspace_id.to_string(),
        host_id: workspace.host_id,
        title: "Resources".to_string(),
    });
    let workspace = require_workspace_mut(snapshot, workspace_id)?;
    workspace.owned_tool_tab_ids.push(tool_tab_id);
    workspace.layout = add_resource_monitor_slot(workspace.layout.clone(), target_group_id, slot)?;
    Ok(())
}

fn add_resource_monitor_slot(
    layout: WorkspaceDockLayout,
    target_group_id: Option<&str>,
    slot: WorkspaceToolSlot,
) -> Result<WorkspaceDockLayout> {
    match target_group_id {
        Some(group_id) if contains_group(&layout, group_id) => {
            add_slot_to_group(layout, group_id, slot)
        }
        Some(group_id) => Err(missing_error(format!("dock group {group_id} not found"))),
        None => add_slot_to_first_group(layout, slot),
    }
}

fn remove_slot(
    layout: WorkspaceDockLayout,
    slot_id_value: &str,
) -> Result<Option<WorkspaceDockLayout>> {
    let (layout, removed) = remove_slot_recursive(layout, slot_id_value)?;
    if removed.is_none() {
        return Err(missing_error(format!(
            "display slot {slot_id_value} not found"
        )));
    }
    cleanup_dock_layout(layout)
}

fn remove_slot_for_move(
    layout: WorkspaceDockLayout,
    slot_id_value: &str,
) -> Result<(WorkspaceDockLayout, Option<WorkspaceToolSlot>)> {
    let (layout, removed) = remove_slot_recursive(layout, slot_id_value)?;
    let layout = cleanup_dock_layout(layout)?
        .ok_or_else(|| invalid_error("cannot move the last tool slot in a workspace"))?;
    Ok((layout, removed))
}

fn remove_slot_recursive(
    layout: WorkspaceDockLayout,
    slot_id_value: &str,
) -> Result<(Option<WorkspaceDockLayout>, Option<WorkspaceToolSlot>)> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            slots,
            active_slot_id,
        } => {
            let Some(removed_index) = slots
                .iter()
                .position(|slot| workspace_slot_id(slot) == slot_id_value)
            else {
                return Ok((
                    Some(WorkspaceDockLayout::Group {
                        id,
                        role,
                        slots,
                        active_slot_id,
                    }),
                    None,
                ));
            };
            let removed = slots
                .get(removed_index)
                .ok_or_else(|| invalid_error("removed slot index out of bounds"))?
                .clone();
            let remaining = slots
                .into_iter()
                .filter(|slot| workspace_slot_id(slot) != slot_id_value)
                .collect::<Vec<_>>();
            if remaining.is_empty() {
                return Ok((
                    if role == WorkspaceDockGroupRole::Content {
                        Some(WorkspaceDockLayout::Group {
                            id,
                            role,
                            slots: Vec::new(),
                            active_slot_id: String::new(),
                        })
                    } else {
                        None
                    },
                    Some(removed),
                ));
            }
            let active = if remaining
                .iter()
                .any(|slot| workspace_slot_id(slot) == active_slot_id)
            {
                active_slot_id
            } else {
                workspace_slot_id(
                    remaining
                        .first()
                        .ok_or_else(|| invalid_error(format!("dock group {id} has no slots")))?,
                )
                .to_string()
            };
            Ok((
                Some(WorkspaceDockLayout::Group {
                    id,
                    role,
                    slots: remaining,
                    active_slot_id: active,
                }),
                Some(removed),
            ))
        }
        WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        } => {
            let mut removed = None;
            let mut next_children = Vec::new();
            for child in children {
                if removed.is_some() {
                    next_children.push(child);
                    continue;
                }
                let (next_child, child_removed) = remove_slot_recursive(child, slot_id_value)?;
                removed = child_removed;
                if let Some(next_child) = next_child {
                    next_children.push(next_child);
                }
            }
            let next_layout = if next_children.is_empty() {
                None
            } else {
                Some(WorkspaceDockLayout::Split {
                    direction,
                    ratios: normalize_ratio_len(&ratios, next_children.len())?,
                    children: next_children,
                })
            };
            Ok((next_layout, removed))
        }
    }
}

fn add_slot_to_group(
    layout: WorkspaceDockLayout,
    group_id_value: &str,
    inserted_slot: WorkspaceToolSlot,
) -> Result<WorkspaceDockLayout> {
    if contains_slot(&layout, workspace_slot_id(&inserted_slot)) {
        return Err(invalid_error(format!(
            "display slot {} already exists",
            workspace_slot_id(&inserted_slot)
        )));
    }
    map_group(
        layout,
        group_id_value,
        &|id, role, mut slots, _active_slot_id| {
            let active_slot_id = workspace_slot_id(&inserted_slot).to_string();
            slots.push(inserted_slot.clone());
            WorkspaceDockLayout::Group {
                id,
                role,
                slots,
                active_slot_id,
            }
        },
    )
}

fn add_slot_to_first_group(
    layout: WorkspaceDockLayout,
    inserted_slot: WorkspaceToolSlot,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            mut slots,
            ..
        } => {
            let active_slot_id = workspace_slot_id(&inserted_slot).to_string();
            slots.push(inserted_slot);
            Ok(WorkspaceDockLayout::Group {
                id,
                role,
                slots,
                active_slot_id,
            })
        }
        WorkspaceDockLayout::Split {
            direction,
            mut children,
            ratios,
        } => {
            let first = children
                .first()
                .cloned()
                .ok_or_else(|| invalid_error("dock split has no children"))?;
            children[0] = add_slot_to_first_group(first, inserted_slot)?;
            Ok(WorkspaceDockLayout::Split {
                direction,
                children,
                ratios,
            })
        }
    }
}

fn map_group(
    layout: WorkspaceDockLayout,
    group_id_value: &str,
    map: &impl Fn(String, WorkspaceDockGroupRole, Vec<WorkspaceToolSlot>, String) -> WorkspaceDockLayout,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            slots,
            active_slot_id,
        } => {
            if id == group_id_value {
                Ok(map(id, role, slots, active_slot_id))
            } else {
                Ok(WorkspaceDockLayout::Group {
                    id,
                    role,
                    slots,
                    active_slot_id,
                })
            }
        }
        WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        } => {
            if !children
                .iter()
                .any(|child| contains_group(child, group_id_value))
            {
                return Err(missing_error(format!(
                    "dock group {group_id_value} not found"
                )));
            }
            Ok(WorkspaceDockLayout::Split {
                direction,
                ratios,
                children: children
                    .into_iter()
                    .map(|child| {
                        if contains_group(&child, group_id_value) {
                            map_group(child, group_id_value, map)
                        } else {
                            Ok(child)
                        }
                    })
                    .collect::<Result<Vec<_>>>()?,
            })
        }
    }
}

fn remove_or_close_tool_slots(
    layout: WorkspaceDockLayout,
    tool_tab_id_value: &str,
    closed_source: &impl Fn(&str) -> WorkspaceToolSlot,
    remove_owned: bool,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            slots,
            active_slot_id,
        } => {
            let mut next_slots = Vec::new();
            for slot in slots {
                match &slot {
                    WorkspaceToolSlot::ClosedSource { .. } => next_slots.push(slot),
                    WorkspaceToolSlot::Owned { tool_tab_id, .. }
                    | WorkspaceToolSlot::Mirror { tool_tab_id, .. }
                    | WorkspaceToolSlot::FloatingPlaceholder { tool_tab_id, .. }
                        if tool_tab_id == tool_tab_id_value =>
                    {
                        match slot {
                            WorkspaceToolSlot::Mirror { id, .. } => {
                                next_slots.push(closed_source(&id));
                            }
                            WorkspaceToolSlot::Owned { id, .. }
                            | WorkspaceToolSlot::FloatingPlaceholder { id, .. } => {
                                if !remove_owned {
                                    next_slots.push(closed_source(&id));
                                }
                            }
                            WorkspaceToolSlot::ClosedSource { .. } => {}
                        }
                    }
                    _ => next_slots.push(slot),
                }
            }
            if next_slots.is_empty() {
                if role == WorkspaceDockGroupRole::Content {
                    return Ok(WorkspaceDockLayout::Group {
                        id,
                        role,
                        active_slot_id: String::new(),
                        slots: Vec::new(),
                    });
                }
                let closed = closed_source(&format!("{id}-closed"));
                return Ok(WorkspaceDockLayout::Group {
                    id,
                    role,
                    active_slot_id: workspace_slot_id(&closed).to_string(),
                    slots: vec![closed],
                });
            }
            let active = if next_slots
                .iter()
                .any(|slot| workspace_slot_id(slot) == active_slot_id)
            {
                active_slot_id
            } else {
                workspace_slot_id(
                    next_slots
                        .first()
                        .ok_or_else(|| invalid_error(format!("dock group {id} has no slots")))?,
                )
                .to_string()
            };
            Ok(WorkspaceDockLayout::Group {
                id,
                role,
                slots: next_slots,
                active_slot_id: active,
            })
        }
        WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        } => Ok(WorkspaceDockLayout::Split {
            direction,
            ratios,
            children: children
                .into_iter()
                .map(|child| {
                    remove_or_close_tool_slots(
                        child,
                        tool_tab_id_value,
                        closed_source,
                        remove_owned,
                    )
                })
                .collect::<Result<Vec<_>>>()?,
        }),
    }
}

fn find_slot<'a>(layout: &'a WorkspaceDockLayout, needle: &str) -> Option<&'a WorkspaceToolSlot> {
    match layout {
        WorkspaceDockLayout::Group { slots, .. } => {
            slots.iter().find(|slot| workspace_slot_id(slot) == needle)
        }
        WorkspaceDockLayout::Split { children, .. } => {
            children.iter().find_map(|child| find_slot(child, needle))
        }
    }
}

fn find_group_containing_slot<'a>(
    layout: &'a WorkspaceDockLayout,
    needle: &str,
) -> Option<&'a Vec<WorkspaceToolSlot>> {
    match layout {
        WorkspaceDockLayout::Group { slots, .. } => {
            if slots.iter().any(|slot| workspace_slot_id(slot) == needle) {
                Some(slots)
            } else {
                None
            }
        }
        WorkspaceDockLayout::Split { children, .. } => children
            .iter()
            .find_map(|child| find_group_containing_slot(child, needle)),
    }
}

fn find_group_role_containing_slot(
    layout: &WorkspaceDockLayout,
    needle: &str,
) -> Option<WorkspaceDockGroupRole> {
    match layout {
        WorkspaceDockLayout::Group { role, slots, .. } => {
            if slots.iter().any(|slot| workspace_slot_id(slot) == needle) {
                Some(*role)
            } else {
                None
            }
        }
        WorkspaceDockLayout::Split { children, .. } => children
            .iter()
            .find_map(|child| find_group_role_containing_slot(child, needle)),
    }
}

fn find_owned_slot_for_tool_tab(layout: &WorkspaceDockLayout, tool_tab_id: &str) -> Option<String> {
    match layout {
        WorkspaceDockLayout::Group { slots, .. } => slots.iter().find_map(|slot| match slot {
            WorkspaceToolSlot::Owned {
                id,
                tool_tab_id: slot_tool_tab_id,
            } if slot_tool_tab_id == tool_tab_id => Some(id.clone()),
            _ => None,
        }),
        WorkspaceDockLayout::Split { children, .. } => children
            .iter()
            .find_map(|child| find_owned_slot_for_tool_tab(child, tool_tab_id)),
    }
}

#[cfg(test)]
fn find_group<'a>(
    layout: &'a WorkspaceDockLayout,
    needle: &str,
) -> Option<&'a WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group { id, .. } => {
            if id == needle {
                Some(layout)
            } else {
                None
            }
        }
        WorkspaceDockLayout::Split { children, .. } => {
            children.iter().find_map(|child| find_group(child, needle))
        }
    }
}

#[cfg(test)]
fn find_group_role(layout: &WorkspaceDockLayout, needle: &str) -> Option<WorkspaceDockGroupRole> {
    match find_group(layout, needle) {
        Some(WorkspaceDockLayout::Group { role, .. }) => Some(*role),
        _ => None,
    }
}

#[cfg(test)]
fn collect_group_roles(layout: &WorkspaceDockLayout) -> Vec<WorkspaceDockGroupRole> {
    match layout {
        WorkspaceDockLayout::Group { role, .. } => vec![*role],
        WorkspaceDockLayout::Split { children, .. } => {
            children.iter().flat_map(collect_group_roles).collect()
        }
    }
}

fn contains_group(layout: &WorkspaceDockLayout, needle: &str) -> bool {
    match layout {
        WorkspaceDockLayout::Group { id, .. } => id == needle,
        WorkspaceDockLayout::Split { children, .. } => {
            children.iter().any(|child| contains_group(child, needle))
        }
    }
}

fn collapse_single_child(
    layout: Option<WorkspaceDockLayout>,
) -> Result<Option<WorkspaceDockLayout>> {
    match layout {
        Some(WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        }) => {
            let mut next_children = Vec::new();
            for child in children {
                if let Some(child) = collapse_single_child(Some(child))? {
                    next_children.push(child);
                }
            }
            match next_children.len() {
                0 => Ok(None),
                1 => collapse_single_child(next_children.into_iter().next()),
                _ => Ok(Some(WorkspaceDockLayout::Split {
                    direction,
                    ratios: normalize_ratio_len(&ratios, next_children.len())?,
                    children: next_children,
                })),
            }
        }
        other => Ok(other),
    }
}

fn cleanup_dock_layout(layout: Option<WorkspaceDockLayout>) -> Result<Option<WorkspaceDockLayout>> {
    collapse_single_child(remove_redundant_empty_content_groups(layout)?)
}

fn remove_redundant_empty_content_groups(
    layout: Option<WorkspaceDockLayout>,
) -> Result<Option<WorkspaceDockLayout>> {
    let Some(layout) = layout else {
        return Ok(None);
    };
    if !has_non_empty_content_group(&layout) {
        return Ok(Some(layout));
    }
    remove_empty_content_groups(layout)
}

fn has_non_empty_content_group(layout: &WorkspaceDockLayout) -> bool {
    match layout {
        WorkspaceDockLayout::Group { role, slots, .. } => {
            *role == WorkspaceDockGroupRole::Content && !slots.is_empty()
        }
        WorkspaceDockLayout::Split { children, .. } => {
            children.iter().any(has_non_empty_content_group)
        }
    }
}

fn remove_empty_content_groups(layout: WorkspaceDockLayout) -> Result<Option<WorkspaceDockLayout>> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            slots,
            active_slot_id,
        } => {
            if role == WorkspaceDockGroupRole::Content && slots.is_empty() {
                Ok(None)
            } else {
                Ok(Some(WorkspaceDockLayout::Group {
                    id,
                    role,
                    slots,
                    active_slot_id,
                }))
            }
        }
        WorkspaceDockLayout::Split {
            direction,
            children,
            ratios,
        } => {
            let mut next_children = Vec::new();
            for child in children {
                if let Some(child) = remove_empty_content_groups(child)? {
                    next_children.push(child);
                }
            }
            if next_children.is_empty() {
                return Ok(None);
            }
            let next_len = next_children.len();
            Ok(Some(WorkspaceDockLayout::Split {
                direction,
                children: next_children,
                ratios: normalize_ratio_len(&ratios, next_len)?,
            }))
        }
    }
}

fn normalize_ratio_len(ratios: &[f64], len: usize) -> Result<Vec<f64>> {
    if len == 0 {
        return Ok(Vec::new());
    }
    if ratios.len() == len {
        return normalize_ratios(ratios);
    }
    Ok(vec![1.0 / len as f64; len])
}

fn normalize_snapshot_group_roles(snapshot: &mut WorkspaceLayoutSnapshot) {
    for workspace in &mut snapshot.workspaces {
        normalize_workspace_group_roles(&mut workspace.layout);
    }
    for window in &mut snapshot.floating_windows {
        set_all_group_roles(&mut window.layout, WorkspaceDockGroupRole::Content);
    }
}

fn normalize_workspace_group_roles(layout: &mut WorkspaceDockLayout) {
    match layout {
        WorkspaceDockLayout::Group { role, slots, .. } => {
            if slots.is_empty() {
                *role = WorkspaceDockGroupRole::Content;
            }
        }
        WorkspaceDockLayout::Split { children, .. } => {
            for child in children {
                normalize_workspace_group_roles(child);
            }
        }
    }
}

fn set_all_group_roles(layout: &mut WorkspaceDockLayout, next_role: WorkspaceDockGroupRole) {
    match layout {
        WorkspaceDockLayout::Group { role, .. } => *role = next_role,
        WorkspaceDockLayout::Split { children, .. } => {
            for child in children {
                set_all_group_roles(child, next_role);
            }
        }
    }
}

fn validate_snapshot(snapshot: &WorkspaceLayoutSnapshot) -> Result<()> {
    if !snapshot
        .workspaces
        .iter()
        .any(|workspace| workspace.id == snapshot.active_workspace_id)
    {
        return Err(invalid_error(format!(
            "active workspace {} not found",
            snapshot.active_workspace_id
        )));
    }
    for workspace in &snapshot.workspaces {
        validate_layout(&workspace.layout, snapshot)?;
        for tool_tab_id in &workspace.owned_tool_tab_ids {
            let tool_tab = snapshot
                .tool_tabs
                .iter()
                .find(|item| item.id == *tool_tab_id)
                .ok_or_else(|| missing_error(format!("tool tab {tool_tab_id} not found")))?;
            if tool_tab.owner_workspace_id != workspace.id {
                return Err(invalid_error(format!(
                    "workspace {} cannot own tool tab {} from {}",
                    workspace.id, tool_tab.id, tool_tab.owner_workspace_id
                )));
            }
        }
        let resource_tool_tab_count = snapshot
            .tool_tabs
            .iter()
            .filter(|tool_tab| {
                tool_tab.owner_workspace_id == workspace.id
                    && matches!(tool_tab.kind, WorkspaceToolKind::Resources)
            })
            .count();
        if resource_tool_tab_count > 1 {
            return Err(invalid_error(format!(
                "workspace {} cannot own more than one Resource Monitor ToolTab",
                workspace.id
            )));
        }
        let ports_tool_tab_count = snapshot
            .tool_tabs
            .iter()
            .filter(|tool_tab| {
                tool_tab.owner_workspace_id == workspace.id
                    && matches!(tool_tab.kind, WorkspaceToolKind::Ports)
            })
            .count();
        if ports_tool_tab_count > 1 {
            return Err(invalid_error(format!(
                "workspace {} cannot own more than one Ports ToolTab",
                workspace.id
            )));
        }
    }
    for window in &snapshot.floating_windows {
        validate_layout(&window.layout, snapshot)?;
        if let Some(role) =
            first_non_matching_group_role(&window.layout, WorkspaceDockGroupRole::Content)
        {
            return Err(invalid_error(format!(
                "floating window {} contains non-content dock group role {:?}",
                window.id, role
            )));
        }
    }
    Ok(())
}

fn validate_layout(layout: &WorkspaceDockLayout, snapshot: &WorkspaceLayoutSnapshot) -> Result<()> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            role,
            slots,
            active_slot_id,
        } => {
            if slots.is_empty() {
                if *role != WorkspaceDockGroupRole::Content {
                    return Err(invalid_error(format!("dock group {id} has no slots")));
                }
                if !active_slot_id.is_empty() {
                    return Err(invalid_error(format!(
                        "empty content dock group {id} cannot have an active slot"
                    )));
                }
                return Ok(());
            }
            if !slots
                .iter()
                .any(|slot| workspace_slot_id(slot) == active_slot_id)
            {
                return Err(invalid_error(format!(
                    "active slot {active_slot_id} not found in dock group {id}"
                )));
            }
            for slot in slots {
                match slot {
                    WorkspaceToolSlot::ClosedSource { .. } => {}
                    WorkspaceToolSlot::Owned { tool_tab_id, .. }
                    | WorkspaceToolSlot::Mirror { tool_tab_id, .. }
                    | WorkspaceToolSlot::FloatingPlaceholder { tool_tab_id, .. } => {
                        if !snapshot
                            .tool_tabs
                            .iter()
                            .any(|tool_tab| tool_tab.id == *tool_tab_id)
                        {
                            return Err(missing_error(format!(
                                "display slot {} references missing tool tab {tool_tab_id}",
                                workspace_slot_id(slot)
                            )));
                        }
                    }
                }
            }
        }
        WorkspaceDockLayout::Split {
            children, ratios, ..
        } => {
            if children.len() < 2 {
                return Err(invalid_error(
                    "dock split must contain at least two children",
                ));
            }
            if children.len() != ratios.len() {
                return Err(invalid_error(
                    "dock split children and ratios length mismatch",
                ));
            }
            normalize_ratios(ratios)?;
            for child in children {
                validate_layout(child, snapshot)?;
            }
        }
    }
    Ok(())
}

fn require_workspace<'a>(
    snapshot: &'a WorkspaceLayoutSnapshot,
    workspace_id: &str,
) -> Result<&'a WorkspaceTabState> {
    snapshot
        .workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| missing_error(format!("workspace {workspace_id} not found")))
}

fn require_workspace_mut<'a>(
    snapshot: &'a mut WorkspaceLayoutSnapshot,
    workspace_id: &str,
) -> Result<&'a mut WorkspaceTabState> {
    snapshot
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| missing_error(format!("workspace {workspace_id} not found")))
}

fn contains_slot(layout: &WorkspaceDockLayout, needle: &str) -> bool {
    match layout {
        WorkspaceDockLayout::Group { slots, .. } => {
            slots.iter().any(|slot| workspace_slot_id(slot) == needle)
        }
        WorkspaceDockLayout::Split { children, .. } => {
            children.iter().any(|child| contains_slot(child, needle))
        }
    }
}

fn collect_slots(layout: &WorkspaceDockLayout) -> Vec<&WorkspaceToolSlot> {
    match layout {
        WorkspaceDockLayout::Group { slots, .. } => slots.iter().collect(),
        WorkspaceDockLayout::Split { children, .. } => {
            children.iter().flat_map(collect_slots).collect()
        }
    }
}

fn has_group_role(layout: &WorkspaceDockLayout, expected: WorkspaceDockGroupRole) -> bool {
    match layout {
        WorkspaceDockLayout::Group { role, .. } => *role == expected,
        WorkspaceDockLayout::Split { children, .. } => {
            children.iter().any(|child| has_group_role(child, expected))
        }
    }
}

fn first_non_matching_group_role(
    layout: &WorkspaceDockLayout,
    expected: WorkspaceDockGroupRole,
) -> Option<WorkspaceDockGroupRole> {
    match layout {
        WorkspaceDockLayout::Group { role, .. } if *role != expected => Some(*role),
        WorkspaceDockLayout::Group { .. } => None,
        WorkspaceDockLayout::Split { children, .. } => children
            .iter()
            .find_map(|child| first_non_matching_group_role(child, expected)),
    }
}

fn workspace_slot_id(slot: &WorkspaceToolSlot) -> &str {
    match slot {
        WorkspaceToolSlot::Owned { id, .. }
        | WorkspaceToolSlot::Mirror { id, .. }
        | WorkspaceToolSlot::FloatingPlaceholder { id, .. }
        | WorkspaceToolSlot::ClosedSource { id, .. } => id,
    }
}

fn normalize_ratios(ratios: &[f64]) -> Result<Vec<f64>> {
    if ratios.is_empty() {
        return Err(invalid_error("dock split ratios cannot be empty"));
    }
    if ratios
        .iter()
        .any(|ratio| !ratio.is_finite() || *ratio <= 0.0)
    {
        return Err(invalid_error(
            "dock split ratios must be positive finite numbers",
        ));
    }
    let total = ratios.iter().sum::<f64>();
    Ok(ratios.iter().map(|ratio| ratio / total).collect())
}

fn intent_name(intent: &WorkspaceIntent) -> &'static str {
    match intent {
        WorkspaceIntent::CreateWorkspace { .. } => "create_workspace",
        WorkspaceIntent::ActivateWorkspace { .. } => "activate_workspace",
        WorkspaceIntent::RenameWorkspace { .. } => "rename_workspace",
        WorkspaceIntent::CloseWorkspace { .. } => "close_workspace",
        WorkspaceIntent::CloseOtherWorkspaces { .. } => "close_other_workspaces",
        WorkspaceIntent::CloseWorkspacesToRight { .. } => "close_workspaces_to_right",
        WorkspaceIntent::ActivateToolSlot { .. } => "activate_tool_slot",
        WorkspaceIntent::CloseToolSlot { .. } => "close_tool_slot",
        WorkspaceIntent::CloseOtherToolSlots { .. } => "close_other_tool_slots",
        WorkspaceIntent::CloseToolSlotsToRight { .. } => "close_tool_slots_to_right",
        WorkspaceIntent::MirrorToolTab { .. } => "mirror_tool_tab",
        WorkspaceIntent::FloatToolSlot { .. } => "float_tool_slot",
        WorkspaceIntent::CloseFloatingWindow { .. } => "close_floating_window",
        WorkspaceIntent::MoveToolSlotToGroup { .. } => "move_tool_slot_to_group",
        WorkspaceIntent::MoveToolSlotToSplit { .. } => "move_tool_slot_to_split",
        WorkspaceIntent::MoveToolSlotToWorkspaceEdge { .. } => "move_tool_slot_to_workspace_edge",
        WorkspaceIntent::SplitToolSlot { .. } => "split_tool_slot",
        WorkspaceIntent::CreateTerminalToolTab { .. } => "create_terminal_tool_tab",
        WorkspaceIntent::OpenResourceMonitorToolTab { .. } => "open_resource_monitor_tool_tab",
    }
}

fn default_terminal_title(protocol: ConnectionProtocol) -> String {
    match protocol {
        ConnectionProtocol::Local => "Local Shell".to_string(),
        ConnectionProtocol::Ssh => "SSH Shell".to_string(),
        ConnectionProtocol::Telnet => "Telnet Session".to_string(),
    }
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}

fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(io_error)?;
    }
    Ok(())
}

fn write_atomic(path: &Path, content: &str) -> Result<()> {
    let tmp = path.with_extension("toml.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(io_error)?;
        file.write_all(content.as_bytes()).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
    }
    fs::rename(&tmp, path).map_err(io_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirror_tool_tab_focuses_duplicate_in_target_workspace() {
        let mut snapshot = test_snapshot();

        mirror_tool_tab(&mut snapshot, "files-a", "workspace-b", "group-b").unwrap();
        mirror_tool_tab(&mut snapshot, "files-a", "workspace-b", "group-b").unwrap();

        let target = require_workspace(&snapshot, "workspace-b").unwrap();
        let WorkspaceDockLayout::Group {
            slots,
            active_slot_id,
            ..
        } = &target.layout
        else {
            panic!("expected group layout");
        };
        let mirrors = slots
            .iter()
            .filter(|slot| matches!(slot, WorkspaceToolSlot::Mirror { .. }))
            .collect::<Vec<_>>();
        assert_eq!(mirrors.len(), 1);
        assert_eq!(workspace_slot_id(mirrors[0]), active_slot_id);
    }

    #[test]
    fn closing_owner_tool_tab_turns_mirrors_into_closed_source_placeholders() {
        let mut snapshot = test_snapshot();
        mirror_tool_tab(&mut snapshot, "files-a", "workspace-b", "group-b").unwrap();

        close_tool_slot(&mut snapshot, "workspace-a", "slot-files-a").unwrap();

        assert!(!snapshot.tool_tabs.iter().any(|tool| tool.id == "files-a"));
        let target = require_workspace(&snapshot, "workspace-b").unwrap();
        let closed = collect_slots(&target.layout)
            .into_iter()
            .find_map(|slot| match slot {
                WorkspaceToolSlot::ClosedSource {
                    previous_title,
                    owner_workspace_title,
                    ..
                } => Some((previous_title.as_str(), owner_workspace_title.as_str())),
                _ => None,
            });
        assert_eq!(closed, Some(("/home/a", "Production")));
    }

    #[test]
    fn floating_tool_slot_creates_mirror_without_moving_owner() {
        let mut snapshot = test_snapshot();

        float_tool_slot(&mut snapshot, "workspace-a", "slot-files-a").unwrap();
        let floating_window_id = snapshot.floating_windows[0].id.clone();
        let owner = require_workspace(&snapshot, "workspace-a").unwrap();
        assert!(matches!(
            find_slot(&owner.layout, "slot-files-a"),
            Some(WorkspaceToolSlot::Owned { tool_tab_id, .. }) if tool_tab_id == "files-a"
        ));
        assert!(matches!(
            collect_slots(&snapshot.floating_windows[0].layout).first(),
            Some(WorkspaceToolSlot::Mirror { tool_tab_id, owner_workspace_id, .. })
                if tool_tab_id == "files-a" && owner_workspace_id == "workspace-a"
        ));

        close_floating_window(&mut snapshot, &floating_window_id).unwrap();

        assert!(snapshot.floating_windows.is_empty());
        let owner = require_workspace(&snapshot, "workspace-a").unwrap();
        assert!(matches!(
            find_slot(&owner.layout, "slot-files-a"),
            Some(WorkspaceToolSlot::Owned { tool_tab_id, .. }) if tool_tab_id == "files-a"
        ));
    }

    #[test]
    fn closing_floating_mirror_source_keeps_closed_source_placeholder() {
        let mut snapshot = test_snapshot();

        float_tool_slot(&mut snapshot, "workspace-a", "slot-files-a").unwrap();
        close_owner_tool_tab(&mut snapshot, "files-a").unwrap();

        assert!(matches!(
            collect_slots(&snapshot.floating_windows[0].layout).first(),
            Some(WorkspaceToolSlot::ClosedSource { previous_title, owner_workspace_title, .. })
                if previous_title == "/home/a" && owner_workspace_title == "Production"
        ));
    }

    #[test]
    fn close_tool_slots_to_right_only_closes_later_slots_in_group() {
        let mut snapshot = test_snapshot();
        let workspace = require_workspace_mut(&mut snapshot, "workspace-a").unwrap();
        workspace.layout = WorkspaceDockLayout::Group {
            id: "group-a".to_string(),
            role: WorkspaceDockGroupRole::Content,
            active_slot_id: "slot-files-a".to_string(),
            slots: vec![
                WorkspaceToolSlot::Owned {
                    id: "slot-files-a".to_string(),
                    tool_tab_id: "files-a".to_string(),
                },
                WorkspaceToolSlot::Owned {
                    id: "slot-terminal-a".to_string(),
                    tool_tab_id: "terminal-a".to_string(),
                },
            ],
        };

        close_tool_slots_to_right(&mut snapshot, "workspace-a", "slot-files-a").unwrap();

        let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
        assert_eq!(
            collect_slots(&workspace.layout)
                .into_iter()
                .map(workspace_slot_id)
                .collect::<Vec<_>>(),
            vec!["slot-files-a"]
        );
        assert!(!snapshot
            .tool_tabs
            .iter()
            .any(|tool| tool.id == "terminal-a"));
    }

    #[test]
    fn moving_tool_slot_to_group_reparents_existing_display_slot() {
        let mut snapshot = test_split_snapshot();

        move_tool_slot_to_group(
            &mut snapshot,
            "workspace-a",
            "slot-terminal-a",
            "group-files-a",
        )
        .unwrap();

        let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
        let group = find_group_containing_slot(&workspace.layout, "slot-terminal-a").unwrap();
        assert_eq!(
            group.iter().map(workspace_slot_id).collect::<Vec<_>>(),
            vec!["slot-files-a", "slot-terminal-a"]
        );
        assert_eq!(
            find_group_role(&workspace.layout, "group-files-a"),
            Some(WorkspaceDockGroupRole::SidePanel)
        );
        assert_eq!(
            collect_slots(&workspace.layout)
                .into_iter()
                .filter(|slot| matches!(slot, WorkspaceToolSlot::Owned { tool_tab_id, .. } if tool_tab_id == "terminal-a"))
                .count(),
            1
        );
    }

    #[test]
    fn moving_tool_slot_to_split_reuses_slot_without_duplicate_tooltab() {
        let mut snapshot = test_split_snapshot();

        move_tool_slot_to_split(
            &mut snapshot,
            "workspace-a",
            "slot-terminal-a",
            "slot-files-a",
            WorkspaceDockSide::Left,
        )
        .unwrap();

        let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
        assert_eq!(
            collect_slots(&workspace.layout)
                .into_iter()
                .filter(|slot| matches!(slot, WorkspaceToolSlot::Owned { tool_tab_id, .. } if tool_tab_id == "terminal-a"))
                .count(),
            1
        );
        assert!(matches!(
            workspace.layout,
            WorkspaceDockLayout::Split { .. }
        ));
        assert_eq!(
            collect_group_roles(&workspace.layout),
            vec![
                WorkspaceDockGroupRole::Content,
                WorkspaceDockGroupRole::SidePanel
            ]
        );
    }

    #[test]
    fn normalize_snapshot_preserves_explicit_content_group_with_bottom_panel() {
        let mut snapshot = test_split_snapshot();
        snapshot.tool_tabs.push(WorkspaceToolTab {
            id: "ports-a".to_string(),
            kind: WorkspaceToolKind::Ports,
            owner_workspace_id: "workspace-a".to_string(),
            host_id: "host-a".to_string(),
            title: "Ports".to_string(),
        });
        let workspace = require_workspace_mut(&mut snapshot, "workspace-a").unwrap();
        workspace.owned_tool_tab_ids.push("ports-a".to_string());
        workspace.layout = WorkspaceDockLayout::Split {
            direction: WorkspaceDockDirection::Column,
            ratios: vec![0.7, 0.3],
            children: vec![
                workspace.layout.clone(),
                WorkspaceDockLayout::Group {
                    id: "group-ports-a".to_string(),
                    role: WorkspaceDockGroupRole::SidePanel,
                    active_slot_id: "slot-ports-a".to_string(),
                    slots: vec![WorkspaceToolSlot::Owned {
                        id: "slot-ports-a".to_string(),
                        tool_tab_id: "ports-a".to_string(),
                    }],
                },
            ],
        };

        normalize_snapshot_group_roles(&mut snapshot);

        let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
        assert_eq!(
            find_group_role(&workspace.layout, "group-terminal-a"),
            Some(WorkspaceDockGroupRole::Content)
        );
        assert_eq!(
            find_group_role(&workspace.layout, "group-ports-a"),
            Some(WorkspaceDockGroupRole::SidePanel)
        );
    }

    #[test]
    fn moving_tool_slot_to_workspace_edge_keeps_inserted_group_on_requested_edge() {
        for (side, before, direction) in [
            (WorkspaceDockSide::Left, true, WorkspaceDockDirection::Row),
            (WorkspaceDockSide::Right, false, WorkspaceDockDirection::Row),
            (WorkspaceDockSide::Up, true, WorkspaceDockDirection::Column),
            (
                WorkspaceDockSide::Down,
                false,
                WorkspaceDockDirection::Column,
            ),
        ] {
            let mut snapshot = test_split_snapshot();

            move_tool_slot_to_workspace_edge(&mut snapshot, "workspace-a", "slot-files-a", side)
                .unwrap();

            let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
            let WorkspaceDockLayout::Split {
                direction: actual_direction,
                ratios,
                children,
            } = &workspace.layout
            else {
                panic!("expected root split after workspace edge docking");
            };
            assert!(matches!(
                (actual_direction, direction),
                (WorkspaceDockDirection::Row, WorkspaceDockDirection::Row)
                    | (
                        WorkspaceDockDirection::Column,
                        WorkspaceDockDirection::Column
                    )
            ));
            assert_eq!(
                ratios.as_slice(),
                if before { &[0.28, 0.72] } else { &[0.72, 0.28] }
            );
            let inserted_child = if before { &children[0] } else { &children[1] };
            let WorkspaceDockLayout::Group { role, slots, .. } = inserted_child else {
                panic!("expected inserted edge group");
            };
            assert_eq!(*role, WorkspaceDockGroupRole::SidePanel);
            assert_eq!(
                slots.iter().map(workspace_slot_id).collect::<Vec<_>>(),
                vec!["slot-files-a"]
            );
        }
    }

    #[test]
    fn closing_split_content_group_collapses_empty_split_side() {
        let mut snapshot = test_content_split_snapshot();

        close_tool_slot(&mut snapshot, "workspace-a", "slot-terminal-right").unwrap();

        let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
        assert!(!snapshot
            .tool_tabs
            .iter()
            .any(|tool| tool.id == "terminal-right"));
        assert_eq!(workspace.owned_tool_tab_ids, vec!["terminal-left"]);
        let WorkspaceDockLayout::Group {
            id,
            role,
            slots,
            active_slot_id,
        } = &workspace.layout
        else {
            panic!("expected remaining content group to replace the split");
        };
        assert_eq!(id, "group-left");
        assert_eq!(*role, WorkspaceDockGroupRole::Content);
        assert_eq!(active_slot_id, "slot-terminal-left");
        assert_eq!(
            slots.iter().map(workspace_slot_id).collect::<Vec<_>>(),
            vec!["slot-terminal-left"]
        );
        validate_snapshot(&snapshot).unwrap();
    }

    #[test]
    fn closing_final_content_slot_preserves_empty_content_group() {
        let mut snapshot = test_split_snapshot();

        close_tool_slot(&mut snapshot, "workspace-a", "slot-terminal-a").unwrap();

        let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
        let group =
            find_group(&workspace.layout, "group-terminal-a").expect("terminal content group");
        let WorkspaceDockLayout::Group {
            role,
            slots,
            active_slot_id,
            ..
        } = group
        else {
            panic!("expected content group");
        };
        assert_eq!(*role, WorkspaceDockGroupRole::Content);
        assert!(slots.is_empty());
        assert!(active_slot_id.is_empty());
    }

    #[test]
    fn closing_one_of_multiple_same_host_workspaces_keeps_host_port_forwards_alive() {
        let host_id = "host-same-port-forward-close";
        let rule_id = "018f6eb3-6f91-7410-bc43-f927b2236da0";
        crate::port_forwarding::set_port_forward_rule_status_for_test(
            host_id,
            rule_id,
            crate::types::PortForwardRuleStatus::Running,
        )
        .expect("seed running Host port forward");
        let mut snapshot = WorkspaceLayoutSnapshot {
            version: 1,
            active_workspace_id: "workspace-a".to_string(),
            workspaces: vec![
                WorkspaceTabState {
                    id: "workspace-a".to_string(),
                    host_id: host_id.to_string(),
                    title: "Production".to_string(),
                    owned_tool_tab_ids: vec!["files-a".to_string()],
                    layout: single_owned_content_group("group-a", "slot-files-a", "files-a"),
                },
                WorkspaceTabState {
                    id: "workspace-b".to_string(),
                    host_id: host_id.to_string(),
                    title: "Production 2".to_string(),
                    owned_tool_tab_ids: vec!["files-b".to_string()],
                    layout: single_owned_content_group("group-b", "slot-files-b", "files-b"),
                },
                WorkspaceTabState {
                    id: "workspace-c".to_string(),
                    host_id: "host-other".to_string(),
                    title: "Other".to_string(),
                    owned_tool_tab_ids: vec!["files-c".to_string()],
                    layout: single_owned_content_group("group-c", "slot-files-c", "files-c"),
                },
            ],
            tool_tabs: vec![
                WorkspaceToolTab {
                    id: "files-a".to_string(),
                    kind: WorkspaceToolKind::Files,
                    owner_workspace_id: "workspace-a".to_string(),
                    host_id: host_id.to_string(),
                    title: "/home/a".to_string(),
                },
                WorkspaceToolTab {
                    id: "files-b".to_string(),
                    kind: WorkspaceToolKind::Files,
                    owner_workspace_id: "workspace-b".to_string(),
                    host_id: host_id.to_string(),
                    title: "/home/b".to_string(),
                },
                WorkspaceToolTab {
                    id: "files-c".to_string(),
                    kind: WorkspaceToolKind::Files,
                    owner_workspace_id: "workspace-c".to_string(),
                    host_id: "host-other".to_string(),
                    title: "/home/c".to_string(),
                },
            ],
            floating_windows: Vec::new(),
        };

        close_workspace(&mut snapshot, "workspace-a").expect("close first same-Host workspace");

        assert!(
            crate::port_forwarding::host_port_forward_close_requires_confirmation(host_id)
                .expect("Host runtime should remain while another same-Host Workspace is open")
        );

        close_workspace(&mut snapshot, "workspace-b").expect("close final same-Host workspace");

        assert!(
            !crate::port_forwarding::host_port_forward_close_requires_confirmation(host_id)
                .expect("Host runtime should be cleared after final same-Host Workspace closes")
        );
    }

    #[test]
    fn create_terminal_tool_tab_adds_owned_terminal_to_target_group() {
        let mut snapshot = test_split_snapshot();

        create_terminal_tool_tab(&mut snapshot, "workspace-a", Some("group-terminal-a")).unwrap();

        let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
        let terminal_tools = snapshot
            .tool_tabs
            .iter()
            .filter(|tool| {
                tool.owner_workspace_id == "workspace-a"
                    && matches!(tool.kind, WorkspaceToolKind::Terminal)
            })
            .collect::<Vec<_>>();
        assert_eq!(terminal_tools.len(), 2);
        let created = terminal_tools
            .iter()
            .find(|tool| tool.id != "terminal-a")
            .expect("created terminal tool tab");
        assert!(created.id.starts_with("tool-terminal-"));
        assert_eq!(created.host_id, "host-a");
        assert!(workspace
            .owned_tool_tab_ids
            .iter()
            .any(|id| id == &created.id));

        let group = find_group_containing_slot(&workspace.layout, "slot-terminal-a").unwrap();
        let created_slot = group
            .iter()
            .find(|slot| matches!(slot, WorkspaceToolSlot::Owned { tool_tab_id, .. } if tool_tab_id == &created.id))
            .expect("created terminal slot");
        assert!(workspace_slot_id(created_slot).starts_with("slot-terminal-"));
        let WorkspaceDockLayout::Split { children, .. } = &workspace.layout else {
            panic!("expected split workspace");
        };
        let WorkspaceDockLayout::Group { active_slot_id, .. } = &children[1] else {
            panic!("expected terminal group");
        };
        assert_eq!(active_slot_id, workspace_slot_id(created_slot));
    }

    #[test]
    fn unique_workspace_title_appends_next_available_suffix() {
        let mut snapshot = test_snapshot();

        assert_eq!(
            unique_workspace_title(&snapshot, "Production"),
            "Production 2"
        );
        assert_eq!(unique_workspace_title(&snapshot, "Staging"), "Staging 2");
        assert_eq!(
            unique_workspace_title(&snapshot, "Local Shell"),
            "Local Shell"
        );

        snapshot.workspaces.push(WorkspaceTabState {
            id: "workspace-production-2".to_string(),
            host_id: "host-a".to_string(),
            title: "Production 2".to_string(),
            owned_tool_tab_ids: vec![],
            layout: WorkspaceDockLayout::Group {
                id: "group-production-2".to_string(),
                role: WorkspaceDockGroupRole::Content,
                active_slot_id: "slot-production-2".to_string(),
                slots: vec![WorkspaceToolSlot::ClosedSource {
                    id: "slot-production-2".to_string(),
                    previous_title: "Closed".to_string(),
                    owner_workspace_title: "Closed Owner".to_string(),
                }],
            },
        });

        assert_eq!(
            unique_workspace_title(&snapshot, "Production"),
            "Production 3"
        );
    }

    #[test]
    fn open_resource_monitor_tool_tab_creates_once_and_focuses_existing_slot() {
        let mut snapshot = test_split_snapshot();

        open_resource_monitor_tool_tab(&mut snapshot, "workspace-a", Some("group-files-a"))
            .unwrap();
        open_resource_monitor_tool_tab(&mut snapshot, "workspace-a", Some("group-files-a"))
            .unwrap();

        let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
        let resources = snapshot
            .tool_tabs
            .iter()
            .filter(|tool| {
                tool.owner_workspace_id == "workspace-a"
                    && matches!(tool.kind, WorkspaceToolKind::Resources)
            })
            .collect::<Vec<_>>();
        assert_eq!(resources.len(), 1);
        let created = resources[0];
        assert!(created.id.starts_with("tool-resources-"));
        assert_eq!(created.host_id, "host-a");
        assert_eq!(created.title, "Resources");
        assert_eq!(
            workspace
                .owned_tool_tab_ids
                .iter()
                .filter(|id| *id == &created.id)
                .count(),
            1
        );

        let group = find_group_containing_slot(&workspace.layout, "slot-files-a").unwrap();
        let created_slot = group
            .iter()
            .find(|slot| matches!(slot, WorkspaceToolSlot::Owned { tool_tab_id, .. } if tool_tab_id == &created.id))
            .expect("created Resource Monitor slot");
        assert!(workspace_slot_id(created_slot).starts_with("slot-resources-"));
        let WorkspaceDockLayout::Split { children, .. } = &workspace.layout else {
            panic!("expected split workspace");
        };
        let WorkspaceDockLayout::Group { active_slot_id, .. } = &children[0] else {
            panic!("expected files group");
        };
        assert_eq!(active_slot_id, workspace_slot_id(created_slot));
        validate_snapshot(&snapshot).unwrap();
    }

    #[test]
    fn validate_snapshot_rejects_duplicate_owned_resource_monitor_tool_tabs() {
        let mut snapshot = test_snapshot();
        snapshot.workspaces[0]
            .owned_tool_tab_ids
            .extend(["resources-a".to_string(), "resources-b".to_string()]);
        snapshot.tool_tabs.extend([
            WorkspaceToolTab {
                id: "resources-a".to_string(),
                kind: WorkspaceToolKind::Resources,
                owner_workspace_id: "workspace-a".to_string(),
                host_id: "host-a".to_string(),
                title: "Resources".to_string(),
            },
            WorkspaceToolTab {
                id: "resources-b".to_string(),
                kind: WorkspaceToolKind::Resources,
                owner_workspace_id: "workspace-a".to_string(),
                host_id: "host-a".to_string(),
                title: "Resources".to_string(),
            },
        ]);

        let error =
            validate_snapshot(&snapshot).expect_err("duplicate Resource Monitor should fail");

        assert!(
            error
                .to_string()
                .contains("cannot own more than one Resource Monitor ToolTab"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn validate_snapshot_allows_workspace_without_content_group() {
        let mut snapshot = test_snapshot();
        let workspace = require_workspace_mut(&mut snapshot, "workspace-a").unwrap();
        workspace.layout = WorkspaceDockLayout::Group {
            id: "group-a".to_string(),
            role: WorkspaceDockGroupRole::SidePanel,
            active_slot_id: "slot-files-a".to_string(),
            slots: vec![WorkspaceToolSlot::Owned {
                id: "slot-files-a".to_string(),
                tool_tab_id: "files-a".to_string(),
            }],
        };

        validate_snapshot(&snapshot).expect("workspace without content group should be valid");
    }

    #[test]
    fn validate_snapshot_rejects_non_content_floating_group() {
        let mut snapshot = test_snapshot();
        snapshot
            .floating_windows
            .push(WorkspaceFloatingWindowState {
                id: "floating-a".to_string(),
                layout: WorkspaceDockLayout::Group {
                    id: "group-floating-a".to_string(),
                    role: WorkspaceDockGroupRole::SidePanel,
                    active_slot_id: "slot-floating-a".to_string(),
                    slots: vec![WorkspaceToolSlot::Mirror {
                        id: "slot-floating-a".to_string(),
                        tool_tab_id: "files-a".to_string(),
                        owner_workspace_id: "workspace-a".to_string(),
                    }],
                },
            });

        let error =
            validate_snapshot(&snapshot).expect_err("floating non-content group should fail");

        assert!(
            error
                .to_string()
                .contains("floating window floating-a contains non-content dock group role"),
            "unexpected error: {error}"
        );
    }

    fn test_snapshot() -> WorkspaceLayoutSnapshot {
        WorkspaceLayoutSnapshot {
            version: 1,
            active_workspace_id: "workspace-a".to_string(),
            workspaces: vec![
                WorkspaceTabState {
                    id: "workspace-a".to_string(),
                    host_id: "host-a".to_string(),
                    title: "Production".to_string(),
                    owned_tool_tab_ids: vec!["files-a".to_string(), "terminal-a".to_string()],
                    layout: WorkspaceDockLayout::Group {
                        id: "group-a".to_string(),
                        role: WorkspaceDockGroupRole::Content,
                        active_slot_id: "slot-files-a".to_string(),
                        slots: vec![WorkspaceToolSlot::Owned {
                            id: "slot-files-a".to_string(),
                            tool_tab_id: "files-a".to_string(),
                        }],
                    },
                },
                WorkspaceTabState {
                    id: "workspace-b".to_string(),
                    host_id: "host-b".to_string(),
                    title: "Staging".to_string(),
                    owned_tool_tab_ids: vec!["files-b".to_string()],
                    layout: WorkspaceDockLayout::Group {
                        id: "group-b".to_string(),
                        role: WorkspaceDockGroupRole::Content,
                        active_slot_id: "slot-files-b".to_string(),
                        slots: vec![WorkspaceToolSlot::Owned {
                            id: "slot-files-b".to_string(),
                            tool_tab_id: "files-b".to_string(),
                        }],
                    },
                },
            ],
            tool_tabs: vec![
                WorkspaceToolTab {
                    id: "files-a".to_string(),
                    kind: WorkspaceToolKind::Files,
                    owner_workspace_id: "workspace-a".to_string(),
                    host_id: "host-a".to_string(),
                    title: "/home/a".to_string(),
                },
                WorkspaceToolTab {
                    id: "terminal-a".to_string(),
                    kind: WorkspaceToolKind::Terminal,
                    owner_workspace_id: "workspace-a".to_string(),
                    host_id: "host-a".to_string(),
                    title: "zsh".to_string(),
                },
                WorkspaceToolTab {
                    id: "files-b".to_string(),
                    kind: WorkspaceToolKind::Files,
                    owner_workspace_id: "workspace-b".to_string(),
                    host_id: "host-b".to_string(),
                    title: "/home/b".to_string(),
                },
            ],
            floating_windows: Vec::new(),
        }
    }

    fn test_split_snapshot() -> WorkspaceLayoutSnapshot {
        let mut snapshot = test_snapshot();
        let workspace = require_workspace_mut(&mut snapshot, "workspace-a").unwrap();
        workspace.layout = WorkspaceDockLayout::Split {
            direction: WorkspaceDockDirection::Row,
            ratios: vec![0.5, 0.5],
            children: vec![
                WorkspaceDockLayout::Group {
                    id: "group-files-a".to_string(),
                    role: WorkspaceDockGroupRole::SidePanel,
                    active_slot_id: "slot-files-a".to_string(),
                    slots: vec![WorkspaceToolSlot::Owned {
                        id: "slot-files-a".to_string(),
                        tool_tab_id: "files-a".to_string(),
                    }],
                },
                WorkspaceDockLayout::Group {
                    id: "group-terminal-a".to_string(),
                    role: WorkspaceDockGroupRole::Content,
                    active_slot_id: "slot-terminal-a".to_string(),
                    slots: vec![WorkspaceToolSlot::Owned {
                        id: "slot-terminal-a".to_string(),
                        tool_tab_id: "terminal-a".to_string(),
                    }],
                },
            ],
        };
        snapshot
    }

    fn test_content_split_snapshot() -> WorkspaceLayoutSnapshot {
        let mut snapshot = test_snapshot();
        snapshot.tool_tabs = vec![
            WorkspaceToolTab {
                id: "terminal-left".to_string(),
                kind: WorkspaceToolKind::Terminal,
                owner_workspace_id: "workspace-a".to_string(),
                host_id: "host-a".to_string(),
                title: "Left Shell".to_string(),
            },
            WorkspaceToolTab {
                id: "terminal-right".to_string(),
                kind: WorkspaceToolKind::Terminal,
                owner_workspace_id: "workspace-a".to_string(),
                host_id: "host-a".to_string(),
                title: "Right Shell".to_string(),
            },
            WorkspaceToolTab {
                id: "files-b".to_string(),
                kind: WorkspaceToolKind::Files,
                owner_workspace_id: "workspace-b".to_string(),
                host_id: "host-b".to_string(),
                title: "/home/b".to_string(),
            },
        ];
        let workspace = require_workspace_mut(&mut snapshot, "workspace-a").unwrap();
        workspace.owned_tool_tab_ids =
            vec!["terminal-left".to_string(), "terminal-right".to_string()];
        workspace.layout = WorkspaceDockLayout::Split {
            direction: WorkspaceDockDirection::Row,
            ratios: vec![0.5, 0.5],
            children: vec![
                WorkspaceDockLayout::Group {
                    id: "group-left".to_string(),
                    role: WorkspaceDockGroupRole::Content,
                    active_slot_id: "slot-terminal-left".to_string(),
                    slots: vec![WorkspaceToolSlot::Owned {
                        id: "slot-terminal-left".to_string(),
                        tool_tab_id: "terminal-left".to_string(),
                    }],
                },
                WorkspaceDockLayout::Group {
                    id: "group-right".to_string(),
                    role: WorkspaceDockGroupRole::Content,
                    active_slot_id: "slot-terminal-right".to_string(),
                    slots: vec![WorkspaceToolSlot::Owned {
                        id: "slot-terminal-right".to_string(),
                        tool_tab_id: "terminal-right".to_string(),
                    }],
                },
            ],
        };
        snapshot
    }

    fn single_owned_content_group(
        id: &str,
        slot_id: &str,
        tool_tab_id: &str,
    ) -> WorkspaceDockLayout {
        WorkspaceDockLayout::Group {
            id: id.to_string(),
            role: WorkspaceDockGroupRole::Content,
            active_slot_id: slot_id.to_string(),
            slots: vec![WorkspaceToolSlot::Owned {
                id: slot_id.to_string(),
                tool_tab_id: tool_tab_id.to_string(),
            }],
        }
    }
}
