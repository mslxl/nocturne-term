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
    display: inline-grid;
    place-items: center;
  }

  input {
    position: absolute;
    opacity: 0;
  }

  span {
    width: 38px;
    height: 22px;
    display: block;
    border-radius: 999px;
    background: var(--settings-border);
  }

  span::after {
    content: "";
    width: 18px;
    height: 18px;
    display: block;
    margin: 2px;
    border-radius: 50%;
    background: var(--settings-control);
    transition: transform 120ms ease;
  }

  input:checked + span {
    background: var(--settings-accent);
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
</style>
