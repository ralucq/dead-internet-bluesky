// bot_types.mjs
// Shows which KINDS of bots the combined score finds and which it misses.
// The kind is guessed from words in the bio (first matching kind wins). It is a rough sort used
// ONLY for this report: it is not a signal in the score and it is not checked by hand.
//
// Reads:  data/bots_curated.json, data/score_combined.csv, data/features_profile.csv
// Writes: data/bot_types.csv, data/bot_types_report.txt
//
// Usage:  node bot_types.mjs
// Needs Node 18+. No packages, no network.

import { readFile, writeFile } from "node:fs/promises";

const DIR = "data";
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function readOrExit(name) {
  try { return await readFile(`${DIR}/${name}`, "utf8"); } catch { console.log(`Could not read ${DIR}/${name}. Run the earlier steps first, from the folder that contains the data folder.`); process.exit(1); }
}
const asMap = (text) => {
  const t = parseCsv(text.trim());
  const m = new Map();
  for (const r of t.slice(1)) { const o = {}; t[0].forEach((n, i) => { o[n] = r[i]; }); m.set(o.did, o); }
  return m;
};
const scores = asMap(await readOrExit("score_combined.csv"));
const profile = asMap(await readOrExit("features_profile.csv"));
const bots = JSON.parse(await readOrExit("bots_curated.json"));

// Kinds, in priority order. Each has a pattern over the bio and display name.
const KINDS = [
  ["AI agent or chatbot", /\b(ai agent|ai bot|ai-powered|ai powered|ai-driven|llm|gpt|claude|chatbot|chat bot|artificial intelligence|agentic|i am an ai|i'm an ai|language model|mention me|ask me)\b/i],
  ["persona (pronouns, 'I')", /\b(she\/her|he\/him|they\/them|it\/its|she\/they|he\/they|it\/she|i'm a|i am a|my name is|lives in|she is|he is)\b/i],
  ["mirror or bridge", /\b(mirror|mirrors|bridged|cross-?post|crossposts|archive of|backup of|reposts? from|copies of)\b/i],
  ["weather, alerts, transit", /\b(weather|forecast|alerts?|warnings?|earthquakes?|storms?|tornado|transit|train|trains|bus|traffic|outage|flood|delays?|service status)\b/i],
  ["tracking, data, government", /\b(track|tracks|tracking|tracker|stats|statistics|data|monitor|monitoring|counts?|trending|leaderboard|analytics|legislation|bills|congress|government|senate|court|market|prices?|stocks?|crypto|bitcoin|sewage|planning|water)\b/i],
  ["news or feeds", /\b(news|headlines?|rss|feed|feeds|press|journal|articles?|newsletter|posts? every|latest from)\b/i],
  ["art, images, space", /\b(art|artwork|image|images|photo|photos|picture|pictures|paint|painting|gallery|space|nasa|astronomy|gif|gifs|pixel|generative|visual|illustrations?|museum|aesthetic)\b/i],
  ["quotes, text, books", /\b(quote|quotes|poem|poems|poetry|words of|literary|literature|book|books|novel|haiku|lyrics|excerpts?|sentences?|fiction|stories)\b/i],
];
const typeOf = (b) => {
  const text = `${b.description ?? ""} ${b.displayName ?? ""}`;
  for (const [name, re] of KINDS) if (re.test(text)) return name;
  return "other (no keyword)";
};

const rows = [];
for (const b of bots) {
  const s = scores.get(b.did);
  if (!s) continue;
  rows.push({
    did: b.did, handle: b.handle, type: typeOf(b), score: Number(s.score),
    bio: (b.description ?? "").replace(/\s+/g, " ").trim(),
    follows: Number(profile.get(b.did)?.follows ?? NaN),
  });
}

const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "n/a");
const types = [...KINDS.map((k) => k[0]), "other (no keyword)"];
const lines = [];
const out = (s = "") => { console.log(s); lines.push(s); };

out("=== HOW TO READ THIS REPORT ===");
out("Each bot is put into ONE kind from words in its bio (first matching kind wins, in the order of the");
out("table). This sorting is rough and was not checked by hand. A bot with no matching word is 'other'.");
out("For each kind: how many bots, the typical score, and how many are found (score 50 or more) or");
out("clearly missed (score below 30). Score = the combined score, each bot scored by a model that never");
out("saw it or its maker group.\n");
out(`Bots: ${rows.length}\n`);
out("=== 1. SCORE BY KIND OF BOT ===");
out("kind                          bots   median score   found (>=50)   missed (<30)   median follows");
for (const t of types) {
  const g = rows.filter((r) => r.type === t);
  if (!g.length) continue;
  out(`${t.padEnd(29)} ${String(g.length).padStart(4)}   ${med(g.map((r) => r.score)).toFixed(0).padStart(12)}   ${pct(g.filter((r) => r.score >= 50).length, g.length).padStart(12)}   ${pct(g.filter((r) => r.score < 30).length, g.length).padStart(12)}   ${med(g.map((r) => r.follows)).toFixed(0).padStart(14)}`);
}
out("\n=== 2. EXAMPLES FOR CHECKING THE SORT (3 lowest-scoring bots of each kind) ===");
for (const t of types) {
  const g = rows.filter((r) => r.type === t).sort((a, b) => a.score - b.score).slice(0, 3);
  if (!g.length) continue;
  out(`\n${t}`);
  for (const r of g) out(`  ${r.score.toFixed(0).padStart(3)}  ${r.handle}  |  ${r.bio.slice(0, 110) || "(no bio)"}`);
}
out("\n=== 3. A RANDOM LOOK AT 'OTHER' (to see what the keywords miss) ===");
const other = rows.filter((r) => r.type === "other (no keyword)");
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
for (let i = other.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [other[i], other[j]] = [other[j], other[i]]; }
for (const r of other.slice(0, 10)) out(`  ${r.score.toFixed(0).padStart(3)}  ${r.handle}  |  ${r.bio.slice(0, 110) || "(no bio)"}`);

const csv = (v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
await writeFile(`${DIR}/bot_types.csv`, ["did,handle,type,score", ...rows.map((r) => [r.did, r.handle, r.type, r.score.toFixed(1)].map(csv).join(","))].join("\n") + "\n");
await writeFile(`${DIR}/bot_types_report.txt`, lines.join("\n") + "\n");
console.log(`\nSaved: ${DIR}/bot_types.csv and ${DIR}/bot_types_report.txt`);
