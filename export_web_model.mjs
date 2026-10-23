// export_web_model.mjs
// Builds the model used by the web app. It is the combined score of score_combined.mjs, without the two
// 'text copied between accounts' signals (they need other accounts of the study and cannot be measured for
// a single visitor account). It (1) tests this web model with the same grouped cross-validation, (2) builds the
// score bands and evidence ratios from its out-of-fold scores, (3) fits the final model on all accounts and
// writes app/model.json.
// Reads:  the feature tables and text_families.csv (like score_combined.mjs)
// Writes: app/model.json, data/web_model_report.txt
// Usage:  node export_web_model.mjs        (Node 18+, no packages, no network)
//
// The rest of this file is copied from score_combined.mjs (same fitting code).
// The combined bot-likeness score from THREE groups of signals:
//   profile    (numbers on the profile: followers, follows, posts per day, handle)
//   behaviour  (posting rhythm, replies/reposts, reactions received, repeated text)
//   graph      (who follows the account, whom it follows, and what those accounts look like)
//   content    (what the account says: variety, near-copies, text copied between accounts)
//              only used if data/features_content.csv exists (made by features_content.mjs)
// and the test of what each group adds.
//
// Reads:  data/features_profile.csv, data/features_behaviour.csv, data/features_graph.csv,
//         data/features_content.csv (optional), data/text_families.csv (optional: bots that post
//         the same texts are treated as one maker when splitting the data for testing)
// Writes: data/score_combined.csv, data/score_combined_report.txt
//
// Usage:  node score_combined.mjs
//         node score_combined.mjs --repeats 10 --variant-repeats 3 --folds 5 --lambda 1 --seed 1
// Needs Node 18+. No packages, no network.

import { readFile, writeFile, mkdir } from "node:fs/promises";

function parseArgs(argv) {
  const o = { repeats: 10, variantRepeats: 3, folds: 5, lambda: 1, seed: 1, dir: "data" };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--repeats") o.repeats = Number(argv[++i]);
    else if (argv[i] === "--variant-repeats") o.variantRepeats = Number(argv[++i]);
    else if (argv[i] === "--folds") o.folds = Number(argv[++i]);
    else if (argv[i] === "--lambda") o.lambda = Number(argv[++i]);
    else if (argv[i] === "--seed") o.seed = Number(argv[++i]);
    else if (argv[i] === "--dir") o.dir = argv[++i];
  }
  return o;
}
const args = parseArgs(process.argv);
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
function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
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
async function readTable(name, hint, optional = false) {
  let text;
  try { text = await readFile(`${args.dir}/${name}`, "utf8"); } catch {
    if (optional) return null;
    console.log(`Could not read ${args.dir}/${name}. ${hint}`);
    process.exit(1);
  }
  const t = parseCsv(text.trim());
  const h = t[0];
  const map = new Map();
  for (const r of t.slice(1)) {
    const o = {};
    h.forEach((n, i) => { o[n] = r[i]; });
    map.set(o.did, o);
  }
  return map;
}
const P = await readTable("features_profile.csv", "Run features_profile.mjs first.");
const B = await readTable("features_behaviour.csv", "Run collect_posts.mjs and features_behaviour.mjs first.");
const G = await readTable("features_graph.csv", "Run collect_graph.mjs and features_graph.mjs first.");
const C = await readTable("features_content.csv", "Run features_content.mjs first.");

// ---------------------------------------------------------------- the signals
// Counts are heavy-tailed, so their logarithm is used. Left out on purpose: bio length, has-bio,
// custom domain (artifacts of how the bots were found), account age (matched), has-avatar (no
// variation), window length (an artifact of how often the account posts), and the signals that
// exist for only a few accounts (reply targets, repost sources).
const n = (src) => (k) => (r) => {
  const v = src.get(r.did)?.[k];
  return v === undefined || v === "" ? NaN : Number(v);
};
const p = n(P), b = n(B), g = n(G), c = C ? n(C) : null;
const SIGNALS = [
  ["profile", "logPostsPerDay", (r) => Math.log(p("postsPerDay")(r)), true],
  ["profile", "logFollowers", (r) => Math.log1p(p("followers")(r)), true],
  ["profile", "logFollows", (r) => Math.log1p(p("follows")(r)), true],
  ["profile", "handleDigitShare", p("handleDigitShare"), false],
  ["profile", "hasDisplayName", p("hasDisplayName"), false],
  ["profile", "hasBanner", p("hasBanner"), false],
  ["behaviour", "logItemsPerDay", (r) => Math.log(b("itemsPerDay")(r)), true],
  ["behaviour", "gapCV", b("gapCV"), false],
  ["behaviour", "sameGapShare", b("sameGapShare"), false],
  ["behaviour", "minuteModeShare", b("minuteModeShare"), false],
  ["behaviour", "secondModeShare", b("secondModeShare"), false],
  ["behaviour", "repostShare", b("repostShare"), false],
  ["behaviour", "replyShare", b("replyShare"), false],
  ["behaviour", "quoteShare", b("quoteShare"), false],
  ["behaviour", "zeroEngagementShare", b("zeroEngagementShare"), false],
  ["behaviour", "logEngagementPerFollower", (r) => Math.log1p(100 * b("engagementPerFollower")(r)), false],
  ["behaviour", "templateShare", b("templateShare"), false],
  ["behaviour", "meanSimilarity", b("meanSimilarity"), false],
  ["behaviour", "exactDupShare", b("exactDupShare"), false],
  ["behaviour", "logTextLength", (r) => Math.log1p(b("textLength")(r)), false],
  ["behaviour", "languages", b("languages"), false],
  ["behaviour", "linkShare", b("linkShare"), false],
  ["behaviour", "imageShare", b("imageShare"), false],
  ["graph", "mutualOfFollowers", g("mutualOfFollowers"), true],
  ["graph", "followerBotShare", g("followerBotShare"), false],
  ["graph", "followerEmptyShare", g("followerEmptyShare"), false],
  ["graph", "followerNoAvatarShare", g("followerNoAvatarShare"), false],
  ["graph", "logFollowerAge", (r) => Math.log1p(g("followerAgeMedianDays")(r)), false],
  ["graph", "followerDayModeShare", g("followerDayModeShare"), false],
  ["graph", "followsBotShare", g("followsBotShare"), true],
  ["graph", "logSampleFollowers", (r) => Math.log1p(g("sampleFollowers")(r)), true],
  ...(C
    ? [
        ["content", "ttr100", c("ttr100"), false],
        ["content", "lengthCV", c("lengthCV"), false],
        ["content", "digitCharShare", c("digitCharShare"), false],
        ["content", "headlineLinkShare", c("headlineLinkShare"), false],
        ["content", "charSimilarity", c("charSimilarity"), false],
        ["content", "nearDupShare", c("nearDupShare"), false],
        ["content", "crossCopyShare", c("crossCopyShare"), false],
        ["content", "crossCopyOtherMakerShare", c("crossCopyOtherMakerShare"), false],
      ]
    : []),
].filter(([, name]) => !name.startsWith("crossCopy")).map(([group, name, get, volume]) => ({ group, name, get, volume }));

// Accounts that appear in all three tables.
const accounts = [];
for (const [did, pr] of P) {
  if (!B.has(did) || !G.has(did) || (C && !C.has(did))) continue;
  const base = { did, label: Number(pr.label), handle: pr.handle, operator: pr.operator };
  base.x = SIGNALS.map((s) => s.get(base));
  accounts.push(base);
}
// Text families (from features_content.mjs): bots whose posts share the same texts are probably
// from one maker even when their bios do not say so. Their maker groups are joined here, so
// that such bots are never on both sides of a test split. The files from earlier steps are
// not changed.
let mergedInfo = null;
const famText = await (async () => {
  try { return await readFile(`${args.dir}/text_families.csv`, "utf8"); } catch { return null; }
})();
if (famText) {
  const ft = parseCsv(famText.trim());
  const fh = ft[0];
  const fi = (n) => fh.indexOf(n);
  const parentOp = new Map();
  const findOp = (x) => { if (!parentOp.has(x)) parentOp.set(x, x); while (parentOp.get(x) !== x) { parentOp.set(x, parentOp.get(parentOp.get(x))); x = parentOp.get(x); } return x; };
  const byFam = new Map();
  for (const r of ft.slice(1)) {
    if (r[fi("label")] !== "1") continue;
    const a = accounts.find((x) => x.did === r[fi("did")]);
    if (!a) continue;
    if (!byFam.has(r[fi("family")])) byFam.set(r[fi("family")], []);
    byFam.get(r[fi("family")]).push(a);
  }
  const before = new Set(accounts.filter((a) => a.label === 1).map((a) => a.operator)).size;
  for (const members of byFam.values()) for (let i = 1; i < members.length; i++) parentOp.set(findOp(members[i].operator), findOp(members[0].operator));
  let affected = 0;
  for (const a of accounts) if (a.label === 1) {
    const merged = findOp(a.operator);
    if (merged !== a.operator) affected++;
    a.operator = merged;
  }
  const after = new Set(accounts.filter((a) => a.label === 1).map((a) => a.operator)).size;
  mergedInfo = { families: byFam.size, before, after, affected };
}
// A signal gets a "missing" marker column when more than 10% of accounts lack it. Being
// unable to compute a signal can itself mean something (for example, no follower sample).
const missingShare = SIGNALS.map((_, j) => accounts.filter((a) => !Number.isFinite(a.x[j])).length / accounts.length);
const needsMarker = missingShare.map((m) => m > 0.1);

// ------------------------------------------------------- logistic regression (L2)
function solve(A, bv) {
  const m = bv.length;
  const M = A.map((row, i) => [...row, bv[i]]);
  for (let c = 0; c < m; c++) {
    let pv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[pv][c])) pv = r;
    [M[c], M[pv]] = [M[pv], M[c]];
    for (let r = c + 1; r < m; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(m).fill(0);
  for (let r = m - 1; r >= 0; r--) {
    let s = M[r][m];
    for (let k = r + 1; k < m; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}
const medianOf = (arr) => { const s = arr.filter(Number.isFinite).sort((a, b2) => a - b2); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// sig = list of signal indices used.
function fit(rows, sig, lambda) {
  const med = sig.map((j) => medianOf(rows.map((r) => r.x[j])));
  const cols = [];
  sig.forEach((j, k) => {
    cols.push({ j, k, marker: false });
    if (needsMarker[j]) cols.push({ j, k, marker: true });
  });
  const raw = (r, c) => (c.marker ? (Number.isFinite(r.x[c.j]) ? 0 : 1) : Number.isFinite(r.x[c.j]) ? r.x[c.j] : med[c.k]);
  const mean = cols.map((c) => rows.reduce((s, r) => s + raw(r, c), 0) / rows.length);
  const sd = cols.map((c, i) => Math.sqrt(rows.reduce((s, r) => s + (raw(r, c) - mean[i]) ** 2, 0) / rows.length) || 1);
  const d = cols.length;
  const Z = rows.map((r) => [1, ...cols.map((c, i) => (raw(r, c) - mean[i]) / sd[i])]);
  const y = rows.map((r) => r.label);
  const nPos = y.filter((v) => v === 1).length;
  const wPos = y.length / (2 * nPos);
  const wNeg = y.length / (2 * (y.length - nPos));
  const w = new Array(d + 1).fill(0);
  for (let iter = 0; iter < 60; iter++) {
    const gr = new Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < Z.length; i++) {
      let z = 0;
      for (let k = 0; k <= d; k++) z += w[k] * Z[i][k];
      const pr = 1 / (1 + Math.exp(-z));
      const cw = y[i] === 1 ? wPos : wNeg;
      const e = cw * (pr - y[i]);
      const h = cw * pr * (1 - pr);
      for (let k = 0; k <= d; k++) {
        gr[k] += e * Z[i][k];
        for (let m2 = 0; m2 <= k; m2++) H[k][m2] += h * Z[i][k] * Z[i][m2];
      }
    }
    for (let k = 0; k <= d; k++) for (let m2 = k + 1; m2 <= d; m2++) H[k][m2] = H[m2][k];
    for (let k = 1; k <= d; k++) { gr[k] += lambda * w[k]; H[k][k] += lambda; }
    H[0][0] += 1e-9;
    const step = solve(H, gr);
    let size = 0;
    for (let k = 0; k <= d; k++) { w[k] -= step[k]; size += Math.abs(step[k]); }
    if (size < 1e-7) break;
  }
  return { w, mean, sd, cols, raw };
}
function predict(model, r) {
  let z = model.w[0];
  model.cols.forEach((c, i) => { z += model.w[i + 1] * ((model.raw(r, c) - model.mean[i]) / model.sd[i]); });
  return 1 / (1 + Math.exp(-z));
}
function auc(pos, neg) {
  const all = [...pos.map((v) => [v, 1]), ...neg.map((v) => [v, 0])].sort((a, b2) => a[0] - b2[0]);
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

// Folds that keep every maker group together.
function makeFolds(random) {
  const fold = new Map();
  const bots = accounts.filter((a) => a.label === 1);
  const comp = accounts.filter((a) => a.label === 0);
  const gmap = new Map();
  for (const a of bots) { if (!gmap.has(a.operator)) gmap.set(a.operator, []); gmap.get(a.operator).push(a); }
  const units = [...gmap.values()];
  shuffle(units, random);
  units.sort((a, b2) => b2.length - a.length);
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
function crossValidate(sig, repeats, seedOffset, keep) {
  const aucs = [], prec = [], rec = [];
  const sums = new Map();
  for (let rep = 0; rep < repeats; rep++) {
    const random = seededRandom(args.seed * 1000 + rep + seedOffset);
    const fold = makeFolds(random);
    const score = new Map();
    for (let f = 0; f < args.folds; f++) {
      const train = accounts.filter((a) => fold.get(a.did) !== f);
      const test = accounts.filter((a) => fold.get(a.did) === f);
      const trainOps = new Set(train.filter((a) => a.label === 1).map((a) => a.operator));
      if (test.some((a) => a.label === 1 && trainOps.has(a.operator))) throw new Error("maker group on both sides of the split");
      const model = fit(train, sig, args.lambda);
      for (const a of test) score.set(a.did, predict(model, a));
    }
    const pos = accounts.filter((a) => a.label === 1).map((a) => score.get(a.did));
    const neg = accounts.filter((a) => a.label === 0).map((a) => score.get(a.did));
    aucs.push(auc(pos, neg));
    const tp = pos.filter((v) => v >= 0.5).length;
    const fp = neg.filter((v) => v >= 0.5).length;
    prec.push(tp / Math.max(1, tp + fp));
    rec.push(tp / pos.length);
    if (keep) for (const [d, s] of score) sums.set(d, (sums.get(d) ?? 0) + s / repeats);
  }
  return { aucs, prec, rec, sums };
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const range = (a) => `${Math.min(...a).toFixed(3)}-${Math.max(...a).toFixed(3)}`;
const idx = (pred) => SIGNALS.map((s, i) => (pred(s) ? i : -1)).filter((i) => i >= 0);


// ------------------------------------------------------------------------ web model
const all = idx(() => true);
const nB = accounts.filter((a) => a.label === 1).length;
out("=== WEB MODEL: the combined score without the copy-between-accounts signals ===");
out(`Accounts: ${accounts.length} (bots ${nB}, comparison ${accounts.length - nB}); signals: ${SIGNALS.length}`);
const cv = crossValidate(all, args.repeats, 0, true);
out(`AUC (grouped by maker, ${args.repeats} repeats): ${mean(cv.aucs).toFixed(3)}  (spread ${range(cv.aucs)})`);
out(`At the cut-off 50: precision ${mean(cv.prec).toFixed(2)}, recall ${mean(cv.rec).toFixed(2)}`);
const scoreOf = (a) => cv.sums.get(a.did) * 100;

const BANDS = [
  ["very low", 0, 2], ["low", 2, 10], ["slightly low", 10, 30], ["unclear", 30, 70],
  ["raised", 70, 90], ["high", 90, 98], ["very high", 98, 100.0001],
];
const bots = accounts.filter((a) => a.label === 1), comp = accounts.filter((a) => a.label === 0);
const bands = BANDS.map(([name, lo, hi]) => {
  const nb = bots.filter((a) => scoreOf(a) >= lo && scoreOf(a) < hi).length;
  const nc = comp.filter((a) => scoreOf(a) >= lo && scoreOf(a) < hi).length;
  const ratio = ((nb + 0.5) / (bots.length + 0.5 * BANDS.length)) / ((nc + 0.5) / (comp.length + 0.5 * BANDS.length));
  return { name, lo, hi, bots: nb, comparison: nc, ratio: +ratio.toFixed(3) };
});
out("\nband            score        bots  comparison  evidence ratio");
for (const b of bands) out(`${b.name.padEnd(14)} ${(b.lo + "-" + Math.min(100, b.hi).toFixed(0)).padEnd(10)} ${String(b.bots).padStart(6)} ${String(b.comparison).padStart(11)} ${b.ratio.toFixed(2).padStart(15)}`);

const finalModel = fit(accounts, all, args.lambda);
const med = SIGNALS.map((_, j) => medianOf(accounts.map((r) => r.x[j])));
const refMed = (lab) => SIGNALS.map((_, j) => medianOf(accounts.filter((a) => a.label === lab).map((r) => r.x[j])));
const model = {
  built: new Date().toISOString(),
  about: "Combined bot-likeness score without cross-account copy signals. Fitted on all study accounts; bands from out-of-fold scores.",
  lambda: args.lambda,
  trainedOn: { bots: bots.length, comparison: comp.length },
  cv: { auc: +mean(cv.aucs).toFixed(4), precision: +mean(cv.prec).toFixed(3), recall: +mean(cv.rec).toFixed(3), repeats: args.repeats },
  signals: SIGNALS.map((s) => s.name),
  groups: SIGNALS.map((s) => s.group),
  cols: finalModel.cols.map((c) => ({ j: c.j, marker: c.marker })),
  mean: finalModel.mean, sd: finalModel.sd, w: finalModel.w, med,
  refBots: refMed(1), refComparison: refMed(0),
  bands,
};
// Accounts of the study for the equality test. Kept in data/ (not published), because they name ordinary accounts.
const check = [...bots.slice(0, 10), ...comp.slice(0, 10)].map((a) => ({ did: a.did, handle: a.handle, score: +(predict(finalModel, a) * 100).toFixed(3) }));
await mkdir("app", { recursive: true });
await writeFile("app/model.json", JSON.stringify(model));
await writeFile(`${args.dir}/model_check.json`, JSON.stringify(check));
await writeFile(`${args.dir}/web_model_report.txt`, lines.join("\n") + "\n");
console.log("\nSaved: app/model.json and " + `${args.dir}/web_model_report.txt`);
