// Refreshes public/schema-vocab.json, the Schema.org vocabulary the Structured data panel validates
// JSON-LD against, locally. Usage: pnpm schema-vocab [version]
//
// It reads the current release number from the schemaorg/schemaorg repository (versions.json), downloads
// that release's vocabulary (https://schema.org/version/<version>/schemaorg-current-https.jsonld: core,
// pending and the hosted extensions) and keeps what the checks need: each type with its direct parents,
// each property with its domainIncludes and rangeIncludes, the members of each enumeration, superseded
// terms with their replacement, and which terms are still pending. Comments, labels other than the term
// names, equivalences to other vocabularies and contributors are dropped. The license notice ships next
// to the data (public/schema-vocab.LICENSE.txt).
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const get = async (url, as = "json") => {
  const res = await fetch(url, { headers: { "user-agent": "devkit-schema-vocab" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return as === "json" ? res.json() : res.text();
};

const versions = await get("https://raw.githubusercontent.com/schemaorg/schemaorg/main/versions.json");
const version = process.argv[2] ?? versions.schemaversion;
const date = versions.releaseLog?.[version];
if (!date) throw new Error(`Schema.org release ${version} is not in versions.json`);
const file = `https://schema.org/version/${version}/schemaorg-current-https.jsonld`;
const graph = (await get(file))["@graph"];

const SCHEMA = "schema:";
const name = (ref) => {
  const id = typeof ref === "string" ? ref : ref?.["@id"];
  return typeof id === "string" && id.startsWith(SCHEMA) ? id.slice(SCHEMA.length) : null;
};
const names = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(name).filter(Boolean);
const sorted = (xs) => Array.from(new Set(xs)).sort();

const types = {};
const properties = {};
const members = {};
const superseded = {};
const pending = [];
let dataTypes = [];

for (const node of graph) {
  const id = name(node["@id"]);
  if (!id) continue;
  const kinds = [].concat(node["@type"] ?? []);
  if (kinds.includes("rdfs:Class")) {
    types[id] = sorted(names(node["rdfs:subClassOf"]));
    if (kinds.includes("schema:DataType")) dataTypes.push(id);
  } else if (kinds.includes("rdf:Property")) {
    properties[id] = [sorted(names(node["schema:domainIncludes"])), sorted(names(node["schema:rangeIncludes"]))];
  } else {
    // An enumeration member: its @type is the enumeration (or several).
    const of = names(kinds);
    if (of.length) members[id] = sorted(of);
  }
  const next = names(node["schema:supersededBy"]);
  if (next.length) superseded[id] = next[0];
  if ([].concat(node["schema:isPartOf"] ?? []).some((p) => p?.["@id"] === "https://pending.schema.org")) pending.push(id);
}
dataTypes = sorted(dataTypes);

const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const changes =
  "Trimmed by devkit's scripts/schema-vocab.mjs: only schema.org terms are kept, each type with its direct parents (rdfs:subClassOf), each property with its domainIncludes and rangeIncludes, enumeration members with their enumeration, supersededBy and the pending flag; comments, labels, equivalences to other vocabularies, sources and contributors are dropped; the format is devkit's own compact JSON.";
const vocab = {
  source: {
    name: "Schema.org",
    url: "https://schema.org",
    file,
    version,
    date,
    license: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
    terms: "https://schema.org/docs/terms.html",
    changes,
  },
  dataTypes,
  types: sortKeys(types),
  properties: sortKeys(properties),
  members: sortKeys(members),
  superseded: sortKeys(superseded),
  pending: sorted(pending),
};

const out = join(root, "public/schema-vocab.json");
const json = `${JSON.stringify(vocab)}\n`;
writeFileSync(out, json);
writeFileSync(
  join(root, "public/schema-vocab.LICENSE.txt"),
  `public/schema-vocab.json is derived from the Schema.org vocabulary, release ${version} (${date}),
downloaded from ${file}.

${changes}

Schema.org (https://schema.org) is sponsored by Google, Inc., Yahoo, Inc., Microsoft Corporation and Yandex.
From the Schema.org Terms of Service (https://schema.org/docs/terms.html):

  "The Sponsors' copyrights in the schema are licensed to website publishers and other third parties
  under the Creative Commons Attribution-ShareAlike License (version 3.0). To view a copy of this
  license, please visit http://creativecommons.org/licenses/by-sa/3.0/."

This derived file is shared under the same license, Creative Commons Attribution-ShareAlike 3.0
Unported (CC BY-SA 3.0): https://creativecommons.org/licenses/by-sa/3.0/legalcode
`,
);
console.log(
  `${Object.keys(types).length} types, ${Object.keys(properties).length} properties, ${Object.keys(members).length} enumeration members, ` +
    `${Object.keys(superseded).length} superseded, ${pending.length} pending, Schema.org ${version} (${date}) → public/schema-vocab.json (${(json.length / 1024).toFixed(0)} KB)`,
);
