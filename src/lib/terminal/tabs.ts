import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { commands, type ConfigError, type TerminalSessionInfo, type TerminalSettings, type TerminalTransportState } from "$lib/bindings";
import { unwrapCommand } from "./commands";
import { isTerminalSessionInactiveMessage } from "./errors";
import { orderedTerminalOutputChunks } from "./output";
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
  error?: ConfigError | null;
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

export type TerminalSession = {
  id: string;
  tabId?: string;
  title: string;
  baseTitle: string;
  agentSessionName: string;
  command: string;
  currentDirectory: string;
  titleOverride: string;
  status: TerminalStatus;
  readOnly: boolean;
  agentBacked: boolean;
  agentSessionId: string;
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

export type TerminalTab = {
  id: string;
  title: string;
  sessionId: string;
  session: TerminalSession;
};

const resizeDelayMs = 24;
let nextTerminalTabSequence = 0;

type TerminalTabContext = {
  settings: () => TerminalSettings | null;
  tabs: () => TerminalTab[];
  setGlobalError: (message: string) => void;
  notifySelectionChange?: () => void;
  notifyTitleChange?: (sessionId: string, title: string) => void;
  notifySessionTitleRefresh?: () => void;
  requestReconnect?: (sessionId: string) => void;
};

export function createTerminalTab(info: TerminalSessionInfo): TerminalTab {
  const session = createTerminalSession(info);
  const tab = {
    id: nextTerminalTabId(),
    title: session.title,
    sessionId: session.id,
    session,
  };
  refreshTerminalTabTitle(tab);
  return tab;
}

export function createTerminalTabFromSession(session: TerminalSession): TerminalTab {
  session.tabId = session.tabId ?? "";
  const tab = {
    id: nextTerminalTabId(),
    title: session.title,
    sessionId: session.id,
    session,
  };
  refreshTerminalTabTitle(tab);
  return tab;
}

export function createTerminalSession(info: TerminalSessionInfo): TerminalSession {
  const size = normalizeTerminalSessionSize(info);
  const initialOutput = initialTransportOutput(info);
  const status = terminalStatusFromTransportState(info.transport_state);
  return {
    id: info.id,
    tabId: "",
    title: info.title,
    baseTitle: info.title,
    agentSessionName: info.agent ? info.title : "",
    command: info.command,
    currentDirectory: info.cwd ?? "",
    titleOverride: "",
    status,
    readOnly: status === "disconnected",
    agentBacked: info.agent !== null,
    agentSessionId: info.agent?.session_id ?? "",
    reconnectPending: false,
    everConnected: info.transport_state === "connected" || status === "disconnected",
    connectionHostId: "",
    reconnectTrust: {},
    exitText: status === "disconnected" ? "History" : "",
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

export function retargetTerminalSession(session: TerminalSession, info: TerminalSessionInfo) {
  const size = normalizeTerminalSessionSize(info);
  const initialOutput = initialTransportOutput(info);
  if (session.resizeTimer !== null) window.clearTimeout(session.resizeTimer);
  if (session.outputFrame !== null) window.cancelAnimationFrame(session.outputFrame);
  session.id = info.id;
  session.title = info.title;
  session.baseTitle = info.title;
  session.agentSessionName = info.agent ? info.title : "";
  session.command = info.command;
  session.currentDirectory = info.cwd ?? "";
  session.titleOverride = "";
  session.status = terminalStatusFromTransportState(info.transport_state);
  session.readOnly = session.status === "disconnected";
  session.agentBacked = info.agent !== null;
  session.agentSessionId = info.agent?.session_id ?? "";
  session.reconnectPending = false;
  session.everConnected = info.transport_state === "connected" || session.status === "disconnected";
  session.reconnectTrust = {};
  session.exitText = session.status === "disconnected" ? "History" : "";
  session.error = "";
  session.decoder = new TextDecoder();
  session.outputQueue = [];
  session.replayBuffer = [];
  session.outputFrame = null;
  session.nextOutputSequence = 0n;
  session.pendingOutput = new Map();
  session.resizeTimer = null;
  session.mountPromise = null;
  session.lastCols = size.cols;
  session.lastRows = size.rows;
  session.lastPixelWidth = size.pixelWidth;
  session.lastPixelHeight = size.pixelHeight;
  session.wheelRemainder = 0;
  if (initialOutput) {
    if (session.term) {
      writeTerminalSessionViews(session, `\r\n${initialOutput}`);
    } else {
      session.outputQueue.push(initialOutput);
    }
  }
}

function terminalStatusFromTransportState(state: TerminalTransportState): TerminalStatus {
  if (state === "connected") return "running";
  if (state === "disconnected") return "disconnected";
  if (state === "failed") return "error";
  return "starting";
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
  if (state === "waiting_for_workspace_verification") return "Waiting for Workspace verification";
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

export function terminalSessionById(tab: TerminalTab, sessionId: string): TerminalSession | undefined {
  return tab.session.id === sessionId || tab.id === sessionId || tab.sessionId === sessionId ? tab.session : undefined;
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
  const tabById = (id: string) => context.tabs().find((item) => item.id === id || item.session.id === id);
  const sessionById = (id: string) => tabById(id)?.session;

  function refreshTitleForSession(session: TerminalSession) {
    const tab = tabById(session.id);
    if (tab) refreshTerminalTabTitle(tab);
    context.notifySessionTitleRefresh?.();
  }

  async function mountTerminal(id: string, viewId = id) {
    const config = context.settings();
    if (!config) throw new Error("Terminal settings are not loaded");
    const session = sessionById(id);
    const container = session?.viewContainers.get(viewId) ?? (viewId === id ? session?.container : undefined);
    if (!session || !container) return;
    if (session.mountPromise) await session.mountPromise;
    const existingView = session.views.get(viewId);
    if (existingView) {
      existingView.container = container;
      attachMountedTerminal(session, existingView, () => scheduleFit(session.id, viewId));
      return;
    }

    session.mountPromise = mountTerminalOnce(session, config, container, viewId);
    try {
      await session.mountPromise;
    } finally {
      session.mountPromise = null;
    }
  }

  async function mountTerminalOnce(session: TerminalSession, config: TerminalSettings, container: HTMLDivElement, viewId: string) {
    const term = new Terminal({
      ...xtermOptions(config),
      cols: session.lastCols,
      rows: session.lastRows,
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
          cols: session.lastCols,
          rows: session.lastRows,
          pixelWidth: session.lastPixelWidth,
          pixelHeight: session.lastPixelHeight,
        },
        fitted: false,
        tooSmall: false,
        constraining: false,
      };
      session.views.set(viewId, view);
      setActiveSessionView(session, view);
      attachTerminalScrollbar(session, view);
      fitTerminal(session, view);

      if (config.renderer === "webgl") {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon(true);
        term.loadAddon(webgl);
        view.webgl = webgl;
        session.webgl = webgl;
        stabilizeWebglTerminal(term, webgl);
      }

      if (session.replayBuffer.length) {
        term.write(session.replayBuffer.join(""));
      }
      if (session.outputQueue.length) {
        scheduleOutputFlush(session);
      }

      view.dataDisposables = [
        attachTerminalScrollSync(session, view),
        term.onTitleChange((title) => {
          session.titleOverride = title;
          refreshTitleForSession(session);
          const trimmed = title.trim();
          if (trimmed && session.agentBacked && !session.readOnly) {
            context.notifyTitleChange?.(session.id, trimmed);
          }
        }),
        term.parser.registerOscHandler(7, (data) => {
          session.currentDirectory = parseOsc7Directory(data);
          refreshTitleForSession(session);
          return true;
        }),
        term.onData((data) => {
          setActiveSessionView(session, view);
          handleTerminalSessionInput(session, data, {
            markReconnectRequested,
            requestReconnect: context.requestReconnect,
            writeTerminal: (input) => {
              void unwrapCommand(commands.writeTerminal({ session_id: session.id, data: input })).catch((error) => {
                markWriteFailure(session.id, error instanceof Error ? error.message : String(error));
              });
            },
          });
        }),
        term.onResize(() => {
          fitTerminal(session, view);
          scheduleResize(session.id);
        }),
        term.onSelectionChange(() => {
          setActiveSessionView(session, view);
          context.notifySelectionChange?.();
        }),
      ];
      view.resizeObserver = new ResizeObserver(() => scheduleFit(session.id, view.id));
      view.resizeObserver.observe(container);
      scheduleFit(session.id, view.id);
      requestAnimationFrame(() => {
        fitTerminal(session, view);
        if (view.webgl) stabilizeWebglTerminal(term, view.webgl);
      });
      term.focus();
    } catch (error) {
      term.dispose();
      session.views.delete(viewId);
      if (session.term === term) {
        session.term = undefined;
        session.fit = undefined;
        session.search = undefined;
        session.serialize = undefined;
        session.image = undefined;
        session.webgl = undefined;
      }
      markSessionError(session.id, error instanceof Error ? error.message : String(error));
    }
  }

  function scheduleFit(id: string, viewId?: string) {
    const session = sessionById(id);
    if (!session) return;
    requestAnimationFrame(() => {
      const views = viewId
        ? [session.views.get(viewId)].filter((view): view is TerminalView => view !== undefined)
        : Array.from(session.views.values());
      for (const view of views) {
        fitTerminal(session, view);
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

  function refreshSessionPresentation(id: string) {
    const session = sessionById(id);
    if (!session) return;
    refreshTerminalSessionPresentation(session);
  }

  function scheduleResize(id: string) {
    const session = sessionById(id);
    if (!session || session.status !== "running") return;
    const result = computeTerminalMirrorPtySize({
      views: sessionViewMeasurements(session),
      lastValidSize: {
        cols: session.lastCols,
        rows: session.lastRows,
        pixelWidth: session.lastPixelWidth,
        pixelHeight: session.lastPixelHeight,
      },
      lastSentSize: {
        cols: session.lastCols,
        rows: session.lastRows,
        pixelWidth: session.lastPixelWidth,
        pixelHeight: session.lastPixelHeight,
      },
    });
    updateTerminalViewSizeState(session, result.tooSmallViewIds, result.constrainingViewIds);
    if (!result.shouldSendResize) return;
    const normalized = normalizeTerminalFitSize(result.size, {
      cols: session.lastCols,
      rows: session.lastRows,
      pixelWidth: session.lastPixelWidth,
      pixelHeight: session.lastPixelHeight,
    });
    if (
      session.lastCols === normalized.cols &&
      session.lastRows === normalized.rows &&
      session.lastPixelWidth === normalized.pixelWidth &&
      session.lastPixelHeight === normalized.pixelHeight
    ) {
      return;
    }
    session.lastCols = normalized.cols;
    session.lastRows = normalized.rows;
    session.lastPixelWidth = normalized.pixelWidth;
    session.lastPixelHeight = normalized.pixelHeight;
    if (session.resizeTimer !== null) window.clearTimeout(session.resizeTimer);
    session.resizeTimer = window.setTimeout(() => {
      session.resizeTimer = null;
      void unwrapCommand(
        commands.resizeTerminal({
          session_id: id,
          cols: session.lastCols,
          rows: session.lastRows,
          pixel_width: session.lastPixelWidth,
          pixel_height: session.lastPixelHeight,
        }),
      ).catch((error) => markWriteFailure(id, error instanceof Error ? error.message : String(error)));
    }, resizeDelayMs);
  }

  function enqueueOutput(event: TerminalOutputEvent) {
    const session = sessionById(event.session_id);
    if (!session) return;
    const chunks = orderedTerminalOutputChunks(session, event, session.decoder);
    if (!chunks.length) return;
    if (updateTerminalSessionDirectoryFromOutput(session, chunks)) refreshTitleForSession(session);
    session.outputQueue.push(...chunks);
    scheduleOutputFlush(session);
  }

  function markExited(event: TerminalExitEvent) {
    const session = sessionById(event.session_id);
    if (!session) return;
    if (session.everConnected && event.signal && event.signal !== "closed") {
      markDisconnected(session, disconnectMessage(event.signal));
      return;
    }
    if (session.status === "starting" && event.signal) {
      session.status = "error";
      session.error = event.signal;
      writeTerminalSessionViews(session, `\r\n[Connection stopped: ${event.signal}]\r\n`);
      return;
    }
    if (session.status === "running" && event.signal && event.signal !== "closed") {
      markDisconnected(session, event.signal);
      return;
    }
    if (session.status === "error") {
      session.error = event.signal ?? session.error;
      writeTerminalSessionViews(session, `\r\n[Terminal error: ${session.error || "connection failed"}]\r\n`);
      return;
    }
    session.status = "exited";
    session.reconnectPending = false;
    session.exitText = event.signal ? `Signal: ${event.signal}` : `Exit ${event.exit_code ?? "unknown"}`;
    session.titleOverride = "";
    refreshTitleForSession(session);
    writeTerminalSessionViews(session, `\r\n[Process completed: ${session.exitText}]\r\n`);
  }

  function markTransportState(event: TerminalTransportStateEvent) {
    const session = sessionById(event.session_id);
    if (!session) return;
    const line = `[${transportStateLabel(event.state)}]\r\n`;
    writeTerminalSessionViews(session, line);
    if (event.state === "failed") {
      if (session.everConnected) {
        return;
      }
      session.status = "error";
      session.reconnectPending = false;
      return;
    }
    if (event.state === "connected") {
      session.status = "running";
      session.reconnectPending = false;
      session.everConnected = true;
    }
  }

  function markSessionError(id: string, message: string) {
    const session = sessionById(id);
    if (!session) return;
    if (isTerminalSessionInactiveMessage(message)) {
      markDisconnected(session, "connection is no longer active");
      return;
    }
    session.status = "error";
    session.reconnectPending = false;
    session.error = message;
    writeTerminalSessionViews(session, `\r\n[Terminal error: ${message}]\r\n`);
  }

  function markWriteFailure(id: string, message: string) {
    const session = sessionById(id);
    if (!session) return;
    if (isTerminalSessionInactiveMessage(message)) {
      markDisconnected(session, "connection is no longer active");
      return;
    }
    markSessionError(id, message);
  }

  function markDisconnected(session: TerminalSession, message: string) {
    if (session.reconnectPending) return;
    session.status = "disconnected";
    session.reconnectPending = true;
    session.exitText = message;
    session.error = "";
    writeTerminalSessionViews(session, `\r\n[Connection disconnected: ${message}]\r\n[Press any key to reconnect]\r\n`);
  }

  function markReconnectUnavailable(id: string, message: string) {
    const session = sessionById(id);
    if (!session) return;
    session.status = "error";
    session.reconnectPending = false;
    session.error = message;
    writeTerminalSessionViews(session, `\r\n[Reconnect failed: ${message}]\r\n`);
  }

  function markReconnectRequested(id: string) {
    const session = sessionById(id);
    if (!session || !session.reconnectPending) return;
    session.status = "starting";
    session.reconnectPending = false;
    session.exitText = "Reconnecting";
    session.error = "";
    writeTerminalSessionViews(session, "\r\n[Reconnecting]\r\n");
  }

  function markConnectionError(id: string, message: string) {
    markSessionError(id, message);
  }

  function markConnectionPrompt(id: string, message: string) {
    const session = sessionById(id);
    if (!session) return;
    session.status = "exited";
    session.reconnectPending = false;
    session.exitText = message;
    session.error = "";
    writeTerminalSessionViews(session, `\r\n[Connection paused: ${message}]\r\n`);
  }

  function markConnectionCancelled(id: string, message: string) {
    const session = sessionById(id);
    if (!session) return;
    session.status = "error";
    session.reconnectPending = false;
    session.error = message;
    session.exitText = message;
    writeTerminalSessionViews(session, `\r\n[Connection canceled: ${message}]\r\n`);
  }

  function scheduleOutputFlush(session: TerminalSession) {
    if (session.views.size === 0 || session.outputFrame !== null) return;
    session.outputFrame = requestAnimationFrame(() => {
      session.outputFrame = null;
      if (session.views.size === 0 || !session.outputQueue.length) return;
      const text = session.outputQueue.join("");
      session.outputQueue = [];
      session.replayBuffer.push(text);
      trimReplayBuffer(session);
      for (const view of session.views.values()) {
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
    refreshSessionPresentation,
    scheduleFit,
  };
}

export function handleTerminalSessionInput(
  session: Pick<TerminalSession, "id" | "readOnly" | "reconnectPending">,
  data: string,
  callbacks: {
    markReconnectRequested?: (sessionId: string) => void;
    requestReconnect?: (sessionId: string) => void;
    writeTerminal: (data: string) => void;
  },
) {
  if (session.readOnly) return;
  if (session.reconnectPending) {
    callbacks.markReconnectRequested?.(session.id);
    callbacks.requestReconnect?.(session.id);
    return;
  }
  callbacks.writeTerminal(data);
}

export function updateTerminalSessionDirectoryFromOutput(
  session: Pick<TerminalSession, "currentDirectory">,
  chunks: string[],
) {
  const cwd = inferDirectoryFromPromptOutput(chunks.join(""));
  if (!cwd || cwd === session.currentDirectory) return false;
  session.currentDirectory = cwd;
  return true;
}

function inferDirectoryFromPromptOutput(output: string) {
  const normalized = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = [...normalized.matchAll(/(?:^|[\r\n])([A-Za-z]:\\[^\r\n<>:"|?*]+)>/g)];
  const match = matches.at(-1);
  return match?.[1]?.trim() ?? "";
}

function attachMountedTerminal(session: TerminalSession, view: TerminalView, scheduleFit: () => void) {
  const element = view.term.element;
  if (!element) return;
  if (element.parentElement !== view.container) {
    view.container.replaceChildren(element);
    view.resizeObserver?.disconnect();
    view.resizeObserver = new ResizeObserver(scheduleFit);
    view.resizeObserver.observe(view.container);
  }
  setActiveSessionView(session, view);
  attachTerminalScrollbar(session, view);
  fitTerminal(session, view);
  view.term.refresh(0, Math.max(0, view.term.rows - 1));
}

export function refreshTerminalSessionPresentation(session: TerminalSession) {
  for (const view of session.views.values()) {
    attachTerminalScrollbar(session, view);
    view.term.refresh(0, Math.max(0, view.term.rows - 1));
    updateTerminalScrollbar(view);
  }
}

export function disposeTerminalTab(tab: TerminalTab) {
  detachTerminalSession(tab.session);
}

export function disposeTerminalSession(session: TerminalSession) {
  detachTerminalSession(session);
}

export function detachTerminalSession(session: TerminalSession) {
  const serialized = session.serialize?.serialize({ scrollback: 1000 }) ?? "";
  if (serialized) session.outputQueue = [serialized, ...session.outputQueue];
  if (session.outputFrame !== null) cancelAnimationFrame(session.outputFrame);
  session.outputFrame = null;
  if (session.resizeTimer !== null) window.clearTimeout(session.resizeTimer);
  session.resizeTimer = null;
  for (const view of session.views.values()) {
    disposeTerminalView(view);
  }
  session.views.clear();
  session.viewContainers.clear();
  session.term = undefined;
  session.fit = undefined;
  session.search = undefined;
  session.serialize = undefined;
  session.image = undefined;
  session.webgl = undefined;
  session.scrollbarDom = undefined;
  session.scrollbarInteraction = undefined;
  session.resizeObserver = undefined;
  session.dataDisposables = [];
  session.container?.replaceChildren();
  session.container = undefined;
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

function fitTerminal(session: TerminalSession, view: TerminalView): TerminalFitSize | null {
  const dimensions = view.fit.proposeDimensions();
  const fallback = {
    cols: session.lastCols,
    rows: session.lastRows,
    pixelWidth: session.lastPixelWidth,
    pixelHeight: session.lastPixelHeight,
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

function attachTerminalScrollbar(_session: TerminalSession, view: TerminalView) {
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

function attachTerminalScrollSync(_session: TerminalSession, view: TerminalView): { dispose: () => void } {
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

function setActiveSessionView(session: TerminalSession, view: TerminalView) {
  session.term = view.term;
  session.fit = view.fit;
  session.search = view.search;
  session.serialize = view.serialize;
  session.image = view.image;
  session.webgl = view.webgl;
  session.scrollbarDom = view.scrollbarDom;
  session.scrollbarInteraction = view.scrollbarInteraction;
  session.container = view.container;
  session.resizeObserver = view.resizeObserver;
  session.dataDisposables = view.dataDisposables;
  session.wheelRemainder = view.wheelRemainder;
}

function sessionViewMeasurements(session: TerminalSession): TerminalMirrorViewMeasurement[] {
  return Array.from(session.views.values()).map((view) => ({
    id: view.id,
    visible: view.container.isConnected && view.container.getClientRects().length > 0,
    mounted: view.term.element?.isConnected === true,
    fitted: view.fitted,
    ...view.lastFitSize,
  }));
}

function updateTerminalViewSizeState(session: TerminalSession, tooSmallViewIds: string[], constrainingViewIds: string[]) {
  const tooSmall = new Set(tooSmallViewIds);
  const constraining = new Set(constrainingViewIds);
  for (const view of session.views.values()) {
    view.tooSmall = tooSmall.has(view.id);
    view.constraining = constraining.has(view.id);
    view.container.toggleAttribute("data-terminal-too-small", view.tooSmall);
    view.container.toggleAttribute("data-terminal-size-constraining", view.constraining);
  }
}

function trimReplayBuffer(session: TerminalSession) {
  const maxReplayChars = 500_000;
  let total = 0;
  const retained: string[] = [];
  for (let index = session.replayBuffer.length - 1; index >= 0; index -= 1) {
    const chunk = session.replayBuffer[index];
    if (total + chunk.length > maxReplayChars && retained.length > 0) break;
    retained.push(chunk);
    total += chunk.length;
  }
  session.replayBuffer = retained.reverse();
}

function writeTerminalSessionViews(session: TerminalSession, text: string) {
  if (session.views.size === 0) {
    session.outputQueue.push(text);
    return;
  }
  session.replayBuffer.push(text);
  trimReplayBuffer(session);
  for (const view of session.views.values()) {
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
