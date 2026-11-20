import { type Browser, browser } from "wxt/browser";
import { dedupeCookies } from "./cookies-export";

/**
 * `chrome.cookies.getAll`, plus the partitioned (CHIPS) cookies where Chrome can list them.
 * `partitionKey: {}` asks for every partition (Chrome 119+); older versions reject the property,
 * so the plain call alone is kept there. Chrome only returns cookies of hosts devkit can access.
 */
export async function readCookies(details: Browser.cookies.GetAllDetails): Promise<Browser.cookies.Cookie[]> {
  const plain = await browser.cookies.getAll(details);
  const partitioned = await browser.cookies.getAll({ ...details, partitionKey: {} }).catch(() => []);
  return dedupeCookies([...plain, ...partitioned]);
}
