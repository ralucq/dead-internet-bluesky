// bot_grade.mjs
// Turns the near yes/no score into GRADES OF EVIDENCE. It does not change the score. It asks:
// "if an account falls in this score band, how much more likely is that than for an ordinary account?"
//
// Reads:  data/score_combined.csv   (score 0-100 per account, from a model that did not see it)
// Writes: data/bot_grade.csv, data/bot_grade_report.txt
// Usage:  node bot_grade.mjs        (Node 18+, no packages, no network)

import { readFile, writeFile } from "node:fs/promises";
const DIR = "data";
let text;
try { text = await readFile(`${DIR}/score_combined.csv`, "utf8"); } catch { console.log(`Could not read ${DIR}/score_combined.csv. Run score_combined.mjs first, from the folder that contains the data folder.`); process.exit(1); }
function parseCsv(t) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const t = parseCsv(text.trim());
const accounts = t.slice(1).map((r) => Object.fromEntries(t[0].map((n, i) => [n, r[i]]))).map((a) => ({ ...a, label: Number(a.label), score: Number(a.score) })).filter((a) => Number.isFinite(a.score));

// Bands on the score. Edges are fixed in advance (not tuned): they are steps on the log-odds scale.
const BANDS = [
  ["0 very low (score under 2)", 0, 2],
  ["1 low (2 to 10)", 2, 10],
  ["2 slightly low (10 to 30)", 10, 30],
  ["3 unclear (30 to 70)", 30, 70],
  ["4 raised (70 to 90)", 70, 90],
  ["5 high (90 to 98)", 90, 98],
  ["6 very high (98 and over)", 98, 100.0001],
];
const bandOf = (s) => BANDS.findIndex(([, lo, hi]) => s >= lo && s < hi);
const bots = accounts.filter((a) => a.label === 1), comp = accounts.filter((a) => a.label === 0);
const lines = [];
const out = (s = "") => { console.log(s); lines.push(s); };
const pct = (x) => `${(100 * x).toFixed(0)}%`;

out("=== HOW TO READ THIS REPORT ===");
out("The score is almost two-valued (most accounts are near 0 or near 100). Instead of pretending to a");
out("fine scale, accounts are put in 7 bands, and each band is described by how often declared bots and");
out("ordinary accounts fall in it. 'Evidence ratio' = share of all bots in the band divided by share of");
out("all ordinary accounts in the band (0.5 added to each count so empty cells do not give 0 or infinity).");
out("A ratio of 10 means: an account in this band is 10 times more typical of bots than of ordinary");
out("accounts. The ratio does NOT depend on how many bots exist in the sample, so it also holds for");
out("a network where bots are rare. Band edges were fixed in advance, not tuned to the data.");
out(`\nAccounts: ${accounts.length} (bots ${bots.length}, comparison ${comp.length})\n`);

const rows = BANDS.map(([name], k) => {
  const nb = bots.filter((a) => bandOf(a.score) === k).length;
  const nc = comp.filter((a) => bandOf(a.score) === k).length;
  const ratio = ((nb + 0.5) / (bots.length + 0.5 * BANDS.length)) / ((nc + 0.5) / (comp.length + 0.5 * BANDS.length));
  return { name, nb, nc, ratio };
});
out("=== 1. THE BANDS ===");
out("band                           bots   comparison   share of bots   share of comparison   evidence ratio");
for (const r of rows) out(`${r.name.padEnd(30)} ${String(r.nb).padStart(4)}   ${String(r.nc).padStart(10)}   ${pct(r.nb / bots.length).padStart(13)}   ${pct(r.nc / comp.length).padStart(19)}   ${r.ratio.toFixed(r.ratio >= 10 ? 0 : 2).padStart(14)}`);
out(`\nMiddle bands (2 to 4, score 10 to 90): ${pct(accounts.filter((a) => { const k = bandOf(a.score); return k >= 2 && k <= 4; }).length / accounts.length)} of all accounts.`);
const ratios = rows.map((r) => r.ratio);
out("Do the ratios rise from band to band? " + (ratios.every((x, i) => i === 0 || x >= ratios[i - 1]) ? "yes, in every step" : "not in every step (small bands are noisy): " + ratios.map((x) => x.toFixed(1)).join(" -> ")));

out("\n=== 2. WHAT A BAND MEANS IF BOTS ARE RARE (example only) ===");
out("Chance that an account in the band is a declared bot, IF a given share of all accounts were declared bots.");
out("The share is an assumption, not a result. It is used only to show that the same band means less when bots are rare.");
out("band                           if 1 in 100   if 1 in 20   if 1 in 2 (like this sample)");
for (const r of rows) {
  const post = (p) => { const o = (r.ratio * p) / (1 - p); return o / (1 + o); };
  out(`${r.name.padEnd(30)} ${pct(post(0.01)).padStart(10)}   ${pct(post(0.05)).padStart(10)}   ${pct(post(0.5)).padStart(10)}`);
}

// Which accounts are in the middle: a few examples with their kind of profile, for reading.
out("\n=== 3. EXAMPLES FROM THE MIDDLE BANDS (2 to 4), for reading ===");
const mid = accounts.filter((a) => bandOf(a.score) >= 2 && bandOf(a.score) <= 4).sort((x, y) => x.score - y.score);
let seed = 5; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
for (let i = mid.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [mid[i], mid[j]] = [mid[j], mid[i]]; }
for (const a of mid.slice(0, 12)) out(`  ${a.score.toFixed(0).padStart(3)}  ${a.label === 1 ? "bot       " : "comparison"}  ${a.handle}`);

const csv = (v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
await writeFile(`${DIR}/bot_grade.csv`, ["label,did,handle,score,band,evidence_ratio", ...accounts.map((a) => { const k = bandOf(a.score); return [a.label, a.did, a.handle, a.score.toFixed(1), rows[k].name, rows[k].ratio.toFixed(2)].map(csv).join(","); })].join("\n") + "\n");
await writeFile(`${DIR}/bot_grade_report.txt`, lines.join("\n") + "\n");
console.log(`\nSaved: ${DIR}/bot_grade.csv and ${DIR}/bot_grade_report.txt`);
