const DECORUM_TITLEBAR_SELECTOR = "[data-tauri-decorum-tb]";
const DECORUM_TITLEBAR_HOST_ID = "decorum-titlebar-host";

export function mountDecorumTitlebarHost(node: HTMLElement) {
  let disposed = false;
  let host: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  const originalParentByHost = new WeakMap<HTMLElement, HTMLElement>();

  function attach(candidate: HTMLElement) {
    if (disposed || host === candidate) return;
    observer?.disconnect();
    observer = null;
    if (!originalParentByHost.has(candidate) && candidate.parentElement) {
      originalParentByHost.set(candidate, candidate.parentElement);
    }
    host = candidate;
    candidate.id = DECORUM_TITLEBAR_HOST_ID;
    candidate.classList.add("workspace-decorum-controls", "mounted");
    candidate.style.removeProperty("inset");
    candidate.style.removeProperty("left");
    candidate.style.removeProperty("position");
    candidate.style.removeProperty("top");
    candidate.style.removeProperty("width");
    candidate.style.removeProperty("z-index");
    candidate.style.height = "100%";
    node.appendChild(candidate);
  }

  function findAndAttach() {
    const candidate = document.querySelector(DECORUM_TITLEBAR_SELECTOR);
    if (candidate instanceof HTMLElement) attach(candidate);
  }

  findAndAttach();
  if (!host) {
    observer = new MutationObserver(findAndAttach);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  return {
    destroy() {
      disposed = true;
      observer?.disconnect();
      if (!host || host.parentElement !== node) return;
      host.classList.remove("mounted");
      const originalParent = originalParentByHost.get(host);
      if (originalParent?.isConnected) originalParent.appendChild(host);
      else document.body.appendChild(host);
    },
  };
}
