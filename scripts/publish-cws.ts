// Uploads a zip to an existing Chrome Web Store item and submits it for review (Chrome Web Store API v2).
// Usage: node scripts/publish-cws.ts <zip>
// Env: CWS_PUBLISHER_ID, CWS_EXTENSION_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN.
// The first version of an item is created by hand in the developer dashboard; see store/README.md.
import { readFileSync } from "node:fs";

const API = "https://chromewebstore.googleapis.com";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } | string; error_description?: string };
  if (!res.ok) {
    const e = body.error;
    const message = typeof e === "string" ? (body.error_description ?? e) : (e?.message ?? res.statusText);
    throw new Error(`${res.status} ${message}`);
  }
  return body;
}

async function main() {
  const zip = process.argv[2];
  if (!zip) throw new Error("Usage: node scripts/publish-cws.ts <zip>");
  const item = `publishers/${env("CWS_PUBLISHER_ID")}/items/${env("CWS_EXTENSION_ID")}`;

  const { access_token } = await call<{ access_token: string }>("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env("CWS_CLIENT_ID"),
      client_secret: env("CWS_CLIENT_SECRET"),
      refresh_token: env("CWS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const auth = { authorization: `Bearer ${access_token}` };

  const upload = await call<{ uploadState?: string; crxVersion?: string }>(`${API}/upload/v2/${item}:upload`, {
    method: "POST",
    headers: { ...auth, "x-goog-upload-protocol": "raw", "x-goog-upload-file-name": "extension.zip" },
    body: readFileSync(zip),
  }).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    // Not a failure of this release: the store takes one version at a time. The next release, or the
    // "Chrome Web Store" workflow run by hand once the review is over, sends the newest zip.
    if (/in review/i.test(message)) {
      console.log(
        `::warning::Chrome Web Store: the previous version is still in review, so ${zip} was not uploaded. ` +
          "Once the review is over, run the Chrome Web Store workflow (gh workflow run store.yml) to send the latest release.",
      );
      process.exit(0);
    }
    throw new Error(`upload refused (this version may not be above the store's): ${message}`);
  });
  let state = upload.uploadState;
  for (let i = 0; state === "IN_PROGRESS" && i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    state = (await call<{ lastAsyncUploadState?: string }>(`${API}/v2/${item}:fetchStatus`, { headers: auth })).lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`Upload ended in state ${state ?? "unknown"}`);
  console.log(`Uploaded version ${upload.crxVersion ?? "?"}.`);

  const published = await call<{ state?: string }>(`${API}/v2/${item}:publish`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" }),
  });
  console.log(`Submitted for review: ${published.state ?? "ok"}.`);
}

main().catch((e: unknown) => {
  console.error(`Chrome Web Store: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
