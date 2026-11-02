import { forwardRef, useLayoutEffect, useRef } from "react";
import { Icon } from "./icons";

type Props = {
  value: string;
  onChange: (v: string) => void;
  thinking: boolean;
  onThinking: (on: boolean) => void;
  busy: boolean;
  onSend: () => void;
  onStop: () => void;
};

export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer(p, outerRef) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Grow with the text (CSS caps it at 220px, then it scrolls).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [p.value]);

  return (
    <div className="composer">
      <textarea
        ref={(el) => {
          ref.current = el;
          if (typeof outerRef === "function") outerRef(el);
          else if (outerRef) outerRef.current = el;
        }}
        aria-label="Message"
        placeholder="Message Harness"
        rows={1}
        value={p.value}
        autoFocus
        // Autocorrect stays (ill → I'll); macOS's grey inline predictions are off. Spell-check
        // underlines are hidden in CSS, since turning spell check off would also stop autocorrect.
        autoCapitalize="off"
        {...{ writingsuggestions: "false" }}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!p.busy) p.onSend();
          }
        }}
      />
      <div className="tools">
        <button className="think" aria-pressed={p.thinking} onClick={() => p.onThinking(!p.thinking)} title="Reason before answering">
          <Icon name="memory" size={13} stroke={1.8} />
          Think
        </button>
        {/* Voice input arrives with the voice milestone. */}
        <button className="icon-btn mic" aria-label="Hold to talk" title="Voice input is coming soon" disabled>
          <Icon name="mic" size={16} />
        </button>
        <button
          className={"send" + (p.busy ? " stop" : "")}
          aria-label={p.busy ? "Stop" : "Send"}
          disabled={!p.busy && !p.value.trim()}
          onClick={p.busy ? p.onStop : p.onSend}
        >
          <svg className="arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
          <svg className="square" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="10" height="10" rx="2.5" fill="currentColor" /></svg>
        </button>
      </div>
    </div>
  );
});
