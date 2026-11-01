import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isTauri, syncAccent, windowLabel } from "./native";
import { SettingsWindow } from "./Settings";
import "./styles.css";

if (!isTauri) document.documentElement.classList.add("web");
syncAccent();

// One bundle, two windows: the label picks the screen.
const Root = windowLabel() === "settings" ? SettingsWindow : App;
createRoot(document.getElementById("root")!).render(<Root />);
