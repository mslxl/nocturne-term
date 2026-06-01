<script lang="ts">
  import type { ConnectionHostIcon } from "$lib/bindings";
  import HostIcon from "$lib/hosts/HostIcon.svelte";
  import {
    catalogIcon,
    genericHostIcons,
    hostIconCategories,
    hostIconLabel,
    hostIconSearchText,
    type HostIconCategory,
    type HostIconOption,
  } from "$lib/hosts/icons";
  import Plus from "~icons/lucide/plus";

  type PickerMode = "quick" | "full";

  type Props = {
    value: ConnectionHostIcon | null;
    fallbackIcon?: ConnectionHostIcon;
    mode?: PickerMode;
    disabled?: boolean;
    onChange: (icon: ConnectionHostIcon | null) => void;
    onClose?: () => void;
    onOpenFull?: () => void;
  };

  let {
    value,
    fallbackIcon = catalogIcon("lucide:server"),
    mode = "full",
    disabled = false,
    onChange,
    onClose = () => {},
    onOpenFull = () => {},
  }: Props = $props();
  let query = $state("");
  let activeCategory = $state<HostIconCategory["id"]>("generic");
  let focusedIndex = $state(0);
  let svgText = $state("");
  let error = $state("");
  const maxImageBytes = 256 * 1024;
  const categoryIcons: Record<HostIconCategory["id"], ConnectionHostIcon> = {
    generic: catalogIcon("lucide:terminal"),
    os: catalogIcon("simple-icons:linux"),
    cloud: catalogIcon("lucide:cloud"),
    database: catalogIcon("lucide:database"),
    custom: catalogIcon("lucide:upload"),
  };

  const effectiveValue = $derived(value ?? fallbackIcon);
  const fallbackCatalogId = $derived(fallbackIcon.type === "catalog" ? fallbackIcon.name : "");
  const quickIcons = $derived(genericHostIcons.filter((option) => option.id !== fallbackCatalogId));
  const selectedCatalogId = $derived(value?.type === "catalog" ? value.name : "");
  const activeIcons = $derived(filteredIcons());
  const categoryLabel = $derived(searching() ? "Search Results" : (hostIconCategories.find((category) => category.id === activeCategory)?.label ?? "Icons"));
  const selectedLabel = $derived(hostIconLabel(value));
  const selectedMeta = $derived(value?.type === "catalog" ? value.name : value ? `Custom ${value.type}` : "Default");

  function filteredIcons(): HostIconOption[] {
    const normalized = query.trim().toLowerCase();
    const icons = normalized
      ? hostIconCategories.flatMap((category) => category.icons)
      : hostIconCategories.find((category) => category.id === activeCategory)?.icons ?? [];
    if (!normalized) return icons;
    return icons.filter((option) => hostIconSearchText(option).includes(normalized));
  }

  function searching() {
    return query.trim().length > 0;
  }

  function chooseCatalog(id: string) {
    onChange(catalogIcon(id));
    error = "";
    if (mode === "quick") onClose();
  }

  function chooseDefault() {
    onChange(null);
    error = "";
    if (mode === "quick") onClose();
  }

  function selectCategory(id: HostIconCategory["id"]) {
    activeCategory = id;
    query = "";
    focusedIndex = 0;
  }

  function handleGridKeydown(event: KeyboardEvent) {
    if (activeIcons.length === 0) return;
    const columns = Math.max(1, Math.floor(((event.currentTarget as HTMLElement).clientWidth || 40) / 40));
    let next = focusedIndex;
    if (event.key === "ArrowRight") next += 1;
    else if (event.key === "ArrowLeft") next -= 1;
    else if (event.key === "ArrowDown") next += columns;
    else if (event.key === "ArrowUp") next -= columns;
    else if (event.key === "Enter") chooseCatalog(activeIcons[focusedIndex]?.id ?? activeIcons[0].id);
    else if (event.key === "Escape") onClose();
    else return;
    event.preventDefault();
    focusedIndex = Math.min(activeIcons.length - 1, Math.max(0, next));
  }

  function applySvg() {
    const svg = svgText.trim();
    if (!svg) {
      error = "SVG cannot be empty.";
      return;
    }
    if (!svg.toLowerCase().includes("<svg")) {
      error = "SVG must contain an <svg> element.";
      return;
    }
    onChange({ type: "svg", svg });
    error = "";
  }

  async function importIconFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")) {
      svgText = await file.text();
      applySvg();
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      error = "Choose a PNG, JPEG, WebP, or SVG file.";
      return;
    }
    if (file.size > maxImageBytes) {
      error = "Image icons must be 256 KB or smaller.";
      return;
    }
    const dataBase64 = await readBase64(file);
    onChange({ type: "image", mime: file.type, data_base64: dataBase64 });
    error = "";
  }

  function readBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read icon file."));
      reader.onload = () => {
        const result = String(reader.result);
        const marker = ";base64,";
        const index = result.indexOf(marker);
        if (index < 0) {
          reject(new Error("Icon file did not produce base64 data."));
          return;
        }
        resolve(result.slice(index + marker.length));
      };
      reader.readAsDataURL(file);
    });
  }
</script>

<div class="icon-picker" class:disabled>
  {#if mode === "quick"}
    <div class="picker-panel quick-panel">
      <div class="quick-icons" role="grid" aria-label="Quick icon choices">
        <button
          class:selected={!value}
          type="button"
          disabled={disabled}
          title={`Default (${hostIconLabel(fallbackIcon)})`}
          aria-label={`Default (${hostIconLabel(fallbackIcon)})`}
          onclick={chooseDefault}
        >
          <HostIcon icon={fallbackIcon} />
        </button>
        {#each quickIcons as option}
          <button
            class:selected={selectedCatalogId === option.id}
            type="button"
            disabled={disabled}
            title={`${option.label} (${option.id})`}
            aria-label={`${option.label} (${option.id})`}
            onclick={() => chooseCatalog(option.id)}
          >
            <HostIcon icon={catalogIcon(option.id)} />
          </button>
        {/each}
        <button class="more-button" type="button" disabled={disabled} title="More icons" aria-label="More icons" onclick={onOpenFull}>
          <Plus />
        </button>
      </div>
    </div>
  {:else}
    <div class="picker-panel full-panel">
      <div class="picker-toolbar">
      <div class="search-shell">
        <input
          value={query}
          placeholder="Search icons"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          disabled={disabled}
          oninput={(event) => {
            query = event.currentTarget.value;
            focusedIndex = 0;
          }}
        />
      </div>
        <button class="done-button" type="button" onclick={onClose}>Done</button>
      </div>
      <div class="category-tabs" role="tablist" aria-label="Icon categories">
        {#each hostIconCategories as category}
          <button
            class:active={activeCategory === category.id}
            type="button"
            role="tab"
            aria-selected={activeCategory === category.id}
            disabled={disabled}
            title={category.label}
            aria-label={category.label}
            onclick={() => selectCategory(category.id)}
          >
            <HostIcon icon={categoryIcons[category.id]} size="small" framed={false} />
          </button>
        {/each}
      </div>

      {#if activeCategory === "custom" && !query.trim()}
        <div class="custom-icon">
          <label class="file-button">
            <span>Import Image or SVG</span>
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg" disabled={disabled} onchange={importIconFile} />
          </label>
          <textarea
            rows="5"
            bind:value={svgText}
            disabled={disabled}
            placeholder="<svg ...>"
          ></textarea>
          <button class="use-svg" type="button" disabled={disabled} onclick={applySvg}>Use SVG</button>
        </div>
      {:else}
        <div class="icon-grid" role="grid" aria-label={categoryLabel} tabindex="0" onkeydown={handleGridKeydown}>
          <div class="category-label">{categoryLabel}</div>
          {#each activeIcons as option, index}
            <button
              class:selected={selectedCatalogId === option.id}
              class:focused={focusedIndex === index}
              type="button"
              disabled={disabled}
              title={`${option.label} (${option.id})`}
              aria-label={`${option.label} (${option.id})`}
              onmouseenter={() => (focusedIndex = index)}
              onclick={() => chooseCatalog(option.id)}
            >
              <HostIcon icon={catalogIcon(option.id)} />
            </button>
          {:else}
            <p>No icons</p>
          {/each}
        </div>
      {/if}

      {#if error}
        <p class="picker-error">{error}</p>
      {/if}
      <footer class="picker-preview">
        <HostIcon icon={effectiveValue} size="large" />
        <span>
          <strong>{selectedLabel}</strong>
          <small>{selectedMeta}</small>
        </span>
      </footer>
    </div>
  {/if}
</div>

<style>
  .icon-picker {
    position: relative;
    min-width: 0;
    width: max-content;
    --picker-bg: color-mix(in srgb, var(--hosts-control, #fff) 96%, var(--hosts-bg, #f5f5f5));
    --picker-border: color-mix(in srgb, var(--hosts-border, currentColor) 86%, transparent);
    --picker-muted: color-mix(in srgb, currentColor 58%, transparent);
    --picker-hover: color-mix(in srgb, var(--hosts-active, currentColor) 42%, transparent);
    --picker-selected: color-mix(in srgb, var(--hosts-active, currentColor) 78%, var(--hosts-control, transparent));
  }

  .picker-panel {
    position: relative;
    z-index: 30;
    width: 350px;
    max-width: min(350px, calc(100vw - 32px));
    overflow: hidden;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto auto;
    border: 1px solid var(--picker-border);
    border-radius: 8px;
    background: var(--picker-bg);
    box-shadow: 0 16px 42px color-mix(in srgb, #000 26%, transparent);
    animation: picker-enter 0.16s ease-out;
  }

  .quick-panel {
    width: auto;
    max-width: none;
    grid-template-rows: auto;
    padding: 6px;
  }

  .full-panel {
    grid-template-rows: auto auto minmax(0, 1fr) auto auto;
  }

  .quick-icons {
    display: flex;
    gap: 2px;
  }

  .quick-icons button {
    min-width: 0;
    width: 34px;
    height: 34px;
    min-height: 34px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 8px;
    padding: 4px;
    background: transparent;
    color: inherit;
    transition:
      background-color 0.14s ease-out,
      transform 0.18s cubic-bezier(0.175, 0.885, 0.32, 1.35);
  }

  .quick-icons button:hover:not(:disabled),
  .quick-icons button:focus-visible:not(:disabled) {
    background: var(--picker-hover);
    transform: scale(1.12);
  }

  .quick-icons button.selected {
    background: var(--picker-selected);
  }

  .quick-icons .more-button {
    margin-left: 4px;
    border-left: 1px solid var(--picker-border);
    border-radius: 0 8px 8px 0;
  }

  .quick-icons .more-button :global(svg) {
    width: 18px;
    height: 18px;
  }

  .picker-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 7px;
    padding: 10px 10px 8px;
  }

  .search-shell {
    min-width: 0;
  }

  .search-shell input,
  .custom-icon textarea {
    min-width: 0;
    width: 100%;
  }

  .search-shell input {
    height: 36px;
    border: 1px solid color-mix(in srgb, var(--picker-border) 65%, transparent);
    border-radius: 8px;
    padding: 0 30px;
    background: color-mix(in srgb, var(--hosts-bg, #f5f5f5) 82%, var(--hosts-control, #fff));
    color: inherit;
    font: inherit;
    outline: none;
    transition:
      border-color 0.12s ease-out,
      background-color 0.12s ease-out;
  }

  .done-button {
    min-width: 64px;
    height: 32px;
    min-height: 32px;
  }

  .search-shell input:focus {
    border-color: color-mix(in srgb, var(--hosts-active, currentColor) 72%, currentColor);
    background: color-mix(in srgb, var(--hosts-control, #fff) 94%, var(--hosts-bg, #f5f5f5));
  }

  .category-tabs {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 4px;
    padding: 0 5px 5px;
    border-bottom: 1px solid var(--picker-border);
  }

  .category-tabs button {
    min-width: 0;
    width: 100%;
    height: 30px;
    min-height: 30px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 6px;
    padding: 0;
    background: transparent;
    color: var(--picker-muted);
    font-size: 13px;
    font-weight: 700;
    transition:
      background-color 0.14s ease-out,
      color 0.14s ease-out,
      transform 0.18s cubic-bezier(0.175, 0.885, 0.32, 1.35);
  }

  .category-tabs button:hover:not(:disabled) {
    background: var(--picker-hover);
    color: inherit;
    transform: translateY(-1px);
  }

  .category-tabs button.active {
    background: var(--picker-selected);
    color: inherit;
  }

  .icon-grid {
    min-height: 154px;
    max-height: 254px;
    display: grid;
    grid-template-columns: repeat(auto-fill, 40px);
    grid-auto-rows: 40px;
    justify-content: start;
    align-content: start;
    gap: 0;
    padding: 0 8px 8px;
    overflow: auto;
    outline: none;
  }

  .category-label {
    position: sticky;
    z-index: 1;
    top: 0;
    grid-column: 1 / -1;
    height: 34px;
    display: flex;
    align-items: center;
    padding: 0 2px;
    background: color-mix(in srgb, var(--picker-bg) 86%, transparent);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    color: var(--picker-muted);
    font-size: 12px;
    font-weight: 700;
  }

  .icon-grid button {
    min-width: 0;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 8px;
    padding: 3px;
    background: transparent;
    transition:
      background-color 0.14s ease-out,
      transform 0.18s cubic-bezier(0.175, 0.885, 0.32, 1.35);
  }

  .icon-grid button:hover:not(:disabled),
  .icon-grid button.focused:not(:disabled) {
    background: var(--picker-hover);
    transform: scale(1.16);
  }

  .icon-grid button:active:not(:disabled) {
    transform: scale(1.04);
  }

  .icon-grid button.selected {
    background: var(--picker-selected);
  }

  .custom-icon {
    display: grid;
    gap: 9px;
    padding: 10px;
    border-bottom: 1px solid var(--picker-border);
  }

  .file-button {
    display: inline-grid;
    grid-template-columns: 1fr;
    width: max-content;
    min-height: 28px;
    align-items: center;
    border: 1px solid var(--hosts-border, currentColor);
    border-radius: 6px;
    padding: 4px 10px;
    background: var(--hosts-control, transparent);
    font-size: 13px;
  }

  .custom-icon textarea {
    min-height: 104px;
    border: 1px solid var(--picker-border);
    border-radius: 8px;
    padding: 8px;
    background: color-mix(in srgb, var(--hosts-bg, #f5f5f5) 82%, var(--hosts-control, #fff));
    color: inherit;
    font: inherit;
    resize: vertical;
  }

  .use-svg {
    justify-self: start;
  }

  .file-button input {
    display: none;
  }

  .picker-error {
    margin: 0;
    padding: 8px 10px 0;
    color: var(--hosts-danger, #a92727);
    font-size: 12px;
  }

  .picker-preview {
    min-width: 0;
    height: 60px;
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    border-top: 1px solid var(--picker-border);
    padding: 9px 10px;
    color: inherit;
  }

  .picker-preview span,
  .picker-preview strong,
  .picker-preview small {
    min-width: 0;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .picker-preview strong {
    font-size: 13px;
  }

  .picker-preview small {
    color: var(--picker-muted);
    font-size: 11px;
  }

  @keyframes picker-enter {
    from {
      opacity: 0;
      transform: scale(0.985) translateY(-3px);
    }

    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .picker-panel,
    .category-tabs button,
    .icon-grid button,
    .quick-icons button {
      animation: none;
      transition: none;
    }

    .category-tabs button:hover:not(:disabled),
    .icon-grid button:hover:not(:disabled),
    .icon-grid button.focused:not(:disabled),
    .quick-icons button:hover:not(:disabled),
    .quick-icons button:focus-visible:not(:disabled) {
      transform: none;
    }
  }
</style>
