import type { WorkspaceLayoutSnapshot, ToolTabId, DisplaySlotId, DockGroupId } from "./model";

export type DefaultWorkspaceToolIds = {
  filesToolId: ToolTabId;
  terminalToolId: ToolTabId;
  resourcesToolId: ToolTabId;
  transfersToolId: ToolTabId;
  filesSlotId: DisplaySlotId;
  terminalSlotId: DisplaySlotId;
  resourcesSlotId: DisplaySlotId;
  transfersSlotId: DisplaySlotId;
  filesGroupId: DockGroupId;
  terminalGroupId: DockGroupId;
  rightGroupId: DockGroupId;
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
    resourcesToolId: `tool-resources-${suffix}`,
    transfersToolId: `tool-transfers-${suffix}`,
    filesSlotId: `slot-files-${suffix}`,
    terminalSlotId: `slot-terminal-${suffix}`,
    resourcesSlotId: `slot-resources-${suffix}`,
    transfersSlotId: `slot-transfers-${suffix}`,
    filesGroupId: `group-files-${suffix}`,
    terminalGroupId: `group-terminal-${suffix}`,
    rightGroupId: `group-resources-transfers-${suffix}`,
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
          ids.resourcesToolId,
          ids.transfersToolId,
        ],
        layout: {
          kind: "split",
          direction: "row",
          ratios: [0.24, 0.52, 0.24],
          children: [
            {
              kind: "group",
              id: ids.filesGroupId,
              role: "sidebar",
              activeSlotId: ids.filesSlotId,
              slots: [{ kind: "owned", id: ids.filesSlotId, toolTabId: ids.filesToolId }],
            },
            {
              kind: "group",
              id: ids.terminalGroupId,
              role: "content",
              activeSlotId: ids.terminalSlotId,
              slots: [{ kind: "owned", id: ids.terminalSlotId, toolTabId: ids.terminalToolId }],
            },
            {
              kind: "group",
              id: ids.rightGroupId,
              role: "sidebar",
              activeSlotId: ids.resourcesSlotId,
              slots: [
                { kind: "owned", id: ids.resourcesSlotId, toolTabId: ids.resourcesToolId },
                { kind: "owned", id: ids.transfersSlotId, toolTabId: ids.transfersToolId },
              ],
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
    ],
    floatingWindows: [],
  };
}
