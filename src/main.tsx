import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow-semi-condensed/600.css";
import "./styles/app.css";
import "./styles/screen.css";
import "./styles/screen-extra.css";
import "./styles/app-icons.css";
import "./styles/files-extra.css";
import "./styles/firmware-extra.css";
import App from "./App";
import { startSession } from "./state/session";
import { loadSettings } from "./state/settings";

async function main() {
  try {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  } catch {
    /* not allowed here */
  }
  await loadSettings();
  startSession();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
void main();
