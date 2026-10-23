// score_combined.mjs
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

import { readFile, writeFile } from "node:fs/promises";

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
const C = await readTable("features_content.csv", "", true);

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
].map(([group, name, get, volume]) => ({ group, name, get, volume }));

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

// ------------------------------------------------------------------------ report
const nBots = accounts.filter((a) => a.label === 1).length;
out("=== HOW TO READ THIS REPORT ===");
out(`One bot-likeness score (0-100) from ${C ? "four" : "three"} groups of signals: profile, behaviour, graph${C ? ", content" : ""}.`);
out("Every account is scored by a model that never saw it nor any other bot from the same maker.");
out("AUC = the chance that a random bot scores higher than a random comparison account (0.50 =");
out("nothing, 1.00 = perfect). The score ranks accounts; it is not a probability for Bluesky as");
out("a whole, because the training sample is about half bots.\n");

out("=== 1. DATA ===");
out(`Accounts in all ${C ? "four" : "three"} tables: ${accounts.length} (bots ${nBots}, comparison ${accounts.length - nBots}; ${new Set(accounts.filter((a) => a.label === 1).map((a) => a.operator)).size} maker groups).`);
if (mergedInfo) out(`Text families joined: ${mergedInfo.families} families; bot maker groups ${mergedInfo.before} -> ${mergedInfo.after} (${mergedInfo.affected} bots moved to another group).`);
out(`Signals: ${SIGNALS.length} (profile ${SIGNALS.filter((s) => s.group === "profile").length}, behaviour ${SIGNALS.filter((s) => s.group === "behaviour").length}, graph ${SIGNALS.filter((s) => s.group === "graph").length}${C ? `, content ${SIGNALS.filter((s) => s.group === "content").length}` : ""}).`);
out("Signals missing for more than 10% of accounts get a 'missing' marker; other gaps are filled with the median:");
SIGNALS.forEach((s, j) => { if (needsMarker[j]) out(`  ${s.name.padEnd(26)} missing for ${(100 * missingShare[j]).toFixed(0)}%`); });
out(`Cross-validation: ${args.folds} folds; ${args.repeats} repeats for the full score, ${args.variantRepeats} for the variants; ridge penalty ${args.lambda}.\n`);

const all = idx(() => true);
const main = crossValidate(all, args.repeats, 0, true);
out("=== 2. THE FULL SCORE ===");
out(`AUC (grouped by maker): ${mean(main.aucs).toFixed(3)}   (spread over repeats ${range(main.aucs)})`);
out(`At the cut-off 50: precision ${mean(main.prec).toFixed(2)}, recall ${mean(main.rec).toFixed(2)}`);
out("  precision = of the accounts scored 50 or more, the share that are bots");
out("  recall    = of the bots, the share scored 50 or more\n");

out("=== 3. WHAT EACH GROUP CAN DO ===");
out("variant                                                       AUC     vs full");
const base = mean(main.aucs);
const row = (name, sig) => {
  const r = crossValidate(sig, args.variantRepeats, 100, false);
  const a = mean(r.aucs);
  out(`${name.padEnd(60)} ${a.toFixed(3)}  ${(a - base >= 0 ? "+" : "") + (a - base).toFixed(3)}`);
};
out("-- one group alone --");
row("profile only", idx((s) => s.group === "profile"));
row("behaviour only", idx((s) => s.group === "behaviour"));
row("graph only", idx((s) => s.group === "graph"));
if (C) {
  row("content only", idx((s) => s.group === "content"));
  out("-- does the content group add anything? --");
  row("profile + behaviour + graph (no content)", idx((s) => s.group !== "content"));
  row("all groups, content added to behaviour + graph", idx((s) => s.group !== "profile"));
}
out("-- two groups --");
row("profile + behaviour", idx((s) => s.group === "profile" || s.group === "behaviour"));
row("profile + graph", idx((s) => s.group === "profile" || s.group === "graph"));
row("behaviour + graph", idx((s) => s.group === "behaviour" || s.group === "graph"));
out("-- take away what feed bots are easy to spot by --");
const noVol = idx((s) => !s.volume);
row("all groups WITHOUT follows, followers, posts per day, follow-back", noVol);
row("  of which behaviour only", idx((s) => !s.volume && s.group === "behaviour"));
row("  of which graph only", idx((s) => !s.volume && s.group === "graph"));
row("  of which profile only", idx((s) => !s.volume && s.group === "profile"));
if (C) row("  of which content only", idx((s) => !s.volume && s.group === "content"));
out("-- behaviour split --");
const inter = ["repostShare", "replyShare", "quoteShare", "zeroEngagementShare", "logEngagementPerFollower"];
const rep = ["templateShare", "meanSimilarity", "exactDupShare", "logTextLength", "languages", "linkShare", "imageShare"];
const tim = ["logItemsPerDay", "gapCV", "sameGapShare", "minuteModeShare", "secondModeShare"];
row("timing only", idx((s) => tim.includes(s.name)));
row("interaction only (replies, reposts, reactions received)", idx((s) => inter.includes(s.name)));
row("text only (repetition, length, links, languages)", idx((s) => rep.includes(s.name)));
out("\nRows marked 'WITHOUT ...' show how much is left when the most obvious clues of feed bots are");
out("removed. A bot that tries to look human would mostly be seen through such remaining signals.\n");

const finalModel = fit(accounts, all, args.lambda);
out("=== 4. HOW MUCH EACH SIGNAL COUNTS (model fitted on all accounts) ===");
out("Positive = pushes the score towards 'bot'. Signals are on a common scale (one standard");
out("deviation). Signals overlap, so a single size should not be over-read.\n");
finalModel.cols
  .map((c, i) => [SIGNALS[c.j].group, SIGNALS[c.j].name + (c.marker ? " (missing)" : ""), finalModel.w[i + 1]])
  .sort((a, b2) => Math.abs(b2[2]) - Math.abs(a[2]))
  .slice(0, 18)
  .forEach(([grp, nm, w]) => out(`  ${grp.padEnd(10)} ${nm.padEnd(34)} ${(w >= 0 ? "+" : "") + w.toFixed(2)}`));

const scoreOf = (a) => main.sums.get(a.did) * 100;
const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
const bs = accounts.filter((a) => a.label === 1).map(scoreOf).sort((a, b2) => a - b2);
const cs = accounts.filter((a) => a.label === 0).map(scoreOf).sort((a, b2) => a - b2);
out("\n=== 5. SCORE DISTRIBUTION (25% / median / 75%) ===");
out(`Bots:                ${q(bs, 0.25).toFixed(0)} / ${q(bs, 0.5).toFixed(0)} / ${q(bs, 0.75).toFixed(0)}`);
out(`Comparison accounts: ${q(cs, 0.25).toFixed(0)} / ${q(cs, 0.5).toFixed(0)} / ${q(cs, 0.75).toFixed(0)}`);

out("\n=== 6. THE CLEAREST MISTAKES (for reading) ===");
const byScore = [...accounts].sort((a, b2) => scoreOf(b2) - scoreOf(a));
out("Comparison accounts with the HIGHEST scores (maybe unlabeled bots):");
byScore.filter((a) => a.label === 0).slice(0, 12).forEach((a) => out(`  ${scoreOf(a).toFixed(0).padStart(3)}  ${a.handle}`));
out("Bots with the LOWEST scores (bots that look like ordinary accounts):");
[...byScore].reverse().filter((a) => a.label === 1).slice(0, 12).forEach((a) => out(`  ${scoreOf(a).toFixed(0).padStart(3)}  ${a.handle}`));

const csv = (v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const cl = ["label,did,handle,operator,score"];
for (const a of accounts) cl.push([a.label, a.did, a.handle, a.operator, scoreOf(a).toFixed(1)].map(csv).join(","));
await writeFile(`${args.dir}/score_combined.csv`, cl.join("\n") + "\n");
await writeFile(`${args.dir}/score_combined_report.txt`, lines.join("\n") + "\n");
console.log(`\nSaved: ${args.dir}/score_combined.csv and ${args.dir}/score_combined_report.txt`);
