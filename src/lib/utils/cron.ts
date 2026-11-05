// Explains a 5-field cron expression (minute hour day-of-month month day-of-week) in English.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

interface Field {
  name: string;
  min: number;
  max: number;
  names?: string[];
}
const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS.map((m) => m.slice(0, 3).toLowerCase()) },
  { name: "day of week", min: 0, max: 7, names: DAYS.map((d) => d.slice(0, 3).toLowerCase()) },
];

/** Every value a field matches. */
export function expandField(expr: string, field: Field): number[] {
  const values = new Set<number>();
  const num = (s: string) => {
    const lower = s.toLowerCase();
    const idx = field.names?.indexOf(lower) ?? -1;
    const n = idx >= 0 ? idx + (field.name === "month" ? 1 : 0) : Number(s);
    if (!Number.isInteger(n) || n < field.min || n > field.max)
      throw new Error(`"${s}" is out of range for ${field.name} (${field.min}–${field.max})`);
    return n;
  };
  for (const part of expr.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step "${stepStr}" in ${field.name}`);
    let lo: number;
    let hi: number;
    if (range === "*" || range === "?") [lo, hi] = [field.min, field.max];
    else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      lo = num(a!);
      hi = num(b!);
    } else {
      lo = num(range!);
      hi = stepStr === undefined ? lo : field.max;
    }
    for (let v = lo; v <= hi; v += step) values.add(field.name === "day of week" && v === 7 ? 0 : v);
  }
  return Array.from(values).sort((a, b) => a - b);
}

const list = (items: string[]) =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
const pad = (n: number) => String(n).padStart(2, "0");

export interface CronExplanation {
  text: string;
  next: Date[];
}

export function explainCron(input: string, from = new Date(), count = 5): CronExplanation {
  const expr = ALIASES[input.trim().toLowerCase()] ?? input.trim();
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) throw new Error(`Expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  const [mins, hours, doms, months, dows] = parts.map((p, i) => expandField(p, FIELDS[i]!)) as [
    number[],
    number[],
    number[],
    number[],
    number[],
  ];
  const all = (p: string) => p === "*" || p === "?";
  const [mP, hP, domP, monP, dowP] = parts as [string, string, string, string, string];

  let time: string;
  if (all(mP) && all(hP)) time = "every minute";
  else if (mP.startsWith("*/") && all(hP)) time = `every ${mP.slice(2)} minutes`;
  else if (all(hP)) time = `at minute ${list(mins.map(String))} of every hour`;
  else if (mins.length === 1 && hours.length <= 6) time = `at ${list(hours.map((h) => `${pad(h)}:${pad(mins[0]!)}`))}`;
  else time = `at minute ${list(mins.map(String))} past hour ${list(hours.map(String))}`;

  const when: string[] = [];
  if (!all(domP)) when.push(`on day ${list(doms.map(String))} of the month`);
  if (!all(dowP)) when.push(`on ${list(dows.map((d) => DAYS[d]!))}`);
  if (!all(monP)) when.push(`in ${list(months.map((m) => MONTHS[m - 1]!))}`);
  const text = [time, ...when].join(", ").replace(/^./, (c) => c.toUpperCase());

  // Cron's rule: when both day fields are restricted, either one matching is enough.
  const domAll = all(domP);
  const dowAll = all(dowP);
  const next: Date[] = [];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let guard = 0; next.length < count && guard < 600_000; guard++) {
    const dayOk =
      domAll && dowAll
        ? true
        : domAll
          ? dows.includes(d.getDay())
          : dowAll
            ? doms.includes(d.getDate())
            : doms.includes(d.getDate()) || dows.includes(d.getDay());
    if (!months.includes(d.getMonth() + 1) || !dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!hours.includes(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (mins.includes(d.getMinutes())) next.push(new Date(d.getTime()));
    d.setMinutes(d.getMinutes() + 1);
  }
  return { text, next };
}
