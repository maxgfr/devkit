import { describe, expect, it } from "vitest";
import { entropy, mask, mergeFindings, type SecretSource, scanSecrets } from "../src/lib/security/secrets";

// Every fixture is fake. Values are assembled at runtime so no file in the repository holds a
// string that a secret scanner (GitHub push protection included) would take for a real key.
const j = (...parts: string[]) => parts.join("");
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (payload: Record<string, unknown>) =>
  `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.${j("c2lnbmF0dXJl", "LWRldmtpdC1mYWtl")}`;

const FAKE = {
  stripeLive: j("sk_", "live_", "51DevkitFake9Qw3Er7Ty2Ui8Op4As"),
  stripeRestricted: j("rk_", "live_", "51DevkitFake9Qw3Er7Ty2Ui8Op4As"),
  stripeTest: j("sk_", "test_", "51DevkitFake9Qw3Er7Ty2Ui8Op4As"),
  stripePublishable: j("pk_", "live_", "51DevkitFake9Qw3Er7Ty2Ui8Op4As"),
  awsId: j("AKIA", "DEVKITFAKE7Q2W4E"),
  awsSecret: j("devkitFAKE/9s8d7f6g5h4", "j3k2l1Zx+Cv8Bn7Mq0"),
  google: j("AIza", "SyDevkitFake_0123456789abcdefghijkl"),
  github: j("ghp", "_", "DevkitFake0123456789abcdefghijKLMNOP"),
  slackWebhook: j("https://hooks.slack.com/services/", "T0DEVKIT1/B0FAKE22/", "devkitFake0123456789abcd"),
  slackToken: j("xox", "b-", "123456789012-1234567890123-DevkitFakeTokenAbc"),
  openai: j("sk-", "proj-", "DevkitFake0123456789abcdefghijklmnopQRSTUV"),
  anthropic: j("sk-", "ant-", "api03-", "DevkitFake0123456789abcdefghijklmnopQRSTUVWXYZ_-0123456789abcdefghijklmnopqrstuvwxyzAB"),
  sendgrid: j("SG", ".", "DevkitFake0123456789ab", ".", "DevkitFake0123456789abcdefghijklmnopqrstuvw"),
  mailgun: j("key-", "devkitfake0123456789qrstuvwxyz01"),
  twilioKey: j("SK", "0123456789abcdef0123456789abcdef"),
};

const src = (text: string, kind: SecretSource["kind"] = "inline-script", label = "inline script #1"): SecretSource => ({
  kind,
  label,
  text,
});
const scan = (text: string, kind?: SecretSource["kind"]) => scanSecrets([src(text, kind)]);
const rules = (text: string, kind?: SecretSource["kind"]) => scan(text, kind).map((f) => f.rule);

describe("secret patterns: positives", () => {
  it("Stripe keys by kind", () => {
    const f = scan(`const a="${FAKE.stripeLive}", b="${FAKE.stripeRestricted}", c="${FAKE.stripeTest}", d="${FAKE.stripePublishable}"`);
    const by = Object.fromEntries(f.map((x) => [x.title, x.severity]));
    expect(by).toMatchObject({
      "Stripe live secret key": "bad",
      "Stripe live restricted key": "bad",
      "Stripe test secret key": "warn",
      "Stripe publishable key": "info",
    });
  });
  it("AWS key ID alone is a warning, with its secret nearby it is bad", () => {
    expect(scan(`id: "${FAKE.awsId}"`)[0]).toMatchObject({ rule: "aws-access-key", severity: "warn" });
    const both = scan(`accessKeyId: "${FAKE.awsId}", secretAccessKey: "${FAKE.awsSecret}"`);
    expect(both.map((x) => [x.rule, x.severity])).toEqual(
      expect.arrayContaining([
        ["aws-secret-key", "bad"],
        ["aws-access-key", "bad"],
      ]),
    );
  });
  it("Google key: warn, Firebase config: info", () => {
    expect(scan(`maps.load({ key: "${FAKE.google}" })`)[0]).toMatchObject({ rule: "google-api-key", severity: "warn" });
    const fb = scan(
      `const firebaseConfig = { apiKey: "${FAKE.google}", authDomain: "devkit-fake.firebaseapp.com", projectId: "devkit-fake" }`,
    );
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ rule: "firebase-config", severity: "info" });
  });
  it("GitHub, Slack, OpenAI, Anthropic, SendGrid, Mailgun, Twilio", () => {
    const text = Object.values(FAKE).join("\n");
    expect(rules(text)).toEqual(
      expect.arrayContaining([
        "github-token",
        "slack-webhook",
        "slack-token",
        "openai-key",
        "anthropic-key",
        "sendgrid-key",
        "mailgun-key",
        "twilio-api-key",
      ]),
    );
  });
  it("private key blocks with a body, escaped newlines included", () => {
    const body = "MIIEowIBAAKCAQEAdevkitFAKEkeyMaterial0123456789abcdefghijklmnopqrstuv";
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n${body}\n-----END RSA PRIVATE KEY-----`;
    expect(scan(`/* ${pem} */`)[0]).toMatchObject({ rule: "private-key", severity: "bad" });
    expect(scan(`var k = "${pem.replace(/\n/g, "\\n")}";`)[0]?.rule).toBe("private-key");
    expect(scan(`/* ${pem} */`)[0]!.masked).toContain("BEGIN RSA PRIVATE KEY");
  });
  it("JWTs: Supabase service_role is bad, anon is info, storage tokens are info", () => {
    expect(scan(`createClient(url, "${jwt({ iss: "supabase", role: "service_role" })}")`)[0]).toMatchObject({
      title: "Supabase service_role key",
      severity: "bad",
    });
    expect(scan(`createClient(url, "${jwt({ iss: "supabase", role: "anon" })}")`)[0]).toMatchObject({
      title: "Supabase anon key",
      severity: "info",
    });
    expect(scan(`token=${jwt({ sub: "42", exp: 1 })}`, "storage")[0]).toMatchObject({ severity: "info", detail: "expired" });
    expect(scan(`window.t = "${jwt({ sub: "42" })}"`)[0]).toMatchObject({ rule: "jwt", severity: "warn" });
  });
  it("generic secret assignments with random values (heuristic)", () => {
    const f = scan(`const config = { "client_secret": "q8Z2nX7rB4vK9mT1pW6s", DB_PASSWORD: 'h7Gk2Lq9Xz4Wv1Rt' }`);
    expect(f.map((x) => x.rule)).toEqual(["generic-assignment", "generic-assignment"]);
    expect(f.every((x) => x.heuristic)).toBe(true);
    expect(scan("# .env leaked into a comment\nSTRIPE_SECRET_KEY=a9Kd02LmQx7Zp4Vb\n", "comment")[0]?.rule).toBe("generic-assignment");
  });
  it("database URLs with credentials", () => {
    expect(scan(`const url = "postgres://admin:h7Gk2Lq9Xz@db.internal.example:5432/app"`)[0]).toMatchObject({
      title: "Database connection string",
      severity: "bad",
    });
  });
});

describe("secret patterns: negatives", () => {
  it("placeholders and documentation examples", () => {
    expect(rules(`key: "${j("sk_", "live_", "xxxxxxxxxxxxxxxxxxxxxxxx")}"`)).toEqual([]);
    expect(rules(`id: "${j("AKIA", "IOSFODNN7EXAMPLE")}"`)).toEqual([]);
    expect(rules(`apiKey: "YOUR_API_KEY_GOES_HERE_1"`)).toEqual([]);
    expect(rules(`password: "\${process.env.PASSWORD}"`)).toEqual([]);
  });
  it("names and paths assigned to secret-sounding keys", () => {
    expect(rules(`const passwordField = "passwordConfirmation"; api_key: "settings.apiKeyLabel"`)).toEqual([]);
    expect(rules(`secret: "/api/v1/secrets/list", token: "https://auth.example.com/1234/token"`)).toEqual([]);
    expect(rules(`recaptchaSiteKey: "6LcDevkitFake0123456789"`)).toEqual([]);
  });
  it("hashes and look-alikes in minified code", () => {
    const sha1 = "3f786850e387550fdab836ed7e6dc881de23001b";
    expect(rules(`id: "${j("AKIA", "DEVKITFAKE7Q2W4E")}", commit: "${sha1}"`)).toEqual(["aws-access-key"]);
    expect(scan(`id: "${j("AKIA", "DEVKITFAKE7Q2W4E")}", commit: "${sha1}"`)[0]!.severity).toBe("warn");
    expect(rules(`el.className = "task-runner"; const k = "${j("key-", "0123456789abcdef0123456789abcdef")}"`)).toEqual([]);
    expect(rules(`const t = "eyJhbGciOi.not-a-jwt.really"`)).toEqual([]);
  });
  it("a PEM header constant without key material", () => {
    expect(rules(`var h = "-----BEGIN RSA PRIVATE KEY-----"; parse(h + body)`)).toEqual([]);
  });
  it("user:pass placeholders in URLs", () => {
    expect(rules(`"https://user:password@example.com"`)).toEqual([]);
  });
});

describe("scan output", () => {
  it("deduplicates a value seen in several sources and keeps every location with its line", () => {
    const f = scanSecrets([
      src(`line1\nline2\nconst k = "${FAKE.stripeLive}";`, "inline-script", "inline script #2"),
      { kind: "script", label: "/static/app.js", url: "https://ex.com/static/app.js", text: `a="${FAKE.stripeLive}"` },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.locations.map((l) => [l.source, l.line])).toEqual([
      ["inline script #2", 3],
      ["/static/app.js", 1],
    ]);
    expect(f[0]!.locations[0]!.context).not.toContain(FAKE.stripeLive);
    expect(f[0]!.locations[0]!.context).toContain(f[0]!.masked);
  });
  it("sorts by severity", () => {
    const f = scan(`"${FAKE.stripePublishable}" "${FAKE.stripeLive}" "${FAKE.google}"`);
    expect(f.map((x) => x.severity)).toEqual(["bad", "warn", "info"]);
  });
  it("masks to the first and last 4 characters", () => {
    expect(mask(FAKE.stripeLive)).toBe(`sk_l…${FAKE.stripeLive.slice(-4)}`);
    expect(mask("abcdef")).toBe("ab••••");
  });
  it("entropy", () => {
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });
});

describe("merging scans", () => {
  it("merges locations of the same secret and keeps the worst verdict", () => {
    const token = jwt({ sub: "42" });
    const a = scanSecrets([src(`t=${token}`, "storage", 'localStorage["t"]')]);
    const b = scanSecrets([{ kind: "script", label: "/app.js", text: `x="${token}"` }]);
    const m = mergeFindings(a, b);
    expect(m).toHaveLength(1);
    expect(m[0]!.severity).toBe("warn");
    expect(m[0]!.locations.map((l) => l.source)).toEqual(['localStorage["t"]', "/app.js"]);
    expect(a[0]!.locations).toHaveLength(1);
  });
});
