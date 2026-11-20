import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../ui/styles.css";
import { PrintApp } from "../../ui/Print";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrintApp />
  </StrictMode>,
);
