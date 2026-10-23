// lowest_bots.mjs
// Looks at the bots that the combined score takes for ordinary accounts (the lowest scores):
// what do they look like, and how do they differ from the other bots?
//
// Reads:  data/score_combined.csv, data/features_profile.csv, data/features_behaviour.csv,
//         data/features_graph.csv, data/features_content.csv, data/bots_curated.json
// Writes: data/lowest_bots_report.txt
//
// Usage:  node lowest_bots.mjs
//         node lowest_bots.mjs --below 30 --show 30
// Needs Node 18+. No packages, no network.

import { readFile, writeFile } from "node:fs/promises";

const o = { below: 30, show: 30, dir: "data" };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--below") o.below = Number(process.argv[++i]);
  else if (process.argv[i] === "--show") o.show = Number(process.argv[++i]);
  else if (process.argv[i] === "--dir") o.dir = process.argv[++i];
}
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
async function table(name) {
  let text;
  try { text = await readFile(`${o.dir}/${name}`, "utf8"); } catch { return null; }
  const t = parseCsv(text.trim());
  const map = new Map();
  for (const r of t.slice(1)) {
    const rec = {};
    t[0].forEach((n, i) => { rec[n] = r[i]; });
    map.set(rec.did, rec);
  }
  return map;
}
const S = await table("score_combined.csv");
const P = await table("features_profile.csv");
const B = await table("features_behaviour.csv");
const G = await table("features_graph.csv");
const C = await table("features_content.csv");
if (!S || !P || !B || !G) { console.log("Missing files. Run the earlier steps first, from the folder that contains the data folder."); process.exit(1); }
let bios = new Map();
try { for (const b of JSON.parse(await readFile(`${o.dir}/bots_curated.json`, "utf8"))) bios.set(b.did, (b.description ?? "").replace(/\s+/g, " ").trim()); } catch {}

const KEYS = [
  ["posts per day (lifetime)", P, "postsPerDay"],
  ["follows", P, "follows"],
  ["followers", P, "followers"],
  ["items per day (recent)", B, "itemsPerDay"],
  ["share of replies", B, "replyShare"],
  ["share of reposts", B, "repostShare"],
  ["posts with no reaction", B, "zeroEngagementShare"],
  ["same first 3 words", B, "templateShare"],
  ["same minute of the hour", B, "minuteModeShare"],
  ["followers that follow back", G, "mutualOfFollowers"],
  ["bot-labeled followers", G, "followerBotShare"],
  ...(C ? [["similarity between posts", C, "charSimilarity"], ["uneven post lengths", C, "lengthCV"]] : []),
];
const med = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const val = (src, did, k) => { const v = src?.get(did)?.[k]; return v === undefined || v === "" ? NaN : Number(v); };
const fmt = (x) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) : "n/a");

const all = [...S.values()].map((r) => ({ did: r.did, handle: r.handle, label: Number(r.label), score: Number(r.score) }));
const low = all.filter((a) => a.label === 1 && a.score < o.below).sort((a, b) => a.score - b.score);
const high = all.filter((a) => a.label === 1 && a.score >= o.below);
const comp = all.filter((a) => a.label === 0);

const lines = [];
const out = (s = "") => { console.log(s); lines.push(s); };
out("=== HOW TO READ THIS REPORT ===");
out(`Bots that score below ${o.below} (out of 100) look like ordinary accounts to the score. This report compares`);
out("them with the other bots and with the comparison accounts, signal by signal (medians).\n");
out(`Bots below ${o.below}: ${low.length} of ${low.length + high.length} (${((100 * low.length) / (low.length + high.length)).toFixed(1)}%)\n`);
out("=== 1. MEDIANS ===");
out("signal                          low-scoring bots | other bots | comparison accounts");
for (const [name, src, k] of KEYS) {
  const m = (group) => med(group.map((a) => val(src, a.did, k)));
  out(`${name.padEnd(30)}  ${fmt(m(low)).padStart(12)}     | ${fmt(m(high)).padStart(9)}  | ${fmt(m(comp)).padStart(9)}`);
}
out("\nRead the table across: where the low-scoring bots are close to the comparison column and far from");
out("the other bots, that signal is why they are missed.\n");
out(`=== 2. THE ${Math.min(o.show, low.length)} LOWEST-SCORING BOTS ===`);
out("score  handle  |  posts/day, follows, followers, replies, no-reaction, template  |  bio");
for (const a of low.slice(0, o.show)) {
  const v = (src, k) => fmt(val(src, a.did, k));
  out(`${a.score.toFixed(0).padStart(3)}  ${a.handle}  |  ${v(P, "postsPerDay")}, ${v(P, "follows")}, ${v(P, "followers")}, ${v(B, "replyShare")}, ${v(B, "zeroEngagementShare")}, ${v(B, "templateShare")}`);
  out(`       bio: ${(bios.get(a.did) ?? "").slice(0, 130) || "(none)"}`);
}
await writeFile(`${o.dir}/lowest_bots_report.txt`, lines.join("\n") + "\n");
console.log(`\nSaved: ${o.dir}/lowest_bots_report.txt`);
