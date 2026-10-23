// score_baseline.mjs
// Step 2 of the project: a first combined "bot-likeness" score from the profile signals.
//
// Reads:  data/features_profile.csv   (made by features_profile.mjs)
// Writes: data/score_baseline.csv     one row per account with its out-of-fold score (0-100)
//         data/score_baseline_report.txt
//
// Usage:  node score_baseline.mjs
//         node score_baseline.mjs --repeats 10 --folds 5 --lambda 1 --seed 1
// Needs Node 18+. No packages, no network.
//
// How the score is made (simple version): a logistic regression. It looks at the signals
// of all training accounts, finds how much each signal should count, and turns them into one
// number between 0 and 1 (times 100 here). Each account is scored by a model that never saw it,
// and never saw any other bot from the same maker (grouped cross-validation).

import { readFile, writeFile } from "node:fs/promises";

const IN = "data/features_profile.csv";
const OUT_CSV = "data/score_baseline.csv";
const OUT_REPORT = "data/score_baseline_report.txt";

function parseArgs(argv) {
  const o = { repeats: 10, folds: 5, lambda: 1, seed: 1, input: IN };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--repeats") o.repeats = Number(argv[++i]);
    else if (argv[i] === "--folds") o.folds = Number(argv[++i]);
    else if (argv[i] === "--lambda") o.lambda = Number(argv[++i]);
    else if (argv[i] === "--seed") o.seed = Number(argv[++i]);
    else if (argv[i] === "--input") o.input = argv[++i];
  }
  return o;
}
const args = parseArgs(process.argv);

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
function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ----------------------------------------------------------------- read the CSV
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

let text;
try {
  text = await readFile(args.input, "utf8");
} catch {
  console.log(`Could not read ${args.input}. Run features_profile.mjs first, from the same folder.`);
  process.exit(1);
}
const table = parseCsv(text.trim());
const header = table[0];
const idx = (n) => header.indexOf(n);
const num = (r, n) => (r[idx(n)] === "" || r[idx(n)] === undefined ? NaN : Number(r[idx(n)]));

// ---------------------------------------------------------------- the signals used
// Transformations: counts are heavy-tailed (a few accounts have huge numbers), so their
// logarithm is used. Not used: bio length, has-bio, custom domain (likely artifacts of how
// the bots were found), account age (matched by design), has-avatar (no variation),
// raw posts (almost the same information as posts per day, because age is matched).
const SIGNALS = {
  logPostsPerDay: (r) => Math.log(num(r, "postsPerDay")),
  logFollowers: (r) => Math.log1p(num(r, "followers")),
  logFollows: (r) => Math.log1p(num(r, "follows")),
  handleDigitShare: (r) => num(r, "handleDigitShare"),
  handleLength: (r) => num(r, "handleLength"),
  hasDisplayName: (r) => num(r, "hasDisplayName"),
  hasBanner: (r) => num(r, "hasBanner"),
};
const SIGNAL_NAMES = Object.keys(SIGNALS);

const accounts = [];
let dropped = 0;
for (const r of table.slice(1)) {
  const x = SIGNAL_NAMES.map((n) => SIGNALS[n](r));
  if (x.some((v) => !Number.isFinite(v))) { dropped++; continue; }
  accounts.push({
    label: Number(r[idx("label")]),
    did: r[idx("did")],
    handle: r[idx("handle")],
    operator: r[idx("operator")],
    x,
  });
}

// ------------------------------------------------------- logistic regression (L2)
// Newton's method on standardized signals, balanced class weights.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function fit(rows, cols, lambda) {
  const d = cols.length;
  const mean = cols.map((c) => rows.reduce((s, r) => s + r.x[c], 0) / rows.length);
  const sd = cols.map((c, j) => {
    const v = rows.reduce((s, r) => s + (r.x[c] - mean[j]) ** 2, 0) / rows.length;
    return Math.sqrt(v) || 1;
  });
  const Z = rows.map((r) => [1, ...cols.map((c, j) => (r.x[c] - mean[j]) / sd[j])]);
  const y = rows.map((r) => r.label);
  const nPos = y.filter((v) => v === 1).length;
  const nNeg = y.length - nPos;
  const wPos = y.length / (2 * nPos);
  const wNeg = y.length / (2 * nNeg);
  let w = new Array(d + 1).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    const g = new Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < Z.length; i++) {
      let z = 0;
      for (let k = 0; k <= d; k++) z += w[k] * Z[i][k];
      const p = 1 / (1 + Math.exp(-z));
      const cw = y[i] === 1 ? wPos : wNeg;
      const e = cw * (p - y[i]);
      const h = cw * p * (1 - p);
      for (let k = 0; k <= d; k++) {
        g[k] += e * Z[i][k];
        for (let m = 0; m <= d; m++) H[k][m] += h * Z[i][k] * Z[i][m];
      }
    }
    for (let k = 1; k <= d; k++) { g[k] += lambda * w[k]; H[k][k] += lambda; }
    H[0][0] += 1e-9;
    const step = solve(H, g);
    let size = 0;
    for (let k = 0; k <= d; k++) { w[k] -= step[k]; size += Math.abs(step[k]); }
    if (size < 1e-8) break;
  }
  return { w, mean, sd, cols };
}
function predict(model, r) {
  let z = model.w[0];
  model.cols.forEach((c, j) => { z += model.w[j + 1] * ((r.x[c] - model.mean[j]) / model.sd[j]); });
  return 1 / (1 + Math.exp(-z));
}

function auc(pos, neg) {
  const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b) => a[0] - b[0]);
  let rs = 0;
  let i = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    for (let k = i; k <= j; k++) if (all[k][1] === 1) rs += (i + j) / 2 + 1;
    i = j + 1;
  }
  return (rs - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

// ------------------------------------------------------------ cross-validation
// grouped = true: all bots of one maker land in the same fold. Comparison accounts are
// spread randomly. grouped = false: every account is placed at random (the naive way).
function makeFolds(random, grouped) {
  const fold = new Map();
  const bots = accounts.filter((a) => a.label === 1);
  const comp = accounts.filter((a) => a.label === 0);
  const units = [];
  if (grouped) {
    const g = new Map();
    for (const b of bots) { if (!g.has(b.operator)) g.set(b.operator, []); g.get(b.operator).push(b); }
    units.push(...g.values());
  } else for (const b of bots) units.push([b]);
  shuffle(units, random);
  units.sort((a, b) => b.length - a.length); // big groups first, then fill the emptiest fold
  const load = new Array(args.folds).fill(0);
  for (const u of units) {
    let f = 0;
    for (let k = 1; k < args.folds; k++) if (load[k] < load[f]) f = k;
    load[f] += u.length;
    for (const a of u) fold.set(a.did, f);
  }
  shuffle(comp, random);
  comp.forEach((a, i) => fold.set(a.did, i % args.folds));
  return fold;
}

function crossValidate(cols, grouped, seedOffset, keepScores) {
  const aucs = [];
  const prec = [];
  const rec = [];
  const sums = new Map();
  for (let rep = 0; rep < args.repeats; rep++) {
    const random = seededRandom(args.seed * 1000 + rep + seedOffset);
    const fold = makeFolds(random, grouped);
    const score = new Map();
    for (let f = 0; f < args.folds; f++) {
      const train = accounts.filter((a) => fold.get(a.did) !== f);
      const test = accounts.filter((a) => fold.get(a.did) === f);
      if (grouped) {
        const trainOps = new Set(train.filter((a) => a.label === 1).map((a) => a.operator));
        if (test.some((a) => a.label === 1 && trainOps.has(a.operator))) throw new Error("maker group on both sides of the split");
      }
      const model = fit(train, cols, args.lambda);
      for (const a of test) score.set(a.did, predict(model, a));
    }
    const pos = accounts.filter((a) => a.label === 1).map((a) => score.get(a.did));
    const neg = accounts.filter((a) => a.label === 0).map((a) => score.get(a.did));
    aucs.push(auc(pos, neg));
    const tp = pos.filter((p) => p >= 0.5).length;
    const fp = neg.filter((p) => p >= 0.5).length;
    prec.push(tp / Math.max(1, tp + fp));
    rec.push(tp / pos.length);
    if (keepScores) for (const [d, s] of score) sums.set(d, (sums.get(d) ?? 0) + s / args.repeats);
  }
  return { aucs, prec, rec, sums };
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sdev = (a) => Math.sqrt(mean(a.map((v) => (v - mean(a)) ** 2)));
const range = (a) => `${Math.min(...a).toFixed(3)}-${Math.max(...a).toFixed(3)}`;
const all = SIGNAL_NAMES.map((_, i) => i);
const without = (names) => all.filter((i) => !names.includes(SIGNAL_NAMES[i]));

// ------------------------------------------------------------------------ report
const nBots = accounts.filter((a) => a.label === 1).length;
const nComp = accounts.length - nBots;
const nGroups = new Set(accounts.filter((a) => a.label === 1).map((a) => a.operator)).size;

out("=== HOW TO READ THIS REPORT ===");
out("A first combined score (0-100) built from the profile signals with a logistic regression.");
out("Every account is scored by a model that never saw it, and never saw any other bot from the");
out("same maker. AUC again means: the chance that a random bot gets a higher score than a random");
out("comparison account (0.50 = nothing, 1.00 = perfect). The score is relative: the training");
out("sample is about half bots and half ordinary accounts, so 70 does NOT mean '70% chance of");
out("being a bot' on Bluesky in general. It only ranks accounts.\n");

out("=== 1. DATA ===");
out(`Bots: ${nBots} (in ${nGroups} maker groups). Comparison accounts: ${nComp}. Dropped for missing values: ${dropped}.`);
out(`Signals used (${SIGNAL_NAMES.length}): ${SIGNAL_NAMES.join(", ")}`);
out(`Not used: bio length, has bio, custom domain (suspect), account age, has avatar, raw posts.`);
out(`Cross-validation: ${args.folds} folds, repeated ${args.repeats} times with different random splits; ridge penalty ${args.lambda}.\n`);

const main = crossValidate(all, true, 0, true);
const naive = crossValidate(all, false, 500, false);
out("=== 2. THE SCORE ===");
out(`AUC, grouped by maker (the honest number): ${mean(main.aucs).toFixed(3)}  (spread over repeats ${range(main.aucs)})`);
out(`At the cut-off 50 (out of 100): precision ${mean(main.prec).toFixed(2)}, recall ${mean(main.rec).toFixed(2)}`);
out(`  precision = of the accounts scored 50 or more, the share that are bots`);
out(`  recall    = of the bots, the share scored 50 or more`);
out(`AUC if splits ignore makers (the naive way): ${mean(naive.aucs).toFixed(3)}`);
out(`  If this is clearly higher than the grouped number, bots of one maker look alike and`);
out(`  would make the score look better than it is. That is why we split by maker.\n`);

out("=== 3. WHICH SIGNALS MATTER? (remove one group of signals and see what is lost) ===");
out("variant                                          AUC     change");
const variants = [
  ["all signals", []],
  ["without follows and followers", ["logFollows", "logFollowers"]],
  ["without posts per day", ["logPostsPerDay"]],
  ["without follows, followers AND posts per day", ["logFollows", "logFollowers", "logPostsPerDay"]],
  ["only follows, followers, posts per day", ["handleDigitShare", "handleLength", "hasDisplayName", "hasBanner"]],
  ["without handle signals", ["handleDigitShare", "handleLength"]],
];
const base = mean(main.aucs);
for (const [name, drop] of variants) {
  const r = crossValidate(without(drop), true, 100, false);
  const a = mean(r.aucs);
  out(`${name.padEnd(48)} ${a.toFixed(3)}  ${(a - base >= 0 ? "+" : "") + (a - base).toFixed(3)}`);
}
out("\nThe row 'without follows, followers AND posts per day' shows how much is left when the");
out("two things that separate feed bots (posts a lot, follows nobody) are taken away. A bot that");
out("looks human would mostly be seen through such remaining signals.\n");

// Final model on everything: only to show how much each signal counts.
const finalModel = fit(accounts, all, args.lambda);
out("=== 4. HOW MUCH EACH SIGNAL COUNTS (model fitted on all accounts) ===");
out("A positive number pushes the score towards 'bot', a negative one away from it. The signals");
out("are on a common scale (one standard deviation), so the sizes can be compared.\n");
SIGNAL_NAMES
  .map((n, i) => [n, finalModel.w[i + 1]])
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  .forEach(([n, w]) => out(`  ${n.padEnd(18)} ${(w >= 0 ? "+" : "") + w.toFixed(2)}`));
out("\nThese numbers describe this sample only. The scores in the CSV come from models that did not");
out("see the account, so they are not inflated by training on it.\n");

// Score distribution
const scoreOf = (a) => main.sums.get(a.did) * 100;
const botScores = accounts.filter((a) => a.label === 1).map(scoreOf).sort((a, b) => a - b);
const compScores = accounts.filter((a) => a.label === 0).map(scoreOf).sort((a, b) => a - b);
const qq = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
out("=== 5. SCORE DISTRIBUTION (25% / median / 75%) ===");
out(`Bots:                ${qq(botScores, 0.25).toFixed(0)} / ${qq(botScores, 0.5).toFixed(0)} / ${qq(botScores, 0.75).toFixed(0)}`);
out(`Comparison accounts: ${qq(compScores, 0.25).toFixed(0)} / ${qq(compScores, 0.5).toFixed(0)} / ${qq(compScores, 0.75).toFixed(0)}`);

out("\n=== 6. THE CLEAREST MISTAKES (for reading, not for fixing) ===");
const byScore = [...accounts].sort((a, b) => scoreOf(b) - scoreOf(a));
out("Comparison accounts with the HIGHEST scores (maybe unlabeled bots, maybe wrong):");
byScore.filter((a) => a.label === 0).slice(0, 10).forEach((a) => out(`  ${scoreOf(a).toFixed(0).padStart(3)}  ${a.handle}`));
out("Bots with the LOWEST scores (bots that look like ordinary accounts):");
[...byScore].reverse().filter((a) => a.label === 1).slice(0, 10).forEach((a) => out(`  ${scoreOf(a).toFixed(0).padStart(3)}  ${a.handle}`));

const csv = (v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvLines = ["label,did,handle,operator,score"];
for (const a of accounts) csvLines.push([a.label, a.did, a.handle, a.operator, scoreOf(a).toFixed(1)].map(csv).join(","));
await writeFile(OUT_CSV, csvLines.join("\n") + "\n");
await writeFile(OUT_REPORT, lines.join("\n") + "\n");
console.log(`\nSaved: ${OUT_CSV} and ${OUT_REPORT}`);
