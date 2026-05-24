<script lang="ts">
  type Option = {
    value: string;
    label: string;
  };

  type Props = {
    value: string;
    options: Option[];
    update: (value: string) => void | Promise<void>;
  };

  let { value, options, update }: Props = $props();
</script>

<div class="segmented" role="group">
  {#each options as option}
    <button
      class:active={value === option.value}
      type="button"
      aria-pressed={value === option.value}
      onclick={() => update(option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>

<style>
  .segmented {
    display: inline-flex;
    max-width: 100%;
    padding: 2px;
    border: 1px solid var(--settings-border);
    border-radius: 7px;
    background: color-mix(in srgb, var(--settings-control) 82%, var(--settings-bg));
  }

  button {
    appearance: none;
    border: 0;
    min-height: 26px;
    padding: 3px 10px;
    border-radius: 5px;
    color: inherit;
    font: inherit;
    white-space: nowrap;
    background: transparent;
  }

  button.active {
    background: color-mix(in srgb, var(--settings-accent) 18%, var(--settings-control));
    color: var(--settings-fg);
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--settings-accent) 44%, transparent),
      0 1px 1px color-mix(in srgb, black 12%, transparent);
  }

  button:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--settings-accent) 72%, transparent);
    outline-offset: 1px;
  }

  button:active {
    background: color-mix(in srgb, var(--settings-accent) 26%, var(--settings-control));
  }

  @media (max-width: 640px) {
    .segmented {
      justify-self: start;
      overflow: auto;
    }
  }
</style>
