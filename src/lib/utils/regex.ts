export interface RegexMatch {
  index: number;
  match: string;
  groups: (string | undefined)[];
  named: Record<string, string | undefined>;
}

export function runRegex(pattern: string, flags: string, text: string, limit = 500): { matches: RegexMatch[]; error?: string } {
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`);
  } catch (e) {
    return { matches: [], error: e instanceof Error ? e.message : String(e) };
  }
  const matches: RegexMatch[] = [];
  for (const m of text.matchAll(re)) {
    matches.push({ index: m.index ?? 0, match: m[0], groups: m.slice(1), named: { ...(m.groups ?? {}) } });
    if (matches.length >= limit || (!flags.includes("g") && matches.length === 1)) break;
  }
  return { matches };
}
