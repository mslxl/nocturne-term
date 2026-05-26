import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { commands, type TerminalSessionInfo, type TerminalSettings } from "$lib/bindings";
import { unwrapCommand } from "./commands";
import { countPaneLeaves, createPaneLeaf, deriveTabDisplayTitle, type PaneTree } from "./panes";
import { xtermOptions } from "./settings";
import { normalizeTerminalFitSize, normalizeTerminalSessionSize, type TerminalFitSize } from "./sizes";

export type TerminalOutputEvent = {
  session_id: string;
  data: string;
};

export type TerminalExitEvent = {
  session_id: string;
  exit_code: number | null;
  signal: string | null;
};

export type TerminalStatus = "starting" | "running" | "exited" | "error";
type WebglTerminalAddon = { clearTextureAtlas?: () => void; dispose: () => void };
type WebglRenderService = {
  handleResize?: (cols: number, rows: number) => void;
  refreshRows?: (start: number, end: number, isRedrawOnly?: boolean) => void;
};
type TerminalWithRenderService = Terminal & {
  _core?: {
    _renderService?: WebglRenderService;
  };
};
export type TerminalTab = {
  id: string;
  title: string;
  activePaneId: string;
  panes: TerminalPane[];
  tree: PaneTree;
};

export type TerminalPane = {
  id: string;
  tabId: string;
  title: string;
  baseTitle: string;
  command: string;
  currentDirectory: string;
  titleOverride: string;
  status: TerminalStatus;
  exitText: string;
  error: string;
  term?: Terminal;
  fit?: FitAddon;
  image?: { dispose: () => void };
  webgl?: WebglTerminalAddon;
  container?: HTMLDivElement;
  resizeObserver?: ResizeObserver;
  dataDisposables: Array<{ dispose: () => void }>;
  decoder: TextDecoder;
  outputQueue: string[];
  outputFrame: number | null;
  resizeTimer: number | null;
  mountPromise: Promise<void> | null;
  lastCols: number;
  lastRows: number;
  lastPixelWidth: number;
  lastPixelHeight: number;
};

const resizeDelayMs = 24;
let nextTerminalTabSequence = 0;

type TerminalTabContext = {
  settings: () => TerminalSettings | null;
  tabs: () => TerminalTab[];
  setGlobalError: (message: string) => void;
};

export function createTerminalTab(info: TerminalSessionInfo): TerminalTab {
  const tabId = nextTerminalTabId();
  const pane = createTerminalPane(info, tabId);
  return {
    id: tabId,
    title: pane.title,
    activePaneId: pane.id,
    panes: [pane],
    tree: createPaneLeaf(pane.id),
  };
}

export function createTerminalTabFromPane(pane: TerminalPane): TerminalTab {
  const tabId = nextTerminalTabId();
  pane.tabId = tabId;
  return {
    id: tabId,
    title: pane.title,
    activePaneId: pane.id,
    panes: [pane],
    tree: createPaneLeaf(pane.id),
  };
}

export function createTerminalPane(info: TerminalSessionInfo, tabId: string): TerminalPane {
  const size = normalizeTerminalSessionSize(info);
  return {
    id: info.id,
    tabId,
    title: info.cwd ?? info.title,
    baseTitle: info.cwd ?? info.title,
    command: info.command,
    currentDirectory: info.cwd ?? "",
    titleOverride: "",
    status: "running",
    exitText: "",
    error: "",
    dataDisposables: [],
    decoder: new TextDecoder(),
    outputQueue: [],
    outputFrame: null,
    resizeTimer: null,
    mountPromise: null,
    lastCols: size.cols,
    lastRows: size.rows,
    lastPixelWidth: size.pixelWidth,
    lastPixelHeight: size.pixelHeight,
  };
}

export function refreshTerminalTabTitle(tab: TerminalTab) {
  const activePane = terminalPaneById(tab, tab.activePaneId);
  if (!activePane) throw new Error(`active pane ${tab.activePaneId} not found in tab ${tab.id}`);
  tab.title = deriveTabDisplayTitle(activePane.title, countPaneLeaves(tab.tree));
}

export function terminalPaneById(tab: TerminalTab, paneId: string): TerminalPane | undefined {
  return tab.panes.find((pane) => pane.id === paneId);
}

function nextTerminalTabId(): string {
  nextTerminalTabSequence += 1;
  return `tab-${nextTerminalTabSequence}`;
}

export function measureTerminalFit(
  container: HTMLElement,
  config: TerminalSettings,
  fallback: { cols: number; rows: number },
): TerminalFitSize {
  const term = new Terminal(xtermOptions(config));
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  const dimensions = fit.proposeDimensions();
  const pixels = measureTerminalPixels(container);
  term.dispose();
  container.replaceChildren();
  return normalizeTerminalFitSize({ ...(dimensions ?? fallback), ...pixels }, { ...fallback, ...pixels });
}

export function createTerminalTabController(context: TerminalTabContext) {
  const tabById = (id: string) => context.tabs().find((item) => item.id === id);
  const paneById = (id: string) => context.tabs().flatMap((tab) => tab.panes).find((item) => item.id === id);

  async function mountTerminal(id: string) {
    const config = context.settings();
    if (!config) throw new Error("Terminal settings are not loaded");
    const pane = paneById(id);
    const container = pane?.container;
    if (!pane || !container) return;
    if (pane.mountPromise) return pane.mountPromise;
    if (pane.term) {
      attachMountedTerminal(pane, container, () => scheduleFit(pane.id));
      return;
    }

    pane.mountPromise = mountTerminalOnce(pane, config, container);
    try {
      await pane.mountPromise;
    } finally {
      pane.mountPromise = null;
    }
  }

  async function mountTerminalOnce(pane: TerminalPane, config: TerminalSettings, container: HTMLDivElement) {
    const term = new Terminal({
      ...xtermOptions(config),
      cols: pane.lastCols,
      rows: pane.lastRows,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    try {
      const { ImageAddon } = await import("@xterm/addon-image");
      const image = new ImageAddon();
      term.loadAddon(image);
      pane.image = image;

      container.replaceChildren();
      term.open(container);
      pane.term = term;
      pane.fit = fit;
      fitTerminal(pane);

      if (config.renderer === "webgl") {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        term.loadAddon(webgl);
        pane.webgl = webgl;
        stabilizeWebglTerminal(term, webgl);
      }

      pane.dataDisposables = [
        term.onTitleChange((title) => {
          pane.titleOverride = title;
          refreshPaneTitle(pane);
        }),
        term.parser.registerOscHandler(7, (data) => {
          pane.currentDirectory = parseOsc7Directory(data);
          refreshPaneTitle(pane);
          return true;
        }),
        term.onData((data) => {
          void unwrapCommand(commands.writeTerminal({ session_id: pane.id, data })).catch((error) => {
            markPaneError(pane.id, error instanceof Error ? error.message : String(error));
          });
        }),
        term.onResize(() => {
          const size = fitTerminal(pane);
          if (size) scheduleResize(pane.id, size);
        }),
      ];
      pane.resizeObserver = new ResizeObserver(() => scheduleFit(pane.id));
      pane.resizeObserver.observe(container);
      scheduleFit(pane.id);
      requestAnimationFrame(() => {
        fitTerminal(pane);
        if (pane.webgl) stabilizeWebglTerminal(term, pane.webgl);
      });
      term.focus();
    } catch (error) {
      term.dispose();
      pane.term = undefined;
      pane.fit = undefined;
      pane.image = undefined;
      pane.webgl = undefined;
      markPaneError(pane.id, error instanceof Error ? error.message : String(error));
    }
  }

  function scheduleFit(id: string) {
    const pane = paneById(id);
    if (!pane?.fit || !pane.term) return;
    requestAnimationFrame(() => {
      const size = fitTerminal(pane);
      if (size) scheduleResize(id, size);
      if (pane.webgl && pane.term) stabilizeWebglTerminal(pane.term, pane.webgl);
    });
  }

  function scheduleResize(id: string, size: TerminalFitSize) {
    const pane = paneById(id);
    if (!pane || pane.status !== "running") return;
    const normalized = normalizeTerminalFitSize(size, {
      cols: pane.lastCols,
      rows: pane.lastRows,
      pixelWidth: pane.lastPixelWidth,
      pixelHeight: pane.lastPixelHeight,
    });
    if (
      pane.lastCols === normalized.cols &&
      pane.lastRows === normalized.rows &&
      pane.lastPixelWidth === normalized.pixelWidth &&
      pane.lastPixelHeight === normalized.pixelHeight
    ) {
      return;
    }
    pane.lastCols = normalized.cols;
    pane.lastRows = normalized.rows;
    pane.lastPixelWidth = normalized.pixelWidth;
    pane.lastPixelHeight = normalized.pixelHeight;
    if (pane.resizeTimer !== null) window.clearTimeout(pane.resizeTimer);
    pane.resizeTimer = window.setTimeout(() => {
      pane.resizeTimer = null;
      void unwrapCommand(
        commands.resizeTerminal({
          session_id: id,
          cols: pane.lastCols,
          rows: pane.lastRows,
          pixel_width: pane.lastPixelWidth,
          pixel_height: pane.lastPixelHeight,
        }),
      ).catch((error) => markPaneError(id, error instanceof Error ? error.message : String(error)));
    }, resizeDelayMs);
  }

  function enqueueOutput(event: TerminalOutputEvent) {
    const pane = paneById(event.session_id);
    if (!pane) return;
    const chunk = decodeOutput(pane, event.data);
    if (!chunk) return;
    pane.outputQueue.push(chunk);
    if (pane.outputFrame !== null) return;
    pane.outputFrame = requestAnimationFrame(() => {
      pane.outputFrame = null;
      const text = pane.outputQueue.join("");
      pane.outputQueue = [];
      pane.term?.write(text);
    });
  }

  function markExited(event: TerminalExitEvent) {
    const pane = paneById(event.session_id);
    if (!pane) return;
    pane.status = "exited";
    pane.exitText = event.signal ? `Signal: ${event.signal}` : `Exit ${event.exit_code ?? "unknown"}`;
    pane.titleOverride = "";
    refreshPaneTitle(pane);
    pane.term?.write(`\r\n[Process completed: ${pane.exitText}]\r\n`);
  }

  function markPaneError(id: string, message: string) {
    const pane = paneById(id);
    if (!pane) {
      context.setGlobalError(message);
      return;
    }
    pane.status = "error";
    pane.error = message;
    pane.term?.write(`\r\n[Terminal error: ${message}]\r\n`);
  }

  function refreshPaneTitle(pane: TerminalPane) {
    pane.title = derivePaneTitle(pane);
    const tab = tabById(pane.tabId);
    if (tab && tab.activePaneId === pane.id) refreshTerminalTabTitle(tab);
  }

  return {
    enqueueOutput,
    markExited,
    mountTerminal,
    scheduleFit,
  };
}

function attachMountedTerminal(pane: TerminalPane, container: HTMLDivElement, scheduleFit: () => void) {
  const element = pane.term?.element;
  if (!element) return;
  if (element.parentElement !== container) {
    container.replaceChildren(element);
    pane.resizeObserver?.disconnect();
    pane.resizeObserver = new ResizeObserver(scheduleFit);
    pane.resizeObserver.observe(container);
  }
  fitTerminal(pane);
  pane.term?.refresh(0, Math.max(0, pane.term.rows - 1));
}

export function disposeTerminalTab(tab: TerminalTab) {
  tab.panes.forEach(disposeTerminalPane);
}

export function disposeTerminalPane(pane: TerminalPane) {
  if (pane.outputFrame !== null) cancelAnimationFrame(pane.outputFrame);
  if (pane.resizeTimer !== null) window.clearTimeout(pane.resizeTimer);
  pane.resizeObserver?.disconnect();
  pane.dataDisposables.forEach((disposable) => disposable.dispose());
  pane.image?.dispose();
  pane.webgl?.dispose();
  pane.term?.dispose();
}

function decodeOutput(pane: TerminalPane, data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return pane.decoder.decode(bytes, { stream: true });
}

function fitTerminal(pane: TerminalPane): TerminalFitSize | null {
  if (!pane.fit || !pane.term) return null;
  const dimensions = pane.fit.proposeDimensions();
  const fallback = {
    cols: pane.lastCols,
    rows: pane.lastRows,
    pixelWidth: pane.lastPixelWidth,
    pixelHeight: pane.lastPixelHeight,
  };
  const pixels = pane.container ? measureTerminalPixels(pane.container) : fallback;
  const size = normalizeTerminalFitSize(
    { ...(dimensions ?? { cols: pane.term.cols, rows: pane.term.rows }), ...pixels },
    fallback,
  );
  if (Number.isFinite(dimensions?.cols) && Number.isFinite(dimensions?.rows)) {
    pane.fit.fit();
    pane.term.refresh(0, Math.max(0, pane.term.rows - 1));
  }
  return size;
}

function measureTerminalPixels(container: HTMLElement): { pixelWidth: number; pixelHeight: number } {
  const rect = container.getBoundingClientRect();
  return {
    pixelWidth: clampU16(Math.round(rect.width)),
    pixelHeight: clampU16(Math.round(rect.height)),
  };
}

function clampU16(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(Math.round(value), 65535);
}

function stabilizeWebglTerminal(term: Terminal, webgl: WebglTerminalAddon) {
  refreshWebglTerminal(term, webgl);
  requestAnimationFrame(() => {
    refreshWebglTerminal(term, webgl);
  });
}

function refreshWebglTerminal(term: Terminal, webgl: WebglTerminalAddon) {
  const renderService = (term as TerminalWithRenderService)._core?._renderService;
  renderService?.handleResize?.(term.cols, term.rows);
  webgl.clearTextureAtlas?.();
  term.refresh(0, term.rows - 1);
  renderService?.refreshRows?.(0, term.rows - 1, true);
}

function derivePaneTitle(pane: TerminalPane): string {
  const programTitle = pane.titleOverride.trim();
  if (programTitle) return programTitle;

  const currentDirectory = pane.currentDirectory.trim();
  if (currentDirectory) {
    const leaf = currentDirectory.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).pop();
    if (leaf) return leaf;
    return currentDirectory;
  }

  if (pane.command.trim()) return pane.command;
  return pane.baseTitle || "Session";
}

function parseOsc7Directory(data: string): string {
  const value = data.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname ?? "");
    if (pathname) {
      return pathname.startsWith("/") && /^[A-Za-z]:/.test(pathname.slice(1, 3)) ? pathname.slice(1) : pathname;
    }
  } catch {
    // Fall through to raw parsing below.
  }
  const stripped = value.replace(/^file:\/\//, "");
  return decodeURIComponent(stripped);
}
