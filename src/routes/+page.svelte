<script lang="ts">
  import { onMount, tick } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { FitAddon } from "@xterm/addon-fit";
  import { Terminal } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";
  import {
    commands,
    type TabBarOrientation,
    type TerminalSettings,
    type TerminalSessionInfo,
  } from "$lib/bindings";

  type CommandResult<T, E> = { status: "ok"; data: T } | { status: "error"; error: E };
  type TerminalOutputEvent = {
    session_id: string;
    data: string;
  };
  type TerminalExitEvent = {
    session_id: string;
    exit_code: number | null;
    signal: string | null;
  };
  type TerminalStatus = "starting" | "running" | "exited" | "error";
  type TerminalTab = {
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

  const initialCols = 80;
  const initialRows = 24;
  const resizeDelayMs = 24;

  let settings = $state<TerminalSettings | null>(null);
  let settingsError = $state("");
  let tabs = $state<TerminalTab[]>([]);
  let activeId = $state("");
  let tabBarOrientation = $state<TabBarOrientation>("horizontal");
  let outputUnlisten: undefined | (() => void);
  let exitUnlisten: undefined | (() => void);

  let activeTab = $derived(tabs.find((tab) => tab.id === activeId));
  let isVertical = $derived(tabBarOrientation === "vertical");

  async function unwrapCommand<T, E>(result: Promise<CommandResult<T, E>>): Promise<T> {
    const resolved = await result;
    if (resolved.status === "ok") return resolved.data;
    throw new Error(formatCommandError(resolved.error));
  }

  function formatCommandError(error: unknown): string {
    if (isRecord(error) && typeof error.kind === "string") {
      const message = isRecord(error.message) && typeof error.message.message === "string" ? error.message.message : "";
      return message ? `${error.kind}: ${message}` : error.kind;
    }
    return String(error);
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function xtermTheme(config: TerminalSettings["theme"]) {
    return {
      background: config.background,
      foreground: config.foreground,
      cursor: config.cursor,
      selectionBackground: config.selection_background,
      black: config.black,
      red: config.red,
      green: config.green,
      yellow: config.yellow,
      blue: config.blue,
      magenta: config.magenta,
      cyan: config.cyan,
      white: config.white,
      brightBlack: config.bright_black,
      brightRed: config.bright_red,
      brightGreen: config.bright_green,
      brightYellow: config.bright_yellow,
      brightBlue: config.bright_blue,
      brightMagenta: config.bright_magenta,
      brightCyan: config.bright_cyan,
      brightWhite: config.bright_white,
    };
  }

  function syncThemeVariables(config: TerminalSettings) {
    document.documentElement.style.setProperty("--terminal-bg", config.theme.background);
    document.documentElement.style.setProperty("--terminal-fg", config.theme.foreground);
    document.documentElement.style.setProperty("--terminal-selection", config.theme.selection_background);
  }

  function finiteNumber(name: string, value: number | null): number {
    if (value === null || !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number`);
    }
    return value;
  }

  async function loadSettings() {
    settingsError = "";
    const next = await unwrapCommand(commands.getTerminalSettings());
    settings = next;
    tabBarOrientation = next.tab_bar_orientation;
    syncThemeVariables(next);
  }

  function createTab(info: TerminalSessionInfo): TerminalTab {
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

  async function newSession() {
    try {
      if (!settings) await loadSettings();
      const info = await unwrapCommand(
        commands.createTerminalSession({
          cols: initialCols,
          rows: initialRows,
        }),
      );
      tabs = [...tabs, createTab(info)];
      activeId = info.id;
      await tick();
      await mountTerminal(info.id);
    } catch (error) {
      settingsError = error instanceof Error ? error.message : String(error);
    }
  }

  async function mountTerminal(id: string) {
    const config = settings;
    if (!config) throw new Error("Terminal settings are not loaded");
    const tab = tabs.find((item) => item.id === id);
    const container = tab?.container;
    if (!tab || !container || tab.term) return;

    const term = new Terminal({
      allowProposedApi: config.renderer === "webgl",
      cursorBlink: config.cursor_blink,
      cursorStyle: config.cursor_style,
      fontFamily: config.font_family,
      fontSize: finiteNumber("terminal.font_size", config.font_size),
      scrollback: config.scrollback,
      theme: xtermTheme(config.theme),
    });
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
    const tab = tabs.find((item) => item.id === id);
    if (!tab?.fit || !tab.term) return;
    requestAnimationFrame(() => {
      tab.fit?.fit();
      const cols = tab.term?.cols;
      const rows = tab.term?.rows;
      if (cols && rows) scheduleResize(id, cols, rows);
    });
  }

  function scheduleResize(id: string, cols: number, rows: number) {
    const tab = tabs.find((item) => item.id === id);
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

  function decodeOutput(tab: TerminalTab, data: string): string {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return tab.decoder.decode(bytes, { stream: true });
  }

  function enqueueOutput(event: TerminalOutputEvent) {
    const tab = tabs.find((item) => item.id === event.session_id);
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
    const tab = tabs.find((item) => item.id === event.session_id);
    if (!tab) return;
    tab.status = "exited";
    tab.exitText = event.signal ? `Signal: ${event.signal}` : `Exit ${event.exit_code ?? "unknown"}`;
    tab.term?.write(`\r\n[Process completed: ${tab.exitText}]\r\n`);
  }

  function markTabError(id: string, message: string) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) {
      settingsError = message;
      return;
    }
    tab.status = "error";
    tab.error = message;
    tab.term?.write(`\r\n[Terminal error: ${message}]\r\n`);
  }

  async function activateTab(id: string) {
    activeId = id;
    await tick();
    await mountTerminal(id);
    scheduleFit(id);
    tabs.find((tab) => tab.id === id)?.term?.focus();
  }

  async function closeTab(id: string) {
    const tab = tabs.find((item) => item.id === id);
    if (!tab) return;
    disposeTab(tab);
    if (tab.status === "running") {
      await unwrapCommand(commands.closeTerminalSession(id)).catch((error) => {
        settingsError = error instanceof Error ? error.message : String(error);
      });
    }
    const index = tabs.findIndex((item) => item.id === id);
    tabs = tabs.filter((item) => item.id !== id);
    if (activeId === id) {
      activeId = tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? "";
      if (activeId) await activateTab(activeId);
    }
  }

  function disposeTab(tab: TerminalTab) {
    if (tab.outputFrame !== null) cancelAnimationFrame(tab.outputFrame);
    if (tab.resizeTimer !== null) window.clearTimeout(tab.resizeTimer);
    tab.resizeObserver?.disconnect();
    tab.dataDisposables.forEach((disposable) => disposable.dispose());
    tab.webgl?.dispose();
    tab.term?.dispose();
  }

  function toggleTabBarOrientation() {
    tabBarOrientation = tabBarOrientation === "horizontal" ? "vertical" : "horizontal";
    requestAnimationFrame(() => {
      if (activeId) scheduleFit(activeId);
    });
  }

  function tabContextMenu(event: MouseEvent) {
    event.preventDefault();
    toggleTabBarOrientation();
  }

  function handleKeyboard(event: KeyboardEvent) {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const newTab = isMac ? event.metaKey && event.key.toLowerCase() === "t" : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "t";
    if (newTab) {
      event.preventDefault();
      void newSession();
      return;
    }
    const closeActiveTab = isMac ? event.metaKey && event.key.toLowerCase() === "w" : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "w";
    if (closeActiveTab && activeId) {
      event.preventDefault();
      void closeTab(activeId);
    }
  }

  onMount(() => {
    void loadSettings().catch((error) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
    void listen<TerminalOutputEvent>("terminal://output", (event) => enqueueOutput(event.payload)).then((dispose) => {
      outputUnlisten = dispose;
    });
    void listen<TerminalExitEvent>("terminal://exit", (event) => markExited(event.payload)).then((dispose) => {
      exitUnlisten = dispose;
    });
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      outputUnlisten?.();
      exitUnlisten?.();
      for (const tab of tabs) {
        disposeTab(tab);
        if (tab.status === "running") void unwrapCommand(commands.closeTerminalSession(tab.id));
      }
    };
  });

  $effect(() => {
    if (activeId) {
      void tick().then(() => {
        void mountTerminal(activeId);
        scheduleFit(activeId);
      });
    }
  });
</script>

<main class:vertical={isVertical} class="workspace">
  {#if !isVertical}
    <nav class="tabbar horizontal" aria-label="Terminal sessions" oncontextmenu={tabContextMenu}>
      <div class="tabs">
        {#each tabs as tab}
          <button class:active={tab.id === activeId} class:error={tab.status === "error"} class:exited={tab.status === "exited"} type="button" onclick={() => activateTab(tab.id)}>
            <span>{tab.title}</span>
            <small>{tab.command}</small>
          </button>
        {/each}
      </div>
      <button class="new-session" type="button" aria-label="New session" title="New session" onclick={newSession}>+</button>
    </nav>
  {/if}

  <section class="content" aria-label="Terminal content">
    {#if settingsError}
      <div class="placeholder error-state">
        <img src="/favicon.png" alt="" />
        <h1>Nocturne</h1>
        <p>{settingsError}</p>
      </div>
    {:else if tabs.length === 0}
      <div class="placeholder">
        <img src="/favicon.png" alt="" />
        <h1>Nocturne</h1>
      </div>
    {:else}
      {#each tabs as tab}
        <div class:active={tab.id === activeId} class="terminal-pane">
          <div class="terminal-host" bind:this={tab.container}></div>
          {#if tab.error}
            <p class="terminal-error">{tab.error}</p>
          {/if}
        </div>
      {/each}
    {/if}
  </section>

  {#if isVertical}
    <nav class="tabbar vertical-tabs" aria-label="Terminal sessions" oncontextmenu={tabContextMenu}>
      <div class="tabs">
        {#each tabs as tab}
          <button class:active={tab.id === activeId} class:error={tab.status === "error"} class:exited={tab.status === "exited"} type="button" onclick={() => activateTab(tab.id)}>
            <span>{tab.title}</span>
            <small>{tab.command}</small>
          </button>
        {/each}
      </div>
      <button class="new-session" type="button" aria-label="New session" title="New session" onclick={newSession}>+</button>
    </nav>
  {/if}
</main>

<style>
  :global(:root) {
    --terminal-bg: #101113;
    --terminal-fg: #eef1f6;
    --terminal-selection: #36506f;
  }

  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--terminal-bg);
    color: var(--terminal-fg);
    overflow: hidden;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .workspace {
    width: 100vw;
    height: 100vh;
    display: grid;
    grid-template-rows: 40px minmax(0, 1fr);
    background: color-mix(in srgb, var(--terminal-bg) 94%, black);
  }

  .workspace.vertical {
    grid-template-columns: minmax(0, 1fr) 208px;
    grid-template-rows: minmax(0, 1fr);
  }

  .tabbar {
    user-select: none;
    -webkit-user-select: none;
    border-color: color-mix(in srgb, var(--terminal-fg) 16%, transparent);
    background: color-mix(in srgb, var(--terminal-bg) 88%, var(--terminal-fg));
  }

  .tabbar.horizontal {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 36px;
    align-items: stretch;
    border-bottom: 1px solid color-mix(in srgb, var(--terminal-fg) 16%, transparent);
  }

  .vertical-tabs {
    display: grid;
    grid-template-rows: minmax(0, 1fr) 40px;
    border-left: 1px solid color-mix(in srgb, var(--terminal-fg) 16%, transparent);
  }

  .tabs {
    min-width: 0;
    min-height: 0;
    display: flex;
    overflow: auto;
  }

  .vertical-tabs .tabs {
    flex-direction: column;
  }

  .tabs button,
  .new-session {
    appearance: none;
    border: 0;
    color: inherit;
    font: inherit;
    background: transparent;
  }

  .tabs button {
    min-width: 148px;
    max-width: 220px;
    height: 39px;
    display: grid;
    align-content: center;
    gap: 1px;
    padding: 4px 12px;
    border-right: 1px solid color-mix(in srgb, var(--terminal-fg) 12%, transparent);
    text-align: left;
  }

  .vertical-tabs .tabs button {
    width: 100%;
    max-width: none;
    border-right: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--terminal-fg) 12%, transparent);
  }

  .tabs button.active {
    background: var(--terminal-bg);
  }

  .tabs button.exited {
    color: color-mix(in srgb, var(--terminal-fg) 62%, transparent);
  }

  .tabs button.error {
    color: #ffb4b4;
  }

  .tabs span,
  .tabs small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tabs span {
    font-size: 12px;
    line-height: 1.1;
  }

  .tabs small {
    font-size: 10px;
    line-height: 1.1;
    color: color-mix(in srgb, var(--terminal-fg) 64%, transparent);
  }

  .new-session {
    width: 36px;
    min-width: 36px;
    height: 39px;
    display: grid;
    place-items: center;
    font-size: 21px;
    line-height: 1;
    border-left: 1px solid color-mix(in srgb, var(--terminal-fg) 12%, transparent);
  }

  .vertical-tabs .new-session {
    width: 100%;
    border-left: 0;
    border-top: 1px solid color-mix(in srgb, var(--terminal-fg) 12%, transparent);
  }

  .new-session:active,
  .tabs button:active {
    background: color-mix(in srgb, var(--terminal-selection) 38%, transparent);
  }

  .content {
    min-width: 0;
    min-height: 0;
    position: relative;
    background: var(--terminal-bg);
  }

  .placeholder {
    height: 100%;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    color: color-mix(in srgb, var(--terminal-fg) 72%, transparent);
    user-select: none;
    -webkit-user-select: none;
  }

  .placeholder img {
    width: 74px;
    height: 74px;
    image-rendering: auto;
  }

  .placeholder h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    line-height: 1.2;
  }

  .placeholder p {
    max-width: min(560px, calc(100vw - 48px));
    margin: 0;
    color: #ffb4b4;
    text-align: center;
    overflow-wrap: anywhere;
  }

  .terminal-pane {
    position: absolute;
    inset: 0;
    display: none;
    min-width: 0;
    min-height: 0;
    background: var(--terminal-bg);
  }

  .terminal-pane.active {
    display: block;
  }

  .terminal-host {
    width: 100%;
    height: 100%;
    padding: 8px 10px;
  }

  .terminal-error {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 10px;
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, #551818 78%, transparent);
    color: #ffd0d0;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  :global(.xterm) {
    height: 100%;
  }

  :global(.xterm .xterm-viewport) {
    background-color: transparent;
  }

  @media (max-width: 720px) {
    .workspace.vertical {
      grid-template-columns: minmax(0, 1fr) 160px;
    }

    .tabs button {
      min-width: 124px;
      padding-inline: 10px;
    }
  }
</style>
