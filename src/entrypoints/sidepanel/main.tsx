import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../ui/styles.css";
import { SidePanelApp } from "../../ui/SidePanel";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SidePanelApp />
  </StrictMode>,
);
