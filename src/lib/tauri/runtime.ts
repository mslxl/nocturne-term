export function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
