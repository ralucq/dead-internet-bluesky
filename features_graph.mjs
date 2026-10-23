// features_graph.mjs
// Measures SOCIAL-CONNECTION signals from data/graph.json (made by collect_graph.mjs) and tests
// every signal alone with AUC, the same way as the profile and behaviour signals.
//
// Reads:  data/graph.json, data/graph_status.json, data/features_profile.csv
// Writes: data/features_graph.csv, data/features_graph_report.txt
//
// Usage:  node features_graph.mjs
//         node features_graph.mjs --asof 2026-10-23 --boot 300 --seed 1
// Needs Node 18+. No packages, no network.

import { readFile, writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const o = { boot: 300, seed: 1, minSample: 10, asof: new Date().toISOString(), dir: "data" };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--boot") o.boot = Number(argv[++i]);
    else if (argv[i] === "--seed") o.seed = Number(argv[++i]);
    else if (argv[i] === "--min-sample") o.minSample = Number(argv[++i]);
    else if (argv[i] === "--asof") o.asof = new Date(argv[++i]).toISOString();
    else if (argv[i] === "--dir") o.dir = argv[++i];
  }
  return o;
}
const args = parseArgs(process.argv);
const asofMs = Date.parse(args.asof);

const lines = [];
const out = (s = "") => { console.log(s); lines.push(s); };

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
async function readOrExit(path, hint) {
  try { return await readFile(path, "utf8"); } catch { console.log(`Could not read ${path}. ${hint}`); process.exit(1); }
}

const graph = JSON.parse(await readOrExit(`${args.dir}/graph.json`, "Run collect_graph.mjs first, from the folder that contains the data folder."));
const status = JSON.parse(await readOrExit(`${args.dir}/graph_status.json`, "Run collect_graph.mjs first."));
const table = parseCsv((await readOrExit(`${args.dir}/features_profile.csv`, "Run features_profile.mjs first.")).trim());
const H = table[0];
const people = table.slice(1).map((r) => ({
  label: Number(r[H.indexOf("label")]), did: r[H.indexOf("did")], handle: r[H.indexOf("handle")], operator: r[H.indexOf("operator")],
  followers: Number(r[H.indexOf("followers")]), follows: Number(r[H.indexOf("follows")]),
}));

const FEATURES = [
  ["sampleFollowers", "followers in the sample (the 100 most recent at most)"],
  ["mutualOfFollowers", "share of the sampled followers that the account follows back (only when it follows 100 or fewer)"],
  ["mutualOfFollows", "share of the accounts it follows that follow it back (only when it has 100 or fewer followers)"],
  ["followerAgeMedianDays", "median age in days of its followers' accounts"],
  ["followerNewShare", "share of followers whose account is under 30 days old"],
  ["followerDayModeShare", "share of followers created on the single most common day (a burst = many accounts made together)"],
  ["followerEmptyShare", "share of followers with no picture, no name and no bio"],
  ["followerNoAvatarShare", "share of followers without a profile picture"],
  ["followerBotShare", "share of followers that carry the bot self-label"],
  ["followerDigitShare", "average share of digits in the handles of followers"],
  ["followsAgeMedianDays", "median age in days of the accounts it follows"],
  ["followsEmptyShare", "share of followed accounts with no picture, no name and no bio"],
  ["followsBotShare", "share of followed accounts that carry the bot self-label"],
];

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const share = (arr, f) => arr.filter(f).length / arr.length;
const maxShare = (values) => { const c = new Map(); for (const v of values) c.set(v, (c.get(v) ?? 0) + 1); return Math.max(...c.values()) / values.length; };
const ageDays = (a) => { const ms = Date.parse(a.c ?? ""); return Number.isFinite(ms) ? Math.max(0, (asofMs - ms) / 86400000) : NaN; };
const digitShare = (h) => { const l = (h ?? "").split(".")[0]; return l.length ? (l.match(/[0-9]/g) ?? []).length / l.length : NaN; };
const empty = (a) => !a.av && !a.nm && !a.bio;

function featuresOf(g, p) {
  const f = Object.fromEntries(FEATURES.map(([n]) => [n, NaN]));
  const F = g.followers;
  const G = g.follows;
  f.sampleFollowers = F.length;
  if (F.length >= args.minSample) {
    const ages = F.map(ageDays).filter(Number.isFinite);
    f.followerAgeMedianDays = median(ages);
    f.followerNewShare = share(ages, (a) => a < 30);
    const days = F.map((a) => (a.c ?? "").slice(0, 10)).filter(Boolean);
    if (days.length) f.followerDayModeShare = maxShare(days);
    f.followerEmptyShare = share(F, empty);
    f.followerNoAvatarShare = share(F, (a) => !a.av);
    f.followerBotShare = share(F, (a) => a.bot);
    const dg = F.map((a) => digitShare(a.h)).filter(Number.isFinite);
    if (dg.length) f.followerDigitShare = mean(dg);
    if (p.follows <= 100) {
      const followed = new Set(G.map((a) => a.d));
      f.mutualOfFollowers = share(F, (a) => followed.has(a.d));
    }
  }
  if (G.length >= args.minSample) {
    const ages = G.map(ageDays).filter(Number.isFinite);
    f.followsAgeMedianDays = median(ages);
    f.followsEmptyShare = share(G, empty);
    f.followsBotShare = share(G, (a) => a.bot);
    if (p.followers <= 100) {
      const followers = new Set(F.map((a) => a.d));
      f.mutualOfFollows = share(G, (a) => followers.has(a.d));
    }
  }
  return f;
}

function auc(botVals, compVals) {
  const all = [...botVals.map((v) => [v, 1]), ...compVals.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]);
  let rs = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    for (let k = i; k <= j; k++) if (all[k][1] === 1) rs += (i + j) / 2 + 1;
    i = j + 1;
  }
  return (rs - (botVals.length * (botVals.length + 1)) / 2) / (botVals.length * compVals.length);
}
const fmt = (x) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) : "n/a");

const rows = people.filter((p) => graph[p.did]).map((p) => ({ ...p, f: featuresOf(graph[p.did], p) }));

out("=== HOW TO READ THIS REPORT ===");
out("Signals about the account's connections: who follows it, whom it follows, and what those");
out("accounts look like. Each is tested alone with AUC: the chance that a random bot has a");
out("HIGHER value than a random comparison account (0.50 = nothing, 1.00 = bots always higher,");
out("0.00 = bots always lower). Strength folds both directions. The 95% interval draws whole");
out("maker groups together. Only the 100 most recent followers and the first 100 follows are");
out("looked at, so these describe recent connections, not the whole network.\n");

out("=== 1. COVERAGE ===");
for (const label of [1, 0]) {
  const st = Object.values(status).filter((s) => s.label === label);
  const c = {};
  for (const s of st) c[s.status] = (c[s.status] ?? 0) + 1;
  out(`${label === 1 ? "Bots" : "Comparison"}: ${st.length} accounts; ` + Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", "));
}
const withFollowers = (l) => rows.filter((r) => r.label === l && r.f.sampleFollowers >= args.minSample).length;
out(`With at least ${args.minSample} followers in the sample: bots ${withFollowers(1)}, comparison ${withFollowers(0)}`);
out("The signals about followers cannot be computed for accounts with very few followers.\n");

const random = seededRandom(args.seed);
const groups = new Map();
for (const r of rows.filter((r) => r.label === 1)) { if (!groups.has(r.operator)) groups.set(r.operator, []); groups.get(r.operator).push(r); }
const groupList = [...groups.values()];
const compRows = rows.filter((r) => r.label === 0);

const results = [];
for (const [name, description] of FEATURES) {
  const bv = rows.filter((r) => r.label === 1).map((r) => r.f[name]).filter(Number.isFinite);
  const cv = compRows.map((r) => r.f[name]).filter(Number.isFinite);
  if (bv.length < 20 || cv.length < 20) { results.push({ name, description, point: NaN, nb: bv.length, nc: cv.length }); continue; }
  const point = auc(bv, cv);
  const draws = [];
  for (let b = 0; b < args.boot; b++) {
    const bs = [];
    for (let i = 0; i < groupList.length; i++) {
      const g = groupList[Math.floor(random() * groupList.length)];
      for (const r of g) if (Number.isFinite(r.f[name])) bs.push(r.f[name]);
    }
    const cs = [];
    for (let i = 0; i < compRows.length; i++) { const v = compRows[Math.floor(random() * compRows.length)].f[name]; if (Number.isFinite(v)) cs.push(v); }
    if (bs.length && cs.length) draws.push(auc(bs, cs));
  }
  draws.sort((a, b) => a - b);
  results.push({ name, description, point, nb: bv.length, nc: cv.length, lo: draws[Math.floor(0.025 * draws.length)], hi: draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))], botMed: median(bv), compMed: median(cv) });
}

out("=== 2. EACH SIGNAL ALONE (sorted by strength) ===");
out("signal                 AUC   [95% range]    strength  bots tend to be   median bots | median comparison   (n bots / n comp)");
const sorted = results.filter((r) => Number.isFinite(r.point)).sort((a, b) => Math.abs(b.point - 0.5) - Math.abs(a.point - 0.5));
for (const r of sorted) {
  const dir = Math.abs(r.point - 0.5) < 0.03 ? "about equal" : r.point > 0.5 ? "higher" : "lower";
  out(`${r.name.padEnd(22)} ${r.point.toFixed(2)}  [${r.lo.toFixed(2)}-${r.hi.toFixed(2)}]   ${Math.max(r.point, 1 - r.point).toFixed(2)}      ${dir.padEnd(14)}  ${fmt(r.botMed).padStart(8)} | ${fmt(r.compMed).padEnd(10)}   (${r.nb} / ${r.nc})`);
}
for (const r of results.filter((r) => !Number.isFinite(r.point))) out(`${r.name.padEnd(22)} not enough accounts with this signal (${r.nb} bots / ${r.nc} comparison)`);

out("\n=== 3. WHAT EACH SIGNAL MEANS ===");
for (const [n, d] of FEATURES) out(`${n.padEnd(22)} ${d}`);

out("\n=== 4. CHECKS ===");
out("Signals that need few followers or few follows are only computed for such accounts, so the");
out("two groups may be compared on different kinds of accounts: look at the n columns.");
out("Followers who are themselves bots (followerBotShare) show whether bots cluster together.");
out("Note that this uses the bot label of OTHER accounts, never the label of the account itself.");

const csv = (v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const cl = [["label", "did", "handle", "operator", ...FEATURES.map(([n]) => n)].join(",")];
for (const r of rows) cl.push([r.label, r.did, r.handle, r.operator, ...FEATURES.map(([n]) => (Number.isFinite(r.f[n]) ? +r.f[n].toFixed(6) : ""))].map(csv).join(","));
await writeFile(`${args.dir}/features_graph.csv`, cl.join("\n") + "\n");
await writeFile(`${args.dir}/features_graph_report.txt`, lines.join("\n") + "\n");
console.log(`\nSaved: ${args.dir}/features_graph.csv and ${args.dir}/features_graph_report.txt`);
