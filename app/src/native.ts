// Thin wrapper over the Tauri APIs so the UI still runs in a plain browser (dev at :1420).
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
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

// Panes: general | models | tools | memory | voice. Both windows share localStorage,
// so a freshly opened Settings window reads the pane from there; an open one gets the event.
export function openSettings(pane = "general") {
  try {
    localStorage.setItem("settings-pane", pane);
  } catch {}
  if (!isTauri) return void window.open("/?window=settings", "settings", "width=760,height=640");
  emit("settings-pane", pane);
  invoke("open_settings_window");
}

export function onSettingsPane(fn: (pane: string) => void): () => void {
  if (!isTauri) return () => {};
  const off = listen<string>("settings-pane", (e) => fn(e.payload));
  return () => void off.then((f) => f());
}

// Settings window → main window: settings were saved, re-read them.
export const announceSettings = () => (isTauri ? emit("settings-changed") : Promise.resolve());
export function onSettingsChanged(fn: () => void): () => void {
  if (!isTauri) return () => {};
  const off = listen("settings-changed", () => fn());
  return () => void off.then((f) => f());
}

export function showMainWindow() {
  if (isTauri) invoke("show_main_window");
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
