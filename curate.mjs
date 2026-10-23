// curate.mjs  (version 3: the maker's @handle may be on the line after "by", "automated by", ...)
// Turns the raw collection (data/labeled_bots.json) into an evaluation-ready set.
//
// Three decisions are made here, each of them a parameter you can change:
//   1. ACTIVITY FILTER: drop bots with fewer than --min-posts posts (default 100),
//      because posting rhythm and repetitiveness cannot be measured without history.
//   2. MAKER GROUPS: assign every bot to a group of bots probably made by the same
//      person or organisation (rules explained below).
//   3. PER-MAKER CAP: keep at most --cap bots per group (default 15), chosen at random,
//      so that one prolific maker cannot dominate the evaluation.
//
// Usage:
//   node curate.mjs
//   node curate.mjs --min-posts 50 --cap 10 --seed 7
//
// Output (in ./data):
//   bots_annotated.json        every bot that passes the activity filter, with its maker group
//   bots_curated.json          the capped subset (the main evaluation set)
//   curation_log.csv           one row per bot: group, how it was assigned, kept or dropped and why
//   loners_with_mentions.csv   bots with no maker found whose bio still mentions an @handle
//   curation_report.txt        the funnel, group sizes, a cap sensitivity table, a sanity sample
//                              and the list of possibly missed makers
//
// Needs Node 18+. Nothing to install. Does not touch the network.

import { readFile, writeFile } from "node:fs/promises";

const IN_FILE = "data/labeled_bots.json";
const ANNOTATED_FILE = "data/bots_annotated.json";
const CURATED_FILE = "data/bots_curated.json";
const LOG_FILE = "data/curation_log.csv";
const LONERS_FILE = "data/loners_with_mentions.csv";
const REPORT_FILE = "data/curation_report.txt";

// Services that host or bridge many unrelated bots. A bio that mentions one of these says
// nothing about who made the bot, so they are never treated as the maker.
const PLATFORM_HANDLES = new Set([
  "bluebotsdonequick.com",
  "ap.brid.gy",
  "bsky.app",
  "eurosky.social",
]);

// Handle domains that belong to a platform, not to one maker. Bots whose handles end in one
// of these are NOT grouped by domain: for example *.mastodon.social.ap.brid.gy is a bridge
// to a very large general fediverse server, so those accounts are many different people.
const PLATFORM_DOMAIN_SUFFIXES = ["ap.brid.gy", "eurosky.social"];

function parseArgs(argv) {
  const out = { minPosts: 100, cap: 15, seed: 1, sample: 15 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--min-posts") out.minPosts = Number(argv[++i]);
    else if (argv[i] === "--cap") out.cap = Number(argv[++i]);
    else if (argv[i] === "--seed") out.seed = Number(argv[++i]);
    else if (argv[i] === "--sample") out.sample = Number(argv[++i]);
  }
  return out;
}

// ------------------------------------------------------------------ small helpers
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

// Seeded random generator: the same --seed always gives the same selection.
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

function shuffle(array, random) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const oneLine = (s, max) => {
  const flat = (s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// Shows a text exactly as stored: line breaks as \n and invisible characters as \uXXXX.
const isInvisible = (c) =>
  c === 0x00a0 || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 ||
  (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || c === 0xfeff;
const visible = (s) =>
  [...(s ?? "")]
    .map((ch) => {
      if (ch === "\n") return "\\n";
      if (ch === "\r") return "\\r";
      if (ch === "\t") return "\\t";
      const c = ch.codePointAt(0);
      return isInvisible(c) ? "\\" + "u" + c.toString(16).padStart(4, "0") : ch;
    })
    .join("");

const csv = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

// --------------------------------------------------------------------- maker rules
// Rule 1: the bio names its maker, e.g. "maintained by @someone.bsky.social".
//         We look for a maker word followed within 25 characters (a line break counts as
//         a character) by an @handle. The word
//         list covers common English phrasings ("by", "maintained", "automated by",
//         "powered by", "operated by", ...) and a few other languages ("gestito da",
//         "von", "par", "por", "door", "av", ...). Handles of hosting services and the
//         bot's own handle are skipped. Email addresses are not matched.
// Rule 2: otherwise, the bot's handle uses a custom domain shared by 3 or more bots
//         (for example *.bot.example), which suggests one owner. Platform domains
//         (see PLATFORM_DOMAIN_SUFFIXES) are excluded.
// Rule 3: otherwise, the bot is on its own (a group of one).
const HANDLE =
  "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+";
const MAKER_WORDS =
  // English
  "by|contact|maintainer|maintained|maintains|owner|owned|operator|operated|admin|made|" +
  "created|run|runs|ran|managed|manager|built|curated|developed|author|authored|creator|" +
  "report|reports|automated|powered|written|coded|programmed|posted|mirrored|forked|" +
  // Italian, Spanish, Portuguese, German, French, Dutch, Scandinavian, Polish, Romanian
  "gestito|gestita|gestionado|gestionada|gerido|gerida|geführt|betrieben|von|par|por|" +
  "door|beheerd|av|przez|administrat|creat|" +
  // Phrasings seen in real bios of this dataset ("blame @x", Danish "Lavet af @x")
  "blame|lavet";
// [^@]{0,25} also matches line breaks: many bios put the handle on the line after "by".
const makerRe = new RegExp(
  `\\b(?:${MAKER_WORDS})\\b[^@]{0,25}(?<![a-z0-9._-])@(${HANDLE})`,
  "gi"
);
const mentionRe = new RegExp(`(?<![a-z0-9._-])@(${HANDLE})`, "gi");

function findMaker(bot) {
  const own = (bot.handle ?? "").toLowerCase();
  for (const m of (bot.description ?? "").matchAll(makerRe)) {
    const handle = m[1].toLowerCase();
    if (handle !== own && !PLATFORM_HANDLES.has(handle)) return handle;
  }
  return null;
}

// Every @handle in the bio except the bot's own and platform handles.
function mentionedHandles(bot) {
  const own = (bot.handle ?? "").toLowerCase();
  const found = new Set();
  for (const m of (bot.description ?? "").matchAll(mentionRe)) {
    const handle = m[1].toLowerCase();
    if (handle !== own && !PLATFORM_HANDLES.has(handle)) found.add(handle);
  }
  return [...found];
}

const isPlatformDomain = (domain) =>
  PLATFORM_DOMAIN_SUFFIXES.some((s) => domain === s || domain.endsWith(`.${s}`));

// The part of the handle after the first dot, unless it is plain bsky.social or a platform.
function domainOf(bot) {
  const parts = (bot.handle ?? "").toLowerCase().split(".");
  if (parts.length < 3) return null;
  const domain = parts.slice(1).join(".");
  return domain === "bsky.social" || isPlatformDomain(domain) ? null : domain;
}

// ------------------------------------------------------------------------- load
const { minPosts, cap, seed, sample } = parseArgs(process.argv);

let bots;
try {
  bots = JSON.parse(await readFile(IN_FILE, "utf8"));
} catch {
  console.log(`Could not read ${IN_FILE}. Run collector.mjs first, from this same folder.`);
  process.exit(1);
}
if (!bots.length) {
  console.log("The file is empty. Run collector.mjs first.");
  process.exit(1);
}

const domainCounts = new Map(countBy(bots, domainOf));

function assignGroup(bot) {
  const maker = findMaker(bot);
  if (maker) return { operator: `maker:${maker}`, rule: "named in bio" };
  const domain = domainOf(bot);
  if (domain && (domainCounts.get(domain) ?? 0) >= 3) {
    return { operator: `domain:${domain}`, rule: "shared handle domain" };
  }
  return { operator: `solo:${bot.did}`, rule: "no maker found (group of one)" };
}

// ---------------------------------------------------------------- filter and cap
const postsOf = (b) => b.profile?.postsCount ?? 0;

const decisions = new Map(); // did -> "kept" | "dropped_inactive" | "dropped_cap"
const active = [];
for (const b of bots) {
  if (postsOf(b) >= minPosts) {
    active.push({ ...b, ...assignGroup(b) });
  } else {
    decisions.set(b.did, "dropped_inactive");
  }
}

// Shuffle once (seeded), then keep the first `cap` bots seen in each group. The selection
// is random within a group and does not depend on how good or typical a bot looks.
const random = seededRandom(seed);
const order = [...active].sort((a, b) => a.did.localeCompare(b.did));
shuffle(order, random);
const keptPerGroup = new Map();
for (const b of order) {
  const n = keptPerGroup.get(b.operator) ?? 0;
  if (n < cap) {
    keptPerGroup.set(b.operator, n + 1);
    decisions.set(b.did, "kept");
  } else {
    decisions.set(b.did, "dropped_cap");
  }
}
const curated = active.filter((b) => decisions.get(b.did) === "kept");

// Bots with no maker found whose bio still mentions some @handle: possible missed makers.
const loners = active.filter((b) => b.rule.startsWith("no maker found"));
const lonersWithMentions = loners
  .map((b) => ({ bot: b, mentions: mentionedHandles(b) }))
  .filter((x) => x.mentions.length);

// ------------------------------------------------------------------------ outputs
await writeFile(ANNOTATED_FILE, JSON.stringify(active, null, 2));
await writeFile(CURATED_FILE, JSON.stringify(curated, null, 2));

const groupOf = new Map(active.map((b) => [b.did, b]));
const logRows = [["did", "handle", "operator_group", "assigned_by", "posts", "created_at", "decision"]];
for (const b of bots) {
  const a = groupOf.get(b.did);
  logRows.push([
    b.did,
    b.handle,
    a?.operator ?? "",
    a?.rule ?? "",
    postsOf(b),
    b.profile?.createdAt ?? b.createdAt ?? "",
    decisions.get(b.did),
  ]);
}
await writeFile(LOG_FILE, logRows.map((r) => r.map(csv).join(",")).join("\n") + "\n");

const lonerRows = [["did", "handle", "mentioned_handles", "bio"]];
for (const { bot, mentions } of lonersWithMentions) {
  lonerRows.push([bot.did, bot.handle, mentions.join(" "), oneLine(bot.description, 400)]);
}
await writeFile(LONERS_FILE, lonerRows.map((r) => r.map(csv).join(",")).join("\n") + "\n");

// ------------------------------------------------------------------------- report
const droppedInactive = bots.length - active.length;
const droppedCap = active.length - curated.length;

out("=== HOW TO READ THIS REPORT ===");
out("Bots are filtered for activity, grouped by probable maker, and each group is capped.");
out("The point is to stop one prolific maker from dominating the evaluation. Groups are");
out("found by simple rules, so check the sanity sample at the end before trusting them.\n");

out("=== 1. PARAMETERS ===");
out(`Minimum posts:       ${minPosts}`);
out(`Cap per maker group: ${cap}`);
out(`Random seed:         ${seed}\n`);

out("=== 2. FUNNEL ===");
out(`Labeled bots collected:                  ${String(bots.length).padStart(5)}`);
out(`  dropped, fewer than ${minPosts} posts:        ${String(droppedInactive).padStart(5)}`);
out(`After activity filter:                   ${String(active.length).padStart(5)}  (${pct(active.length, bots.length)})`);
out(`  dropped by per-maker cap of ${cap}:       ${String(droppedCap).padStart(5)}`);
out(`Curated evaluation set:                  ${String(curated.length).padStart(5)}  (${pct(curated.length, bots.length)} of collected)\n`);

out("=== 3. HOW BOTS WERE ASSIGNED TO GROUPS (bots passing the activity filter) ===");
for (const [rule, n] of countBy(active, (b) => b.rule)) {
  out(`  ${String(n).padStart(5)}  ${pct(n, active.length).padStart(6)}  ${rule}`);
}
const groupSizes = countBy(active, (b) => b.operator);
const multi = groupSizes.filter(([, n]) => n > 1);
out(`\nDistinct groups: ${groupSizes.length}, of which ${multi.length} contain more than one bot.\n`);

out("=== 4. LARGEST GROUPS WITH MORE THAN ONE BOT (before cap -> after cap) ===");
if (!multi.length) out("  (every bot is in a group of one)");
for (const [group, n] of multi.slice(0, 15)) {
  const after = keptPerGroup.get(group) ?? 0;
  out(`  ${String(n).padStart(5)} -> ${String(after).padStart(3)}  ${group}`);
}

out("\n=== 5. CAP SENSITIVITY (what would other cap values give?) ===");
out("A lower cap makes the set more varied but smaller. 'Largest group' is the share of");
out("the resulting set that comes from its single biggest group.\n");
out("  cap   set size   largest group");
for (const c of [5, 10, 15, 20, 30, 50, Infinity]) {
  const sizes = groupSizes.map(([, n]) => Math.min(n, c));
  const total = sizes.reduce((a, b) => a + b, 0);
  const biggest = Math.max(...sizes);
  out(`  ${String(c === Infinity ? "none" : c).padStart(4)}  ${String(total).padStart(8)}   ${pct(biggest, total).padStart(8)}`);
}

out("\n=== 6. DOES CURATION CHANGE THE MIX? (after activity filter vs curated) ===");
const years = (set) => countBy(set, (b) => (b.profile?.createdAt ?? b.createdAt ?? "").slice(0, 4));
const yearList = [...new Set([...years(active), ...years(curated)].map(([y]) => y))].sort();
const activeYears = new Map(years(active));
const curatedYears = new Map(years(curated));
out("\nAccount creation year:");
for (const y of yearList) {
  out(
    `  ${y}: ${pct(activeYears.get(y) ?? 0, active.length).padStart(6)} -> ${pct(curatedYears.get(y) ?? 0, curated.length).padStart(6)}`
  );
}
const q = (arr, p) => quantile([...arr].sort((a, b) => a - b), p);
out("\nPosts per bot (25% / median / 75%):");
out(`  after activity filter: ${q(active.map(postsOf), 0.25)} / ${q(active.map(postsOf), 0.5)} / ${q(active.map(postsOf), 0.75)}`);
out(`  curated:               ${q(curated.map(postsOf), 0.25)} / ${q(curated.map(postsOf), 0.5)} / ${q(curated.map(postsOf), 0.75)}`);

out(`\n=== 7. SANITY SAMPLE: ${Math.min(sample, active.length)} RANDOM BOTS WITH THEIR ASSIGNED GROUP ===`);
out("Check that the group makes sense given the bio. Wrong groups are worth reporting to me.\n");
const sampleRandom = seededRandom(seed + 1);
shuffle([...active], sampleRandom)
  .slice(0, sample)
  .forEach((b, i) => {
    out(`${String(i + 1).padStart(2)}. ${b.handle}   -> ${b.operator}   (${b.rule})`);
    out(`    bio: ${oneLine(b.description, 250) || "-"}`);
  });

out("\n=== 8. POSSIBLY MISSED MAKERS ===");
out("Bots that ended up on their own (no maker found) but whose bio still mentions an");
out("@handle. Some are missed makers, some just mention the account they mirror or a");
out("credit. The full list is in data/loners_with_mentions.csv.");
out("'raw' shows the bio exactly as stored: line breaks as \\n, invisible characters as \\uXXXX.\n");
out(`Bots on their own:                       ${String(loners.length).padStart(5)}`);
out(`  of which the bio mentions an @handle:  ${String(lonersWithMentions.length).padStart(5)}  (${pct(lonersWithMentions.length, loners.length)})`);
out("\nHandles mentioned by 2 or more of these bots (a repeated handle is a likely missed maker):\n");
const repeated = countBy(
  lonersWithMentions.flatMap((x) => x.mentions),
  (h) => h
).filter(([, n]) => n >= 2);
if (!repeated.length) out("  (none)");
for (const [handle, n] of repeated.slice(0, 15)) out(`  ${String(n).padStart(4)}  @${handle}`);
out("\nFirst 15 examples:\n");
for (const { bot, mentions } of lonersWithMentions.slice(0, 15)) {
  out(`  ${bot.handle}  ->  ${mentions.map((m) => `@${m}`).join(" ")}`);
  out(`    bio: ${oneLine(bot.description, 200)}`);
  out(`    raw: ${visible(bot.description).slice(0, 300)}`);
}

await writeFile(REPORT_FILE, lines.join("\n") + "\n");
console.log(`\nSaved: ${CURATED_FILE}, ${ANNOTATED_FILE}, ${LOG_FILE}, ${LONERS_FILE}, ${REPORT_FILE}`);
