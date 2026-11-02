import type { MemoryChange } from "./api";
import { Icon } from "./icons";

// One quiet line under a reply when the model saved, changed or forgot a memory, with Undo.
const VERB = { save: "Saved to memory", update: "Updated memory", delete: "Forgot" } as const;

export function MemoryLine({ change, onUndo }: { change: MemoryChange; onUndo: () => void }) {
  return (
    <div className={"memory-line" + (change.undone ? " undone" : "")}>
      <Icon name="memory" size={12} stroke={1.8} />
      <span className="what">
        {change.undone ? "Undone · " : `${VERB[change.action]} · `}
        <span className="fact">{change.text}</span>
      </span>
      {!change.undone && (
        <button className="link-button" onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  );
}
