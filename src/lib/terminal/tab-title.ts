import { deriveCustomizableTabTitle } from "./panes";

type PaneTitleItem = {
  id: string;
  title: string;
};

type TabTitleModel = {
  id: string;
  title: string;
  customTitle: string;
  activePaneId: string;
  panes: readonly PaneTitleItem[];
};

export function refreshTerminalTabTitleModel(tab: TabTitleModel) {
  const activePane = tab.panes.find((pane) => pane.id === tab.activePaneId);
  if (!activePane) throw new Error(`active pane ${tab.activePaneId} not found in tab ${tab.id}`);
  tab.title = deriveCustomizableTabTitle(tab.customTitle, activePane.title, tab.panes.length);
}
