import type { WorkspaceLayoutSnapshot, ToolTabId, DisplaySlotId, DockGroupId } from "./model";

export type DefaultWorkspaceToolIds = {
  filesToolId: ToolTabId;
  terminalToolId: ToolTabId;
  terminalSessionsToolId: ToolTabId;
  resourcesToolId: ToolTabId;
  transfersToolId: ToolTabId;
  portsToolId: ToolTabId;
  filesSlotId: DisplaySlotId;
  terminalSlotId: DisplaySlotId;
  terminalSessionsSlotId: DisplaySlotId;
  resourcesSlotId: DisplaySlotId;
  transfersSlotId: DisplaySlotId;
  portsSlotId: DisplaySlotId;
  filesGroupId: DockGroupId;
  terminalGroupId: DockGroupId;
  rightGroupId: DockGroupId;
  portsGroupId: DockGroupId;
};

export type DefaultWorkspaceLayoutInput = {
  workspaceId: string;
  hostId: string;
  title: string;
  filesTitle: string;
  terminalTitle: string;
  ids: DefaultWorkspaceToolIds;
};

export function defaultWorkspaceToolIds(suffix: string): DefaultWorkspaceToolIds {
  if (!suffix.trim()) throw new Error("default Workspace id suffix cannot be empty");
  return {
    filesToolId: `tool-files-${suffix}`,
    terminalToolId: `tool-terminal-${suffix}`,
    terminalSessionsToolId: `tool-terminal-sessions-${suffix}`,
    resourcesToolId: `tool-resources-${suffix}`,
    transfersToolId: `tool-transfers-${suffix}`,
    portsToolId: `tool-ports-${suffix}`,
    filesSlotId: `slot-files-${suffix}`,
    terminalSlotId: `slot-terminal-${suffix}`,
    terminalSessionsSlotId: `slot-terminal-sessions-${suffix}`,
    resourcesSlotId: `slot-resources-${suffix}`,
    transfersSlotId: `slot-transfers-${suffix}`,
    portsSlotId: `slot-ports-${suffix}`,
    filesGroupId: `group-files-${suffix}`,
    terminalGroupId: `group-terminal-${suffix}`,
    rightGroupId: `group-resources-transfers-${suffix}`,
    portsGroupId: `group-ports-${suffix}`,
  };
}

export function defaultWorkspaceLayoutSnapshot(input: DefaultWorkspaceLayoutInput): WorkspaceLayoutSnapshot {
  const { ids } = input;
  return {
    version: 0,
    activeWorkspaceId: input.workspaceId,
    workspaces: [
      {
        id: input.workspaceId,
        hostId: input.hostId,
        title: input.title,
        ownedToolTabIds: [
          ids.filesToolId,
          ids.terminalToolId,
          ids.terminalSessionsToolId,
          ids.resourcesToolId,
          ids.transfersToolId,
          ids.portsToolId,
        ],
        layout: {
          kind: "split",
          direction: "column",
          ratios: [0.7, 0.3],
          children: [
            {
              kind: "split",
              direction: "row",
              ratios: [0.24, 0.52, 0.24],
              children: [
                {
                  kind: "group",
                  id: ids.filesGroupId,
                  role: "side_panel",
                  activeSlotId: ids.filesSlotId,
                  collapsed: false,
                  slots: [{ kind: "owned", id: ids.filesSlotId, toolTabId: ids.filesToolId }],
                },
                {
                  kind: "group",
                  id: ids.terminalGroupId,
                  role: "content",
                  activeSlotId: ids.terminalSlotId,
                  collapsed: false,
                  slots: [{ kind: "owned", id: ids.terminalSlotId, toolTabId: ids.terminalToolId }],
                },
                {
                  kind: "group",
                  id: ids.rightGroupId,
                  role: "side_panel",
                  activeSlotId: ids.terminalSessionsSlotId,
                  collapsed: false,
                  slots: [
                    { kind: "owned", id: ids.terminalSessionsSlotId, toolTabId: ids.terminalSessionsToolId },
                    { kind: "owned", id: ids.resourcesSlotId, toolTabId: ids.resourcesToolId },
                    { kind: "owned", id: ids.transfersSlotId, toolTabId: ids.transfersToolId },
                  ],
                },
              ],
            },
            {
              kind: "group",
              id: ids.portsGroupId,
              role: "side_panel",
              activeSlotId: ids.portsSlotId,
              collapsed: false,
              slots: [{ kind: "owned", id: ids.portsSlotId, toolTabId: ids.portsToolId }],
            },
          ],
        },
      },
    ],
    toolTabs: [
      {
        id: ids.filesToolId,
        kind: "files",
        ownerWorkspaceId: input.workspaceId,
        hostId: input.hostId,
        title: input.filesTitle,
      },
      {
        id: ids.terminalToolId,
        kind: "terminal",
        ownerWorkspaceId: input.workspaceId,
        hostId: input.hostId,
        title: input.terminalTitle,
      },
      {
        id: ids.terminalSessionsToolId,
        kind: "terminal_sessions",
        ownerWorkspaceId: input.workspaceId,
        hostId: input.hostId,
        title: "Terminals",
      },
      {
        id: ids.resourcesToolId,
        kind: "resources",
        ownerWorkspaceId: input.workspaceId,
        hostId: input.hostId,
        title: "Resources",
      },
      {
        id: ids.transfersToolId,
        kind: "transfers",
        ownerWorkspaceId: input.workspaceId,
        hostId: input.hostId,
        title: "Transfers",
      },
      {
        id: ids.portsToolId,
        kind: "ports",
        ownerWorkspaceId: input.workspaceId,
        hostId: input.hostId,
        title: "Ports",
      },
    ],
    floatingWindows: [],
  };
}
