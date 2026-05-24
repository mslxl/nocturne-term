<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    help?: string;
    meta?: string;
    inherited?: boolean;
    children: Snippet;
  };

  let { title, help, meta, inherited = false, children }: Props = $props();
</script>

<section class:inherited class="setting-row">
  <div>
    <h3>{title}</h3>
    {#if help}
      <p>{help}</p>
    {/if}
    {#if meta}
      <small>{meta}</small>
    {/if}
  </div>

  <div class="control">
    {@render children()}
  </div>
</section>

<style>
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

  h3,
  p {
    margin: 0;
  }

  h3 {
    font-size: 13px;
    line-height: 1.25;
    font-weight: 520;
  }

  p,
  small {
    margin-top: 4px;
    color: var(--settings-muted);
    font-size: 12px;
    line-height: 1.35;
  }

  .control {
    display: grid;
    justify-items: end;
    gap: 8px;
  }

  @media (max-width: 640px) {
    .setting-row {
      grid-template-columns: 1fr;
      gap: 10px;
      padding: 14px 16px;
    }

    .control {
      justify-items: stretch;
    }
  }
</style>
