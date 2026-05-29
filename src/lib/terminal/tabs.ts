import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { OverlayScrollbars, type OverlayScrollbars as OverlayScrollbarsInstance } from "overlayscrollbars";
import { commands, type TerminalSessionInfo, type TerminalSettings } from "$lib/bindings";
import { unwrapCommand } from "./commands";
import { orderedTerminalOutputChunks } from "./output";
import { countPaneLeaves, createPaneLeaf, deriveCustomizableTabTitle, type PaneTree } from "./panes";
import { terminalScrollbarLineFromPointer, terminalScrollbarState, terminalWheelScrollResult } from "./scrollbar";
import { xtermOptions } from "./settings";
import { normalizeTerminalFitSize, normalizeTerminalSessionSize, type TerminalFitSize } from "./sizes";

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

export type TerminalStatus = "starting" | "running" | "exited" | "error";
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
  exitText: string;
  error: string;
  term?: Terminal;
  fit?: FitAddon;
  search?: TerminalSearchAddon;
  serialize?: SerializeAddon;
  image?: { dispose: () => void };
  webgl?: WebglTerminalAddon;
  scrollbar?: OverlayScrollbarsInstance;
  scrollbarInteraction?: { dispose: () => void };
  container?: HTMLDivElement;
  resizeObserver?: ResizeObserver;
  dataDisposables: Array<{ dispose: () => void }>;
  decoder: TextDecoder;
  outputQueue: string[];
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
  return {
    id: info.id,
    tabId,
    title: info.cwd ?? info.title,
    baseTitle: info.cwd ?? info.title,
    command: info.command,
    currentDirectory: info.cwd ?? "",
    titleOverride: "",
    status: "running",
    readOnly: false,
    exitText: "",
    error: "",
    dataDisposables: [],
    decoder: new TextDecoder(),
    outputQueue: [],
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

export function refreshTerminalTabTitle(tab: TerminalTab) {
  const activePane = terminalPaneById(tab, tab.activePaneId);
  if (!activePane) throw new Error(`active pane ${tab.activePaneId} not found in tab ${tab.id}`);
  tab.title = deriveCustomizableTabTitle(tab.customTitle, activePane.title, countPaneLeaves(tab.tree));
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
    const search = new SearchAddon({ highlightLimit: 1000 }) as TerminalSearchAddon;
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serialize);

    try {
      const { ImageAddon } = await import("@xterm/addon-image");
      const image = new ImageAddon();
      term.loadAddon(image);
      pane.image = image;

      container.replaceChildren();
      term.open(container);
      pane.term = term;
      pane.fit = fit;
      pane.search = search;
      pane.serialize = serialize;
      attachTerminalScrollbar(pane);
      fitTerminal(pane);

      if (config.renderer === "webgl") {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon(true);
        term.loadAddon(webgl);
        pane.webgl = webgl;
        stabilizeWebglTerminal(term, webgl);
      }

      if (pane.outputQueue.length) {
        scheduleOutputFlush(pane);
      }

      pane.dataDisposables = [
        attachTerminalScrollSync(pane),
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
          if (pane.readOnly) return;
          void unwrapCommand(commands.writeTerminal({ session_id: pane.id, data })).catch((error) => {
            markPaneError(pane.id, error instanceof Error ? error.message : String(error));
          });
        }),
        term.onResize(() => {
          const size = fitTerminal(pane);
          if (size) scheduleResize(pane.id, size);
        }),
        term.onSelectionChange(() => {
          context.notifySelectionChange?.();
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
      pane.search = undefined;
      pane.serialize = undefined;
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
      requestAnimationFrame(() => {
        if (pane.webgl && pane.term) stabilizeWebglTerminal(pane.term, pane.webgl);
      });
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
    const chunks = orderedTerminalOutputChunks(pane, event, pane.decoder);
    if (!chunks.length) return;
    pane.outputQueue.push(...chunks);
    scheduleOutputFlush(pane);
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

  function scheduleOutputFlush(pane: TerminalPane) {
    if (!pane.term || pane.outputFrame !== null) return;
    pane.outputFrame = requestAnimationFrame(() => {
      pane.outputFrame = null;
      if (!pane.term || !pane.outputQueue.length) return;
      const text = pane.outputQueue.join("");
      pane.outputQueue = [];
      pane.term.write(text);
    });
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
  attachTerminalScrollbar(pane);
  fitTerminal(pane);
  pane.term?.refresh(0, Math.max(0, pane.term.rows - 1));
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
  pane.resizeObserver?.disconnect();
  pane.resizeObserver = undefined;
  pane.dataDisposables.forEach((disposable) => disposable.dispose());
  pane.dataDisposables = [];
  pane.search?.dispose();
  pane.search = undefined;
  pane.serialize?.dispose();
  pane.serialize = undefined;
  pane.image?.dispose();
  pane.image = undefined;
  pane.webgl?.dispose();
  pane.webgl = undefined;
  pane.scrollbarInteraction?.dispose();
  pane.scrollbarInteraction = undefined;
  destroyTerminalScrollbar(pane);
  pane.fit?.dispose();
  pane.fit = undefined;
  pane.term?.dispose();
  pane.term = undefined;
  pane.container?.replaceChildren();
  pane.container = undefined;
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
  updateTerminalScrollbar(pane);
  return size;
}

function attachTerminalScrollbar(pane: TerminalPane) {
  const elements = terminalScrollbarElements(pane);
  if (!elements) {
    destroyTerminalScrollbar(pane);
    return;
  }
  if (
    pane.scrollbar &&
    OverlayScrollbars.valid(pane.scrollbar) &&
    pane.scrollbar.elements().target === elements.slot &&
    pane.scrollbar.elements().viewport === elements.viewport &&
    pane.scrollbar.elements().content === elements.content &&
    pane.scrollbar.elements().scrollbarVertical.scrollbar.parentElement === elements.slot
  ) {
    updateTerminalScrollbar(pane);
    return;
  }

  destroyTerminalScrollbar(pane);
  pane.scrollbar = OverlayScrollbars(
    {
      target: elements.slot,
      elements: {
        viewport: elements.viewport,
        content: elements.content,
      },
      scrollbars: {
        slot: elements.slot,
      },
    },
    {
      overflow: {
        x: "hidden",
        y: "scroll",
      },
      scrollbars: {
        autoHide: "never",
        autoHideDelay: 900,
        clickScroll: false,
        dragScroll: false,
        visibility: "visible",
        theme: "os-theme-dark os-theme-nocturne-terminal",
      },
    },
  );
  pane.scrollbarInteraction = attachTerminalScrollbarInteraction(pane);
  updateTerminalScrollbar(pane);
}

function attachTerminalScrollSync(pane: TerminalPane): { dispose: () => void } {
  const term = pane.term;
  if (!term) return { dispose: () => {} };

  const update = () => updateTerminalScrollbar(pane);
  const scrollDisposable = term.onScroll(update);
  const writeDisposable = term.onWriteParsed(update);
  const wheelHandler = (event: WheelEvent) => {
    const result = terminalWheelScrollResult({
      baseY: term.buffer.active.baseY,
      viewportY: term.buffer.active.viewportY,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rows: term.rows,
      previousRemainder: pane.wheelRemainder,
      normalBuffer: term.buffer.active.type === "normal",
      mouseTracking: term.modes.mouseTrackingMode !== "none",
      defaultPrevented: event.defaultPrevented,
      shiftKey: event.shiftKey,
    });
    pane.wheelRemainder = result.remainder;
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

function terminalScrollbarElements(
  pane: TerminalPane,
): { root: HTMLElement; viewport: HTMLElement; content: HTMLElement; slot: HTMLElement } | null {
  const root = pane.term?.element;
  const slot = pane.container;
  if (!root || !slot) return null;
  const viewport = root.querySelector<HTMLElement>(".xterm-viewport");
  if (!viewport) return null;
  const content = viewport.querySelector<HTMLElement>(".xterm-scroll-area");
  if (!content) return null;
  return { root, viewport, content, slot };
}

function updateTerminalScrollbar(pane: TerminalPane) {
  const scrollbar = pane.scrollbar;
  if (!scrollbar || !OverlayScrollbars.valid(scrollbar)) return;
  requestAnimationFrame(() => {
    if (!OverlayScrollbars.valid(scrollbar)) return;
    scrollbar.update(true);
    syncTerminalScrollbarThumb(pane);
  });
}

function destroyTerminalScrollbar(pane: TerminalPane) {
  pane.scrollbarInteraction?.dispose();
  pane.scrollbarInteraction = undefined;
  pane.scrollbar?.destroy();
  pane.scrollbar = undefined;
}

function syncTerminalScrollbarThumb(pane: TerminalPane) {
  const term = pane.term;
  const scrollbar = pane.scrollbar;
  if (!term || !scrollbar || !OverlayScrollbars.valid(scrollbar)) return;

  const state = terminalScrollbarState({
    baseY: term.buffer.active.baseY,
    viewportY: term.buffer.active.viewportY,
    rows: term.rows,
  });
  const { scrollbar: vertical, track, handle } = scrollbar.elements().scrollbarVertical;
  vertical.classList.toggle("os-scrollbar-visible", state.visible);
  vertical.classList.toggle("os-scrollbar-unusable", !state.visible);
  vertical.classList.toggle("os-scrollbar-nocturne-visible", state.visible);
  vertical.style.setProperty("--os-viewport-percent", String(state.thumbSizePercent));
  vertical.style.setProperty("--os-scroll-percent", String(state.scrollPercent));
  vertical.style.position = "absolute";
  vertical.style.top = "6px";
  vertical.style.right = "4px";
  vertical.style.bottom = "6px";
  vertical.style.width = "10px";
  vertical.style.opacity = state.visible ? "1" : "";
  vertical.style.visibility = state.visible ? "visible" : "";
  vertical.style.zIndex = state.visible ? "12" : "";
  track.style.position = "relative";
  track.style.width = "100%";
  track.style.height = "100%";
  handle.style.setProperty("height", `${state.thumbSizePercent * 100}%`);
  handle.style.position = "absolute";
  handle.style.top = "auto";
  handle.style.right = "0";
  handle.style.width = "100%";
  handle.style.opacity = state.visible ? "1" : "";
}

function attachTerminalScrollbarInteraction(pane: TerminalPane): { dispose: () => void } {
  const term = pane.term;
  const scrollbar = pane.scrollbar;
  if (!term || !scrollbar || !OverlayScrollbars.valid(scrollbar)) return { dispose: () => {} };

  const { scrollbar: vertical, track } = scrollbar.elements().scrollbarVertical;
  let dragging = false;
  let pointerId: number | null = null;

  const scrollToPointer = (clientY: number) => {
    if (!pane.term || pane.term !== term) return;
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
    updateTerminalScrollbar(pane);
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
    updateTerminalScrollbar(pane);
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
