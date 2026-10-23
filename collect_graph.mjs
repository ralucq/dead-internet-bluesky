// collect_graph.mjs
// Fetches the social connections of every account in the curated bots and the comparison
// group: up to 100 of its MOST RECENT followers and up to 100 of the accounts it follows.
//
// Reads:  data/bots_curated.json, data/comparison_clean.json
// Writes: data/graph.json          per account: its sampled followers and follows (see below)
//         data/graph_status.json   how each account went
//
// Usage:  node collect_graph.mjs
//         node collect_graph.mjs --limit 20      (test: only the first 20 accounts)
// Re-running is safe: accounts already done are skipped. Ctrl+C saves progress.
// Needs Node 18+. No packages. About 2,400 requests: roughly 15 minutes.
//
// What is stored (privacy): for each sampled follower or followed account only a few public
// facts: its identifier, handle, creation time, and whether it has a picture, a display name,
// a bio, and the bot self-label. No posts, no bio text. Public data of ordinary people: keep
// the files on your own computer and do not publish them.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const OUT_DIR = "data";
const GRAPH_FILE = `${OUT_DIR}/graph.json`;
const STATUS_FILE = `${OUT_DIR}/graph_status.json`;

function parseArgs(argv) {
  const o = { limit: Infinity, delay: 300, api: "https://public.api.bsky.app/xrpc", bots: `${OUT_DIR}/bots_curated.json`, comp: `${OUT_DIR}/comparison_clean.json` };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--limit") o.limit = Number(argv[++i]);
    else if (argv[i] === "--delay") o.delay = Number(argv[++i]);
    else if (argv[i] === "--api") o.api = argv[++i];
    else if (argv[i] === "--bots") o.bots = argv[++i];
    else if (argv[i] === "--comp") o.comp = argv[++i];
  }
  return o;
}
const args = parseArgs(process.argv);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

async function get(method, did) {
  const url = `${args.api}/${method}?actor=${encodeURIComponent(did)}&limit=100`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === 5) return { ok: false, status: 0, message: String(err.message ?? err) };
      await sleep(2000 * attempt);
      continue;
    }
    if (res.ok) return { ok: true, data: await res.json() };
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("retry-after")) || 15 * attempt;
      console.log(`  ${res.status} from the server, waiting ${wait}s (attempt ${attempt}/5)...`);
      await sleep(wait * 1000);
      continue;
    }
    let message = "";
    try { message = (await res.text()).slice(0, 120); } catch {}
    return { ok: false, status: res.status, message };
  }
  return { ok: false, status: 0, message: "failed after 5 attempts" };
}

const slim = (p) => ({
  d: p.did,
  h: p.handle,
  c: p.createdAt ?? p.indexedAt ?? null,
  av: Boolean(p.avatar),
  nm: Boolean((p.displayName ?? "").trim()),
  bio: Boolean((p.description ?? "").trim()),
  bot: (p.labels ?? []).some((l) => l.val === "bot" && l.src === p.did),
});

const bots = await loadJson(args.bots, null);
const comp = await loadJson(args.comp, null);
if (!bots || !comp) {
  console.log("Could not read the curated bots or the comparison file. Run it from the folder that contains the data folder.");
  process.exit(1);
}
await mkdir(OUT_DIR, { recursive: true });
const targets = [
  ...bots.map((b) => ({ did: b.did, handle: b.handle, label: 1 })),
  ...comp.map((b) => ({ did: b.did, handle: b.handle, label: 0 })),
].slice(0, args.limit);

const graph = await loadJson(GRAPH_FILE, {});
const status = await loadJson(STATUS_FILE, {});
const todo = targets.filter((t) => !(t.did in status));
console.log(`Accounts: ${targets.length}. Already done: ${targets.length - todo.length}. To fetch: ${todo.length}.\n`);

async function save() {
  await writeFile(GRAPH_FILE, JSON.stringify(graph));
  await writeFile(STATUS_FILE, JSON.stringify(status));
}
process.on("SIGINT", async () => {
  console.log("\nStopped. Saving what we have so far...");
  await save();
  process.exit(0);
});

let n = 0;
for (const t of todo) {
  const fo = await get("app.bsky.graph.getFollowers", t.did);
  await sleep(args.delay);
  const fg = await get("app.bsky.graph.getFollows", t.did);
  await sleep(args.delay);
  if (fo.ok && fg.ok) {
    graph[t.did] = {
      followers: (fo.data.followers ?? []).map(slim),
      follows: (fg.data.follows ?? []).map(slim),
    };
    status[t.did] = { label: t.label, handle: t.handle, status: "ok", followers: graph[t.did].followers.length, follows: graph[t.did].follows.length };
  } else {
    const bad = !fo.ok ? fo : fg;
    status[t.did] = { label: t.label, handle: t.handle, status: `error ${bad.status}`, message: bad.message, followers: 0, follows: 0 };
  }
  n++;
  if (n % 25 === 0) {
    await save();
    console.log(`  ${n} of ${todo.length} done`);
  }
}
await save();

const counts = {};
for (const s of Object.values(status)) counts[s.status] = (counts[s.status] ?? 0) + 1;
console.log("\n=== SUMMARY ===");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`);
console.log(`\nSaved: ${GRAPH_FILE} and ${STATUS_FILE}`);
