// Thin wrapper over the Tauri APIs so the UI still runs in a plain browser (dev at :1420).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const isTauri = "__TAURI_INTERNALS__" in window;

export const windowLabel = (): string => (isTauri ? getCurrentWindow().label : new URLSearchParams(location.search).get("window") ?? "main");

// Menu bar, tray and keyboard-shortcut actions arrive as "menu" events with the item id.
export function onMenu(fn: (id: string) => void): () => void {
  if (!isTauri) return () => {};
  const off = listen<string>("menu", (e) => fn(e.payload));
  return () => void off.then((f) => f());
}

export function setModelMenu(models: { id: string; label: string }[], active: string | null, loaded: boolean) {
  if (isTauri) invoke("set_model_menu", { models, active, loaded }).catch(console.error);
}

export function openSettings() {
  if (isTauri) invoke("open_settings_window");
  else window.open("/?window=settings", "settings", "width=760,height=640");
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
