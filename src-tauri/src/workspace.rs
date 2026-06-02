use std::{
    collections::HashMap,
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
    types::{
        ConnectionProtocol, WorkspaceChangedEvent, WorkspaceDispatchInput, WorkspaceDockDirection,
        WorkspaceDockLayout, WorkspaceDockSide, WorkspaceFloatingWindowState, WorkspaceIntent,
        WorkspaceLayoutSnapshot, WorkspaceTabState, WorkspaceToolKind, WorkspaceToolSlot,
        WorkspaceToolTab,
    },
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
    snapshot.version = snapshot
        .version
        .checked_add(1)
        .ok_or_else(|| invalid_error("workspace snapshot version overflow"))?;
    validate_snapshot(&snapshot)?;
    save_snapshot(&app, &snapshot)?;
    {
        let store = workspace_store();
        let mut guard = store.lock().map_err(|_| invalid_error("workspace store lock poisoned"))?;
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

fn current_snapshot(app: &AppHandle) -> Result<WorkspaceLayoutSnapshot> {
    {
        let store = workspace_store();
        let guard = store.lock().map_err(|_| invalid_error("workspace store lock poisoned"))?;
        if let Some(snapshot) = &guard.snapshot {
            return Ok(snapshot.clone());
        }
    }
    let snapshot = load_snapshot(app)?;
    {
        let store = workspace_store();
        let mut guard = store.lock().map_err(|_| invalid_error("workspace store lock poisoned"))?;
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
    let workspace_id = new_id("workspace");
    let files_tool_id = new_id("tool-files");
    let terminal_tool_id = new_id("tool-terminal");
    let transfers_tool_id = new_id("tool-transfers");
    let files_slot_id = new_id("slot-files");
    let terminal_slot_id = new_id("slot-terminal");
    let transfers_slot_id = new_id("slot-transfers");
    let files_group_id = new_id("group-files");
    let terminal_group_id = new_id("group-terminal");
    let transfers_group_id = new_id("group-transfers");
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
                transfers_tool_id.clone(),
            ],
            layout: WorkspaceDockLayout::Split {
                direction: WorkspaceDockDirection::Row,
                children: vec![
                    WorkspaceDockLayout::Group {
                        id: files_group_id,
                        slots: vec![WorkspaceToolSlot::Owned {
                            id: files_slot_id.clone(),
                            tool_tab_id: files_tool_id.clone(),
                        }],
                        active_slot_id: files_slot_id,
                    },
                    WorkspaceDockLayout::Split {
                        direction: WorkspaceDockDirection::Column,
                        children: vec![
                            WorkspaceDockLayout::Group {
                                id: terminal_group_id,
                                slots: vec![WorkspaceToolSlot::Owned {
                                    id: terminal_slot_id.clone(),
                                    tool_tab_id: terminal_tool_id.clone(),
                                }],
                                active_slot_id: terminal_slot_id,
                            },
                            WorkspaceDockLayout::Group {
                                id: transfers_group_id,
                                slots: vec![WorkspaceToolSlot::Owned {
                                    id: transfers_slot_id.clone(),
                                    tool_tab_id: transfers_tool_id.clone(),
                                }],
                                active_slot_id: transfers_slot_id,
                            },
                        ],
                        ratios: vec![0.78, 0.22],
                    },
                ],
                ratios: vec![0.28, 0.72],
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
                id: transfers_tool_id,
                kind: WorkspaceToolKind::Transfers,
                owner_workspace_id: workspace_id,
                host_id,
                title: "Transfers".to_string(),
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
        WorkspaceIntent::CloseWorkspace { workspace_id } => close_workspace(snapshot, &workspace_id),
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
        WorkspaceIntent::RestoreFloatingWindow { floating_window_id } => {
            restore_floating_window(snapshot, &floating_window_id)
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
    }
}

fn create_workspace(
    app: &AppHandle,
    snapshot: &mut WorkspaceLayoutSnapshot,
    host_id: String,
) -> Result<()> {
    let host = connection_host_by_id(app, &host_id)?;
    let workspace_id = new_id("workspace");
    let files_tool_id = new_id("tool-files");
    let terminal_tool_id = new_id("tool-terminal");
    let transfers_tool_id = new_id("tool-transfers");
    let files_slot_id = new_id("slot-files");
    let terminal_slot_id = new_id("slot-terminal");
    let transfers_slot_id = new_id("slot-transfers");
    let files_group_id = new_id("group-files");
    let terminal_group_id = new_id("group-terminal");
    let transfers_group_id = new_id("group-transfers");
    let default_files_path = host
        .document
        .files
        .as_ref()
        .and_then(|files| files.default_path.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "~".to_string());
    snapshot.workspaces.push(WorkspaceTabState {
        id: workspace_id.clone(),
        host_id: host_id.clone(),
        title: host.document.name.clone(),
        owned_tool_tab_ids: vec![
            files_tool_id.clone(),
            terminal_tool_id.clone(),
            transfers_tool_id.clone(),
        ],
        layout: WorkspaceDockLayout::Split {
            direction: WorkspaceDockDirection::Row,
            children: vec![
                WorkspaceDockLayout::Group {
                    id: files_group_id,
                    slots: vec![WorkspaceToolSlot::Owned {
                        id: files_slot_id.clone(),
                        tool_tab_id: files_tool_id.clone(),
                    }],
                    active_slot_id: files_slot_id,
                },
                WorkspaceDockLayout::Split {
                    direction: WorkspaceDockDirection::Column,
                    children: vec![
                        WorkspaceDockLayout::Group {
                            id: terminal_group_id,
                            slots: vec![WorkspaceToolSlot::Owned {
                                id: terminal_slot_id.clone(),
                                tool_tab_id: terminal_tool_id.clone(),
                            }],
                            active_slot_id: terminal_slot_id,
                        },
                        WorkspaceDockLayout::Group {
                            id: transfers_group_id,
                            slots: vec![WorkspaceToolSlot::Owned {
                                id: transfers_slot_id.clone(),
                                tool_tab_id: transfers_tool_id.clone(),
                            }],
                            active_slot_id: transfers_slot_id,
                        },
                    ],
                    ratios: vec![0.78, 0.22],
                },
            ],
            ratios: vec![0.28, 0.72],
        },
    });
    snapshot.tool_tabs.push(WorkspaceToolTab {
        id: files_tool_id,
        kind: WorkspaceToolKind::Files,
        owner_workspace_id: workspace_id.clone(),
        host_id: host_id.clone(),
        title: default_files_path,
    });
    snapshot.tool_tabs.push(WorkspaceToolTab {
        id: terminal_tool_id,
        kind: WorkspaceToolKind::Terminal,
        owner_workspace_id: workspace_id.clone(),
        host_id: host_id.clone(),
        title: default_terminal_title(host.document.protocol),
    });
    snapshot.tool_tabs.push(WorkspaceToolTab {
        id: transfers_tool_id,
        kind: WorkspaceToolKind::Transfers,
        owner_workspace_id: workspace_id.clone(),
        host_id,
        title: "Transfers".to_string(),
    });
    snapshot.active_workspace_id = workspace_id;
    Ok(())
}

fn close_workspace(snapshot: &mut WorkspaceLayoutSnapshot, workspace_id: &str) -> Result<()> {
    require_workspace(snapshot, workspace_id)?;
    if snapshot.workspaces.len() == 1 {
        return Err(invalid_error("cannot close the last workspace"));
    }
    let closing_workspace_title = require_workspace(snapshot, workspace_id)?.title.clone();
    let owned_tool_tab_ids = require_workspace(snapshot, workspace_id)?.owned_tool_tab_ids.clone();
    let closing_tool_titles = snapshot
        .tool_tabs
        .iter()
        .filter(|tool_tab| tool_tab.owner_workspace_id == workspace_id)
        .map(|tool_tab| (tool_tab.id.clone(), tool_tab.title.clone()))
        .collect::<HashMap<_, _>>();
    snapshot.workspaces.retain(|workspace| workspace.id != workspace_id);
    snapshot.tool_tabs.retain(|tool_tab| tool_tab.owner_workspace_id != workspace_id);
    for workspace in &mut snapshot.workspaces {
        workspace.layout = close_mirrors_for_tool_tabs(
            workspace.layout.clone(),
            &owned_tool_tab_ids,
            &closing_tool_titles,
            &closing_workspace_title,
        )?;
    }
    let live_tool_tab_ids = snapshot
        .tool_tabs
        .iter()
        .map(|tool_tab| tool_tab.id.clone())
        .collect::<Vec<_>>();
    snapshot
        .floating_windows
        .retain(|window| contains_owned_slot_for_live_tool_tab(window, &live_tool_tab_ids));
    if snapshot.active_workspace_id == workspace_id {
        let next = snapshot
            .workspaces
            .first()
            .ok_or_else(|| invalid_error("workspace list is empty after close"))?;
        snapshot.active_workspace_id = next.id.clone();
    }
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
    let closing_workspace_title = require_workspace(snapshot, workspace_id)?.title.clone();
    let owned_tool_tab_ids = require_workspace(snapshot, workspace_id)?.owned_tool_tab_ids.clone();
    let closing_tool_titles = snapshot
        .tool_tabs
        .iter()
        .filter(|tool_tab| tool_tab.owner_workspace_id == workspace_id)
        .map(|tool_tab| (tool_tab.id.clone(), tool_tab.title.clone()))
        .collect::<HashMap<_, _>>();
    snapshot.workspaces.retain(|workspace| workspace.id != workspace_id);
    snapshot.tool_tabs.retain(|tool_tab| tool_tab.owner_workspace_id != workspace_id);
    for workspace in &mut snapshot.workspaces {
        workspace.layout = close_mirrors_for_tool_tabs(
            workspace.layout.clone(),
            &owned_tool_tab_ids,
            &closing_tool_titles,
            &closing_workspace_title,
        )?;
    }
    let live_tool_tab_ids = snapshot
        .tool_tabs
        .iter()
        .map(|tool_tab| tool_tab.id.clone())
        .collect::<Vec<_>>();
    snapshot
        .floating_windows
        .retain(|window| contains_owned_slot_for_live_tool_tab(window, &live_tool_tab_ids));
    if snapshot.active_workspace_id == workspace_id {
        let next = snapshot
            .workspaces
            .first()
            .ok_or_else(|| invalid_error("workspace list is empty after close"))?;
        snapshot.active_workspace_id = next.id.clone();
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
        WorkspaceToolSlot::Owned { tool_tab_id, .. } => close_owner_tool_tab(snapshot, &tool_tab_id),
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
    target_workspace.layout = add_slot_to_group(target_workspace.layout.clone(), target_group_id, slot)?;
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
        return Err(invalid_error("only owned tool tabs can be floated in the first implementation"));
    }
    let WorkspaceToolSlot::Owned { tool_tab_id, .. } = slot else {
        return Err(invalid_error("display slot is not owned"));
    };
    let floating_window_id = new_id("floating-window");
    let floating_slot = WorkspaceToolSlot::Owned {
        id: new_id("slot-floating"),
        tool_tab_id: tool_tab_id.clone(),
    };
    let placeholder = WorkspaceToolSlot::FloatingPlaceholder {
        id: slot_id.to_string(),
        tool_tab_id,
        floating_window_id: floating_window_id.clone(),
    };
    let workspace = require_workspace_mut(snapshot, workspace_id)?;
    workspace.layout = replace_slot(workspace.layout.clone(), slot_id, placeholder)?;
    snapshot.floating_windows.push(WorkspaceFloatingWindowState {
        id: floating_window_id,
        layout: WorkspaceDockLayout::Group {
            id: new_id("group-floating"),
            active_slot_id: workspace_slot_id(&floating_slot).to_string(),
            slots: vec![floating_slot],
        },
    });
    Ok(())
}

fn restore_floating_window(
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
    let window = snapshot.floating_windows.remove(window_index);
    let owned_slots = collect_slots(&window.layout)
        .into_iter()
        .filter_map(|slot| match slot {
            WorkspaceToolSlot::Owned { tool_tab_id, .. } => Some(tool_tab_id.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    for tool_tab_id in owned_slots {
        let owner_workspace_id = snapshot
            .tool_tabs
            .iter()
            .find(|tool_tab| tool_tab.id == tool_tab_id)
            .ok_or_else(|| missing_error(format!("tool tab {tool_tab_id} not found")))?
            .owner_workspace_id
            .clone();
        let workspace = require_workspace_mut(snapshot, &owner_workspace_id)?;
        let placeholder_id = collect_slots(&workspace.layout)
            .into_iter()
            .find_map(|slot| match slot {
                WorkspaceToolSlot::FloatingPlaceholder {
                    id,
                    tool_tab_id: slot_tool_tab_id,
                    floating_window_id: slot_floating_window_id,
                } if slot_tool_tab_id == &tool_tab_id
                    && slot_floating_window_id == floating_window_id =>
                {
                    Some(id.clone())
                }
                _ => None,
            });
        let restored_slot = WorkspaceToolSlot::Owned {
            id: placeholder_id
                .clone()
                .unwrap_or_else(|| new_id("slot-restored")),
            tool_tab_id,
        };
        workspace.layout = if let Some(placeholder_id) = placeholder_id {
            replace_slot(workspace.layout.clone(), &placeholder_id, restored_slot)?
        } else {
            add_slot_to_first_group(workspace.layout.clone(), restored_slot)?
        };
    }
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
        return Err(missing_error(format!("dock group {target_group_id} not found")));
    }
    let (layout_without_slot, removed) = remove_slot_for_move(workspace.layout.clone(), slot_id)?;
    let removed = removed.ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?;
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
    let (layout_without_slot, removed) = remove_slot_for_move(workspace.layout.clone(), slot_id)?;
    let removed = removed.ok_or_else(|| missing_error(format!("display slot {slot_id} not found")))?;
    if !contains_slot(&layout_without_slot, target_slot_id) {
        let workspace = require_workspace_mut(snapshot, workspace_id)?;
        workspace.layout = add_slot_to_first_group(layout_without_slot, removed)?;
        return Ok(());
    }
    let workspace = require_workspace_mut(snapshot, workspace_id)?;
    workspace.layout = split_slot(layout_without_slot, target_slot_id, removed, side)?;
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
    if !workspace.owned_tool_tab_ids.iter().any(|id| id == tool_tab_id) {
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
    split_slot_recursive(layout, target_slot_id, inserted_slot, side)
}

fn split_slot_recursive(
    layout: WorkspaceDockLayout,
    target_slot_id: &str,
    inserted_slot: WorkspaceToolSlot,
    side: WorkspaceDockSide,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            slots,
            active_slot_id,
        } => {
            if !slots.iter().any(|slot| workspace_slot_id(slot) == target_slot_id) {
                return Ok(WorkspaceDockLayout::Group {
                    id,
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
                slots,
                active_slot_id,
            };
            let inserted_id = workspace_slot_id(&inserted_slot).to_string();
            let inserted = WorkspaceDockLayout::Group {
                id: new_id("group"),
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
                        split_slot_recursive(child, target_slot_id, inserted_slot.clone(), side.clone())
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
            slots,
            active_slot_id,
        } => {
            let active = if slots.iter().any(|slot| workspace_slot_id(slot) == slot_id_value) {
                slot_id_value.to_string()
            } else {
                active_slot_id
            };
            WorkspaceDockLayout::Group {
                id,
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
                    } if tool_tab_ids.iter().any(|item| item == &tool_tab_id) =>
                    {
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
            let active = if slots.iter().any(|slot| workspace_slot_id(slot) == active_slot_id) {
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

fn close_owner_tool_tab(snapshot: &mut WorkspaceLayoutSnapshot, tool_tab_id_value: &str) -> Result<()> {
    let tool_tab = snapshot
        .tool_tabs
        .iter()
        .find(|item| item.id == tool_tab_id_value)
        .ok_or_else(|| missing_error(format!("tool tab {tool_tab_id_value} not found")))?
        .clone();
    let owner_workspace_title = require_workspace(snapshot, &tool_tab.owner_workspace_id)?.title.clone();
    let previous_title = tool_tab.title.clone();
    let closed_source = |slot_id_value: &str| WorkspaceToolSlot::ClosedSource {
        id: slot_id_value.to_string(),
        previous_title: previous_title.clone(),
        owner_workspace_title: owner_workspace_title.clone(),
    };
    for workspace in &mut snapshot.workspaces {
        let remove_owned = workspace.id == tool_tab.owner_workspace_id;
        workspace.owned_tool_tab_ids.retain(|id| id != tool_tab_id_value);
        workspace.layout =
            remove_or_close_tool_slots(workspace.layout.clone(), tool_tab_id_value, &closed_source, remove_owned)?;
    }
    for window in &mut snapshot.floating_windows {
        window.layout =
            remove_or_close_tool_slots(window.layout.clone(), tool_tab_id_value, &closed_source, true)?;
    }
    snapshot.tool_tabs.retain(|item| item.id != tool_tab_id_value);
    Ok(())
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
    Ok(collapse_single_child(layout))
}

fn remove_slot_for_move(
    layout: WorkspaceDockLayout,
    slot_id_value: &str,
) -> Result<(WorkspaceDockLayout, Option<WorkspaceToolSlot>)> {
    let (layout, removed) = remove_slot_recursive(layout, slot_id_value)?;
    let layout = collapse_single_child(layout)
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
            slots,
            active_slot_id,
        } => {
            let Some(removed_index) = slots.iter().position(|slot| workspace_slot_id(slot) == slot_id_value) else {
                return Ok((
                    Some(WorkspaceDockLayout::Group {
                        id,
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
                return Ok((None, Some(removed)));
            }
            let active = if remaining.iter().any(|slot| workspace_slot_id(slot) == active_slot_id) {
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

fn replace_slot(
    layout: WorkspaceDockLayout,
    slot_id_value: &str,
    replacement: WorkspaceToolSlot,
) -> Result<WorkspaceDockLayout> {
    if !contains_slot(&layout, slot_id_value) {
        return Err(missing_error(format!(
            "display slot {slot_id_value} not found"
        )));
    }
    if slot_id_value != workspace_slot_id(&replacement) && contains_slot(&layout, workspace_slot_id(&replacement)) {
        return Err(invalid_error(format!(
            "display slot {} already exists",
            workspace_slot_id(&replacement)
        )));
    }
    replace_slot_recursive(layout, slot_id_value, replacement)
}

fn replace_slot_recursive(
    layout: WorkspaceDockLayout,
    slot_id_value: &str,
    replacement: WorkspaceToolSlot,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            slots,
            active_slot_id,
        } => {
            if !slots.iter().any(|slot| workspace_slot_id(slot) == slot_id_value) {
                return Ok(WorkspaceDockLayout::Group {
                    id,
                    slots,
                    active_slot_id,
                });
            }
            let replacement_id = workspace_slot_id(&replacement).to_string();
            let slots = slots
                .into_iter()
                .map(|slot| {
                    if workspace_slot_id(&slot) == slot_id_value {
                        replacement.clone()
                    } else {
                        slot
                    }
                })
                .collect::<Vec<_>>();
            Ok(WorkspaceDockLayout::Group {
                id,
                slots,
                active_slot_id: if active_slot_id == slot_id_value {
                    replacement_id
                } else {
                    active_slot_id
                },
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
                .map(|child| replace_slot_recursive(child, slot_id_value, replacement.clone()))
                .collect::<Result<Vec<_>>>()?,
        }),
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
    map_group(layout, group_id_value, &|id, mut slots, _active_slot_id| {
        let active_slot_id = workspace_slot_id(&inserted_slot).to_string();
        slots.push(inserted_slot.clone());
        WorkspaceDockLayout::Group {
            id,
            slots,
            active_slot_id,
        }
    })
}

fn add_slot_to_first_group(
    layout: WorkspaceDockLayout,
    inserted_slot: WorkspaceToolSlot,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group { id, mut slots, .. } => {
            let active_slot_id = workspace_slot_id(&inserted_slot).to_string();
            slots.push(inserted_slot);
            Ok(WorkspaceDockLayout::Group {
                id,
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
    map: &impl Fn(String, Vec<WorkspaceToolSlot>, String) -> WorkspaceDockLayout,
) -> Result<WorkspaceDockLayout> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            slots,
            active_slot_id,
        } => {
            if id == group_id_value {
                Ok(map(id, slots, active_slot_id))
            } else {
                Ok(WorkspaceDockLayout::Group {
                    id,
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
            if !children.iter().any(|child| contains_group(child, group_id_value)) {
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
                let closed = closed_source(&format!("{id}-closed"));
                return Ok(WorkspaceDockLayout::Group {
                    id,
                    active_slot_id: workspace_slot_id(&closed).to_string(),
                    slots: vec![closed],
                });
            }
            let active = if next_slots.iter().any(|slot| workspace_slot_id(slot) == active_slot_id) {
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
                .map(|child| remove_or_close_tool_slots(child, tool_tab_id_value, closed_source, remove_owned))
                .collect::<Result<Vec<_>>>()?,
        }),
    }
}

fn find_slot<'a>(layout: &'a WorkspaceDockLayout, needle: &str) -> Option<&'a WorkspaceToolSlot> {
    match layout {
        WorkspaceDockLayout::Group { slots, .. } => slots.iter().find(|slot| workspace_slot_id(slot) == needle),
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
        WorkspaceDockLayout::Split { children, .. } => {
            children.iter().find_map(|child| find_group_containing_slot(child, needle))
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

fn collapse_single_child(layout: Option<WorkspaceDockLayout>) -> Option<WorkspaceDockLayout> {
    match layout {
        Some(WorkspaceDockLayout::Split { mut children, .. }) if children.len() == 1 => children.pop(),
        other => other,
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

fn contains_owned_slot_for_live_tool_tab(
    window: &WorkspaceFloatingWindowState,
    live_tool_tab_ids: &[String],
) -> bool {
    collect_slots(&window.layout).into_iter().any(|slot| {
        let WorkspaceToolSlot::Owned { tool_tab_id, .. } = slot else {
            return false;
        };
        live_tool_tab_ids.iter().any(|id| id == tool_tab_id)
    })
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
    }
    for window in &snapshot.floating_windows {
        validate_layout(&window.layout, snapshot)?;
    }
    Ok(())
}

fn validate_layout(layout: &WorkspaceDockLayout, snapshot: &WorkspaceLayoutSnapshot) -> Result<()> {
    match layout {
        WorkspaceDockLayout::Group {
            id,
            slots,
            active_slot_id,
        } => {
            if slots.is_empty() {
                return Err(invalid_error(format!("dock group {id} has no slots")));
            }
            if !slots.iter().any(|slot| workspace_slot_id(slot) == active_slot_id) {
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
                        if !snapshot.tool_tabs.iter().any(|tool_tab| tool_tab.id == *tool_tab_id) {
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
                return Err(invalid_error("dock split must contain at least two children"));
            }
            if children.len() != ratios.len() {
                return Err(invalid_error("dock split children and ratios length mismatch"));
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
    if ratios.iter().any(|ratio| !ratio.is_finite() || *ratio <= 0.0) {
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
        WorkspaceIntent::RestoreFloatingWindow { .. } => "restore_floating_window",
        WorkspaceIntent::MoveToolSlotToGroup { .. } => "move_tool_slot_to_group",
        WorkspaceIntent::MoveToolSlotToSplit { .. } => "move_tool_slot_to_split",
        WorkspaceIntent::SplitToolSlot { .. } => "split_tool_slot",
        WorkspaceIntent::CreateTerminalToolTab { .. } => "create_terminal_tool_tab",
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
    fn floating_owned_slot_restores_to_original_placeholder() {
        let mut snapshot = test_snapshot();

        float_tool_slot(&mut snapshot, "workspace-a", "slot-files-a").unwrap();
        let floating_window_id = snapshot.floating_windows[0].id.clone();
        let owner = require_workspace(&snapshot, "workspace-a").unwrap();
        assert!(matches!(
            find_slot(&owner.layout, "slot-files-a"),
            Some(WorkspaceToolSlot::FloatingPlaceholder { .. })
        ));

        restore_floating_window(&mut snapshot, &floating_window_id).unwrap();

        assert!(snapshot.floating_windows.is_empty());
        let owner = require_workspace(&snapshot, "workspace-a").unwrap();
        assert!(matches!(
            find_slot(&owner.layout, "slot-files-a"),
            Some(WorkspaceToolSlot::Owned { tool_tab_id, .. }) if tool_tab_id == "files-a"
        ));
    }

    #[test]
    fn close_tool_slots_to_right_only_closes_later_slots_in_group() {
        let mut snapshot = test_snapshot();
        let workspace = require_workspace_mut(&mut snapshot, "workspace-a").unwrap();
        workspace.layout = WorkspaceDockLayout::Group {
            id: "group-a".to_string(),
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
        assert!(!snapshot.tool_tabs.iter().any(|tool| tool.id == "terminal-a"));
    }

    #[test]
    fn moving_tool_slot_to_group_reparents_existing_display_slot() {
        let mut snapshot = test_split_snapshot();

        move_tool_slot_to_group(&mut snapshot, "workspace-a", "slot-terminal-a", "group-files-a")
            .unwrap();

        let workspace = require_workspace(&snapshot, "workspace-a").unwrap();
        let group = find_group_containing_slot(&workspace.layout, "slot-terminal-a").unwrap();
        assert_eq!(
            group.iter().map(workspace_slot_id).collect::<Vec<_>>(),
            vec!["slot-files-a", "slot-terminal-a"]
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
        assert!(matches!(workspace.layout, WorkspaceDockLayout::Split { .. }));
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
        assert!(workspace.owned_tool_tab_ids.iter().any(|id| id == &created.id));

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
                    active_slot_id: "slot-files-a".to_string(),
                    slots: vec![WorkspaceToolSlot::Owned {
                        id: "slot-files-a".to_string(),
                        tool_tab_id: "files-a".to_string(),
                    }],
                },
                WorkspaceDockLayout::Group {
                    id: "group-terminal-a".to_string(),
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
}
