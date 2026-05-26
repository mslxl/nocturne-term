<script lang="ts">
  import { terminalKeybindings, type KeybindingMap, type TerminalCommandId } from "$lib/terminal/keybindings";

  type Props = {
    value: KeybindingMap;
    update: (next: KeybindingMap) => void | Promise<void>;
  };

  let { value, update }: Props = $props();

  function change(command: TerminalCommandId, nextValue: string) {
    void update({ ...value, [command]: nextValue.trim() });
  }
</script>

<div class="keybindings">
  {#each terminalKeybindings as binding}
    <label>
      <span>{binding.label}</span>
      <input
        value={value[binding.command]}
        spellcheck="false"
        autocapitalize="off"
        onblur={(event) => change(binding.command, event.currentTarget.value)}
      />
    </label>
  {/each}
</div>

<style>
  .keybindings {
    display: grid;
    gap: 8px;
  }

  label {
    display: grid;
    grid-template-columns: minmax(110px, 1fr) minmax(150px, 1.2fr);
    align-items: center;
    gap: 10px;
  }

  span {
    min-width: 0;
    color: var(--settings-muted);
    font-size: 13px;
  }

  input {
    width: 100%;
  }

  @media (max-width: 680px) {
    label {
      grid-template-columns: 1fr;
      gap: 4px;
    }
  }
</style>
