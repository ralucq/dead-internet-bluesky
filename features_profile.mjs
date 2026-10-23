// features_profile.mjs
// Step 1 of the score: signals that come straight from the profile (no new data needed).
// For each signal it answers: how well does it, on its own, tell the bots from the
// comparison accounts? The answer is a number called AUC (explained in the report).
//
// Reads:  data/bots_curated.json, data/comparison_clean.json
// Writes: data/features_profile.csv     one row per account, all signals (for later steps)
//         data/features_profile_report.txt
//
// Usage:  node features_profile.mjs
//         node features_profile.mjs --asof 2026-10-22   (date used to compute account age)
//         node features_profile.mjs --boot 300 --seed 1
// Needs Node 18+. No packages, no network.

import { readFile, writeFile } from "node:fs/promises";

const BOTS_FILE = "data/bots_curated.json";
const COMP_FILE = "data/comparison_clean.json";
const CSV_FILE = "data/features_profile.csv";
const REPORT_FILE = "data/features_profile_report.txt";

function parseArgs(argv) {
  const out = { asof: new Date().toISOString(), boot: 300, seed: 1, bots: BOTS_FILE, comp: COMP_FILE };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--asof") out.asof = new Date(argv[++i]).toISOString();
    else if (argv[i] === "--boot") out.boot = Number(argv[++i]);
    else if (argv[i] === "--seed") out.seed = Number(argv[++i]);
    else if (argv[i] === "--bots") out.bots = argv[++i];
    else if (argv[i] === "--comp") out.comp = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv);
const asofMs = Date.parse(args.asof);

const lines = [];
const out = (s = "") => {
  console.log(s);
  lines.push(s);
};

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

async function load(path, what) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    console.log(`Could not read ${path} (${what}). Run it from the folder that contains the data folder.`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------ the signals
// Each signal is a number per account. Nothing here reads WHAT the bio says: the bots were
// found by searching for words like "bot" and "rss", so bio words would give the answer away.
const FEATURES = [
  ["ageDays", "account age in days (matched by design, so it should NOT separate the groups)"],
  ["posts", "number of posts"],
  ["postsPerDay", "posts per day since the account was created"],
  ["followers", "number of followers"],
  ["follows", "number of accounts it follows"],
  ["followRatio", "(followers + 1) / (follows + 1): how much more it is followed than it follows"],
  ["hasAvatar", "has a profile picture (1/0)"],
  ["hasBanner", "has a banner image (1/0)"],
  ["hasDisplayName", "has a display name (1/0)"],
  ["hasBio", "has a bio (1/0)"],
  ["bioLength", "length of the bio in characters"],
  ["customDomain", "handle is its own web address, not name.bsky.social (1/0)"],
  ["handleLength", "length of the handle before the first dot"],
  ["handleDigitShare", "share of digits in the handle before the first dot"],
];

function featuresOf(entry) {
  const p = entry.profile ?? {};
  const handle = (entry.handle ?? p.handle ?? "").toLowerCase();
  const local = handle.split(".")[0] ?? "";
  const created = Date.parse(p.createdAt ?? entry.createdAt ?? "");
  const ageDays = Number.isFinite(created) ? Math.max(1, (asofMs - created) / 86400000) : NaN;
  const posts = p.postsCount ?? NaN;
  const followers = p.followersCount ?? NaN;
  const follows = p.followsCount ?? NaN;
  const bio = (p.description ?? entry.description ?? "").trim();
  const name = (p.displayName ?? entry.displayName ?? "").trim();
  return {
    ageDays,
    posts,
    postsPerDay: posts / ageDays,
    followers,
    follows,
    followRatio: (followers + 1) / (follows + 1),
    hasAvatar: p.avatar ? 1 : 0,
    hasBanner: p.banner ? 1 : 0,
    hasDisplayName: name ? 1 : 0,
    hasBio: bio ? 1 : 0,
    bioLength: bio.length,
    customDomain: handle.endsWith(".bsky.social") ? 0 : 1,
    handleLength: local.length,
    handleDigitShare: local.length ? (local.match(/[0-9]/g) ?? []).length / local.length : 0,
  };
}

// ------------------------------------------------------------------------ AUC
// AUC = chance that a randomly chosen bot has a HIGHER value than a randomly chosen
// comparison account (ties count half). 0.5 = no information, 1.0 = bots always higher,
// 0.0 = bots always lower.
function auc(botVals, compVals) {
  const all = [];
  for (const v of botVals) all.push([v, 1]);
  for (const v of compVals) all.push([v, 0]);
  all.sort((a, b) => a[0] - b[0]);
  let rankSumBots = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k][1] === 1) rankSumBots += avgRank;
    i = j + 1;
  }
  const nb = botVals.length;
  const nc = compVals.length;
  return (rankSumBots - (nb * (nb + 1)) / 2) / (nb * nc);
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const q = (arr, f) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN;
};
const fmt = (x) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) : "n/a");

// ------------------------------------------------------------------------ main
const bots = await load(args.bots, "curated bots");
const comp = await load(args.comp, "comparison accounts");
const usable = (e) => e.profile && Number.isFinite(e.profile.postsCount);
const botsOk = bots.filter(usable);
const compOk = comp.filter(usable);

const rows = [
  ...botsOk.map((e) => ({ label: 1, did: e.did, handle: e.handle, operator: e.operator ?? e.did, f: featuresOf(e) })),
  ...compOk.map((e) => ({ label: 0, did: e.did, handle: e.handle, operator: e.did, f: featuresOf(e) })),
];

out("=== HOW TO READ THIS REPORT ===");
out("Each signal is tested alone: how well does it separate the bots from the comparison");
out("accounts? The measure is AUC: the chance that a random bot has a HIGHER value than a");
out("random comparison account. 0.50 means the signal tells nothing, 1.00 means bots are");
out("always higher, 0.00 means bots are always lower. 'Strength' folds both directions, so");
out("0.50 = nothing and 1.00 = perfect. The range in brackets is a 95% interval: if it");
out("includes 0.50 (or 1.00 - 0.50 on the strength scale), do not trust the signal.");
out("These are first looks, not final results: nothing is combined or tuned yet.\n");

out("=== 1. DATA ===");
out(`Curated bots with a profile:       ${botsOk.length} of ${bots.length}  (in ${new Set(botsOk.map((e) => e.operator ?? e.did)).size} maker groups)`);
out(`Comparison accounts with a profile: ${compOk.length} of ${comp.length}`);
out(`Account age measured on: ${args.asof.slice(0, 10)}\n`);

// Cluster bootstrap: bots from the same maker are not independent, so whole maker groups
// are drawn together; comparison accounts are drawn one by one.
const random = seededRandom(args.seed);
const botGroups = new Map();
for (const r of rows.filter((r) => r.label === 1)) {
  if (!botGroups.has(r.operator)) botGroups.set(r.operator, []);
  botGroups.get(r.operator).push(r);
}
const groupList = [...botGroups.values()];
const compRows = rows.filter((r) => r.label === 0);

const results = [];
for (const [name, description] of FEATURES) {
  const bv = rows.filter((r) => r.label === 1).map((r) => r.f[name]).filter(Number.isFinite);
  const cv = compRows.map((r) => r.f[name]).filter(Number.isFinite);
  const point = auc(bv, cv);
  const draws = [];
  for (let b = 0; b < args.boot; b++) {
    const bs = [];
    for (let i = 0; i < groupList.length; i++) {
      const g = groupList[Math.floor(random() * groupList.length)];
      for (const r of g) if (Number.isFinite(r.f[name])) bs.push(r.f[name]);
    }
    const cs = [];
    for (let i = 0; i < compRows.length; i++) {
      const v = compRows[Math.floor(random() * compRows.length)].f[name];
      if (Number.isFinite(v)) cs.push(v);
    }
    draws.push(auc(bs, cs));
  }
  draws.sort((a, b) => a - b);
  results.push({
    name,
    description,
    point,
    lo: draws[Math.floor(0.025 * draws.length)],
    hi: draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))],
    botMed: median(bv),
    compMed: median(cv),
    botQ: [q(bv, 0.25), q(bv, 0.75)],
    compQ: [q(cv, 0.25), q(cv, 0.75)],
  });
}

out("=== 2. EACH SIGNAL ALONE (sorted by strength) ===");
out("signal            AUC   [95% range]    strength  bots tend to be   median bots | median comparison");
const sorted = [...results].sort((a, b) => Math.abs(b.point - 0.5) - Math.abs(a.point - 0.5));
for (const r of sorted) {
  const strength = Math.max(r.point, 1 - r.point);
  const dir = Math.abs(r.point - 0.5) < 0.03 ? "about equal" : r.point > 0.5 ? "higher" : "lower";
  out(
    `${r.name.padEnd(17)} ${r.point.toFixed(2)}  [${r.lo.toFixed(2)}-${r.hi.toFixed(2)}]   ` +
      `${strength.toFixed(2)}      ${dir.padEnd(14)}  ${fmt(r.botMed).padStart(8)} | ${fmt(r.compMed)}`
  );
}

out("\n=== 3. WHAT EACH SIGNAL MEANS ===");
for (const r of results) out(`${r.name.padEnd(17)} ${r.description}`);

out("\n=== 4. CHECKS ===");
const age = results.find((r) => r.name === "ageDays");
out(`Account age: AUC ${age.point.toFixed(2)} [${age.lo.toFixed(2)}-${age.hi.toFixed(2)}]. The comparison group was matched on creation month,`);
out("so this should be close to 0.50. If it is far from 0.50, the matching did not work.");
const strong = results.filter((r) => Math.max(r.point, 1 - r.point) >= 0.9 && r.name !== "ageDays");
if (strong.length) {
  out(`Signals with strength 0.90 or more: ${strong.map((r) => r.name).join(", ")}. Be careful: such a clean`);
  out("split often comes from how the two groups were chosen (for example, the bots follow almost");
  out("nobody because most of them are feed accounts), not from bots in general.");
}
out("Reminder: about 10% of the comparison accounts are probably automated (hand review), so");
out("the true separation is somewhat better than these numbers show.");

// ------------------------------------------------------------------------ CSV
const csv = (v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const header = ["label", "did", "handle", "operator", ...FEATURES.map(([n]) => n)];
const csvLines = [header.join(",")];
for (const r of rows) {
  csvLines.push([r.label, r.did, r.handle, r.operator, ...FEATURES.map(([n]) => (Number.isFinite(r.f[n]) ? +r.f[n].toFixed(6) : ""))].map(csv).join(","));
}
await writeFile(CSV_FILE, csvLines.join("\n") + "\n");
await writeFile(REPORT_FILE, lines.join("\n") + "\n");
console.log(`\nSaved: ${CSV_FILE} and ${REPORT_FILE}`);
