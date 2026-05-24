<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { commands } from "$lib/bindings";
  import { applyAppPreferences, appLanguageFromConfig, readValue } from "$lib/config/document";
  import { setLanguage, t } from "$lib/i18n";
  import { unwrapCommand } from "$lib/terminal/commands";
  import "../dialog.css";

  const queryClient = useQueryClient();
  const snapshotQuery = createQuery(() => ({
    queryKey: ["config", "snapshot"],
    queryFn: () => unwrapCommand(commands.getConfigSnapshot()),
  }));

  let name = $state("");
  let errorMessage = $state("");
  let nameInput: HTMLInputElement;
  const canCreate = $derived(name.trim().length > 0 && !snapshotQuery.data?.profiles.some((profile) => profile.name === name.trim()));

  async function createProfile() {
    if (!canCreate) return;
    errorMessage = "";
    try {
      await unwrapCommand(commands.createProfile({ name: name.trim(), document: { root: { values: {} } } }));
      await unwrapCommand(commands.setActiveProfile(name.trim()));
      await unwrapCommand(commands.refreshAppMenu());
      await queryClient.invalidateQueries({ queryKey: ["config"] });
      await getCurrentWindow().close();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
  }

  function cancel() {
    void getCurrentWindow().close();
  }

  $effect(() => {
    const root = snapshotQuery.data?.effective_config.root;
    if (!root) return;
    applyAppPreferences(root);
    setLanguage(appLanguageFromConfig(readValue(root, ["ui", "language"])));
  });

  onMount(() => {
    nameInput.focus();
  });
</script>

<svelte:head>
  <title>{t("newProfile")}</title>
</svelte:head>

<main class="dialog-root">
  <section class="dialog-body">
    <h1>{t("newProfile")}</h1>
    <p>{t("profileInheritedHint")}</p>
    <label>
      {t("profileName")}
      <input bind:this={nameInput} bind:value={name} onkeydown={(event) => event.key === "Enter" && createProfile()} />
    </label>
    {#if errorMessage}
      <p class="error">{errorMessage}</p>
    {/if}
  </section>
  <footer class="dialog-actions">
    <button type="button" onclick={cancel}>{t("cancel")}</button>
    <button class="primary" disabled={!canCreate} type="button" onclick={createProfile}>{t("create")}</button>
  </footer>
</main>
