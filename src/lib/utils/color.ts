export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  let m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) {
    let hex = m[1]!;
    if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
    const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] ? (m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number(m[4])) : 1;
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const [r, g, b] = hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
    const a = m[4] ? (m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number(m[4])) : 1;
    return { r, g, b, a };
  }
  return null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export function toHex({ r, g, b, a }: Rgba): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a * 255) : ""}`;
}

export function toHsl({ r, g, b, a }: Rgba): string {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d) h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  h = Math.round((h * 60 + 360) % 360);
  const body = `${h} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
  return a < 1 ? `hsl(${body} / ${a})` : `hsl(${body})`;
}

export const toRgb = ({ r, g, b, a }: Rgba) => (a < 1 ? `rgb(${r} ${g} ${b} / ${a})` : `rgb(${r} ${g} ${b})`);

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const luminance = ({ r, g, b }: Rgba) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** WCAG 2 contrast ratio between two opaque colors. */
export function contrast(a: Rgba, b: Rgba): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}
