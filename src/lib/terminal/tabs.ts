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

export type TerminalTab = {
  id: string;
  title: string;
  command: string;
  status: TerminalStatus;
  exitText: string;
  error: string;
  term?: Terminal;
  fit?: FitAddon;
  webgl?: { dispose: () => void };
  container?: HTMLDivElement;
  resizeObserver?: ResizeObserver;
  dataDisposables: Array<{ dispose: () => void }>;
  decoder: TextDecoder;
  outputQueue: string[];
  outputFrame: number | null;
  resizeTimer: number | null;
  lastCols: number;
  lastRows: number;
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
    title: info.title,
    command: info.command,
    status: "running",
    exitText: "",
    error: "",
    dataDisposables: [],
    decoder: new TextDecoder(),
    outputQueue: [],
    outputFrame: null,
    resizeTimer: null,
    lastCols: info.cols,
    lastRows: info.rows,
  };
}

export function createTerminalTabController(context: TerminalTabContext) {
  const tabById = (id: string) => context.tabs().find((item) => item.id === id);

  async function mountTerminal(id: string) {
    const config = context.settings();
    if (!config) throw new Error("Terminal settings are not loaded");
    const tab = tabById(id);
    const container = tab?.container;
    if (!tab || !container || tab.term) return;

    const term = new Terminal(xtermOptions(config));
    const fit = new FitAddon();
    term.loadAddon(fit);

    try {
      if (config.renderer === "webgl") {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        term.loadAddon(webgl);
        tab.webgl = webgl;
      }

      term.open(container);
      fit.fit();
      tab.term = term;
      tab.fit = fit;
      tab.dataDisposables = [
        term.onData((data) => {
          void unwrapCommand(commands.writeTerminal({ session_id: id, data })).catch((error) => {
            markTabError(id, error instanceof Error ? error.message : String(error));
          });
        }),
        term.onResize(({ cols, rows }) => scheduleResize(id, cols, rows)),
      ];
      tab.resizeObserver = new ResizeObserver(() => scheduleFit(id));
      tab.resizeObserver.observe(container);
      scheduleFit(id);
      term.focus();
    } catch (error) {
      term.dispose();
      markTabError(id, error instanceof Error ? error.message : String(error));
    }
  }

  function scheduleFit(id: string) {
    const tab = tabById(id);
    if (!tab?.fit || !tab.term) return;
    requestAnimationFrame(() => {
      tab.fit?.fit();
      const cols = tab.term?.cols;
      const rows = tab.term?.rows;
      if (cols && rows) scheduleResize(id, cols, rows);
    });
  }

  function scheduleResize(id: string, cols: number, rows: number) {
    const tab = tabById(id);
    if (!tab || tab.status !== "running") return;
    if (tab.lastCols === cols && tab.lastRows === rows) return;
    tab.lastCols = cols;
    tab.lastRows = rows;
    if (tab.resizeTimer !== null) window.clearTimeout(tab.resizeTimer);
    tab.resizeTimer = window.setTimeout(() => {
      tab.resizeTimer = null;
      void unwrapCommand(
        commands.resizeTerminal({
          session_id: id,
          cols,
          rows,
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
