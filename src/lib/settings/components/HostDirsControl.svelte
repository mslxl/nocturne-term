<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";

  type Props = {
    dirs: string[];
    label?: string;
    mode?: "directory" | "file";
    update: (dirs: string[]) => void | Promise<void>;
  };

  let { dirs, label = "Paths", mode = "directory", update }: Props = $props();
  let selected = $state("");

  async function addPaths() {
    const chosen = await open({
      directory: mode === "directory",
      multiple: true,
    });
    if (chosen === null) return;
    const selectedDirs = Array.isArray(chosen) ? chosen : [chosen];
    const next = [...dirs];
    for (const dir of selectedDirs) {
      if (!next.includes(dir)) next.push(dir);
    }
    await update(next);
    selected = selectedDirs[selectedDirs.length - 1] ?? selected;
  }

  async function removeSelected() {
    if (!selected) return;
    const next = dirs.filter((dir) => dir !== selected);
    await update(next);
    selected = next[0] ?? "";
  }

  $effect(() => {
    if (selected && dirs.includes(selected)) return;
    selected = dirs[0] ?? "";
  });
</script>

<div class="host-dirs">
  <div class="host-dir-list" role="listbox" aria-label={label} tabindex="0">
    {#each dirs as dir}
      <button
        class:selected={selected === dir}
        type="button"
        role="option"
        aria-selected={selected === dir}
        onclick={() => (selected = dir)}
      >
        {dir}
      </button>
    {/each}
  </div>

  <div class="host-dir-actions">
    <button type="button" aria-label={`Add ${label}`} title={`Add ${label}`} onclick={addPaths}>+</button>
    <button
      type="button"
      aria-label="Remove selected host directory"
      title="Remove selected host directory"
      disabled={!selected}
      onclick={removeSelected}
    >
      -
    </button>
  </div>
</div>

<style>
  .host-dirs {
    width: min(100%, 420px);
    display: grid;
    grid-template-columns: minmax(0, 1fr) 34px;
    gap: 8px;
  }

  .host-dir-list {
    min-height: 92px;
    max-height: 150px;
    overflow: auto;
    display: grid;
    align-content: start;
    border: 1px solid var(--settings-border);
    border-radius: 6px;
    background: var(--settings-control);
  }

  .host-dir-list:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--settings-accent) 72%, transparent);
    outline-offset: 2px;
  }

  button {
    appearance: none;
    border: 0;
    color: inherit;
    font: inherit;
    background: transparent;
  }

  .host-dir-list button {
    min-width: 0;
    min-height: 28px;
    padding: 5px 8px;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .host-dir-list button.selected {
    background: color-mix(in srgb, var(--settings-accent) 20%, var(--settings-control));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--settings-accent) 44%, transparent);
  }

  .host-dir-list button:active {
    background: color-mix(in srgb, var(--settings-accent) 28%, var(--settings-control));
  }

  .host-dir-actions {
    display: grid;
    gap: 6px;
    align-content: start;
  }

  .host-dir-actions button {
    width: 34px;
    height: 30px;
    display: grid;
    place-items: center;
    border: 1px solid var(--settings-border);
    border-radius: 6px;
    background: color-mix(in srgb, var(--settings-control) 88%, var(--settings-bg));
    font-size: 18px;
    line-height: 1;
  }

  .host-dir-actions button:disabled {
    color: color-mix(in srgb, var(--settings-muted) 62%, transparent);
  }

  .host-dir-actions button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--settings-accent) 72%, transparent);
    outline-offset: 2px;
  }

  .host-dir-actions button:active:not(:disabled) {
    background: color-mix(in srgb, var(--settings-accent) 18%, var(--settings-control));
  }

  @media (max-width: 640px) {
    .host-dirs {
      width: 100%;
    }
  }
</style>
