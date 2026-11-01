import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isTauri, syncAccent } from "./native";
import "./styles.css";

if (!isTauri) document.documentElement.classList.add("web");
syncAccent();

createRoot(document.getElementById("root")!).render(<App />);
