<script lang="ts">
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

  let selected = $state("");
  let errorMessage = $state("");
  const deletableProfiles = $derived(snapshotQuery.data?.profiles.filter((profile) => profile.name !== "default") ?? []);
  const canDelete = $derived(!!selected && selected !== "default");

  async function deleteProfile() {
    if (!canDelete) return;
    errorMessage = "";
    try {
      await unwrapCommand(commands.deleteProfile(selected));
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
    if (!selected && deletableProfiles[0]) selected = deletableProfiles[0].name;
  });

  $effect(() => {
    const root = snapshotQuery.data?.effective_config.root;
    if (!root) return;
    applyAppPreferences(root);
    setLanguage(appLanguageFromConfig(readValue(root, ["ui", "language"])));
  });
</script>

<svelte:head>
  <title>{t("deleteProfile")}</title>
</svelte:head>

<main class="dialog-root">
  <section class="dialog-body">
    <h1>{t("deleteProfile")}</h1>
    {#if deletableProfiles.length === 0}
      <p>{t("noEditableProfiles")}</p>
    {:else}
      <p>{t("deleteProfileWarning")}</p>
      <label>
        {t("deleteProfilePrompt")}
        <select bind:value={selected}>
          {#each deletableProfiles as profile}
            <option value={profile.name}>{profile.name}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if errorMessage}
      <p class="error">{errorMessage}</p>
    {/if}
  </section>
  <footer class="dialog-actions">
    <button type="button" onclick={cancel}>{t("cancel")}</button>
    <button class="danger" disabled={!canDelete} type="button" onclick={deleteProfile}>{t("delete")}</button>
  </footer>
</main>
