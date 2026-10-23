// inspect.mjs
// Reads data/labeled_bots.json (made by collector.mjs) and prints a report that answers:
//   1. Do many bots come from the same maker?   (sections 2 and 3)
//   2. Are many of the bots dormant?             (section 4)
//   3. What kinds of bots are these?             (sections 5 and 6)
//
// Usage:
//   node inspect.mjs                 default: 30 random bots in the sample
//   node inspect.mjs --sample 50     bigger sample
//   node inspect.mjs --seed 7        different random sample (same seed = same sample)
//
// The whole report is also saved to data/inspection_report.txt so you can paste it to me.
// Needs Node 18+. Nothing to install. Does not touch the network.

import { readFile, writeFile } from "node:fs/promises";

const BOTS_FILE = "data/labeled_bots.json";
const REPORT_FILE = "data/inspection_report.txt";

function parseArgs(argv) {
  const out = { sample: 30, seed: 1 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--sample") out.sample = Number(argv[++i]);
    else if (argv[i] === "--seed") out.seed = Number(argv[++i]);
  }
  return out;
}

const lines = [];
const out = (s = "") => {
  console.log(s);
  lines.push(s);
};

const pct = (n, total) => (total ? `${((100 * n) / total).toFixed(1)}%` : "n/a");

function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key === null || key === undefined || key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// Small seeded random generator, so the same --seed always gives the same sample.
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

const oneLine = (s, max) => {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const { sample, seed } = parseArgs(process.argv);

let bots;
try {
  bots = JSON.parse(await readFile(BOTS_FILE, "utf8"));
} catch {
  console.log(`Could not read ${BOTS_FILE}. Run collector.mjs first, from this same folder.`);
  process.exit(1);
}
const total = bots.length;
if (!total) {
  console.log("The file is empty. Run collector.mjs first.");
  process.exit(1);
}

// ---------------------------------------------------------------- 1. Overview
out("=== 1. OVERVIEW ===");
out(`Labeled bots in file: ${total}`);
out(`With full profile:    ${bots.filter((b) => b.profile).length}`);
out(`With a description:   ${bots.filter((b) => (b.description ?? "").trim()).length}`);

// ------------------------------------------------- 2. Makers named in descriptions
// Bluesky handles look like domains, so we look for "@something.something" in each bio.
// Each account counts once per maker. An account's own handle is ignored.
out("\n=== 2. MAKERS MENTIONED IN BIOS (possible clusters) ===");
out("Accounts whose description mentions the same @handle. A handle with a big count");
out("is probably the maker (or the original account being mirrored). Ignore handles");
out("that are obviously just the account someone is mirroring if that makes sense.\n");
const mentionRe = /(?<![a-z0-9._-])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;
const mentionCounts = new Map();
for (const b of bots) {
  const own = (b.handle ?? "").toLowerCase();
  const mentioned = new Set(
    [...(b.description ?? "").matchAll(mentionRe)].map((m) => m[1].toLowerCase())
  );
  mentioned.delete(own);
  for (const m of mentioned) mentionCounts.set(m, (mentionCounts.get(m) ?? 0) + 1);
}
const topMentions = [...mentionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
if (!topMentions.length) out("(no @handles found in descriptions)");
for (const [handle, n] of topMentions) {
  out(`${String(n).padStart(4)}  ${pct(n, total).padStart(6)}  @${handle}`);
}

// ------------------------------------------------ 3. Shared domains and phrasings
out("\n=== 3. SHARED HANDLE DOMAINS AND OPENING PHRASES ===");
out("Handle domains used by 3 or more bots (bsky.social is skipped). A custom domain");
out("shared by many bots usually means one maker. Generic ones like co.uk mean nothing.\n");
const domains = countBy(bots, (b) => {
  const parts = (b.handle ?? "").toLowerCase().split(".");
  if (parts.length < 3) return null;
  const domain = parts.slice(1).join(".");
  return domain === "bsky.social" ? null : domain;
}).filter(([, n]) => n >= 3);
if (!domains.length) out("(none)");
for (const [domain, n] of domains.slice(0, 15)) {
  out(`${String(n).padStart(4)}  ${pct(n, total).padStart(6)}  *.${domain}`);
}

out("\nFirst five words of the description, when 3 or more bots start the same way:\n");
const openings = countBy(bots, (b) => {
  const words = (b.description ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.length >= 3 ? words.slice(0, 5).join(" ") : null;
}).filter(([, n]) => n >= 3);
if (!openings.length) out("(none)");
for (const [phrase, n] of openings.slice(0, 12)) {
  out(`${String(n).padStart(4)}  ${pct(n, total).padStart(6)}  "${phrase}..."`);
}

// ------------------------------------------------------------- 4. Activity levels
out("\n=== 4. ACTIVITY (how many posts do these bots have?) ===");
const withProfile = bots.filter((b) => b.profile);
const posts = withProfile.map((b) => b.profile.postsCount ?? 0).sort((a, b) => a - b);
const followers = withProfile.map((b) => b.profile.followersCount ?? 0).sort((a, b) => a - b);
const follows = withProfile.map((b) => b.profile.followsCount ?? 0).sort((a, b) => a - b);

out("\n                 min   25%   median   75%   max");
for (const [name, arr] of [["posts", posts], ["followers", followers], ["follows", follows]]) {
  out(
    `${name.padEnd(12)}${String(arr[0]).padStart(7)}${String(quantile(arr, 0.25)).padStart(6)}` +
      `${String(quantile(arr, 0.5)).padStart(9)}${String(quantile(arr, 0.75)).padStart(6)}` +
      `${String(arr[arr.length - 1]).padStart(8)}`
  );
}

out("\nIf you only keep bots with at least N posts, how many are left?\n");
for (const n of [1, 10, 20, 50, 100, 200, 500, 1000]) {
  const kept = posts.filter((p) => p >= n).length;
  out(`  at least ${String(n).padStart(4)} posts: ${String(kept).padStart(5)} bots (${pct(kept, posts.length)})`);
}
out(`\nBots with zero posts: ${posts.filter((p) => p === 0).length}`);

// ------------------------------------------------------------------- 5. Account age
out("\n=== 5. WHEN WERE THESE ACCOUNTS CREATED? ===\n");
const created = bots
  .map((b) => b.profile?.createdAt ?? b.createdAt)
  .filter(Boolean);
for (const [year, n] of countBy(created, (d) => d.slice(0, 4)).sort((a, b) => a[0].localeCompare(b[0]))) {
  out(`  ${year}: ${String(n).padStart(4)} (${pct(n, created.length)})`);
}
out("\nBusiest creation days (many accounts on one day can mean one maker made a batch):\n");
for (const [day, n] of countBy(created, (d) => d.slice(0, 10)).slice(0, 8)) {
  out(`  ${day}: ${n}`);
}

// ------------------------------------------------------------ 6. Sources and sample
out("\n=== 6. WHICH SEARCH FOUND THEM ===\n");
for (const [query, n] of countBy(bots, (b) => b.foundVia)) {
  out(`  ${String(n).padStart(4)}  "${query}"`);
}

out(`\n=== 7. RANDOM SAMPLE OF ${Math.min(sample, total)} BOTS (seed ${seed}) ===`);
out("Read each one and note its kind: news/RSS, quote, art/image, weather/alerts, other.");
out("Note anything odd: a human who ticked the label by accident, spam, an AI chatbot.\n");
const random = seededRandom(seed);
const shuffled = [...bots];
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
}
shuffled.slice(0, sample).forEach((b, i) => {
  const nPosts = b.profile?.postsCount ?? "?";
  out(`${String(i + 1).padStart(2)}. ${b.handle}  [${nPosts} posts]`);
  out(`    name: ${oneLine(b.displayName, 70) || "-"}`);
  out(`    bio:  ${oneLine(b.description, 160) || "-"}`);
});

await writeFile(REPORT_FILE, lines.join("\n") + "\n");
console.log(`\nReport saved to ${REPORT_FILE}`);
