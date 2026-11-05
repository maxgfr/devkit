export const uuidV4 = () => crypto.randomUUID();

/** UUID v7 (RFC 9562): 48-bit Unix ms timestamp, then random bits. Sorts by creation time. */
export function uuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Version and, for v1/v7, the embedded time. */
export function inspectUuid(value: string): { version: number; variant: string; time?: string } | null {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f])([0-9a-f]{3})-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{12}$/i.exec(value.trim());
  if (!m) return null;
  const version = Number.parseInt(m[3]!, 16);
  const v = Number.parseInt(m[5]!, 16);
  const variant = v >= 8 && v <= 11 ? "RFC 9562" : v >= 12 ? "Microsoft" : "NCS";
  if (version === 7) return { version, variant, time: new Date(Number.parseInt(m[1]! + m[2]!, 16)).toISOString() };
  return { version, variant };
}

export const nanoid = (size = 21) => {
  const alphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), (b) => alphabet[b & 63]).join("");
};
