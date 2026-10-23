// features_behaviour.mjs
// Step 3b: measures POSTING BEHAVIOUR from data/posts.json (made by collect_posts.mjs) and
// tests every signal alone, the same way features_profile.mjs did for profile signals.
//
// Reads:  data/posts.json, data/posts_status.json, data/features_profile.csv
// Writes: data/features_behaviour.csv        one row per account, all behaviour signals
//         data/features_behaviour_report.txt
//
// Usage:  node features_behaviour.mjs
//         node features_behaviour.mjs --boot 300 --seed 1
// Needs Node 18+. No packages, no network.

import { readFile, writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const o = { boot: 300, seed: 1, minItems: 20, minText: 10, dir: "data" };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--boot") o.boot = Number(argv[++i]);
    else if (argv[i] === "--seed") o.seed = Number(argv[++i]);
    else if (argv[i] === "--min-items") o.minItems = Number(argv[++i]);
    else if (argv[i] === "--min-text") o.minText = Number(argv[++i]);
    else if (argv[i] === "--dir") o.dir = argv[++i];
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

async function readOrExit(path, hint) {
  try {
    return await readFile(path, "utf8");
  } catch {
    console.log(`Could not read ${path}. ${hint}`);
    process.exit(1);
  }
}

const posts = JSON.parse(await readOrExit(`${args.dir}/posts.json`, "Run collect_posts.mjs first, from the folder that contains the data folder."));
const status = JSON.parse(await readOrExit(`${args.dir}/posts_status.json`, "Run collect_posts.mjs first."));
const table = parseCsv((await readOrExit(`${args.dir}/features_profile.csv`, "Run features_profile.mjs first.")).trim());
const H = table[0];
const people = table.slice(1).map((r) => ({
  label: Number(r[H.indexOf("label")]),
  did: r[H.indexOf("did")],
  handle: r[H.indexOf("handle")],
  operator: r[H.indexOf("operator")],
  followers: Number(r[H.indexOf("followers")]),
}));

// ------------------------------------------------------------------ the signals
const FEATURES = [
  ["items", "number of items fetched (up to 100): own posts, replies and reposts"],
  ["windowDays", "days covered by those items, from the oldest to the newest"],
  ["itemsPerDay", "items per day over that window (recent activity, not lifetime average)"],
  ["gapCV", "how uneven the waiting times between items are (0 = perfectly regular clock)"],
  ["burstiness", "-1 = perfectly regular, 0 = random, +1 = very bursty"],
  ["medianGapMin", "median waiting time between items, in minutes"],
  ["sameGapShare", "share of waiting times equal (to the minute) to the most common waiting time"],
  ["minuteModeShare", "share of items at the single most common minute of the hour"],
  ["secondModeShare", "share of items at the single most common second of the minute"],
  ["hourSpread", "how evenly items are spread over the 24 hours of the day (0 = one hour only, 1 = even)"],
  ["repostShare", "share of items that are reposts"],
  ["replyShare", "share of own posts that are replies"],
  ["linkShare", "share of own posts with a link"],
  ["imageShare", "share of own posts with images or video"],
  ["hashtagShare", "share of own posts containing a hashtag"],
  ["mentionShare", "share of own posts mentioning another account (@)"],
  ["textLength", "average text length of own posts, in characters"],
  ["languages", "number of different languages declared in own posts"],
  ["selfReplyShare", "share of replies that are to the account's own posts (threads)"],
  ["replyTargetSpread", "different accounts replied to, divided by replies (1 = always someone new, near 0 = few accounts)"],
  ["repostSourceSpread", "different accounts reposted, divided by reposts (near 0 = reposts the same few accounts)"],
  ["topRepostSourceShare", "share of reposts that come from the single most reposted account"],
  ["quoteShare", "share of own posts that quote another post"],
  ["engagementPerPost", "likes + reposts + replies + quotes received per own original post (not replies)"],
  ["engagementPerFollower", "engagementPerPost divided by (followers + 1): do followers react?"],
  ["zeroEngagementShare", "share of own original posts that received no reaction at all"],
  ["repliedToShare", "share of own original posts that received at least one reply"],
  ["exactDupShare", "share of own posts whose text (ignoring links and digits) appears more than once"],
  ["meanSimilarity", "average similarity between all pairs of own posts (0 = nothing in common, 1 = identical)"],
  ["templateShare", "share of own posts that start with the same three words as another post"],
];

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const share = (arr, f) => arr.filter(f).length / arr.length;
const maxShare = (values) => {
  const c = new Map();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  return Math.max(...c.values()) / values.length;
};

const normalize = (s) =>
  s.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[0-9]+/g, "0").replace(/[^\p{L}\p{N}#@\s]/gu, " ").replace(/\s+/g, " ").trim();

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function tokensOf(text) {
  const w = text.split(" ").filter(Boolean);
  const set = new Set();
  if (w.length < 3) w.forEach((x) => set.add(x));
  else for (let i = 0; i + 1 < w.length; i++) set.add(w[i] + " " + w[i + 1]);
  return set;
}

function featuresOf(items, ctx) {
  const f = Object.fromEntries(FEATURES.map(([n]) => [n, NaN]));
  const timed = items.map((i) => ({ ...i, ms: Date.parse(i.t) })).filter((i) => Number.isFinite(i.ms)).sort((a, b) => a.ms - b.ms);
  f.items = timed.length;
  if (timed.length >= args.minItems) {
    const span = (timed[timed.length - 1].ms - timed[0].ms) / 86400000;
    f.windowDays = span;
    f.itemsPerDay = (timed.length - 1) / Math.max(span, 1 / 24);
    const gaps = [];
    for (let i = 1; i < timed.length; i++) gaps.push((timed[i].ms - timed[i - 1].ms) / 1000);
    const mu = mean(gaps);
    const sg = sd(gaps);
    f.gapCV = mu > 0 ? sg / mu : NaN;
    f.burstiness = mu + sg > 0 ? (sg - mu) / (sg + mu) : NaN;
    f.medianGapMin = median(gaps) / 60;
    f.sameGapShare = maxShare(gaps.map((g) => Math.round(g / 60)));
    const dates = timed.map((i) => new Date(i.ms));
    f.minuteModeShare = maxShare(dates.map((d) => d.getUTCMinutes()));
    f.secondModeShare = maxShare(dates.map((d) => d.getUTCSeconds()));
    const hours = new Array(24).fill(0);
    for (const d of dates) hours[d.getUTCHours()]++;
    let H2 = 0;
    for (const c of hours) if (c) H2 -= (c / dates.length) * Math.log(c / dates.length);
    f.hourSpread = H2 / Math.log(24);
    f.repostShare = share(timed, (i) => i.k === "repost");
  }
  const own = items.filter((i) => i.k === "post");
  if (own.length >= args.minText) {
    f.replyShare = share(own, (i) => i.re);
    f.linkShare = share(own, (i) => i.link);
    f.imageShare = share(own, (i) => i.img);
    f.hashtagShare = share(own, (i) => /(^|\s)#\p{L}/u.test(i.x));
    f.mentionShare = share(own, (i) => /(^|\s)@\w/.test(i.x));
    f.textLength = mean(own.map((i) => i.x.length));
    f.languages = new Set(own.flatMap((i) => i.ln)).size;
    f.quoteShare = share(own, (i) => Boolean(i.qu));
    const replies = own.filter((i) => i.re);
    if (replies.length >= 5) {
      f.selfReplyShare = share(replies, (i) => i.to === ctx.did);
      const targets = replies.map((i) => i.to).filter(Boolean);
      if (targets.length >= 5) f.replyTargetSpread = new Set(targets).size / targets.length;
    }
    const reposts = timed.filter((i) => i.k === "repost" && i.a);
    if (reposts.length >= 5) {
      f.repostSourceSpread = new Set(reposts.map((i) => i.a)).size / reposts.length;
      f.topRepostSourceShare = maxShare(reposts.map((i) => i.a));
    }
    const originals = own.filter((i) => !i.re);
    if (originals.length >= args.minText) {
      const eng = originals.map((i) => (i.lk ?? 0) + (i.rp ?? 0) + (i.rc ?? 0) + (i.qt ?? 0));
      f.engagementPerPost = mean(eng);
      f.engagementPerFollower = f.engagementPerPost / ((ctx.followers || 0) + 1);
      f.zeroEngagementShare = share(eng, (e) => e === 0);
      f.repliedToShare = share(originals, (i) => (i.rc ?? 0) > 0);
    }
    const texts = own.map((i) => normalize(i.x)).filter((t) => t.length > 0);
    if (texts.length >= args.minText) {
      const counts = new Map();
      for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
      f.exactDupShare = share(texts, (t) => counts.get(t) > 1);
      const sets = texts.map(tokensOf);
      let total = 0;
      let pairs = 0;
      for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { total += similarity(sets[i], sets[j]); pairs++; }
      f.meanSimilarity = total / pairs;
      const starts = texts.map((t) => t.split(" ").slice(0, 3).join(" "));
      const sc = new Map();
      for (const s of starts) sc.set(s, (sc.get(s) ?? 0) + 1);
      f.templateShare = share(starts, (s) => sc.get(s) > 1);
    }
  }
  return f;
}

// ------------------------------------------------------------------------ AUC
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

// ------------------------------------------------------------------------ main
const rows = people
  .filter((p) => posts[p.did])
  .map((p) => ({ ...p, f: featuresOf(posts[p.did], p) }));

out("=== HOW TO READ THIS REPORT ===");
out("Posting-behaviour signals, each tested alone with AUC: the chance that a random bot has a");
out("HIGHER value than a random comparison account (0.50 = nothing, 1.00 = bots always higher,");
out("0.00 = bots always lower). Strength folds both directions. The 95% interval draws whole");
out("maker groups together. Signals use only the most recent items (up to 100), so timing");
out("signals describe recent behaviour, not the whole history.\n");

out("=== 1. COVERAGE ===");
for (const label of [1, 0]) {
  const st = Object.values(status).filter((s) => s.label === label);
  const c = {};
  for (const s of st) c[s.status] = (c[s.status] ?? 0) + 1;
  out(`${label === 1 ? "Bots" : "Comparison"}: ${st.length} accounts; ` + Object.entries(c).map(([k, v]) => `${k} ${v}`).join(", "));
}
const enough = (label) => rows.filter((r) => r.label === label && Number.isFinite(r.f.gapCV)).length;
const text = (label) => rows.filter((r) => r.label === label && Number.isFinite(r.f.meanSimilarity)).length;
out(`With at least ${args.minItems} items (timing signals): bots ${enough(1)}, comparison ${enough(0)}`);
out(`With at least ${args.minText} own posts (text signals): bots ${text(1)}, comparison ${text(0)}`);
out("Accounts with too little recent activity drop out of the signal that needs it. If many more");
out("comparison accounts than bots drop out, the groups are not compared on equal terms.\n");

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
  results.push({
    name, description, point, nb: bv.length, nc: cv.length,
    lo: draws[Math.floor(0.025 * draws.length)], hi: draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))],
    botMed: median(bv), compMed: median(cv),
  });
}

out("=== 2. EACH SIGNAL ALONE (sorted by strength) ===");
out("signal            AUC   [95% range]    strength  bots tend to be   median bots | median comparison   (n bots / n comp)");
const sorted = results.filter((r) => Number.isFinite(r.point)).sort((a, b) => Math.abs(b.point - 0.5) - Math.abs(a.point - 0.5));
for (const r of sorted) {
  const dir = Math.abs(r.point - 0.5) < 0.03 ? "about equal" : r.point > 0.5 ? "higher" : "lower";
  out(`${r.name.padEnd(17)} ${r.point.toFixed(2)}  [${r.lo.toFixed(2)}-${r.hi.toFixed(2)}]   ${Math.max(r.point, 1 - r.point).toFixed(2)}      ${dir.padEnd(14)}  ${fmt(r.botMed).padStart(8)} | ${fmt(r.compMed).padEnd(10)}   (${r.nb} / ${r.nc})`);
}
for (const r of results.filter((r) => !Number.isFinite(r.point))) out(`${r.name.padEnd(17)} not enough accounts with this signal (${r.nb} bots / ${r.nc} comparison)`);

out("\n=== 3. WHAT EACH SIGNAL MEANS ===");
for (const [n, d] of FEATURES) out(`${n.padEnd(17)} ${d}`);

out("\n=== 4. CHECKS ===");
const strong = sorted.filter((r) => Math.max(r.point, 1 - r.point) >= 0.9);
if (strong.length) out(`Signals with strength 0.90 or more: ${strong.map((r) => r.name).join(", ")}. Check that they do not just repeat posts per day or follows.`);
out("Several signals here are linked to how much an account posts (itemsPerDay, medianGapMin,");
out("windowDays, items). They are different views of the same thing, not separate clues.");

const csv = (v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const cl = [["label", "did", "handle", "operator", ...FEATURES.map(([n]) => n)].join(",")];
for (const r of rows) cl.push([r.label, r.did, r.handle, r.operator, ...FEATURES.map(([n]) => (Number.isFinite(r.f[n]) ? +r.f[n].toFixed(6) : ""))].map(csv).join(","));
await writeFile(`${args.dir}/features_behaviour.csv`, cl.join("\n") + "\n");
await writeFile(`${args.dir}/features_behaviour_report.txt`, lines.join("\n") + "\n");
console.log(`\nSaved: ${args.dir}/features_behaviour.csv and ${args.dir}/features_behaviour_report.txt`);
