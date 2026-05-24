<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { commands } from "$lib/bindings";
  import {
    applyAppPreferences,
    appLanguageFromConfig,
    cloneDocument,
    hasValue,
    readValue,
    type ConfigDocument,
  } from "$lib/config/document";
  import { setLanguage, t } from "$lib/i18n";
  import { saveConfigValue } from "$lib/settings/save";
  import { settingCategories, settingsSchema, type SettingCategoryId, type SettingDefinition } from "$lib/settings/schema";
  import { hasTauriRuntime } from "$lib/tauri/runtime";
  import { unwrapCommand } from "$lib/terminal/commands";

  type Mode = "main" | "profile";

  const queryClient = useQueryClient();
  const snapshotQuery = createQuery(() => ({
    queryKey: ["config", "snapshot"],
    queryFn: () => unwrapCommand(commands.getConfigSnapshot()),
  }));

  let mode = $state<Mode>("main");
  let activeCategory = $state<SettingCategoryId>("appearance");
  let narrowDetail = $state<SettingCategoryId | null>(null);
  let errorMessage = $state("");
  let unlistenConfig: undefined | (() => void);
  let unlistenNavigate: undefined | (() => void);

  const snapshot = $derived(snapshotQuery.data);
  const effectiveRoot = $derived(snapshot?.effective_config.root);
  const activeProfile = $derived(snapshot?.root.active_profile ?? "");
  const editableDocument = $derived<ConfigDocument | null>(
    snapshot ? (mode === "main" ? snapshot.main_config : snapshot.profile_config) : null,
  );
  const visibleCategories = $derived(
    mode === "main" ? settingCategories : settingCategories.filter((category) => category.id !== "profiles"),
  );
  const activeSettings = $derived(settingsSchema.filter((setting) => setting.category === activeCategory));
  const pageTitle = $derived(mode === "main" ? t("mainSettings") : `${t("profileSettings")}: ${activeProfile}`);

  function parseModeFromLocation() {
    const params = new URLSearchParams(window.location.search);
    mode = params.get("mode") === "profile" ? "profile" : "main";
  }

  function navigateTo(route: string) {
    const url = new URL(route, window.location.origin);
    mode = url.searchParams.get("mode") === "profile" ? "profile" : "main";
    history.replaceState(null, "", `${url.pathname}${url.search}`);
    narrowDetail = null;
  }

  function selectCategory(category: SettingCategoryId) {
    activeCategory = category;
    narrowDetail = category;
  }

  function inherited(setting: SettingDefinition) {
    if (!editableDocument || mode !== "profile") return false;
    return !hasValue(editableDocument.root, setting.path);
  }

  function settingValue(setting: SettingDefinition) {
    if (!editableDocument || !effectiveRoot) return setting.defaultValue;
    if (mode === "profile" && !hasValue(editableDocument.root, setting.path)) {
      return setting.get(effectiveRoot);
    }
    return setting.get(editableDocument.root);
  }

  async function updateSetting(setting: SettingDefinition, value: unknown) {
    if (!editableDocument) return;
    errorMessage = "";
    try {
      await saveConfigValue(
        { kind: mode, profile: activeProfile },
        cloneDocument(editableDocument),
        setting.path,
        setting.toConfigValue(value),
      );
      await queryClient.invalidateQueries({ queryKey: ["config"] });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function useDefault(setting: SettingDefinition) {
    if (!editableDocument || mode !== "profile") return;
    errorMessage = "";
    try {
      await saveConfigValue({ kind: "profile", profile: activeProfile }, editableDocument, setting.path, undefined);
      await queryClient.invalidateQueries({ queryKey: ["config"] });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  async function switchProfile(name: string) {
    errorMessage = "";
    try {
      await unwrapCommand(commands.setActiveProfile(name));
      await queryClient.invalidateQueries({ queryKey: ["config"] });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  $effect(() => {
    if (!effectiveRoot) return;
    applyAppPreferences(effectiveRoot);
    setLanguage(appLanguageFromConfig(readValue(effectiveRoot, ["ui", "language"])));
  });

  onMount(() => {
    parseModeFromLocation();
    if (!hasTauriRuntime()) return;
    void listen("config://changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      void unwrapCommand(commands.refreshAppMenu()).catch((error) => {
        errorMessage = error instanceof Error ? error.message : String(error);
      });
    }).then((dispose) => {
      unlistenConfig = dispose;
    });
    void listen<string>("settings://navigate", (event) => navigateTo(event.payload)).then((dispose) => {
      unlistenNavigate = dispose;
    });
    return () => {
      unlistenConfig?.();
      unlistenNavigate?.();
    };
  });
</script>

<svelte:head>
  <title>{pageTitle}</title>
</svelte:head>

<main class="settings-shell">
  <aside class:narrow-hidden={narrowDetail} class="sidebar" aria-label={t("categories")}>
    <header>
      <h1>{pageTitle}</h1>
      {#if mode === "profile"}
        <p>{t("profileInheritedHint")}</p>
      {/if}
    </header>
    <nav>
      {#each visibleCategories as category}
        <button class:active={activeCategory === category.id} type="button" onclick={() => selectCategory(category.id)}>
          {t(category.label)}
        </button>
      {/each}
    </nav>
  </aside>

  <section class:detail-open={narrowDetail} class="detail">
    <button class="back" type="button" onclick={() => (narrowDetail = null)}>{t("back")}</button>
    <header class="detail-header">
      <div>
        <h2>{t(visibleCategories.find((category) => category.id === activeCategory)?.label ?? "settings")}</h2>
        {#if mode === "profile"}
          <p>{activeProfile}</p>
        {/if}
      </div>
    </header>

    {#if errorMessage}
      <p class="error">{errorMessage}</p>
    {/if}

    {#if snapshotQuery.isPending}
      <div class="empty">{t("settings")}</div>
    {:else if snapshotQuery.error}
      <p class="error">{snapshotQuery.error.message}</p>
    {:else}
      <div class="settings-list">
        {#if activeCategory === "profiles" && snapshot}
          <section class="setting-row">
            <div>
              <h3>{t("activeProfile")}</h3>
            </div>
            <select value={snapshot.root.active_profile} onchange={(event) => switchProfile(event.currentTarget.value)}>
              {#each snapshot.profiles as profile}
                <option value={profile.name}>{profile.name}</option>
              {/each}
            </select>
          </section>
        {/if}

        {#each activeSettings as setting}
          {@const value = settingValue(setting)}
          {@const isInherited = inherited(setting)}
          <section class:inherited={isInherited} class="setting-row">
            <div>
              <h3>{t(setting.label)}</h3>
              {#if setting.help}
                <p>{t(setting.help)}</p>
              {/if}
              {#if isInherited}
                <small>{t("inherited")}</small>
              {:else if mode === "profile"}
                <small>{t("overridden")}</small>
              {/if}
            </div>

            <div class="control">
              {#if setting.kind === "select"}
                <div class="segmented">
                  {#each setting.options ?? [] as option}
                    <button class:active={String(value) === option.value} type="button" onclick={() => updateSetting(setting, option.value)}>
                      {t(option.label)}
                    </button>
                  {/each}
                </div>
              {:else if setting.kind === "boolean"}
                <label class="switch">
                  <input checked={Boolean(value)} type="checkbox" onchange={(event) => updateSetting(setting, event.currentTarget.checked)} />
                  <span></span>
                </label>
              {:else if setting.kind === "textarea"}
                <textarea value={String(value)} rows="4" onblur={(event) => updateSetting(setting, event.currentTarget.value)}></textarea>
              {:else}
                <input
                  min={setting.min}
                  step={setting.step}
                  type={setting.kind === "text" ? "text" : "number"}
                  value={String(value)}
                  onblur={(event) => updateSetting(setting, setting.kind === "text" ? event.currentTarget.value : Number(event.currentTarget.value))}
                />
              {/if}
              {#if mode === "profile" && !isInherited}
                <button class="default-button" type="button" onclick={() => useDefault(setting)}>{t("useDefault")}</button>
              {/if}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  </section>
</main>

<style>
  :global(:root) {
    color-scheme: light dark;
    --settings-bg: #f5f5f5;
    --settings-fg: #1e1e1e;
    --settings-muted: #6d6d6d;
    --settings-border: #d7d7d7;
    --settings-control: #ffffff;
    --settings-active: #dce8fb;
    --settings-danger: #a92727;
  }

  :global(:root[data-theme="dark"]) {
    --settings-bg: #202124;
    --settings-fg: #eeeeee;
    --settings-muted: #a7a7a7;
    --settings-border: #3d3f43;
    --settings-control: #2b2d31;
    --settings-active: #34445f;
    --settings-danger: #ffb5b5;
  }

  :global(body) {
    margin: 0;
    background: var(--settings-bg);
    color: var(--settings-fg);
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow: hidden;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .settings-shell {
    width: 100vw;
    height: 100vh;
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
  }

  .sidebar {
    min-width: 0;
    border-right: 1px solid var(--settings-border);
    background: color-mix(in srgb, var(--settings-bg) 86%, var(--settings-control));
    user-select: none;
    -webkit-user-select: none;
  }

  .sidebar header {
    padding: 22px 18px 12px;
  }

  h1,
  h2,
  h3,
  p {
    margin: 0;
  }

  h1 {
    font-size: 20px;
    line-height: 1.2;
    font-weight: 650;
  }

  .sidebar p,
  .detail-header p,
  .setting-row p,
  small {
    margin-top: 4px;
    color: var(--settings-muted);
    font-size: 12px;
    line-height: 1.35;
  }

  nav {
    display: grid;
    padding: 8px;
  }

  nav button,
  .back,
  .default-button,
  .segmented button {
    appearance: none;
    border: 0;
    color: inherit;
    font: inherit;
    background: transparent;
  }

  nav button {
    min-height: 32px;
    padding: 6px 10px;
    border-radius: 6px;
    text-align: left;
  }

  nav button.active {
    background: var(--settings-active);
  }

  .detail {
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .detail-header {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 22px 28px 14px;
    border-bottom: 1px solid var(--settings-border);
    background: color-mix(in srgb, var(--settings-bg) 96%, transparent);
  }

  h2 {
    font-size: 17px;
    line-height: 1.25;
    font-weight: 650;
  }

  .settings-list {
    max-width: 860px;
  }

  .setting-row {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(260px, 1.25fr);
    gap: 20px;
    align-items: center;
    padding: 16px 28px;
    border-bottom: 1px solid var(--settings-border);
  }

  .setting-row.inherited {
    color: color-mix(in srgb, var(--settings-fg) 72%, transparent);
  }

  h3 {
    font-size: 13px;
    line-height: 1.25;
    font-weight: 520;
  }

  .control {
    display: grid;
    justify-items: end;
    gap: 8px;
  }

  input,
  textarea,
  select {
    width: min(100%, 360px);
    border: 1px solid var(--settings-border);
    border-radius: 6px;
    padding: 6px 8px;
    background: var(--settings-control);
    color: var(--settings-fg);
    font: inherit;
  }

  textarea {
    resize: vertical;
    min-height: 80px;
  }

  .segmented {
    display: inline-flex;
    max-width: 100%;
    padding: 2px;
    border: 1px solid var(--settings-border);
    border-radius: 7px;
    background: color-mix(in srgb, var(--settings-control) 86%, var(--settings-bg));
  }

  .segmented button {
    min-height: 26px;
    padding: 3px 10px;
    border-radius: 5px;
    white-space: nowrap;
  }

  .segmented button.active {
    background: var(--settings-control);
  }

  .switch input {
    position: absolute;
    opacity: 0;
  }

  .switch span {
    width: 38px;
    height: 22px;
    display: block;
    border-radius: 999px;
    background: var(--settings-border);
  }

  .switch span::after {
    content: "";
    width: 18px;
    height: 18px;
    display: block;
    margin: 2px;
    border-radius: 50%;
    background: var(--settings-control);
    transition: transform 120ms ease;
  }

  .switch input:checked + span {
    background: #3d7dd8;
  }

  .switch input:checked + span::after {
    transform: translateX(16px);
  }

  .default-button,
  .back {
    min-height: 26px;
    padding: 3px 9px;
    border-radius: 6px;
    color: var(--settings-fg);
    background: color-mix(in srgb, var(--settings-control) 88%, var(--settings-bg));
  }

  .back {
    display: none;
    margin: 12px 16px 0;
  }

  .error {
    margin: 12px 28px;
    color: var(--settings-danger);
    overflow-wrap: anywhere;
  }

  .empty {
    padding: 28px;
    color: var(--settings-muted);
  }

  @media (max-width: 640px) {
    .settings-shell {
      display: block;
    }

    .sidebar {
      width: 100vw;
      height: 100vh;
      border-right: 0;
    }

    .sidebar.narrow-hidden {
      display: none;
    }

    .detail {
      display: none;
      width: 100vw;
      height: 100vh;
    }

    .detail.detail-open {
      display: block;
    }

    .back {
      display: inline-block;
    }

    .setting-row {
      grid-template-columns: 1fr;
      gap: 10px;
      padding: 14px 16px;
    }

    .control {
      justify-items: stretch;
    }

    input,
    textarea,
    select {
      width: 100%;
    }
  }
</style>
