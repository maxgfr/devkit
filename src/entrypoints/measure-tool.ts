import { installMeasure } from "../lib/page/measure";

/** Injected on demand in the page's ISOLATED world: installs `window.__devkitMeasure` (spacing ruler overlay). */
export default defineUnlistedScript(() => installMeasure());
