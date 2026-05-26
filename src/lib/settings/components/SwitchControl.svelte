<script lang="ts">
  type Props = {
    checked: boolean;
    update: (checked: boolean) => void | Promise<void>;
  };

  let { checked, update }: Props = $props();
</script>

<label class="switch">
  <input {checked} type="checkbox" onchange={(event) => update(event.currentTarget.checked)} />
  <span></span>
</label>

<style>
  .switch {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 38px;
    height: 22px;
    cursor: pointer;
  }

  input {
    position: absolute;
    opacity: 0;
    inset: 0;
    margin: 0;
    cursor: pointer;
  }

  span {
    width: 38px;
    height: 22px;
    display: block;
    pointer-events: none;
    border: 1px solid color-mix(in srgb, var(--settings-border) 84%, var(--settings-fg));
    border-radius: 999px;
    background: color-mix(in srgb, var(--settings-border) 72%, var(--settings-control));
    transition:
      background 120ms ease,
      border-color 120ms ease;
  }

  span::after {
    content: "";
    width: 18px;
    height: 18px;
    display: block;
    margin: 1px;
    border-radius: 50%;
    background: var(--settings-control);
    box-shadow: var(--app-shadow);
    transition: transform 120ms ease;
  }

  input:checked + span {
    background: var(--settings-accent);
    border-color: color-mix(in srgb, var(--settings-accent) 88%, var(--settings-fg));
  }

  input:checked + span::after {
    transform: translateX(16px);
  }

  input:focus-visible + span {
    outline: 2px solid color-mix(in srgb, var(--settings-accent) 72%, transparent);
    outline-offset: 2px;
  }

  input:active + span::after {
    transform: scale(0.94);
  }

  input:checked:active + span::after {
    transform: translateX(16px) scale(0.94);
  }

  @media (hover: hover) {
    .switch:hover span {
      background: color-mix(in srgb, var(--settings-border) 70%, var(--settings-accent));
    }
  }
</style>
