import { installErrorCapture } from "../lib/page/errors";

/** Registered at runtime when the user turns error capture on (Options or Inspect → Console errors). */
export default defineContentScript({
  matches: ["<all_urls>"],
  world: "MAIN",
  runAt: "document_start",
  registration: "runtime",
  main() {
    installErrorCapture();
  },
});
