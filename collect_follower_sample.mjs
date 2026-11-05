// collect_follower_sample.mjs
// Extends data/graph.json: for each account, picks k random followers (default 5) and
// fetches who they follow. The result is stored as a `followerSample` field on each
// graph entry: [{d: followerDID, follows: [compact profiles, ...]}]
//
// This enables two new signals in features_graph.mjs and in the web app (app/signals.js):
//   followerCluster              do an account's followers follow each other? (bot-farm pattern)
//   followerSampleBotFollowShare are accounts in its followers' network labelled bots?
// Both signals can be computed for ANY account (not just study accounts), so they go into
// the web model and app/model.json once score_combined.mjs and export_web_model.mjs are rerun.
//
// Reads:  data/graph.json  (made by collect_graph.mjs; must exist)
// Writes: data/graph.json  (adds followerSample to each entry; saves every 50 accounts)
//
// Usage:  node collect_follower_sample.mjs
//         node collect_follower_sample.mjs --k 5 --seed 1 --delay 300
//         node collect_follower_sample.mjs --limit 20          test on the first 20 accounts
//         node collect_follower_sample.mjs --dir testdata      use a different data folder
//         node collect_follower_sample.mjs --api http://...    use a different API base URL
//
// Re-running is safe: accounts that already have a followerSample field are skipped.
// About 1,178 x 5 = ~5,900 requests at 300 ms each: about 30 minutes.
// Needs Node 18+. No packages.

import { readFile, writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const o = { k: 5, seed: 1, delay: 300, api: "https://public.api.bsky.app/xrpc", dir: "data", limit: Infinity };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--k") o.k = Number(argv[++i]);
    else if (argv[i] === "--seed") o.seed = Number(argv[++i]);
    else if (argv[i] === "--delay") o.delay = Number(argv[++i]);
    else if (argv[i] === "--api") o.api = argv[++i];
    else if (argv[i] === "--dir") o.dir = argv[++i];
    else if (argv[i] === "--limit") o.limit = Number(argv[++i]);
  }
  return o;
}
const args = parseArgs(process.argv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const slimProfile = (p) => ({
  d: p.did,
  h: p.handle,
  c: p.createdAt ?? p.indexedAt ?? null,
  av: Boolean(p.avatar),
  nm: Boolean((p.displayName ?? "").trim()),
  bio: Boolean((p.description ?? "").trim()),
  bot: (p.labels ?? []).some((l) => l.val === "bot" && l.src === p.did),
});

async function fetchFollows(did) {
  const url = `${args.api}/app.bsky.graph.getFollows?actor=${encodeURIComponent(did)}&limit=100`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try { res = await fetch(url); } catch (err) {
      if (attempt === 5) return { ok: false, message: String(err.message ?? err) };
      await sleep(2000 * attempt);
      continue;
    }
    if (res.ok) return { ok: true, data: await res.json() };
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("retry-after") ?? "") || 15 * attempt;
      console.log(`  HTTP ${res.status}, waiting ${wait}s (attempt ${attempt}/5)...`);
      await sleep(wait * 1000);
      continue;
    }
    return { ok: false, message: `HTTP ${res.status}` };
  }
  return { ok: false, message: "max retries" };
}

const graphFile = `${args.dir}/graph.json`;
let graph;
try {
  graph = JSON.parse(await readFile(graphFile, "utf8"));
} catch {
  console.log(`Could not read ${graphFile}. Run collect_graph.mjs first.`);
  process.exit(1);
}

const dids = Object.keys(graph);
const todo = dids.filter((did) => !graph[did].followerSample);
console.log(`${dids.length} accounts in graph.json.`);
console.log(`${dids.length - todo.length} already have followerSample, ${todo.length} to process.`);
if (todo.length === 0) { console.log("Nothing to do."); process.exit(0); }

const save = async () => { await writeFile(graphFile, JSON.stringify(graph)); };
process.on("SIGINT", async () => {
  console.log("\nCtrl+C: saving progress...");
  await save();
  process.exit(0);
});

const random = seededRandom(args.seed);
let done = 0, fetchErrors = 0;
const toProcess = Number.isFinite(args.limit) ? todo.slice(0, args.limit) : todo;

for (const did of toProcess) {
  const entry = graph[did];
  const followers = entry.followers ?? [];

  // Pick min(k, followers.length) distinct followers using a Fisher-Yates partial shuffle
  const k = Math.min(args.k, followers.length);
  const pool = Array.from({ length: followers.length }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const sampled = pool.slice(0, k).map((i) => followers[i]);

  const followerSample = [];
  for (const f of sampled) {
    await sleep(args.delay);
    const result = await fetchFollows(f.d);
    if (result.ok) {
      followerSample.push({ d: f.d, follows: (result.data.follows ?? []).map(slimProfile) });
    } else {
      followerSample.push({ d: f.d, follows: [], error: result.message });
      fetchErrors++;
    }
  }

  entry.followerSample = followerSample;
  done++;

  if (done % 50 === 0 || done === toProcess.length) {
    await save();
    console.log(`${done}/${toProcess.length} accounts processed (${fetchErrors} fetch errors so far)`);
  }
}

console.log(`\nDone. ${done} accounts extended, ${fetchErrors} fetch errors total.`);
console.log("Next: node features_graph.mjs   (then score_combined.mjs, then export_web_model.mjs)");
