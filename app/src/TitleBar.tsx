import { useEffect, useRef, useState } from "react";
import { api, type ModelState, type Preset } from "./api";
import { Icon } from "./icons";
import { openSettings } from "./native";

export function modelMeta(p: Preset) {
  const short = (s?: string) => s?.replace(" · 4-bit", "").replace("tokens/s", "tok/s");
  return [p.mtp && "MTP", short(p.info.size), short(p.info.speed)].filter(Boolean).join(" · ");
}

export function statusLine(model: ModelState | null, active: Preset | undefined) {
  const idle = model?.idleMinutes ? (model.idleMinutes >= 60 && model.idleMinutes % 60 === 0 ? `${model.idleMinutes / 60} h` : `${model.idleMinutes} min`) : null;
  if (!model || model.status === "unloaded") return "Unloaded · loads on next message";
  if (model.status === "loading") return `Loading ${model.label ?? ""}…`;
  if (model.status === "error") return "Couldn't load the model";
  const which = model.presetId !== active?.id ? `${model.label} loaded` : "Loaded";
  return idle ? `${which} · unloads after ${idle} idle` : `${which} · stays loaded`;
}

export function TitleBar(props: {
  presets: Preset[];
  active: Preset | undefined;
  model: ModelState | null;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", () => setOpen(false), { once: true });
    return () => (window.removeEventListener("mousedown", close), window.removeEventListener("keydown", close));
  }, [open]);

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div ref={ref} style={{ position: "relative" }}>
        <button className="model-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {props.active?.label ?? "No model"}
          <Icon name="chevronDown" size={10} stroke={3} />
        </button>
        {open && (
          <div role="menu" aria-label="Model" className="menu">
            {props.presets.map((p) => (
              <button
                key={p.id}
                role="menuitemradio"
                aria-checked={p.id === props.active?.id}
                className="item model"
                disabled={props.disabled}
                onClick={() => (props.onPick(p.id), setOpen(false))}
              >
                <span className="check">{p.id === props.active?.id ? "✓" : ""}</span>
                <span>
                  <span className="name">{p.label}</span>
                  <span className="sub">{modelMeta(p)}</span>
                </span>
              </button>
            ))}
            <div className="sep" />
            <div className="status">{statusLine(props.model, props.active)}</div>
            <button role="menuitem" className="item" disabled={props.model?.status !== "ready"} onClick={() => (api.unloadModel(), setOpen(false))}>
              Unload model
            </button>
            <button role="menuitem" className="item" onClick={() => (openSettings(), setOpen(false))}>
              Model settings…
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
