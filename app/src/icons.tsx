// Stroke icons from the design canvas (24-unit viewBox, currentColor).
const P = {
  compose: ["M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6", "M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"],
  bulb: ["M12 3a6 6 0 0 0-6 6c0 2.4 1.4 3.6 2.5 4.6.7.6 1.5 1.4 1.5 2.4h4c0-1 .8-1.8 1.5-2.4C16.6 12.6 18 11.4 18 9a6 6 0 0 0-6-6z", "M10 20h4"],
  gear: ["M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"],
  chevronDown: ["M6 9l6 6 6-6"],
  chevronRight: ["M9 6l6 6-6 6"],
  chevronLeft: ["M15 18l-6-6 6-6"],
  doc: ["M14 3H6v18h12V7z", "M14 3v4h4"],
  external: ["M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  close: ["M6 6l12 12M18 6L6 18"],
  mic: ["M5 11a7 7 0 0 0 14 0M12 18v3"],
  arrowUp: ["M12 19V5M6 11l6-6 6 6"],
  arrowDown: ["M12 5v14M6 13l6 6 6-6"],
  general: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3"],
  models: ["M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4"],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  copy: ["M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  retry: ["M20 12a8 8 0 1 1-2.34-5.66", "M20 4v4.5h-4.5"],
  tools: ["M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.5-2.5z"],
} as const;

export type IconName = keyof typeof P | "search" | "settings" | "stop" | "memory" | "voice" | "sidebar" | "more";

export function Icon({ name, size = 14, stroke = 1.7 }: { name: IconName; size?: number; stroke?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: stroke, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "sidebar") return <svg {...common}><rect x="3" y="4.5" width="18" height="15" rx="3.5" /><path d="M9 4.5v15" /></svg>;
  if (name === "more") return <svg {...common} fill="currentColor" stroke="none"><circle cx="6" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18" cy="12" r="1.6" /></svg>;
  if (name === "search") return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
  if (name === "settings") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d={P.gear[0]} /></svg>;
  if (name === "stop") return <svg {...common} fill="currentColor" stroke="none"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>;
  if (name === "memory") return <svg {...common}>{P.bulb.map((d) => <path key={d} d={d} />)}</svg>;
  if (name === "voice") return <svg {...common}><path d="M9 3h6v11H9z" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
  if (name === "mic") return <svg {...common}><rect x="9" y="3" width="6" height="11" rx="3" /><path d={P.mic[0]} /></svg>;
  return <svg {...common}>{P[name].map((d) => <path key={d} d={d} />)}</svg>;
}
