import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../ui/styles.css";
import { OptionsApp } from "../../ui/Options";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>,
);
