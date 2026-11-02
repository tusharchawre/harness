// Thin wrapper over the Tauri APIs so the UI still runs in a plain browser (dev at :1420).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const isTauri = "__TAURI_INTERNALS__" in window;

// Menu bar, tray and keyboard-shortcut actions arrive as "menu" events with the item id.
export function onMenu(fn: (id: string) => void): () => void {
  if (!isTauri) return () => {};
  const off = listen<string>("menu", (e) => fn(e.payload));
  return () => void off.then((f) => f());
}

export function setModelMenu(models: { id: string; label: string }[], active: string | null, loaded: boolean) {
  if (isTauri) invoke("set_model_menu", { models, active, loaded }).catch(console.error);
}

// Settings is a modal in the main window. Panes: general | models | tools | memory | voice.
export function openSettings(pane = "general") {
  window.dispatchEvent(new CustomEvent("open-settings", { detail: pane }));
}
export function onOpenSettings(fn: (pane: string) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent<string>).detail);
  window.addEventListener("open-settings", h);
  return () => window.removeEventListener("open-settings", h);
}

// Links in replies open in the default browser, never inside the app.
export function openUrl(url: string) {
  if (!/^(https?:|mailto:)/i.test(url)) return;
  if (isTauri) invoke("open_url", { url });
  else window.open(url, "_blank", "noopener");
}

// Native folder picker; null when cancelled or outside Tauri (the browser view types a path instead).
export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, title: "Choose a folder to share with Harness" });
  return typeof dir === "string" ? dir : null;
}

export function reveal(path: string) {
  if (isTauri) invoke("reveal", { path });
}

// Keep --accent in step with System Settings › Appearance › Accent color.
export function syncAccent() {
  if (!isTauri) return;
  const apply = () =>
    invoke<string | null>("accent_color").then((c) => c && document.documentElement.style.setProperty("--accent", c));
  apply();
  window.addEventListener("focus", apply);
}
