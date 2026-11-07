import { installReportPage } from "../lib/page/recorder";

/** Injected on demand in the page's ISOLATED world: installs `window.__devkitReport` (steps recorder, DOM snapshot). */
export default defineUnlistedScript(() => installReportPage());
