// features_conversation.mjs
// Do accounts TALK WITH people the way people do? Measures who an account replies to and mentions,
// and whether those are accounts it is connected to. Then asks the hard question: do these signals
// help to tell the bots the main score MISSES from ordinary accounts?
//
// Reads:  data/posts.json, data/graph.json, data/features_profile.csv, data/score_combined.csv,
//         data/bot_types.csv (optional)
// Writes: data/features_conversation.csv, data/features_conversation_report.txt
// Usage:  node features_conversation.mjs        (Node 18+, no packages, no network)

import { readFile, writeFile } from "node:fs/promises";

const DIR = "data";
function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function load(name, optional = false) {
  try { return await readFile(`${DIR}/${name}`, "utf8"); } catch {
    if (optional) return null;
    console.log(`Could not read ${DIR}/${name}. Run the earlier steps first, from the folder that contains the data folder.`); process.exit(1);
  }
}
const table = (text) => { const t = parseCsv(text.trim()); return t.slice(1).map((r) => Object.fromEntries(t[0].map((n, i) => [n, r[i]]))); };

const posts = JSON.parse(await load("posts.json"));
const graph = JSON.parse(await load("graph.json"));
const prof = new Map(table(await load("features_profile.csv")).map((r) => [r.did, r]));
const scoreRows = table(await load("score_combined.csv"));
const typeText = await load("bot_types.csv", true);
const types = new Map(typeText ? table(typeText).map((r) => [r.did, r.type]) : []);

const FEATURES = [
  ["replies", "number of replies among the fetched items"],
  ["replyToOthersShare", "share of own posts that are replies to OTHER accounts"],
  ["replyTopTargetShare", "share of replies to others that go to the single most replied-to account"],
  ["replyToFollowedShare", "share of replies to others that go to accounts it follows (only when it follows 100 or fewer)"],
  ["replyToFollowerShare", "share of replies to others that go to accounts that follow it (only when it has 100 or fewer followers)"],
  ["replyToKnownShare", "share of replies to others that go to an account it follows or that follows it (needs both lists complete)"],
  ["mentions", "number of @mentions in own posts"],
  ["mentionSpread", "different accounts mentioned divided by mentions (near 0 = same few accounts)"],
  ["mentionKnownShare", "share of mentions that point to accounts it follows or that follow it (needs both lists complete)"],
  ["replyLenRatio", "average text length of replies divided by average length of other own posts"],
];
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

function featuresOf(items, p, g) {
  const f = Object.fromEntries(FEATURES.map(([n]) => [n, NaN]));
  const own = items.filter((i) => i.k === "post");
  if (own.length < 20) return f;
  const did = p.did;
  const replies = own.filter((i) => i.re);
  f.replies = replies.length;
  const toOthers = replies.filter((i) => i.to && i.to !== did);
  f.replyToOthersShare = toOthers.length / own.length;
  const follows = g ? new Set(g.follows.map((a) => a.d)) : null;
  const followers = g ? new Set(g.followers.map((a) => a.d)) : null;
  const fullFollows = follows && Number(p.follows) <= 100;
  const fullFollowers = followers && Number(p.followers) <= 100;
  if (toOthers.length >= 5) {
    const c = new Map();
    for (const i of toOthers) c.set(i.to, (c.get(i.to) ?? 0) + 1);
    f.replyTopTargetShare = Math.max(...c.values()) / toOthers.length;
    if (fullFollows) f.replyToFollowedShare = toOthers.filter((i) => follows.has(i.to)).length / toOthers.length;
    if (fullFollowers) f.replyToFollowerShare = toOthers.filter((i) => followers.has(i.to)).length / toOthers.length;
    if (fullFollows && fullFollowers) f.replyToKnownShare = toOthers.filter((i) => follows.has(i.to) || followers.has(i.to)).length / toOthers.length;
  }
  const ments = own.flatMap((i) => (i.me ?? []).filter((d) => d !== did));
  f.mentions = ments.length;
  if (ments.length >= 5) {
    f.mentionSpread = new Set(ments).size / ments.length;
    if (fullFollows && fullFollowers) f.mentionKnownShare = ments.filter((d) => follows.has(d) || followers.has(d)).length / ments.length;
  }
  const rl = replies.map((i) => (i.x ?? "").length).filter((n) => n > 0);
  const ol = own.filter((i) => !i.re).map((i) => (i.x ?? "").length).filter((n) => n > 0);
  if (rl.length >= 5 && ol.length >= 5 && mean(ol) > 0) f.replyLenRatio = mean(rl) / mean(ol);
  return f;
}

function auc(a, b) {
  const all = [...a.map((v) => [v, 1]), ...b.map((v) => [v, 0])].sort((x, y) => x[0] - y[0]);
  let rs = 0, i = 0;
  while (i < all.length) { let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++; for (let k = i; k <= j; k++) if (all[k][1] === 1) rs += (i + j) / 2 + 1; i = j + 1; }
  return (rs - (a.length * (a.length + 1)) / 2) / (a.length * b.length);
}
let seed = 1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
function aucCI(a, b) {
  const d = [];
  for (let k = 0; k < 300; k++) {
    const x = a.map(() => a[Math.floor(rnd() * a.length)]);
    const y = b.map(() => b[Math.floor(rnd() * b.length)]);
    d.push(auc(x, y));
  }
  d.sort((p, q) => p - q);
  return [d[7], d[292]];
}

const rows = scoreRows.filter((r) => posts[r.did]).map((r) => ({
  label: Number(r.label), did: r.did, handle: r.handle, operator: r.operator, score: Number(r.score),
  type: types.get(r.did) ?? "", f: featuresOf(posts[r.did], prof.get(r.did) ?? {}, graph[r.did]),
}));
const lines = [];
const out = (s = "") => { console.log(s); lines.push(s); };
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");

const bots = rows.filter((r) => r.label === 1);
const comp = rows.filter((r) => r.label === 0);
const hardType = (r) => /^(AI agent|persona)/.test(r.type);
const setA = bots.filter((r) => r.score < 50);
const setB = bots.filter(hardType);
out("=== HOW TO READ THIS REPORT ===");
out("Signals about how an account talks WITH others: whom it replies to and mentions, and whether");
out("those accounts are ones it is connected to. People mostly talk to people they know; many bots");
out("never reply, or reply to strangers. AUC = chance that a random bot has a HIGHER value than a");
out("random comparison account (0.50 = nothing). The question here is not whether the signals");
out("separate ALL bots (the main score already does), but whether they separate the bots that the");
out("main score MISSES. Those groups are small, so the intervals are wide.\n");
out("Accounts used:");
out(`  all bots ${bots.length}, comparison ${comp.length}`);
out(`  group A: bots the main score gives below 50: ${setA.length}`);
out(`  group B: bots whose bio says AI agent or persona (rough sort): ${setB.length}`);
out("  The comparison group in the hard tests is: ordinary accounts scoring below 50 on the main score.\n");
const compLow = comp.filter((r) => r.score < 50);
out(`  comparison accounts below 50: ${compLow.length}\n`);

out("=== 1. EACH SIGNAL: ALL BOTS vs ALL COMPARISON ===");
out("signal                  AUC    n bots / n comp   median bots | median comparison");
for (const [n] of FEATURES) {
  const a = bots.map((r) => r.f[n]).filter(Number.isFinite), b = comp.map((r) => r.f[n]).filter(Number.isFinite);
  if (a.length < 15 || b.length < 15) { out(`${n.padEnd(22)}  not enough accounts (${a.length} / ${b.length})`); continue; }
  out(`${n.padEnd(22)}  ${fmt(auc(a, b))}   ${String(a.length).padStart(4)} / ${String(b.length).padEnd(4)}         ${fmt(median(a)).padStart(6)} | ${fmt(median(b))}`);
}
for (const [title, set] of [["2. THE BOTS THE SCORE MISSES (group A, score below 50) vs low-scoring comparison accounts", setA], ["3. AI-AGENT AND PERSONA BOTS (group B) vs low-scoring comparison accounts", setB]]) {
  out(`\n=== ${title} ===`);
  out("signal                  AUC   [rough 95% range]   n bots / n comp   median bots | median comparison");
  for (const [n] of FEATURES) {
    const a = set.map((r) => r.f[n]).filter(Number.isFinite), b = compLow.map((r) => r.f[n]).filter(Number.isFinite);
    if (a.length < 6 || b.length < 15) { out(`${n.padEnd(22)}  not enough accounts (${a.length} / ${b.length})`); continue; }
    const [lo, hi] = aucCI(a, b);
    out(`${n.padEnd(22)}  ${fmt(auc(a, b))}   [${fmt(lo)}-${fmt(hi)}]        ${String(a.length).padStart(3)} / ${String(b.length).padEnd(4)}      ${fmt(median(a)).padStart(6)} | ${fmt(median(b))}`);
  }
}
out("\n=== 4. WHAT EACH SIGNAL MEANS ===");
for (const [n, d] of FEATURES) out(`${n.padEnd(22)} ${d}`);
out("\nNote: the interval here draws single accounts, not whole maker groups, so it is narrower than it should be.");
out("The range shown is a rough guide only. Treat any AUC from fewer than about 30 bots as a hint, not a result.");

const csv = (v) => (typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
await writeFile(`${DIR}/features_conversation.csv`, [["label", "did", "handle", "operator", ...FEATURES.map(([n]) => n)].join(","),
  ...rows.map((r) => [r.label, r.did, r.handle, r.operator, ...FEATURES.map(([n]) => (Number.isFinite(r.f[n]) ? +r.f[n].toFixed(6) : ""))].map(csv).join(","))].join("\n") + "\n");
await writeFile(`${DIR}/features_conversation_report.txt`, lines.join("\n") + "\n");
console.log(`\nSaved: ${DIR}/features_conversation.csv and ${DIR}/features_conversation_report.txt`);
