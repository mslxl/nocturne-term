import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { commands, type TerminalSessionInfo, type TerminalSettings } from "$lib/bindings";
import { unwrapCommand } from "./commands";
import { xtermOptions } from "./settings";

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
type TerminalFitSize = {
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
};

export type TerminalTab = {
  id: string;
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

type TerminalTabContext = {
  settings: () => TerminalSettings | null;
  tabs: () => TerminalTab[];
  setGlobalError: (message: string) => void;
};

export function createTerminalTab(info: TerminalSessionInfo): TerminalTab {
  return {
    id: info.id,
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
    lastCols: info.cols,
    lastRows: info.rows,
    lastPixelWidth: info.pixel_width,
    lastPixelHeight: info.pixel_height,
  };
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
  return { ...(dimensions ?? fallback), ...pixels };
}

export function createTerminalTabController(context: TerminalTabContext) {
  const tabById = (id: string) => context.tabs().find((item) => item.id === id);

  async function mountTerminal(id: string) {
    const config = context.settings();
    if (!config) throw new Error("Terminal settings are not loaded");
    const tab = tabById(id);
    const container = tab?.container;
    if (!tab || !container) return;
    if (tab.mountPromise) return tab.mountPromise;
    if (tab.term) return;

    tab.mountPromise = mountTerminalOnce(tab, config, container);
    try {
      await tab.mountPromise;
    } finally {
      tab.mountPromise = null;
    }
  }

  async function mountTerminalOnce(tab: TerminalTab, config: TerminalSettings, container: HTMLDivElement) {
    const term = new Terminal({
      ...xtermOptions(config),
      cols: tab.lastCols,
      rows: tab.lastRows,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    try {
      const { ImageAddon } = await import("@xterm/addon-image");
      const image = new ImageAddon();
      term.loadAddon(image);
      tab.image = image;

      container.replaceChildren();
      term.open(container);
      tab.term = term;
      tab.fit = fit;
      fitTerminal(tab);

      if (config.renderer === "webgl") {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        term.loadAddon(webgl);
        tab.webgl = webgl;
        stabilizeWebglTerminal(term, webgl);
      }

      tab.dataDisposables = [
        term.onTitleChange((title) => {
          tab.titleOverride = title;
          refreshTabTitle(tab);
        }),
        term.parser.registerOscHandler(7, (data) => {
          tab.currentDirectory = parseOsc7Directory(data);
          refreshTabTitle(tab);
          return true;
        }),
        term.onData((data) => {
          void unwrapCommand(commands.writeTerminal({ session_id: tab.id, data })).catch((error) => {
            markTabError(tab.id, error instanceof Error ? error.message : String(error));
          });
        }),
        term.onResize(() => {
          const size = fitTerminal(tab);
          if (size) scheduleResize(tab.id, size);
        }),
      ];
      tab.resizeObserver = new ResizeObserver(() => scheduleFit(tab.id));
      tab.resizeObserver.observe(container);
      scheduleFit(tab.id);
      requestAnimationFrame(() => {
        fitTerminal(tab);
        if (tab.webgl) stabilizeWebglTerminal(term, tab.webgl);
      });
      term.focus();
    } catch (error) {
      term.dispose();
      tab.term = undefined;
      tab.fit = undefined;
      tab.image = undefined;
      tab.webgl = undefined;
      markTabError(tab.id, error instanceof Error ? error.message : String(error));
    }
  }

  function scheduleFit(id: string) {
    const tab = tabById(id);
    if (!tab?.fit || !tab.term) return;
    requestAnimationFrame(() => {
      const size = fitTerminal(tab);
      if (size) scheduleResize(id, size);
      if (tab.webgl && tab.term) stabilizeWebglTerminal(tab.term, tab.webgl);
    });
  }

  function scheduleResize(id: string, size: TerminalFitSize) {
    const tab = tabById(id);
    if (!tab || tab.status !== "running") return;
    if (
      tab.lastCols === size.cols &&
      tab.lastRows === size.rows &&
      tab.lastPixelWidth === size.pixelWidth &&
      tab.lastPixelHeight === size.pixelHeight
    ) {
      return;
    }
    tab.lastCols = size.cols;
    tab.lastRows = size.rows;
    tab.lastPixelWidth = size.pixelWidth;
    tab.lastPixelHeight = size.pixelHeight;
    if (tab.resizeTimer !== null) window.clearTimeout(tab.resizeTimer);
    tab.resizeTimer = window.setTimeout(() => {
      tab.resizeTimer = null;
      void unwrapCommand(
        commands.resizeTerminal({
          session_id: id,
          cols: tab.lastCols,
          rows: tab.lastRows,
          pixel_width: tab.lastPixelWidth,
          pixel_height: tab.lastPixelHeight,
        }),
      ).catch((error) => markTabError(id, error instanceof Error ? error.message : String(error)));
    }, resizeDelayMs);
  }

  function enqueueOutput(event: TerminalOutputEvent) {
    const tab = tabById(event.session_id);
    if (!tab) return;
    const chunk = decodeOutput(tab, event.data);
    if (!chunk) return;
    tab.outputQueue.push(chunk);
    if (tab.outputFrame !== null) return;
    tab.outputFrame = requestAnimationFrame(() => {
      tab.outputFrame = null;
      const text = tab.outputQueue.join("");
      tab.outputQueue = [];
      tab.term?.write(text);
    });
  }

  function markExited(event: TerminalExitEvent) {
    const tab = tabById(event.session_id);
    if (!tab) return;
    tab.status = "exited";
    tab.exitText = event.signal ? `Signal: ${event.signal}` : `Exit ${event.exit_code ?? "unknown"}`;
    tab.titleOverride = "";
    refreshTabTitle(tab);
    tab.term?.write(`\r\n[Process completed: ${tab.exitText}]\r\n`);
  }

  function markTabError(id: string, message: string) {
    const tab = tabById(id);
    if (!tab) {
      context.setGlobalError(message);
      return;
    }
    tab.status = "error";
    tab.error = message;
    tab.term?.write(`\r\n[Terminal error: ${message}]\r\n`);
  }

  return {
    enqueueOutput,
    markExited,
    mountTerminal,
    scheduleFit,
  };
}

export function disposeTerminalTab(tab: TerminalTab) {
  if (tab.outputFrame !== null) cancelAnimationFrame(tab.outputFrame);
  if (tab.resizeTimer !== null) window.clearTimeout(tab.resizeTimer);
  tab.resizeObserver?.disconnect();
  tab.dataDisposables.forEach((disposable) => disposable.dispose());
  tab.image?.dispose();
  tab.webgl?.dispose();
  tab.term?.dispose();
}

function decodeOutput(tab: TerminalTab, data: string): string {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return tab.decoder.decode(bytes, { stream: true });
}

function fitTerminal(tab: TerminalTab): TerminalFitSize | null {
  if (!tab.fit || !tab.term) return null;
  const dimensions = tab.fit.proposeDimensions();
  const pixels = tab.container ? measureTerminalPixels(tab.container) : { pixelWidth: 0, pixelHeight: 0 };
  if (!dimensions) return { cols: tab.term.cols, rows: tab.term.rows, ...pixels };
  tab.fit.fit();
  tab.term.refresh(0, tab.term.rows - 1);
  return { ...dimensions, ...pixels };
}

function measureTerminalPixels(container: HTMLElement): { pixelWidth: number; pixelHeight: number } {
  const rect = container.getBoundingClientRect();
  return {
    pixelWidth: clampU16(Math.round(rect.width)),
    pixelHeight: clampU16(Math.round(rect.height)),
  };
}

function clampU16(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 65535);
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

function refreshTabTitle(tab: TerminalTab) {
  tab.title = deriveTabTitle(tab);
}

function deriveTabTitle(tab: TerminalTab): string {
  const programTitle = tab.titleOverride.trim();
  if (programTitle) return programTitle;

  const currentDirectory = tab.currentDirectory.trim();
  if (currentDirectory) {
    const leaf = currentDirectory.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).pop();
    if (leaf) return leaf;
    return currentDirectory;
  }

  if (tab.command.trim()) return tab.command;
  return tab.baseTitle || "Session";
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
