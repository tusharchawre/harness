import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isTauri, syncAccent } from "./native";
import "./styles.css";

if (!isTauri) document.documentElement.classList.add("web");
syncAccent();

createRoot(document.getElementById("root")!).render(<App />);

// Dev-only preview of the permission sheet: http://localhost:1420/?sheet (stripped from builds).
if (import.meta.env.DEV && new URLSearchParams(location.search).has("sheet"))
  import("./PermissionSheet").then(({ askPermission }) =>
    askPermission({
      tool: "write_file",
      path: "/Users/you/Desktop/ai-from-scratch/tok-rate.ts",
      diff: '+ const rows = (await Bun.file("evals/…/http_summary.jsonl").text())\n+   .trim().split("\\n").map(l => JSON.parse(l));\n+\n+ for (const r of rows)\n+   console.log(r.model.padEnd(20), (r.tokens / r.seconds).toFixed(1));',
    }).then((a) => console.log("permission", a)),
  );
