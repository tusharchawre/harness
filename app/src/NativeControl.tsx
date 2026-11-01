import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { nativeControls, onNativeControl, removeNative, upsertNative } from "./native";

type Props = {
  kind: "slider" | "switch";
  value: number;
  onChange: (v: number) => void;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  ticks?: number;
  // Only float the AppKit control while the page around it is still (e.g. not mid-animation).
  active: boolean;
  id?: string;
};

// A system NSSlider / NSSwitch positioned over this placeholder. In a plain browser,
// WebKit's own control stands in.
export function NativeControl(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const id = "nc" + autoId;
  const onChange = useRef(p.onChange);
  onChange.current = p.onChange;

  useEffect(() => (nativeControls ? onNativeControl((cid, v) => cid === id && onChange.current(v)) : undefined), [id]);

  useLayoutEffect(() => {
    if (!nativeControls || !p.active) return;
    const el = ref.current!;
    const scroller = el.closest<HTMLElement>("[data-native-clip]") ?? document.body;
    let raf = 0;
    const place = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const c = scroller.getBoundingClientRect();
        upsertNative({
          id,
          kind: p.kind,
          frame: { x: r.left, y: r.top, w: r.width, h: r.height },
          clip: { x: c.left, y: c.top, w: c.width, h: c.height },
          value: p.value,
          min: p.min,
          max: p.max,
          ticks: p.ticks,
          label: p.label,
        });
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    ro.observe(scroller);
    if (scroller.firstElementChild) ro.observe(scroller.firstElementChild);
    scroller.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scroller.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [p.active, p.value, p.kind, p.min, p.max, p.ticks, p.label, id]);

  // Remove the AppKit view as soon as it shouldn't show (closing, unmounting).
  useEffect(() => {
    if (nativeControls && p.active) return () => removeNative(id);
  }, [p.active, id]);

  const size = p.kind === "switch" ? { width: 40, height: 24 } : { width: "100%", height: 28 };
  if (nativeControls) return <div ref={ref} className="native-slot" style={size} aria-hidden="true" />;
  return p.kind === "switch" ? (
    <input type="checkbox" {...{ switch: "" }} aria-label={p.label} checked={p.value >= 0.5} onChange={(e) => p.onChange(e.target.checked ? 1 : 0)} />
  ) : (
    <input type="range" aria-label={p.label} min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} style={{ width: "100%" }} />
  );
}
