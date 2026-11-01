import { useEffect, useRef, useState, type RefObject } from "react";

// Keeps a scroller glued to its bottom while its content grows; growth eases in over a few frames
// instead of jumping. Scrolling up lets go (`away` turns on for the "Latest" pill); scrolling back
// to the bottom or calling pin() re-attaches.
export function useFollow(scroller: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>) {
  const pinned = useRef(true);
  const frame = useRef(0);
  const [away, setAway] = useState(false);

  const gap = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;
  const release = () => ((pinned.current = false), cancelAnimationFrame(frame.current), setAway(true));

  const follow = () => {
    cancelAnimationFrame(frame.current);
    const step = () => {
      const el = scroller.current;
      if (!el || !pinned.current) return;
      const d = gap(el);
      if (d <= 1) return;
      el.scrollTop += Math.max(1, Math.ceil(d * 0.2));
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    let lastTop = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      if (gap(el) < 24) (pinned.current = true), setAway(false);
      else if (top < lastTop - 1) release(); // the user went up (our own scrolling only goes down)
      lastTop = top;
    };
    // Catch the gesture itself too, so an upward flick wins over a follow frame in flight.
    const onWheel = (e: WheelEvent) => e.deltaY < 0 && el.scrollHeight > el.clientHeight + 24 && release();
    const ro = new ResizeObserver(() => pinned.current && follow());
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    ro.observe(inner);
    ro.observe(el); // window resizes and bottom-padding changes
    return () => (el.removeEventListener("scroll", onScroll), el.removeEventListener("wheel", onWheel), ro.disconnect(), cancelAnimationFrame(frame.current));
  }, []);

  // pin(): glide to the bottom and stay there. jump(): same, instantly (opening a chat).
  const pin = () => ((pinned.current = true), setAway(false), follow());
  const jump = () => {
    pinned.current = true;
    setAway(false);
    cancelAnimationFrame(frame.current);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  };
  return { away, pin, jump };
}
