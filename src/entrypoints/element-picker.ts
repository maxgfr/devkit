import { installElementPicker } from "../lib/page/element";

/** Injected on demand in the page's MAIN world: installs `window.__devkitElement` (picker overlay and collector). */
export default defineUnlistedScript(() => installElementPicker());
