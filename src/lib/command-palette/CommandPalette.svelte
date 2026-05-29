<script lang="ts">
  import { OverlayScrollbarsComponent } from "overlayscrollbars-svelte";
  import "overlayscrollbars/overlayscrollbars.css";
  import type { PaletteSearchResult } from "./search";

  type Props = {
    open: boolean;
    query: string;
    results: PaletteSearchResult[];
    selectedIndex: number;
    onQuery: (value: string) => void;
    onClose: () => void;
    onMove: (delta: number) => void;
    onRun: (item: PaletteSearchResult) => void;
  };

  let { open, query, results, selectedIndex, onQuery, onClose, onMove, onRun }: Props = $props();
  let input = $state<HTMLInputElement>();
  let selectedResult = $derived(results[selectedIndex]);

  $effect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      input?.focus({ preventScroll: true });
      input?.select();
    });
  });

  $effect(() => {
    if (!open || !selectedResult) return;
    requestAnimationFrame(() => {
      document
        .getElementById(resultElementId(selectedResult.id))
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  function resultElementId(id: string) {
    return `command-palette-result-${encodeURIComponent(id)}`;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      onMove(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMove(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = results[selectedIndex];
      if (selected && !selected.disabledReason) onRun(selected);
    }
  }
</script>

{#if open}
  <section class="command-palette" aria-label="Command Palette">
    <input
      bind:this={input}
      value={query}
      aria-label="Command Palette"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      placeholder="Command Palette"
      oninput={(event) => onQuery(event.currentTarget.value)}
      onkeydown={handleKeydown}
    />
    <OverlayScrollbarsComponent
      element="div"
      class="results"
      role="listbox"
      aria-label="Command Palette results"
      options={{
        scrollbars: {
          autoHide: "leave",
          autoHideDelay: 420,
          theme: "os-theme-nocturne",
        },
      }}
      defer
    >
      {#each results as result, index (result.id)}
        <button
          id={resultElementId(result.id)}
          class:selected={index === selectedIndex}
          class:disabled={!!result.disabledReason}
          type="button"
          role="option"
          aria-selected={index === selectedIndex}
          aria-disabled={!!result.disabledReason}
          onmouseenter={() => onMove(index - selectedIndex)}
          onclick={() => {
            if (!result.disabledReason) onRun(result);
          }}
        >
          <span class="title">{result.title}</span>
          <span class="scope">{result.disabledReason ?? result.scope}</span>
          {#if result.shortcut}
            <kbd>{result.shortcut}</kbd>
          {/if}
        </button>
      {:else}
        <p>No results</p>
      {/each}
    </OverlayScrollbarsComponent>
  </section>
{/if}

<style>
  .command-palette {
    position: absolute;
    z-index: 50;
    top: max(54px, env(safe-area-inset-top));
    left: 50%;
    width: min(620px, calc(100vw - 28px));
    transform: translateX(-50%);
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--app-fg) 16%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--app-bg) 92%, transparent);
    color: var(--app-fg);
    box-shadow: 0 18px 48px color-mix(in srgb, #000 24%, transparent);
    -webkit-backdrop-filter: blur(22px);
    backdrop-filter: blur(22px);
    user-select: none;
    -webkit-user-select: none;
  }

  input {
    width: 100%;
    height: 44px;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--app-fg) 11%, transparent);
    padding: 0 14px;
    background: color-mix(in srgb, var(--app-bg) 88%, var(--app-fg));
    color: var(--app-fg);
    font: inherit;
    font-size: 15px;
    outline: none;
  }

  .command-palette :global(.results) {
    display: grid;
    max-height: min(440px, calc(100vh - 130px));
    padding: 6px;
  }

  :global(.os-theme-nocturne.os-scrollbar) {
    --os-size: 7px;
    --os-padding-perpendicular: 2px;
    --os-padding-axis: 4px;
    --os-handle-border-radius: 999px;
    --os-handle-bg: color-mix(in srgb, var(--app-fg) 26%, transparent);
    --os-handle-bg-hover: color-mix(in srgb, var(--app-fg) 34%, transparent);
    --os-handle-bg-active: color-mix(in srgb, var(--app-fg) 42%, transparent);
  }

  button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 10px;
    align-items: center;
    min-height: 34px;
    border: 0;
    border-radius: 6px;
    padding: 0 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  button.selected {
    background: color-mix(in srgb, var(--app-fg) 12%, transparent);
  }

  button:active {
    background: color-mix(in srgb, var(--app-fg) 17%, transparent);
  }

  button.disabled {
    color: color-mix(in srgb, var(--app-fg) 46%, transparent);
  }

  .title {
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scope {
    color: color-mix(in srgb, var(--app-fg) 58%, transparent);
    font-size: 12px;
    white-space: nowrap;
  }

  kbd {
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--app-fg) 16%, transparent);
    border-radius: 5px;
    padding: 2px 5px;
    background: color-mix(in srgb, var(--app-bg) 80%, var(--app-fg));
    color: color-mix(in srgb, var(--app-fg) 72%, transparent);
    font: inherit;
    font-size: 11px;
  }

  p {
    margin: 0;
    padding: 16px 10px 18px;
    color: color-mix(in srgb, var(--app-fg) 56%, transparent);
    font-size: 13px;
  }

  @media (max-width: 680px) {
    .command-palette {
      top: max(42px, env(safe-area-inset-top));
      width: calc(100vw - 16px);
    }

    button {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    kbd {
      display: none;
    }
  }
</style>
