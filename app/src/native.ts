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

// Real AppKit controls floated over the page (see src-tauri/src/native_controls.rs).
type Rect = { x: number; y: number; w: number; h: number };
export type NativeSpec = {
  id: string;
  kind: "slider" | "switch" | "popup" | "search" | "segmented";
  frame: Rect;
  clip: Rect;
  value?: number;
  min?: number;
  max?: number;
  ticks?: number;
  label?: string;
  items?: string[]; // popup titles or segmented SF Symbol names
  enabled?: boolean[];
  style?: string;
  text?: string;
  placeholder?: string;
  align?: string;
};
export const nativeControls = isTauri;
export function upsertNative(spec: NativeSpec) {
  invoke("native_control", { spec }).catch(console.error);
}
export function removeNative(id: string) {
  invoke("native_control", { remove: id }).catch(console.error);
}
export function onNativeControl(fn: (id: string, value: number, text: string | null) => void): () => void {
  if (!isTauri) return () => {};
  const off = listen<{ id: string; value: number; text: string | null }>("native-control", (e) => fn(e.payload.id, e.payload.value, e.payload.text));
  return () => void off.then((f) => f());
}

// Links in replies open in the default browser, never inside the app.
export function openUrl(url: string) {
  if (!/^(https?:|mailto:)/i.test(url)) return;
  if (isTauri) invoke("open_url", { url });
  else window.open(url, "_blank", "noopener");
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
