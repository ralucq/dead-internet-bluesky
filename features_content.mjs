// features_content.mjs
// Signals about WHAT accounts say, from the post texts already stored in data/posts.json.
// Nothing new is fetched. Each signal is tested alone with AUC, like the other groups.
//
// Reads:  data/posts.json, data/posts_status.json, data/features_profile.csv
// Writes: data/features_content.csv, data/features_content_report.txt,
//         data/text_families.csv (accounts linked by shared texts, with their makers)
//
// Usage:  node features_content.mjs
//         node features_content.mjs --boot 300 --seed 1
// Needs Node 18+. No packages, no network.
//
// Why character-based similarity: the earlier text signals split posts into words by spaces,
// which fails for languages written without spaces (Japanese, Chinese). Here posts are
// compared by overlapping groups of 4 characters, which works in every language.

import { readFile, writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const o = { boot: 300, seed: 1, minText: 10, maxPairs: 60, dir: "data" };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--boot") o.boot = Number(argv[++i]);
    else if (argv[i] === "--seed") o.seed = Number(argv[++i]);
    else if (argv[i] === "--min-text") o.minText = Number(argv[++i]);
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

const posts = JSON.parse(await readOrExit(`${args.dir}/posts.json`, "Run collect_posts.mjs first, from the folder that contains the data folder."));
const status = JSON.parse(await readOrExit(`${args.dir}/posts_status.json`, "Run collect_posts.mjs first."));
const table = parseCsv((await readOrExit(`${args.dir}/features_profile.csv`, "Run features_profile.mjs first.")).trim());
const H = table[0];
const people = table.slice(1).map((r) => ({ label: Number(r[H.indexOf("label")]), did: r[H.indexOf("did")], handle: r[H.indexOf("handle")], operator: r[H.indexOf("operator")] }));
const operatorOf = new Map(people.map((p) => [p.did, p.label === 1 ? p.operator : p.did]));

const FEATURES = [
  ["ttr100", "variety of words: different words among the first 100 words of its posts (needs 100 words; spaces-separated languages only)"],
  ["lengthCV", "how uneven the post lengths are (low = all posts about the same length, typical of templates)"],
  ["digitCharShare", "share of characters that are digits (data-like posts: prices, temperatures, counts)"],
  ["headlineLinkShare", "share of own posts that are a short text (25 words or fewer) with a link"],
  ["charSimilarity", "average similarity between its posts, by shared groups of 4 characters (works in every language)"],
  ["nearDupShare", "share of its posts that have a near-copy (70% or more shared 4-character groups) among its own posts"],
  ["crossCopyShare", "share of its posts (20+ characters) whose exact text, ignoring links and digits, is also posted by another account in the sample"],
  ["crossCopyOtherMakerShare", "same, but only counting other accounts that are not from the same maker"],
];

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

const normalize = (s) =>
  s.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[0-9]+/g, "0").replace(/[^\p{L}\p{N}#@\s]/gu, " ").replace(/\s+/g, " ").trim();
const grams = (t) => {
  const c = [...t.replace(/\s+/g, " ")];
  const set = new Set();
  if (c.length < 4) { if (c.length) set.add(c.join("")); return set; }
  for (let i = 0; i + 4 <= c.length; i++) set.add(c.slice(i, i + 4).join(""));
  return set;
};
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// -- First pass over all accounts: which exact texts are posted by which accounts.
const textOwners = new Map(); // normalized text -> Set of dids
const ownTexts = new Map(); // did -> array of {raw, norm, link}
for (const p of people) {
  const items = (posts[p.did] ?? []).filter((i) => i.k === "post");
  const arr = items.map((i) => ({ raw: i.x ?? "", norm: normalize(i.x ?? ""), link: Boolean(i.link) }));
  ownTexts.set(p.did, arr);
  for (const a of arr) {
    if (a.norm.length < 20) continue;
    if (!textOwners.has(a.norm)) textOwners.set(a.norm, new Set());
    textOwners.get(a.norm).add(p.did);
  }
}

function featuresOf(p) {
  const f = Object.fromEntries(FEATURES.map(([n]) => [n, NaN]));
  const arr = ownTexts.get(p.did) ?? [];
  if (arr.length < args.minText) return f;
  const lens = arr.map((a) => [...a.raw].length);
  if (mean(lens) > 0) f.lengthCV = sd(lens) / mean(lens);
  const allChars = arr.reduce((s, a) => s + [...a.raw].length, 0);
  if (allChars > 0) f.digitCharShare = arr.reduce((s, a) => s + (a.raw.match(/[0-9]/g) ?? []).length, 0) / allChars;
  f.headlineLinkShare = arr.filter((a) => a.link && a.raw.trim().split(/\s+/).filter(Boolean).length <= 25).length / arr.length;
  const words = arr.flatMap((a) => a.norm.split(" ").filter(Boolean));
  if (words.length >= 100) f.ttr100 = new Set(words.slice(0, 100)).size / 100;
  const texts = arr.filter((a) => a.norm.length > 0).slice(0, args.maxPairs);
  if (texts.length >= args.minText) {
    const sets = texts.map((a) => grams(a.norm));
    let total = 0;
    let pairs = 0;
    const hasNear = new Array(sets.length).fill(false);
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const s = jaccard(sets[i], sets[j]);
        total += s;
        pairs++;
        if (s >= 0.7) { hasNear[i] = true; hasNear[j] = true; }
      }
    }
    f.charSimilarity = total / pairs;
    f.nearDupShare = hasNear.filter(Boolean).length / sets.length;
  }
  const eligible = arr.filter((a) => a.norm.length >= 20);
  if (eligible.length >= args.minText) {
    f.crossCopyShare = eligible.filter((a) => textOwners.get(a.norm).size >= 2).length / eligible.length;
    const myOp = operatorOf.get(p.did);
    f.crossCopyOtherMakerShare = eligible.filter((a) => [...textOwners.get(a.norm)].some((d) => d !== p.did && operatorOf.get(d) !== myOp)).length / eligible.length;
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

const rows = people.filter((p) => posts[p.did]).map((p) => ({ ...p, f: featuresOf(p) }));

out("=== HOW TO READ THIS REPORT ===");
out("Signals about what accounts say: how varied their words are, how alike their posts are, and");
out("whether the same text is posted by other accounts in the sample. Each is tested alone with");
out("AUC: the chance that a random bot has a HIGHER value than a random comparison account");
out("(0.50 = nothing, 1.00 = bots always higher, 0.00 = bots always lower). Strength folds both");
out("directions. The 95% interval draws whole maker groups together.\n");

out("=== 1. COVERAGE ===");
for (const label of [1, 0]) {
  const n = rows.filter((r) => r.label === label).length;
  const t = rows.filter((r) => r.label === label && Number.isFinite(r.f.charSimilarity)).length;
  const w = rows.filter((r) => r.label === label && Number.isFinite(r.f.ttr100)).length;
  out(`${label === 1 ? "Bots" : "Comparison"}: ${n} accounts; ${t} with at least ${args.minText} own posts (text signals); ${w} with 100 or more words (word variety).`);
}
const multi = [...textOwners.values()].filter((s) => s.size >= 2).length;
out(`Different texts (20+ characters) posted by 2 or more accounts in the sample: ${multi} of ${textOwners.size}.`);
out("Word variety needs spaces between words, so it is mostly missing for Japanese and Chinese.\n");

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
out("signal                    AUC   [95% range]    strength  bots tend to be   median bots | median comparison   (n bots / n comp)");
const sorted = results.filter((r) => Number.isFinite(r.point)).sort((a, b) => Math.abs(b.point - 0.5) - Math.abs(a.point - 0.5));
for (const r of sorted) {
  const dir = Math.abs(r.point - 0.5) < 0.03 ? "about equal" : r.point > 0.5 ? "higher" : "lower";
  out(`${r.name.padEnd(25)} ${r.point.toFixed(2)}  [${r.lo.toFixed(2)}-${r.hi.toFixed(2)}]   ${Math.max(r.point, 1 - r.point).toFixed(2)}      ${dir.padEnd(14)}  ${fmt(r.botMed).padStart(8)} | ${fmt(r.compMed).padEnd(10)}   (${r.nb} / ${r.nc})`);
}
for (const r of results.filter((r) => !Number.isFinite(r.point))) out(`${r.name.padEnd(25)} not enough accounts with this signal (${r.nb} bots / ${r.nc} comparison)`);

out("\n=== 3. WHAT EACH SIGNAL MEANS ===");
for (const [n, d] of FEATURES) out(`${n.padEnd(25)} ${d}`);

out("\n=== 4. TEXTS COPIED BETWEEN ACCOUNTS (examples, for reading) ===");
out("Texts (20+ characters, links and digits ignored) posted by the most different accounts.");
const byDid = new Map(people.map((p) => [p.did, p]));
const top = [...textOwners.entries()].filter(([, s]) => s.size >= 2).sort((a, b) => b[1].size - a[1].size).slice(0, 8);
if (!top.length) out("(none)");
for (const [text, owners] of top) {
  const list = [...owners].map((d) => byDid.get(d));
  const nb = list.filter((x) => x.label === 1).length;
  out(`  ${String(owners.size).padStart(3)} accounts (${nb} bots, ${list.length - nb} comparison): "${text.slice(0, 70)}"`);
  out(`       ${list.map((x) => x.handle).join(", ")}`);
}

// Text families: two accounts are linked if they share at least MIN_SHARED different exact texts,
// or if at least MIN_POSTS of their posts have the same text (texts that differ only in digits
// count as the same text, so a template such as "temperature N degrees" is one text, many posts).
// Linked accounts form a family. A family whose accounts belong to different makers shows a
// maker group that the bio-based grouping did not join.
const MIN_SHARED = 3;
const MIN_POSTS = 10;
const countsOf = new Map(); // did -> Map(normalized text -> number of posts)
for (const [did, arr] of ownTexts) {
  const m = new Map();
  for (const a of arr) if (a.norm.length >= 20) m.set(a.norm, (m.get(a.norm) ?? 0) + 1);
  countsOf.set(did, m);
}
const pairCount = new Map();
const pairPosts = new Map();
for (const [text, owners] of textOwners) {
  if (owners.size < 2 || owners.size > 40) continue; // very widely shared texts are not a family sign
  const l = [...owners].sort();
  for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
    const k = l[i] + "|" + l[j];
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    pairPosts.set(k, (pairPosts.get(k) ?? 0) + Math.min(countsOf.get(l[i]).get(text), countsOf.get(l[j]).get(text)));
  }
}
const parent = new Map();
const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
for (const [k, n] of pairCount) {
  if (n < MIN_SHARED && pairPosts.get(k) < MIN_POSTS) continue;
  const [a, b] = k.split("|");
  parent.set(find(a), find(b));
}
const fam = new Map();
for (const d of parent.keys()) { const r = find(d); if (!fam.has(r)) fam.set(r, []); fam.get(r).push(d); }
const families = [...fam.values()].filter((m) => m.length >= 2).sort((a, b) => b.length - a.length);
out(`\nText families (accounts sharing ${MIN_SHARED} or more different texts, or ${MIN_POSTS} or more posts with the same text): ${families.length}`);
const famRows = ["family,did,handle,label,operator,maker_groups_in_family"];
families.forEach((members, fi) => {
  const ops = new Set(members.map((d) => operatorOf.get(d)));
  const labels = members.map((d) => byDid.get(d)?.label);
  if (fi < 12) {
    out(`  family ${fi + 1}: ${members.length} accounts (${labels.filter((x) => x === 1).length} bots), ${ops.size} different maker group(s)`);
    out(`       ${members.map((d) => byDid.get(d)?.handle).join(", ")}`);
  }
  for (const d of members) famRows.push([fi + 1, d, byDid.get(d)?.handle, byDid.get(d)?.label, `"${String(operatorOf.get(d)).replace(/"/g, '""')}"`, ops.size].join(","));
});
await writeFile(`${args.dir}/text_families.csv`, famRows.join("\n") + "\n");
const split = families.filter((m) => new Set(m.map((d) => operatorOf.get(d))).size > 1);
out(`Families that span more than one maker group (possible missed makers): ${split.length}. Details in text_families.csv.`);
out("\n=== 5. CHECKS ===");
out("Copying between accounts is limited by the sample: bots of one maker were capped at 15, and the");
out("sample is about 1,200 accounts. 'Other maker' copying is the more telling number.");
out("Posts with text in many languages: signals based on spaces (word variety) skip languages without");
out("spaces; the 4-character signals do not.");

const csv = (v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const cl = [["label", "did", "handle", "operator", ...FEATURES.map(([n]) => n)].join(",")];
for (const r of rows) cl.push([r.label, r.did, r.handle, r.operator, ...FEATURES.map(([n]) => (Number.isFinite(r.f[n]) ? +r.f[n].toFixed(6) : ""))].map(csv).join(","));
await writeFile(`${args.dir}/features_content.csv`, cl.join("\n") + "\n");
await writeFile(`${args.dir}/features_content_report.txt`, lines.join("\n") + "\n");
console.log(`\nSaved: ${args.dir}/features_content.csv and ${args.dir}/features_content_report.txt`);
