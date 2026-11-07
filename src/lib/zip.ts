// Minimal ZIP writer, "stored" entries only (no compression: images are compressed already).
// Enough for "download all": UTF-8 names, CRC-32, one central directory. No ZIP64: callers keep
// the archive under 4 GiB and 65 535 entries.

let table: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFile {
  name: string;
  data: Uint8Array;
  date?: Date;
}

export const ZIP_MAX_BYTES = 0xffffffff - 1024 * 1024;
export const ZIP_MAX_FILES = 0xffff;

/** MS-DOS time and date, local time, 2-second resolution. Years before 1980 clamp to 1980. */
export function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A .zip archive holding `files` as stored entries. */
export function zipStore(files: ZipFile[]): Uint8Array<ArrayBuffer> {
  if (files.length > ZIP_MAX_FILES) throw new Error(`Too many files for a zip (${files.length}).`);
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ ...f, nameBytes: enc.encode(f.name), crc: crc32(f.data), dt: dosDateTime(f.date ?? new Date()) }));
  const localSize = entries.reduce((n, e) => n + 30 + e.nameBytes.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.nameBytes.length, 0);
  const total = localSize + centralSize + 22;
  if (localSize + centralSize > ZIP_MAX_BYTES) throw new Error("The files are too large for one zip (4 GB).");
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v: number) => {
    view.setUint16(at, v, true);
    at += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(at, v >>> 0, true);
    at += 4;
  };
  const bytes = (b: Uint8Array) => {
    out.set(b, at);
    at += b.length;
  };
  const offsets: number[] = [];
  for (const e of entries) {
    offsets.push(at);
    u32(0x04034b50); // local file header
    u16(20); // version needed: 2.0
    u16(0x0800); // flags: UTF-8 names
    u16(0); // method: stored
    u16(e.dt.time);
    u16(e.dt.date);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.nameBytes.length);
    u16(0); // extra length
    bytes(e.nameBytes);
    bytes(e.data);
  }
  const centralStart = at;
  entries.forEach((e, i) => {
    u32(0x02014b50); // central directory header
    u16(20); // version made by
    u16(20);
    u16(0x0800);
    u16(0);
    u16(e.dt.time);
    u16(e.dt.date);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.nameBytes.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]!);
    bytes(e.nameBytes);
  });
  const centralLength = at - centralStart;
  u32(0x06054b50); // end of central directory
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(centralLength);
  u32(centralStart);
  u16(0);
  return out;
}
