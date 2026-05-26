<script lang="ts">
  import { save } from "@tauri-apps/plugin-dialog";
  import { useQueryClient, createQuery } from "@tanstack/svelte-query";
  import { commands, type ConfigTable } from "$lib/bindings";
  import { cloneDocument, configString, readValue, stringValue, type ConfigDocument } from "$lib/config/document";
  import { t } from "$lib/i18n";
  import { unwrapCommand } from "$lib/terminal/commands";
  import { builtInDarkSchemeId, builtInLightSchemeId, emptyScheme, type TerminalColorScheme, type TerminalColorSchemeEntry, type TerminalColorSchemeSource, type TerminalColorSchemeVariant } from "$lib/terminal/color-scheme";
  import { saveConfigValue, type SaveTarget } from "$lib/settings/save";

  type Props = {
    target: SaveTarget;
    document: ConfigDocument;
    effectiveRoot: ConfigTable;
  };

  let { target, document, effectiveRoot }: Props = $props();

  const queryClient = useQueryClient();
  const schemesQuery = createQuery(() => ({
    queryKey: ["terminal-color-schemes"],
    queryFn: (): Promise<TerminalColorSchemeEntry[]> => unwrapCommand((commands as any).listTerminalColorSchemes()),
  }));

  let selectedId = $state("");
  let editorMode = $state<"view" | "create" | "edit">("view");
  let editingId = $state<string | null>(null);
  let errorMessage = $state("");
  let exportPath = $state("");
  let draft = $state<TerminalColorScheme>(emptyScheme("custom-scheme", "dark"));

  const schemes = $derived<TerminalColorSchemeEntry[]>(schemesQuery.data ?? []);
  const selected = $derived(schemes.find((item) => item.id === selectedId) ?? schemes[0]);
  const previewScheme = $derived(editorMode === "view" && selected ? selected.scheme : draft);
  const lightSchemeId = $derived(readSchemeId(["terminal", "color_scheme", "light"], builtInLightSchemeId));
  const darkSchemeId = $derived(readSchemeId(["terminal", "color_scheme", "dark"], builtInDarkSchemeId));

  $effect(() => {
    if (schemes.length === 0) return;
    if (selectedId && schemes.some((item) => item.id === selectedId)) return;
    selectedId = schemes[0].id;
    editorMode = "view";
    editingId = null;
  });

  $effect(() => {
    if (!selected) return;
    if (editingId !== selected.id) return;
    draft = cloneScheme(selected.scheme);
  });

  function readSchemeId(path: string[], fallback: string) {
    const value = readValue(document.root, path);
    return stringValue(value) ?? fallback;
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["terminal-color-schemes"] });
    await queryClient.invalidateQueries({ queryKey: ["config"] });
  }

  async function updateThemeMapping(variant: TerminalColorSchemeVariant, schemeId: string) {
    errorMessage = "";
    try {
      await saveConfigValue(
        target,
        cloneDocument(document),
        ["terminal", "color_scheme", variant === "light" ? "light" : "dark"],
        configString(schemeId),
      );
      await refresh();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  function beginCreate() {
    editingId = null;
    draft = emptyScheme("custom-scheme", selected?.scheme.variant ?? "dark");
    editorMode = "create";
  }

  function beginEdit(entry: TerminalColorSchemeEntry) {
    if (entry.source !== "user") return;
    editingId = entry.id;
    draft = cloneScheme(entry.scheme);
    selectedId = entry.id;
    editorMode = "edit";
  }

  function beginCopy(entry: TerminalColorSchemeEntry) {
    editingId = null;
    draft = cloneScheme(entry.scheme);
    draft.id = `${entry.scheme.id}-copy`;
    draft.name = `${entry.scheme.name} Copy`;
    editorMode = "create";
  }

  function cancelEdit() {
    editorMode = "view";
    editingId = null;
    if (!selectedId && schemes[0]) selectedId = schemes[0].id;
  }

  async function saveDraft() {
    errorMessage = "";
    try {
      const nextDraft = { ...draft, variant: inferVariant(draft.background) };
      if (editingId) {
        await unwrapCommand((commands as any).updateTerminalColorScheme({ id: editingId, scheme: nextDraft }));
      } else {
        await unwrapCommand((commands as any).createTerminalColorScheme({ id: nextDraft.id, scheme: nextDraft }));
      }
      await refresh();
      selectedId = nextDraft.id;
      editingId = null;
      editorMode = "view";
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function removeSelected(entry: TerminalColorSchemeEntry) {
    if (entry.source !== "user") return;
    errorMessage = "";
    try {
      await unwrapCommand((commands as any).deleteTerminalColorScheme(entry.id));
      if (selectedId === entry.id) selectedId = "";
      if (editingId === entry.id) editingId = null;
      await refresh();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function exportSelected(entry: TerminalColorSchemeEntry) {
    errorMessage = "";
    try {
      const path = await save({
        title: `Export ${entry.scheme.name}`,
        defaultPath: `${entry.scheme.id}.toml`,
      });
      if (!path) return;
      const exportedPath = await unwrapCommand(
        commands.exportTerminalColorSchemeToPath({ id: entry.id, path }),
      );
      exportPath = exportedPath;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  function setField<K extends keyof TerminalColorScheme>(key: K, value: TerminalColorScheme[K]) {
    draft = { ...draft, [key]: value };
  }

  function cloneScheme(scheme: TerminalColorScheme): TerminalColorScheme {
    return {
      ...scheme,
      author: scheme.author,
    };
  }

  function colorValue(scheme: TerminalColorScheme, field: keyof TerminalColorScheme) {
    const value = scheme[field];
    return typeof value === "string" && value ? value : "#000000";
  }

  function inferVariant(background: string): TerminalColorSchemeVariant {
    const match = /^#?([0-9a-f]{6})$/i.exec(background.trim());
    if (!match) return "dark";
    const value = match[1];
    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    return luminance >= 0.5 ? "light" : "dark";
  }

  function sampleLineStyle(index: number) {
    const palette = [
      "foreground",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
    ] as const;
    const key = palette[index % palette.length];
    return `color: var(--scheme-${key});`;
  }

  const previewStyles = $derived(
    Object.fromEntries(
      [
        "background",
        "foreground",
        "cursor",
        "selection_background",
        "black",
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
        "white",
        "bright_black",
        "bright_red",
        "bright_green",
        "bright_yellow",
        "bright_blue",
        "bright_magenta",
        "bright_cyan",
        "bright_white",
      ].map((field) => [`--scheme-${field}`, colorValue(previewScheme, field as keyof TerminalColorScheme)]),
    ),
  );
</script>

<section class="scheme-manager">
  <header class="scheme-section-header">
    <h3>{t("terminalSchemes")}</h3>
  </header>

  <div class="scheme-panel">
    <div class="panel-title">
      <strong>{t("schemeMapping")}</strong>
    </div>
    <div class="scheme-targets">
      <label>
        <span>{t("appLightTheme")}</span>
        <select value={lightSchemeId} onchange={(event) => updateThemeMapping("light", event.currentTarget.value)}>
          {#each schemes as entry}
            <option value={entry.id}>{entry.scheme.name}</option>
          {/each}
        </select>
      </label>
      <label>
        <span>{t("appDarkTheme")}</span>
        <select value={darkSchemeId} onchange={(event) => updateThemeMapping("dark", event.currentTarget.value)}>
          {#each schemes as entry}
            <option value={entry.id}>{entry.scheme.name}</option>
          {/each}
        </select>
      </label>
    </div>
  </div>

  <div class="scheme-layout">
    <div class="scheme-list">
      <div class="scheme-list-header">
        <strong>{t("schemeLibrary")}</strong>
        <div class="scheme-actions">
          <button type="button" onclick={beginCreate}>{t("newScheme")}</button>
        </div>
      </div>
      {#if schemesQuery.isPending}
        <p class="scheme-empty">{t("settings")}</p>
      {:else}
        {#each schemes as entry}
          <button
            class:selected={editorMode === "view" && selectedId === entry.id}
            class="scheme-item"
            type="button"
            onclick={() => {
              selectedId = entry.id;
              editorMode = "view";
              editingId = null;
            }}
          >
            <span>{entry.scheme.name}</span>
            <small>{entry.id}</small>
          </button>
        {/each}
      {/if}
    </div>

    <div class="scheme-editor">
      {#if selected || editorMode !== "view"}
        <div class="editor-header">
          <div>
            <h3>{editorMode === "view" && selected ? selected.scheme.name : draft.name}</h3>
            <p>{editorMode === "view" && selected ? selected.id : draft.id}</p>
          </div>
          <div class="scheme-actions">
            {#if editorMode === "view" && selected}
              <button type="button" disabled={selected.source !== "user"} onclick={() => beginEdit(selected)}>{t("edit")}</button>
              <button type="button" onclick={() => beginCopy(selected)}>{t("copy")}</button>
              <button type="button" onclick={() => exportSelected(selected)}>{t("export")}</button>
              <button type="button" disabled={selected.source !== "user"} onclick={() => removeSelected(selected)}>{t("delete")}</button>
            {:else}
              <button type="button" onclick={saveDraft}>{editorMode === "edit" ? t("save") : t("create")}</button>
              <button type="button" onclick={cancelEdit}>{t("cancel")}</button>
            {/if}
          </div>
        </div>
      {/if}

      <div class="editor-body">
        <div class="preview" aria-label="Terminal scheme preview" style={Object.entries(previewStyles).map(([key, value]) => `${key}: ${value};`).join(" ")}>
          <div class="preview-lines">
            <div style={sampleLineStyle(0)}>Nocturne terminal preview</div>
            <div style={sampleLineStyle(1)}>alpha beta gamma delta epsilon</div>
            <div style={sampleLineStyle(2)}>0123456789 !@#$%^&*()</div>
          </div>
          <div class="swatches">
            {#each ["black","red","green","yellow","blue","magenta","cyan","white","bright_black","bright_red","bright_green","bright_yellow","bright_blue","bright_magenta","bright_cyan","bright_white"] as color}
              <span style={`background: var(--scheme-${color});`} title={color}></span>
            {/each}
          </div>
        </div>

        {#if editorMode === "view" && selected}
          <dl class="scheme-details">
            <div>
              <dt>ID</dt>
              <dd>{selected.id}</dd>
            </div>
            <div>
              <dt>{t("source")}</dt>
              <dd>{selected.source}</dd>
            </div>
            <div>
              <dt>Author</dt>
              <dd>{selected.scheme.author ?? "-"}</dd>
            </div>
          </dl>
        {:else}
          <div class="editor-form">
            <label>
              <span>ID</span>
              <input value={draft.id} oninput={(event) => setField("id", event.currentTarget.value)} />
            </label>
            <label>
              <span>Name</span>
              <input value={draft.name} oninput={(event) => setField("name", event.currentTarget.value)} />
            </label>
            <label>
              <span>Author</span>
              <input value={draft.author ?? ""} oninput={(event) => setField("author", event.currentTarget.value || null)} />
            </label>

            <div class="color-grid">
              {#each [
                "background","foreground","cursor","selection_background","black","red","green","yellow","blue","magenta","cyan","white","bright_black","bright_red","bright_green","bright_yellow","bright_blue","bright_magenta","bright_cyan","bright_white"
              ] as field}
                <label>
                  <span>{field}</span>
                  <input
                    type="color"
                    value={colorValue(draft, field as keyof TerminalColorScheme)}
                    oninput={(event) => setField(field as keyof TerminalColorScheme, event.currentTarget.value as never)}
                  />
                </label>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      {#if errorMessage}
        <p class="error">{errorMessage}</p>
      {/if}
      {#if exportPath}
        <p class="export-path">{exportPath}</p>
      {/if}
    </div>
  </div>
</section>

<style>
  .scheme-manager {
    display: grid;
    gap: 12px;
    padding: 16px 28px 20px;
    border-bottom: 1px solid var(--app-border);
    background: color-mix(in srgb, var(--app-bg) 96%, var(--app-surface));
  }

  .scheme-section-header h3 {
    margin: 0;
    font-size: 13px;
    line-height: 1.25;
    font-weight: 650;
  }

  .scheme-panel {
    display: grid;
    gap: 10px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    padding: 12px;
    background: var(--app-surface);
    box-shadow: var(--app-shadow);
  }

  .panel-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 20px;
  }

  .scheme-targets {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 260px));
    gap: 12px;
  }

  .scheme-targets label,
  .editor-form label {
    display: grid;
    gap: 6px;
    font-size: 12px;
    color: var(--app-fg);
  }

  .scheme-targets select,
  .editor-form input {
    width: 100%;
    min-width: 0;
    min-height: 30px;
    border: 1px solid var(--app-border);
    border-radius: 6px;
    padding: 6px 8px;
    background: var(--app-control);
    color: var(--app-fg);
    font: inherit;
    box-shadow: inset 0 1px 0 color-mix(in srgb, white 38%, transparent);
  }

  .scheme-targets select:focus-visible,
  .editor-form input:focus-visible,
  .scheme-actions button:focus-visible,
  .scheme-item:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--app-accent) 68%, transparent);
    outline-offset: 2px;
  }

  .scheme-layout {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }

  .scheme-list {
    border: 1px solid var(--app-border);
    border-radius: 8px;
    background: var(--app-surface);
    overflow: hidden;
    box-shadow: var(--app-shadow);
  }

  .scheme-list-header,
  .editor-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    padding: 12px;
    border-bottom: 1px solid var(--app-border);
  }

  .scheme-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .scheme-actions button {
    min-height: 28px;
    padding: 4px 10px;
    border: 1px solid var(--app-border);
    border-radius: 6px;
    background: var(--app-control);
    color: var(--app-fg);
    font: inherit;
    box-shadow: var(--app-shadow);
  }

  .scheme-actions button:hover:not(:disabled) {
    background: var(--app-control-hover);
  }

  .scheme-actions button:active:not(:disabled) {
    background: var(--app-control-pressed);
  }

  .scheme-actions button:disabled {
    color: color-mix(in srgb, var(--app-muted) 60%, transparent);
    box-shadow: none;
  }

  .scheme-item {
    width: 100%;
    display: grid;
    gap: 2px;
    padding: 10px 12px;
    text-align: left;
    border: 0;
    border-top: 1px solid var(--app-border);
    background: transparent;
    color: var(--app-fg);
    font: inherit;
  }

  .scheme-item.selected {
    background: var(--app-active);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 18%, transparent);
  }

  .scheme-item:hover:not(.selected) {
    background: var(--app-control-hover);
  }

  .scheme-item span {
    font-size: 13px;
    color: var(--app-fg);
  }

  .scheme-item small,
  .editor-header p,
  .scheme-empty,
  .error,
  .export-path {
    color: var(--app-muted);
    overflow-wrap: anywhere;
  }

  .scheme-editor {
    border: 1px solid var(--app-border);
    border-radius: 8px;
    background: var(--app-surface);
    overflow: hidden;
    box-shadow: var(--app-shadow);
  }

  .editor-body {
    display: grid;
    grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
    gap: 16px;
    padding: 12px;
  }

  .preview {
    min-width: 0;
    display: grid;
    gap: 10px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    padding: 12px;
    background: var(--scheme-background);
    color: var(--scheme-foreground);
  }

  .preview-lines {
    min-width: 0;
    display: grid;
    gap: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 13px;
    line-height: 1.4;
  }

  .preview-lines div {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .swatches {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(36px, 1fr));
    gap: 6px;
    min-width: 0;
  }

  .swatches span {
    width: 100%;
    aspect-ratio: 1;
    min-width: 0;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--app-fg) 20%, transparent);
  }

  .editor-form {
    display: grid;
    gap: 12px;
    align-content: start;
  }

  .scheme-details {
    display: grid;
    gap: 10px;
    align-content: start;
    margin: 0;
    padding: 0;
  }

  .scheme-details div {
    display: grid;
    gap: 4px;
  }

  .scheme-details dt {
    color: var(--app-muted);
    font-size: 12px;
  }

  .scheme-details dd {
    margin: 0;
    color: var(--app-fg);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .color-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    max-height: 420px;
    overflow: auto;
    padding-right: 4px;
  }

  .color-grid label {
    display: grid;
    gap: 4px;
  }

  .color-grid input[type="color"] {
    width: 100%;
    min-height: 36px;
    padding: 2px;
  }

  .error {
    margin: 0;
  }

  @media (max-width: 920px) {
    .scheme-layout,
    .editor-body,
    .scheme-targets {
      grid-template-columns: 1fr;
    }
  }
</style>
