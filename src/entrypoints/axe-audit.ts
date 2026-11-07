import { installAxeAudit } from "../lib/page/axe";

/** Injected on demand in the ISOLATED world: installs `__devkitAxe` (axe-core audit and in-page highlight). */
export default defineUnlistedScript(() => installAxeAudit());
