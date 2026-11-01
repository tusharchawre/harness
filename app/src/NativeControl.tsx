import { useEffect, useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { nativeControls, onNativeControl, removeNative, upsertNative, type NativeSpec } from "./native";

type Common = {
  label: string;
  // Float the AppKit control only while this is true (e.g. not while the sheet is closing).
  active: boolean;
  style?: CSSProperties;
  align?: "start" | "center" | "end" | "stretch";
};
type Props = Common &
  (
    | { kind: "slider"; value: number; min: number; max: number; step?: number; ticks?: number; onChange: (v: number) => void }
    | { kind: "switch"; value: boolean; onChange: (v: boolean) => void }
    | { kind: "popup"; value: number; items: string[]; onChange: (index: number) => void }
    | { kind: "search"; text: string; placeholder?: string; onText: (text: string) => void }
    | { kind: "segmented"; symbols: string[]; enabled: boolean[]; segmentStyle?: "separated" | "smallSquare"; onSegment: (i: number) => void; fallback: ReactNode }
  );

const SIZES: Record<Props["kind"], CSSProperties> = {
  slider: { width: "100%", height: 28 },
  switch: { width: 40, height: 24 },
  popup: { width: 200, height: 24 },
  search: { width: "100%", height: 28 },
  segmented: { width: 64, height: 26 },
};

// Page rect of `el` as it will be once any transform on the enclosing sheet ([data-native-root])
// has finished, so native views can go to their final spot while the sheet animates in.
function settledRect(el: Element) {
  const r = el.getBoundingClientRect();
  const root = el.closest<HTMLElement>("[data-native-root]");
  if (!root) return { x: r.left, y: r.top, w: r.width, h: r.height };
  const now = root.getBoundingClientRect();
  const k = root.offsetWidth / now.width; // undo the scale
  return { x: root.offsetLeft + (r.left - now.left) * k, y: root.offsetTop + (r.top - now.top) * k, w: r.width * k, h: r.height * k };
}

// A system control (NSSlider, NSSwitch, NSPopUpButton, NSSearchField, NSSegmentedControl) positioned
// over this placeholder. In a plain browser, an HTML control stands in.
export function NativeControl(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const id = "nc" + useId();
  const latest = useRef(p);
  latest.current = p;

  useEffect(
    () =>
      onNativeControl((cid, value, text) => {
        if (cid !== id) return;
        const c = latest.current;
        if (c.kind === "switch") c.onChange(value >= 0.5);
        else if (c.kind === "search") c.onText(text ?? "");
        else if (c.kind === "segmented") c.onSegment(value);
        else c.onChange(value);
      }),
    [id],
  );

  const spec = (): Omit<NativeSpec, "frame" | "clip"> => {
    const c = latest.current;
    const base = { id, kind: c.kind, label: c.label, align: c.align };
    if (c.kind === "slider") return { ...base, value: c.value, min: c.min, max: c.max, ticks: c.ticks };
    if (c.kind === "switch") return { ...base, value: c.value ? 1 : 0 };
    if (c.kind === "popup") return { ...base, value: c.value, items: c.items, align: c.align ?? "end" };
    if (c.kind === "search") return { ...base, text: c.text, placeholder: c.placeholder };
    return { ...base, items: c.symbols, enabled: c.enabled, style: c.segmentStyle, align: c.align ?? "start" };
  };
  // Re-send when anything the native control shows changes.
  const deps = JSON.stringify(spec());

  useLayoutEffect(() => {
    if (!nativeControls || !p.active) return;
    const el = ref.current!;
    const scroller = el.closest<HTMLElement>("[data-native-clip]");
    let raf = 0;
    const place = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const frame = settledRect(el);
        const clip = scroller ? settledRect(scroller) : { x: 0, y: 0, w: innerWidth, h: innerHeight };
        upsertNative({ ...spec(), frame, clip } as NativeSpec);
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    if (scroller) {
      ro.observe(scroller);
      if (scroller.firstElementChild) ro.observe(scroller.firstElementChild);
      scroller.addEventListener("scroll", place, { passive: true });
    }
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [p.active, deps, id]);

  // Remove (fade out) the AppKit view as soon as it shouldn't show.
  useEffect(() => {
    if (nativeControls && p.active) return () => removeNative(id);
  }, [p.active, id]);

  if (nativeControls) return <div ref={ref} className="native-slot" style={{ ...SIZES[p.kind], ...p.style }} aria-hidden="true" />;

  // Plain-browser stand-ins.
  if (p.kind === "switch") return <input type="checkbox" {...{ switch: "" }} aria-label={p.label} checked={p.value} onChange={(e) => p.onChange(e.target.checked)} />;
  if (p.kind === "slider")
    return <input type="range" aria-label={p.label} min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} style={{ width: "100%" }} />;
  if (p.kind === "popup")
    return (
      <select aria-label={p.label} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))}>
        {p.items.map((t, i) => <option key={t} value={i}>{t}</option>)}
      </select>
    );
  if (p.kind === "search") return <input type="search" aria-label={p.label} placeholder={p.placeholder} value={p.text} onChange={(e) => p.onText(e.target.value)} style={{ width: "100%" }} />;
  return <>{p.fallback}</>;
}
