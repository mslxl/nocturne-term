export class TerminalRuntimeCreationGate {
  #pending = new Map<string, Promise<void>>();

  ensure(toolTabId: string, hasRuntime: () => boolean, createRuntime: () => Promise<void>): Promise<void> {
    if (!toolTabId.trim()) {
      throw new Error("terminal ToolTab id is required");
    }
    if (hasRuntime()) return Promise.resolve();

    const existing = this.#pending.get(toolTabId);
    if (existing) return existing;

    const pending = (async () => {
      if (!hasRuntime()) {
        await createRuntime();
      }
    })().finally(() => {
      if (this.#pending.get(toolTabId) === pending) {
        this.#pending.delete(toolTabId);
      }
    });

    this.#pending.set(toolTabId, pending);
    return pending;
  }
}
