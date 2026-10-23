// collector.mjs
// Step 1 of the project: find out how many self-labeled Bluesky bots you can collect.
// Needs Node 18+ (built-in fetch). No packages to install.
//
// Usage:
//   node collector.mjs                       run all default queries
//   node collector.mjs --max-pages 2         fewer pages per query (quick test)
//   node collector.mjs --queries "bot,rss"   your own comma-separated queries
//
// Output (in ./data):
//   labeled_bots.json   every account found with the "bot" self-label + its full profile
//   query_stats.json    how productive each query was
//
// Re-running is safe: it loads what was found before and adds to it.
// Press Ctrl+C at any time: progress is saved.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const BASE = "https://public.api.bsky.app/xrpc";
const OUT_DIR = "data";
const BOTS_FILE = `${OUT_DIR}/labeled_bots.json`;
const STATS_FILE = `${OUT_DIR}/query_stats.json`;
const SEARCH_LIMIT = 100; // results per page; if the API rejects this, lower it to 25
const PROFILE_BATCH = 25; // accounts per getProfiles call; lower it if the API rejects it
const DELAY_MS = 500; // pause between requests, to stay polite

const DEFAULT_QUERIES = [
  "bot", "automated", "automated account", "unofficial bot", "this is a bot",
  "not a human", "posts every", "posts hourly", "posts daily", "rss",
  "news bot", "weather bot", "quote bot", "art bot", "image bot",
  "reposts", "feed", "alerts", "updates", "tracker",
  "daily", "hourly", "random", "generator", "maintained by",
];

function parseArgs(argv) {
  const out = { maxPages: 10, queries: DEFAULT_QUERIES };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--max-pages") out.maxPages = Number(argv[++i]);
    else if (argv[i] === "--queries") {
      out.queries = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One GET request to the public API, with retries for rate limits and network hiccups.
async function apiGet(method, params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => qs.append(key, v));
    else qs.set(key, String(value));
  }
  const url = `${BASE}/${method}?${qs}`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === 5) throw err;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("retry-after")) || 30 * attempt;
      console.log(`  ${res.status} from the API, waiting ${wait}s (attempt ${attempt}/5)...`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`${method} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`${method} failed after 5 attempts`);
}

// A self-label is a label whose source is the account itself.
const isSelfLabeledBot = (actor) =>
  (actor.labels ?? []).some((l) => l.val === "bot" && l.src === actor.did);

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

const { maxPages, queries } = parseArgs(process.argv);
await mkdir(OUT_DIR, { recursive: true });

const found = new Map((await loadJson(BOTS_FILE, [])).map((b) => [b.did, b]));
const stats = await loadJson(STATS_FILE, {});
const seen = new Set();
const startCount = found.size;

async function save() {
  await writeFile(BOTS_FILE, JSON.stringify([...found.values()], null, 2));
  await writeFile(STATS_FILE, JSON.stringify(stats, null, 2));
}

process.on("SIGINT", async () => {
  console.log("\nStopped. Saving what we have so far...");
  await save();
  process.exit(0);
});

console.log(`Starting with ${startCount} labeled bots from earlier runs.`);
console.log(`Running ${queries.length} queries, up to ${maxPages} pages each.\n`);

// Phase 1: search, keep accounts that carry the bot self-label.
for (const q of queries) {
  let cursor;
  let pages = 0;
  let accountsSeen = 0;
  let labeled = 0;
  let newLabeled = 0;

  for (let p = 0; p < maxPages; p++) {
    let data;
    try {
      data = await apiGet("app.bsky.actor.searchActors", { q, limit: SEARCH_LIMIT, cursor });
    } catch (err) {
      console.log(`  "${q}": ${err.message}`);
      break;
    }
    pages++;
    for (const a of data.actors ?? []) {
      seen.add(a.did);
      accountsSeen++;
      if (!isSelfLabeledBot(a)) continue;
      labeled++;
      if (!found.has(a.did)) {
        newLabeled++;
        found.set(a.did, {
          did: a.did,
          handle: a.handle,
          displayName: a.displayName ?? null,
          description: a.description ?? null,
          createdAt: a.createdAt ?? null,
          labels: a.labels,
          foundVia: q,
        });
      }
    }
    cursor = data.cursor;
    if (!cursor) break;
    await sleep(DELAY_MS);
  }

  stats[q] = {
    pages,
    accountsSeen,
    labeledBots: labeled,
    newLabeledBots: newLabeled,
    runAt: new Date().toISOString(),
  };
  console.log(
    `"${q}": ${accountsSeen} accounts, ${labeled} labeled bots (${newLabeled} new). Total so far: ${found.size}`
  );
  await save();
}

// Phase 2: fetch the full profile (follower, follow and post counts) for each labeled bot.
const missing = [...found.values()].filter((b) => !b.profile).map((b) => b.did);
console.log(`\nFetching full profiles for ${missing.length} accounts...`);
for (let i = 0; i < missing.length; i += PROFILE_BATCH) {
  const batch = missing.slice(i, i + PROFILE_BATCH);
  try {
    const data = await apiGet("app.bsky.actor.getProfiles", { actors: batch });
    for (const profile of data.profiles ?? []) {
      const entry = found.get(profile.did);
      if (entry) entry.profile = profile;
    }
  } catch (err) {
    console.log(`  batch starting at ${i} failed: ${err.message}`);
  }
  await sleep(DELAY_MS);
}
await save();

// Summary
const withProfile = [...found.values()].filter((b) => b.profile).length;
const top = Object.entries(stats)
  .sort((a, b) => b[1].labeledBots - a[1].labeledBots)
  .slice(0, 5);

console.log("\n=== SUMMARY ===");
console.log(`Unique accounts seen this run:  ${seen.size}`);
console.log(`Labeled bots collected (total): ${found.size} (${found.size - startCount} new this run)`);
console.log(`With full profile saved:        ${withProfile}`);
console.log(`Most productive queries:        ${top.map(([q, s]) => `"${q}" (${s.labeledBots})`).join(", ")}`);
console.log(`\nSaved to ${BOTS_FILE} and ${STATS_FILE}`);
