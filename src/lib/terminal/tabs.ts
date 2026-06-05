import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { commands, type TerminalSessionInfo, type TerminalSettings, type TerminalTransportState } from "$lib/bindings";
import { unwrapCommand } from "./commands";
import { isTerminalSessionInactiveMessage } from "./errors";
import { orderedTerminalOutputChunks } from "./output";
import { createPaneLeaf, type PaneTree } from "./panes";
import { terminalScrollbarLineFromPointer, terminalScrollbarState, terminalWheelScrollResult } from "./scrollbar";
import { xtermOptions } from "./settings";
import { normalizeTerminalFitSize, normalizeTerminalSessionSize, type TerminalFitSize } from "./sizes";
import { refreshTerminalTabTitleModel } from "./tab-title";
import { computeTerminalMirrorPtySize, type TerminalMirrorViewMeasurement } from "./mirror-size";

export type TerminalOutputEvent = {
  session_id: string;
  sequence: string;
  backlog: boolean;
  data: string;
};

export type TerminalExitEvent = {
  session_id: string;
  exit_code: number | null;
  signal: string | null;
};
export type TerminalTransportStateEvent = {
  session_id: string;
  state: TerminalTransportState;
};

export type TerminalStatus = "starting" | "running" | "exited" | "error" | "disconnected";
type WebglTerminalAddon = { clearTextureAtlas?: () => void; dispose: () => void };
export type TerminalSearchAddon = SearchAddon & { clearDecorations?: () => void };
type WebglRenderService = {
  handleResize?: (cols: number, rows: number) => void;
  clear?: () => void;
  refreshRows?: (start: number, end: number, isRedrawOnly?: boolean) => void;
};
type TerminalWithRenderService = Terminal & {
  _core?: {
    _renderService?: WebglRenderService;
  };
};
type TerminalScrollbarDom = {
  root: HTMLDivElement;
  track: HTMLDivElement;
  handle: HTMLDivElement;
};
export type TerminalView = {
  id: string;
  container: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  search: TerminalSearchAddon;
  serialize: SerializeAddon;
  image?: { dispose: () => void };
  webgl?: WebglTerminalAddon;
  scrollbarDom?: TerminalScrollbarDom;
  scrollbarInteraction?: { dispose: () => void };
  resizeObserver?: ResizeObserver;
  dataDisposables: Array<{ dispose: () => void }>;
  wheelRemainder: number;
  lastFitSize: TerminalFitSize;
  fitted: boolean;
  tooSmall: boolean;
  constraining: boolean;
};
export type TerminalTab = {
  id: string;
  title: string;
  customTitle: string;
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
  readOnly: boolean;
  reconnectPending: boolean;
  everConnected: boolean;
  connectionHostId: string;
  reconnectTrust: {
    acceptNewHostKey?: boolean;
    updateChangedHostKey?: boolean;
  };
  exitText: string;
  error: string;
  term?: Terminal;
  fit?: FitAddon;
  search?: TerminalSearchAddon;
  serialize?: SerializeAddon;
  image?: { dispose: () => void };
  webgl?: WebglTerminalAddon;
  scrollbarDom?: TerminalScrollbarDom;
  scrollbarInteraction?: { dispose: () => void };
  container?: HTMLDivElement;
  viewContainers: Map<string, HTMLDivElement>;
  views: Map<string, TerminalView>;
  resizeObserver?: ResizeObserver;
  dataDisposables: Array<{ dispose: () => void }>;
  decoder: TextDecoder;
  outputQueue: string[];
  replayBuffer: string[];
  outputFrame: number | null;
  nextOutputSequence: bigint;
  pendingOutput: Map<string, string>;
  resizeTimer: number | null;
  mountPromise: Promise<void> | null;
  lastCols: number;
  lastRows: number;
  lastPixelWidth: number;
  lastPixelHeight: number;
  wheelRemainder: number;
};

const resizeDelayMs = 24;
let nextTerminalTabSequence = 0;

type TerminalTabContext = {
  settings: () => TerminalSettings | null;
  tabs: () => TerminalTab[];
  setGlobalError: (message: string) => void;
  notifySelectionChange?: () => void;
  requestReconnect?: (paneId: string) => void;
};

export function createTerminalTab(info: TerminalSessionInfo): TerminalTab {
  const tabId = nextTerminalTabId();
  const pane = createTerminalPane(info, tabId);
  return {
    id: tabId,
    title: pane.title,
    customTitle: "",
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
    customTitle: "",
    activePaneId: pane.id,
    panes: [pane],
    tree: createPaneLeaf(pane.id),
  };
}

export function createTerminalPane(info: TerminalSessionInfo, tabId: string): TerminalPane {
  const size = normalizeTerminalSessionSize(info);
  const initialOutput = initialTransportOutput(info);
  return {
    id: info.id,
    tabId,
    title: info.cwd ?? info.title,
    baseTitle: info.cwd ?? info.title,
    command: info.command,
    currentDirectory: info.cwd ?? "",
    titleOverride: "",
    status: info.transport_state === "connected" ? "running" : "starting",
    readOnly: false,
    reconnectPending: false,
    everConnected: info.transport_state === "connected",
    connectionHostId: "",
    reconnectTrust: {},
    exitText: "",
    error: "",
    viewContainers: new Map(),
    views: new Map(),
    dataDisposables: [],
    decoder: new TextDecoder(),
    outputQueue: initialOutput ? [initialOutput] : [],
    replayBuffer: [],
    outputFrame: null,
    nextOutputSequence: 0n,
    pendingOutput: new Map(),
    resizeTimer: null,
    mountPromise: null,
    lastCols: size.cols,
    lastRows: size.rows,
    lastPixelWidth: size.pixelWidth,
    lastPixelHeight: size.pixelHeight,
    wheelRemainder: 0,
  };
}

export function retargetTerminalPaneSession(pane: TerminalPane, info: TerminalSessionInfo) {
  const size = normalizeTerminalSessionSize(info);
  const initialOutput = initialTransportOutput(info);
  if (pane.resizeTimer !== null) {
    window.clearTimeout(pane.resizeTimer);
  }
  if (pane.outputFrame !== null) {
    window.cancelAnimationFrame(pane.outputFrame);
  }
  pane.id = info.id;
  pane.title = info.cwd ?? info.title;
  pane.baseTitle = info.cwd ?? info.title;
  pane.command = info.command;
  pane.currentDirectory = info.cwd ?? "";
  pane.titleOverride = "";
  pane.status = info.transport_state === "connected" ? "running" : "starting";
  pane.readOnly = false;
  pane.reconnectPending = false;
  pane.everConnected = info.transport_state === "connected";
  pane.reconnectTrust = {};
  pane.exitText = "";
  pane.error = "";
  pane.decoder = new TextDecoder();
  pane.outputQueue = [];
  pane.replayBuffer = [];
  pane.outputFrame = null;
  pane.nextOutputSequence = 0n;
  pane.pendingOutput = new Map();
  pane.resizeTimer = null;
  pane.mountPromise = null;
  pane.lastCols = size.cols;
  pane.lastRows = size.rows;
  pane.lastPixelWidth = size.pixelWidth;
  pane.lastPixelHeight = size.pixelHeight;
  pane.wheelRemainder = 0;
  if (initialOutput) {
    if (pane.term) {
      writeTerminalPaneViews(pane, `\r\n${initialOutput}`);
    } else {
      pane.outputQueue.push(initialOutput);
    }
  }
}

function initialTransportOutput(info: TerminalSessionInfo): string {
  if (info.transport_state === "connected") return "";
  return `[${transportStateLabel(info.transport_state)}: ${info.command}]\r\n`;
}

function transportStateLabel(state: TerminalTransportState): string {
  if (state === "resolving") return "Resolving";
  if (state === "connecting") return "Connecting";
  if (state === "verifying_host_key") return "Verifying host key";
  if (state === "authenticating") return "Authenticating";
  if (state === "connected") return "Connected";
  if (state === "disconnected") return "Disconnected";
  if (state === "failed") return "Failed";
  return state;
}

function disconnectMessage(message: string): string {
  if (message.includes("terminal error: transport read")) return "transport read";
  if (message.includes("terminal error: ")) return message.replace("terminal error: ", "");
  return message;
}

export function refreshTerminalTabTitle(tab: TerminalTab) {
  refreshTerminalTabTitleModel(tab);
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

  async function mountTerminal(id: string, viewId = id) {
    const config = context.settings();
    if (!config) throw new Error("Terminal settings are not loaded");
    const pane = paneById(id);
    const container = pane?.viewContainers.get(viewId) ?? (viewId === id ? pane?.container : undefined);
    if (!pane || !container) return;
    if (pane.mountPromise) await pane.mountPromise;
    const existingView = pane.views.get(viewId);
    if (existingView) {
      existingView.container = container;
      attachMountedTerminal(pane, existingView, () => scheduleFit(pane.id, viewId));
      return;
    }

    pane.mountPromise = mountTerminalOnce(pane, config, container, viewId);
    try {
      await pane.mountPromise;
    } finally {
      pane.mountPromise = null;
    }
  }

  async function mountTerminalOnce(pane: TerminalPane, config: TerminalSettings, container: HTMLDivElement, viewId: string) {
    const term = new Terminal({
      ...xtermOptions(config),
      cols: pane.lastCols,
      rows: pane.lastRows,
    });
    const fit = new FitAddon();
    const search = new SearchAddon({ highlightLimit: 1000 }) as TerminalSearchAddon;
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serialize);

    try {
      const { ImageAddon } = await import("@xterm/addon-image");
      const image = new ImageAddon();
      term.loadAddon(image);

      container.replaceChildren();
      term.open(container);
      const view: TerminalView = {
        id: viewId,
        container,
        term,
        fit,
        search,
        serialize,
        image,
        dataDisposables: [],
        wheelRemainder: 0,
        lastFitSize: {
          cols: pane.lastCols,
          rows: pane.lastRows,
          pixelWidth: pane.lastPixelWidth,
          pixelHeight: pane.lastPixelHeight,
        },
        fitted: false,
        tooSmall: false,
        constraining: false,
      };
      pane.views.set(viewId, view);
      setActivePaneView(pane, view);
      attachTerminalScrollbar(pane, view);
      fitTerminal(pane, view);

      if (config.renderer === "webgl") {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon(true);
        term.loadAddon(webgl);
        view.webgl = webgl;
        pane.webgl = webgl;
        stabilizeWebglTerminal(term, webgl);
      }

      if (pane.replayBuffer.length) {
        term.write(pane.replayBuffer.join(""));
      }
      if (pane.outputQueue.length) {
        scheduleOutputFlush(pane);
      }

      view.dataDisposables = [
        attachTerminalScrollSync(pane, view),
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
          setActivePaneView(pane, view);
          if (pane.readOnly) return;
          if (pane.reconnectPending) {
            markReconnectRequested(pane.id);
            context.requestReconnect?.(pane.id);
            return;
          }
          void unwrapCommand(commands.writeTerminal({ session_id: pane.id, data })).catch((error) => {
            markWriteFailure(pane.id, error instanceof Error ? error.message : String(error));
          });
        }),
        term.onResize(() => {
          fitTerminal(pane, view);
          scheduleResize(pane.id);
        }),
        term.onSelectionChange(() => {
          setActivePaneView(pane, view);
          context.notifySelectionChange?.();
        }),
      ];
      view.resizeObserver = new ResizeObserver(() => scheduleFit(pane.id, view.id));
      view.resizeObserver.observe(container);
      scheduleFit(pane.id, view.id);
      requestAnimationFrame(() => {
        fitTerminal(pane, view);
        if (view.webgl) stabilizeWebglTerminal(term, view.webgl);
      });
      term.focus();
    } catch (error) {
      term.dispose();
      pane.views.delete(viewId);
      if (pane.term === term) {
        pane.term = undefined;
        pane.fit = undefined;
        pane.search = undefined;
        pane.serialize = undefined;
        pane.image = undefined;
        pane.webgl = undefined;
      }
      markPaneError(pane.id, error instanceof Error ? error.message : String(error));
    }
  }

  function scheduleFit(id: string, viewId?: string) {
    const pane = paneById(id);
    if (!pane) return;
    requestAnimationFrame(() => {
      const views = viewId
        ? [pane.views.get(viewId)].filter((view): view is TerminalView => view !== undefined)
        : Array.from(pane.views.values());
      for (const view of views) {
        fitTerminal(pane, view);
        if (view.webgl) stabilizeWebglTerminal(view.term, view.webgl);
      }
      scheduleResize(id);
      requestAnimationFrame(() => {
        for (const view of views) {
          if (view.webgl) stabilizeWebglTerminal(view.term, view.webgl);
        }
      });
    });
  }

  function refreshPanePresentation(id: string) {
    const pane = paneById(id);
    if (!pane) return;
    refreshTerminalPanePresentation(pane);
  }

  function scheduleResize(id: string) {
    const pane = paneById(id);
    if (!pane || pane.status !== "running") return;
    const result = computeTerminalMirrorPtySize({
      views: terminalViewMeasurements(pane),
      lastValidSize: {
        cols: pane.lastCols,
        rows: pane.lastRows,
        pixelWidth: pane.lastPixelWidth,
        pixelHeight: pane.lastPixelHeight,
      },
      lastSentSize: {
        cols: pane.lastCols,
        rows: pane.lastRows,
        pixelWidth: pane.lastPixelWidth,
        pixelHeight: pane.lastPixelHeight,
      },
    });
    updateTerminalViewSizeState(pane, result.tooSmallViewIds, result.constrainingViewIds);
    if (!result.shouldSendResize) return;
    const normalized = normalizeTerminalFitSize(result.size, {
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
      ).catch((error) => markWriteFailure(id, error instanceof Error ? error.message : String(error)));
    }, resizeDelayMs);
  }

  function enqueueOutput(event: TerminalOutputEvent) {
    const pane = paneById(event.session_id);
    if (!pane) return;
    const chunks = orderedTerminalOutputChunks(pane, event, pane.decoder);
    if (!chunks.length) return;
    pane.outputQueue.push(...chunks);
    scheduleOutputFlush(pane);
  }

  function markExited(event: TerminalExitEvent) {
    const pane = paneById(event.session_id);
    if (!pane) return;
    if (pane.everConnected && event.signal && event.signal !== "closed") {
      markDisconnected(pane, disconnectMessage(event.signal));
      return;
    }
    if (pane.status === "starting" && event.signal) {
      pane.status = "error";
      pane.error = event.signal;
      writeTerminalPaneViews(pane, `\r\n[Connection stopped: ${event.signal}]\r\n`);
      return;
    }
    if (pane.status === "running" && event.signal && event.signal !== "closed") {
      markDisconnected(pane, event.signal);
      return;
    }
    if (pane.status === "error") {
      pane.error = event.signal ?? pane.error;
      writeTerminalPaneViews(pane, `\r\n[Terminal error: ${pane.error || "connection failed"}]\r\n`);
      return;
    }
    pane.status = "exited";
    pane.reconnectPending = false;
    pane.exitText = event.signal ? `Signal: ${event.signal}` : `Exit ${event.exit_code ?? "unknown"}`;
    pane.titleOverride = "";
    refreshPaneTitle(pane);
    writeTerminalPaneViews(pane, `\r\n[Process completed: ${pane.exitText}]\r\n`);
  }

  function markTransportState(event: TerminalTransportStateEvent) {
    const pane = paneById(event.session_id);
    if (!pane) return;
    const line = `[${transportStateLabel(event.state)}]\r\n`;
    writeTerminalPaneViews(pane, line);
    if (event.state === "failed") {
      if (pane.everConnected) {
        return;
      }
      pane.status = "error";
      pane.reconnectPending = false;
      return;
    }
    if (event.state === "connected") {
      pane.status = "running";
      pane.reconnectPending = false;
      pane.everConnected = true;
    }
  }

  function markPaneError(id: string, message: string) {
    const pane = paneById(id);
    if (!pane) {
      return;
    }
    if (isTerminalSessionInactiveMessage(message)) {
      markDisconnected(pane, "connection is no longer active");
      return;
    }
    pane.status = "error";
    pane.reconnectPending = false;
    pane.error = message;
    writeTerminalPaneViews(pane, `\r\n[Terminal error: ${message}]\r\n`);
  }

  function markWriteFailure(id: string, message: string) {
    const pane = paneById(id);
    if (!pane) {
      return;
    }
    if (isTerminalSessionInactiveMessage(message)) {
      markDisconnected(pane, "connection is no longer active");
      return;
    }
    markPaneError(id, message);
  }

  function markDisconnected(pane: TerminalPane, message: string) {
    if (pane.reconnectPending) return;
    pane.status = "disconnected";
    pane.reconnectPending = true;
    pane.exitText = message;
    pane.error = "";
    writeTerminalPaneViews(pane, `\r\n[Connection disconnected: ${message}]\r\n[Press any key to reconnect]\r\n`);
  }

  function markReconnectUnavailable(id: string, message: string) {
    const pane = paneById(id);
    if (!pane) return;
    pane.status = "error";
    pane.reconnectPending = false;
    pane.error = message;
    writeTerminalPaneViews(pane, `\r\n[Reconnect failed: ${message}]\r\n`);
  }

  function markReconnectRequested(id: string) {
    const pane = paneById(id);
    if (!pane || !pane.reconnectPending) return;
    pane.status = "starting";
    pane.reconnectPending = false;
    pane.exitText = "Reconnecting";
    pane.error = "";
    writeTerminalPaneViews(pane, "\r\n[Reconnecting]\r\n");
  }

  function markConnectionError(id: string, message: string) {
    markPaneError(id, message);
  }

  function markConnectionPrompt(id: string, message: string) {
    const pane = paneById(id);
    if (!pane) return;
    pane.status = "exited";
    pane.reconnectPending = false;
    pane.exitText = message;
    pane.error = "";
    writeTerminalPaneViews(pane, `\r\n[Connection paused: ${message}]\r\n`);
  }

  function markConnectionCancelled(id: string, message: string) {
    const pane = paneById(id);
    if (!pane) return;
    pane.status = "error";
    pane.reconnectPending = false;
    pane.error = message;
    pane.exitText = message;
    writeTerminalPaneViews(pane, `\r\n[Connection canceled: ${message}]\r\n`);
  }

  function refreshPaneTitle(pane: TerminalPane) {
    pane.title = derivePaneTitle(pane);
    const tab = tabById(pane.tabId);
    if (tab && tab.activePaneId === pane.id) refreshTerminalTabTitle(tab);
  }

  function scheduleOutputFlush(pane: TerminalPane) {
    if (pane.views.size === 0 || pane.outputFrame !== null) return;
    pane.outputFrame = requestAnimationFrame(() => {
      pane.outputFrame = null;
      if (pane.views.size === 0 || !pane.outputQueue.length) return;
      const text = pane.outputQueue.join("");
      pane.outputQueue = [];
      pane.replayBuffer.push(text);
      trimReplayBuffer(pane);
      for (const view of pane.views.values()) {
        view.term.write(text);
      }
    });
  }

  return {
    enqueueOutput,
    markConnectionCancelled,
    markConnectionError,
    markConnectionPrompt,
    markExited,
    markReconnectUnavailable,
    markTransportState,
    mountTerminal,
    refreshPanePresentation,
    scheduleFit,
  };
}

function attachMountedTerminal(pane: TerminalPane, view: TerminalView, scheduleFit: () => void) {
  const element = view.term.element;
  if (!element) return;
  if (element.parentElement !== view.container) {
    view.container.replaceChildren(element);
    view.resizeObserver?.disconnect();
    view.resizeObserver = new ResizeObserver(scheduleFit);
    view.resizeObserver.observe(view.container);
  }
  setActivePaneView(pane, view);
  attachTerminalScrollbar(pane, view);
  fitTerminal(pane, view);
  view.term.refresh(0, Math.max(0, view.term.rows - 1));
}

export function refreshTerminalPanePresentation(pane: TerminalPane) {
  for (const view of pane.views.values()) {
    attachTerminalScrollbar(pane, view);
    view.term.refresh(0, Math.max(0, view.term.rows - 1));
    updateTerminalScrollbar(view);
  }
}

export function disposeTerminalTab(tab: TerminalTab) {
  tab.panes.forEach(disposeTerminalPane);
}

export function disposeTerminalPane(pane: TerminalPane) {
  detachTerminalPane(pane);
}

export function detachTerminalPane(pane: TerminalPane) {
  const serialized = pane.serialize?.serialize({ scrollback: 1000 }) ?? "";
  if (serialized) pane.outputQueue = [serialized, ...pane.outputQueue];
  if (pane.outputFrame !== null) cancelAnimationFrame(pane.outputFrame);
  pane.outputFrame = null;
  if (pane.resizeTimer !== null) window.clearTimeout(pane.resizeTimer);
  pane.resizeTimer = null;
  for (const view of pane.views.values()) {
    disposeTerminalView(view);
  }
  pane.views.clear();
  pane.viewContainers.clear();
  pane.term = undefined;
  pane.fit = undefined;
  pane.search = undefined;
  pane.serialize = undefined;
  pane.image = undefined;
  pane.webgl = undefined;
  pane.scrollbarDom = undefined;
  pane.scrollbarInteraction = undefined;
  pane.resizeObserver = undefined;
  pane.dataDisposables = [];
  pane.container?.replaceChildren();
  pane.container = undefined;
}

function disposeTerminalView(view: TerminalView) {
  view.resizeObserver?.disconnect();
  view.dataDisposables.forEach((disposable) => disposable.dispose());
  view.dataDisposables = [];
  view.search.dispose();
  view.serialize.dispose();
  view.image?.dispose();
  view.webgl?.dispose();
  destroyTerminalScrollbar(view);
  view.fit.dispose();
  view.term.dispose();
  view.container.replaceChildren();
}

function fitTerminal(pane: TerminalPane, view: TerminalView): TerminalFitSize | null {
  const dimensions = view.fit.proposeDimensions();
  const fallback = {
    cols: pane.lastCols,
    rows: pane.lastRows,
    pixelWidth: pane.lastPixelWidth,
    pixelHeight: pane.lastPixelHeight,
  };
  const pixels = measureTerminalPixels(view.container);
  const size = normalizeTerminalFitSize(
    { ...(dimensions ?? { cols: view.term.cols, rows: view.term.rows }), ...pixels },
    fallback,
  );
  view.lastFitSize = size;
  view.fitted = Number.isFinite(dimensions?.cols) && Number.isFinite(dimensions?.rows);
  if (view.fitted) {
    view.fit.fit();
    view.term.refresh(0, Math.max(0, view.term.rows - 1));
  }
  updateTerminalScrollbar(view);
  return size;
}

function attachTerminalScrollbar(_pane: TerminalPane, view: TerminalView) {
  const previousRoot = view.scrollbarDom?.root;
  const dom = ensureTerminalScrollbarDom(view);
  if (!dom) {
    destroyTerminalScrollbar(view);
    return;
  }
  view.scrollbarDom = dom;
  if (view.scrollbarInteraction && previousRoot === dom.root) {
    updateTerminalScrollbar(view);
    return;
  }

  view.scrollbarInteraction?.dispose();
  view.scrollbarInteraction = attachTerminalScrollbarInteraction(view);
  updateTerminalScrollbar(view);
}

function attachTerminalScrollSync(_pane: TerminalPane, view: TerminalView): { dispose: () => void } {
  const term = view.term;

  const update = () => updateTerminalScrollbar(view);
  const scrollDisposable = term.onScroll(update);
  const writeDisposable = term.onWriteParsed(update);
  const wheelHandler = (event: WheelEvent) => {
    const result = terminalWheelScrollResult({
      baseY: term.buffer.active.baseY,
      viewportY: term.buffer.active.viewportY,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rows: term.rows,
      previousRemainder: view.wheelRemainder,
      normalBuffer: term.buffer.active.type === "normal",
      mouseTracking: term.modes.mouseTrackingMode !== "none",
      defaultPrevented: event.defaultPrevented,
      shiftKey: event.shiftKey,
    });
    view.wheelRemainder = result.remainder;
    if (!result.consume) return true;

    event.preventDefault();
    event.stopPropagation();
    if (result.target !== null) {
      term.scrollToLine(result.target);
      term.refresh(0, Math.max(0, term.rows - 1));
      update();
    }
    return false;
  };
  term.attachCustomWheelEventHandler(wheelHandler);

  return {
    dispose: () => {
      term.attachCustomWheelEventHandler(() => true);
      scrollDisposable.dispose();
      writeDisposable.dispose();
    },
  };
}

function updateTerminalScrollbar(view: TerminalView) {
  const sync = () => {
    syncTerminalScrollbarThumb(view);
  };
  requestAnimationFrame(() => {
    sync();
    requestAnimationFrame(sync);
  });
}

function destroyTerminalScrollbar(view: TerminalView) {
  view.scrollbarInteraction?.dispose();
  view.scrollbarInteraction = undefined;
  view.scrollbarDom?.root.remove();
  view.scrollbarDom = undefined;
}

function ensureTerminalScrollbarDom(view: TerminalView): TerminalScrollbarDom | undefined {
  const slot = view.container;
  const existingRoot = slot.querySelector<HTMLDivElement>(":scope > .terminal-scrollbar");
  if (existingRoot) {
    const track = existingRoot.querySelector<HTMLDivElement>(".terminal-scrollbar-track");
    const handle = existingRoot.querySelector<HTMLDivElement>(".terminal-scrollbar-handle");
    if (track && handle) return { root: existingRoot, track, handle };
    existingRoot.remove();
  }

  const root = document.createElement("div");
  root.className = "terminal-scrollbar";
  root.setAttribute("aria-hidden", "true");
  const track = document.createElement("div");
  track.className = "terminal-scrollbar-track";
  const handle = document.createElement("div");
  handle.className = "terminal-scrollbar-handle";
  track.append(handle);
  root.append(track);
  slot.append(root);
  return { root, track, handle };
}

function syncTerminalScrollbarThumb(view: TerminalView) {
  const term = view.term;

  const state = terminalScrollbarState({
    baseY: term.buffer.active.baseY,
    viewportY: term.buffer.active.viewportY,
    rows: term.rows,
  });
  const dom = view.scrollbarDom ?? ensureTerminalScrollbarDom(view);
  if (dom) view.scrollbarDom = dom;
  if (!dom) return;
  const { root: vertical, track, handle } = dom;
  vertical.classList.toggle("terminal-scrollbar-visible", state.visible);
  track.style.position = "relative";
  track.style.width = "100%";
  track.style.height = "100%";
  handle.style.display = "block";
  handle.style.height = `${state.thumbSizePercent * 100}%`;
  handle.style.minHeight = "28px";
  handle.style.setProperty("position", "absolute");
  handle.style.setProperty("top", `${state.scrollPercent * (100 - state.thumbSizePercent * 100)}%`);
  handle.style.setProperty("right", "0");
  handle.style.setProperty("width", "100%");
}

function attachTerminalScrollbarInteraction(view: TerminalView): { dispose: () => void } {
  const term = view.term;
  const dom = view.scrollbarDom ?? ensureTerminalScrollbarDom(view);
  if (!dom) return { dispose: () => {} };
  view.scrollbarDom = dom;

  const { root: vertical, track } = dom;
  let dragging = false;
  let pointerId: number | null = null;

  const scrollToPointer = (clientY: number) => {
    const state = terminalScrollbarState({
      baseY: term.buffer.active.baseY,
      viewportY: term.buffer.active.viewportY,
      rows: term.rows,
    });
    if (!state.visible) return;
    const trackRect = track.getBoundingClientRect();
    const line = terminalScrollbarLineFromPointer({
      pointerY: clientY,
      trackTop: trackRect.top,
      trackHeight: trackRect.height,
      thumbHeight: trackRect.height * state.thumbSizePercent,
      scrollbackRows: state.scrollbackRows,
    });
    term.scrollToLine(line);
    term.refresh(0, Math.max(0, term.rows - 1));
    updateTerminalScrollbar(view);
  };

  const pointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || term.buffer.active.type !== "normal") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dragging = true;
    pointerId = event.pointerId;
    vertical.setPointerCapture(event.pointerId);
    scrollToPointer(event.clientY);
  };
  const pointerMove = (event: PointerEvent) => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    scrollToPointer(event.clientY);
  };
  const pointerEnd = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    dragging = false;
    pointerId = null;
    if (vertical.hasPointerCapture(event.pointerId)) vertical.releasePointerCapture(event.pointerId);
    updateTerminalScrollbar(view);
  };

  vertical.addEventListener("pointerdown", pointerDown, { capture: true });
  vertical.addEventListener("pointermove", pointerMove, { capture: true });
  vertical.addEventListener("pointerup", pointerEnd, { capture: true });
  vertical.addEventListener("pointercancel", pointerEnd, { capture: true });

  return {
    dispose: () => {
      vertical.removeEventListener("pointerdown", pointerDown, { capture: true });
      vertical.removeEventListener("pointermove", pointerMove, { capture: true });
      vertical.removeEventListener("pointerup", pointerEnd, { capture: true });
      vertical.removeEventListener("pointercancel", pointerEnd, { capture: true });
    },
  };
}

function setActivePaneView(pane: TerminalPane, view: TerminalView) {
  pane.term = view.term;
  pane.fit = view.fit;
  pane.search = view.search;
  pane.serialize = view.serialize;
  pane.image = view.image;
  pane.webgl = view.webgl;
  pane.scrollbarDom = view.scrollbarDom;
  pane.scrollbarInteraction = view.scrollbarInteraction;
  pane.container = view.container;
  pane.resizeObserver = view.resizeObserver;
  pane.dataDisposables = view.dataDisposables;
  pane.wheelRemainder = view.wheelRemainder;
}

function terminalViewMeasurements(pane: TerminalPane): TerminalMirrorViewMeasurement[] {
  return Array.from(pane.views.values()).map((view) => ({
    id: view.id,
    visible: view.container.isConnected && view.container.getClientRects().length > 0,
    mounted: view.term.element?.isConnected === true,
    fitted: view.fitted,
    ...view.lastFitSize,
  }));
}

function updateTerminalViewSizeState(pane: TerminalPane, tooSmallViewIds: string[], constrainingViewIds: string[]) {
  const tooSmall = new Set(tooSmallViewIds);
  const constraining = new Set(constrainingViewIds);
  for (const view of pane.views.values()) {
    view.tooSmall = tooSmall.has(view.id);
    view.constraining = constraining.has(view.id);
    view.container.toggleAttribute("data-terminal-too-small", view.tooSmall);
    view.container.toggleAttribute("data-terminal-size-constraining", view.constraining);
  }
}

function trimReplayBuffer(pane: TerminalPane) {
  const maxReplayChars = 500_000;
  let total = 0;
  const retained: string[] = [];
  for (let index = pane.replayBuffer.length - 1; index >= 0; index -= 1) {
    const chunk = pane.replayBuffer[index];
    if (total + chunk.length > maxReplayChars && retained.length > 0) break;
    retained.push(chunk);
    total += chunk.length;
  }
  pane.replayBuffer = retained.reverse();
}

function writeTerminalPaneViews(pane: TerminalPane, text: string) {
  if (pane.views.size === 0) {
    pane.outputQueue.push(text);
    return;
  }
  pane.replayBuffer.push(text);
  trimReplayBuffer(pane);
  for (const view of pane.views.values()) {
    view.term.write(text);
  }
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
  renderService?.clear?.();
  renderService?.handleResize?.(term.cols, term.rows);
  webgl.clearTextureAtlas?.();
  term.clearTextureAtlas();
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
