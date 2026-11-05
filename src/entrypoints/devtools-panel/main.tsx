import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../ui/styles.css";
import { DevtoolsPanelApp } from "../../ui/DevtoolsPanel";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevtoolsPanelApp />
  </StrictMode>,
);
