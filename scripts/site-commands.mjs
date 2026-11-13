// Writes site/commands.json from the extension's registries, so the site's palette demo lists
// exactly the commands the extension ships.
import { readFileSync, writeFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
// `\s*`: the formatter moves long values to the next line.
const field = (block, name) => new RegExp(`${name}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(block)?.[1];

const panelsSrc = read("src/lib/panels.ts");
const panels = [
  ...panelsSrc
    .slice(panelsSrc.indexOf("export const PANELS"), panelsSrc.indexOf("export const PANEL_IDS"))
    .matchAll(/\{\s*id: "[^"]+",[\s\S]*?\}/g),
].map((m) => ({
  id: field(m[0], "id"),
  kind: "panel",
  category: field(m[0], "category"),
  title: field(m[0], "title"),
  description: field(m[0], "description"),
  keywords: field(m[0], "keywords") ?? "",
}));

const actionsSrc = read("src/lib/actions.ts");
const actions = [
  ...actionsSrc
    .slice(actionsSrc.indexOf("export const ACTIONS"))
    .matchAll(/\{\s*id: "[^"]+",[\s\S]*?category: "[^"]+",(?:\s*keywords: "[^"]*",)?/g),
].map((m) => ({
  id: field(m[0], "id"),
  kind: "action",
  category: field(m[0], "category"),
  title: field(m[0], "title"),
  description: field(m[0], "description"),
  keywords: field(m[0], "keywords") ?? "",
}));

const all = [...actions, ...panels];
if (all.some((c) => !c.id || !c.title || !c.category)) throw new Error("Could not parse a command");
writeFileSync(new URL("../site/commands.json", import.meta.url), `${JSON.stringify(all, null, 2)}\n`);
console.log(`site/commands.json: ${actions.length} actions, ${panels.length} panels`);
