import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../ui/styles.css";
import { PaletteApp } from "../../ui/Palette";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PaletteApp />
  </StrictMode>,
);
