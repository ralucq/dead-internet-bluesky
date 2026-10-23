// collect_posts.mjs
// Step 3 of the project: fetch the most recent activity (up to 100 items) of every account in
// the curated bots and in the comparison group, so that posting behaviour can be measured.
//
// Reads:  data/bots_curated.json, data/comparison_clean.json
// Writes: data/posts.json            per account: its recent items (see "what is stored")
//         data/posts_status.json     how each account went (ok, empty, not available, ...)
//
// Usage:  node collect_posts.mjs
//         node collect_posts.mjs --limit 20      (test: only the first 20 accounts)
// Re-running is safe: accounts already done are skipped. Ctrl+C saves progress.
// Needs Node 18+. No packages. About 1,200 requests: roughly 10 minutes.
//
// What is stored (privacy): for the account's own posts and replies, the time, the text, flags
// (is a reply, has a link, has images, languages), WHICH accounts it replied to, quoted or
// mentioned (account identifiers only), and how many likes, reposts, replies and quotes the post
// received. For reposts only the time and the identifier of the original author: the text of
// someone else's post is NOT stored. Nothing else (no images, no other people's text).
// This is public data of ordinary people: keep the files on your own computer and do not publish
// them (see the ethics note in the methods log).

import { readFile, writeFile, mkdir } from "node:fs/promises";

const API = "https://public.api.bsky.app/xrpc";
const OUT_DIR = "data";
const POSTS_FILE = `${OUT_DIR}/posts.json`;
const STATUS_FILE = `${OUT_DIR}/posts_status.json`;

function parseArgs(argv) {
  const o = { limit: Infinity, delay: 300, api: API, bots: `${OUT_DIR}/bots_curated.json`, comp: `${OUT_DIR}/comparison_clean.json` };
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
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// One request, with waiting and retrying on rate limits and server errors.
// Returns { ok: true, data } or { ok: false, status, message } for errors that are final
// for this account (deleted, blocked, not found).
async function getFeed(did) {
  const url = `${args.api}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&limit=100&filter=posts_with_replies`;
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

function simplify(item) {
  if (item.reason?.$type === "app.bsky.feed.defs#reasonPin") return null; // pinned post: skip
  if (item.reason?.$type === "app.bsky.feed.defs#reasonRepost") {
    return { t: item.reason.indexedAt, k: "repost", a: item.post?.author?.did ?? null };
  }
  const rec = item.post?.record ?? {};
  const embed = item.post?.embed;
  const embedType = embed?.$type ?? "";
  const facets = rec.facets ?? [];
  const hasLinkFacet = facets.some((f) => (f.features ?? []).some((x) => x.$type === "app.bsky.richtext.facet#link"));
  const didOf = (uri) => (typeof uri === "string" ? (uri.match(/^at:\/\/(did:[^/]+)\//) ?? [])[1] ?? null : null);
  const mentions = [];
  for (const f of facets) for (const x of f.features ?? []) if (x.$type === "app.bsky.richtext.facet#mention" && x.did) mentions.push(x.did);
  const quoted = embedType.includes("record") ? (embed?.record?.author?.did ?? embed?.record?.record?.author?.did ?? null) : null;
  const post = item.post ?? {};
  return {
    t: rec.createdAt ?? item.post?.indexedAt,
    k: "post",
    re: Boolean(rec.reply),
    to: didOf(rec.reply?.parent?.uri), // account it replies to
    qu: quoted, // account whose post it quotes
    me: [...new Set(mentions)], // accounts it mentions
    rc: post.replyCount ?? 0, // reactions it RECEIVED (at the time of fetching)
    rp: post.repostCount ?? 0,
    lk: post.likeCount ?? 0,
    qt: post.quoteCount ?? 0,
    link: hasLinkFacet || embedType.includes("external"),
    img: embedType.includes("images") || embedType.includes("video"),
    ln: rec.langs ?? [],
    x: typeof rec.text === "string" ? rec.text : "",
  };
}

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

const posts = await loadJson(POSTS_FILE, {});
const status = await loadJson(STATUS_FILE, {});
const todo = targets.filter((t) => !(t.did in status));
console.log(`Accounts: ${targets.length}. Already done: ${targets.length - todo.length}. To fetch: ${todo.length}.\n`);

async function save() {
  await writeFile(POSTS_FILE, JSON.stringify(posts));
  await writeFile(STATUS_FILE, JSON.stringify(status));
}
process.on("SIGINT", async () => {
  console.log("\nStopped. Saving what we have so far...");
  await save();
  process.exit(0);
});

let n = 0;
for (const t of todo) {
  const r = await getFeed(t.did);
  if (r.ok) {
    const items = (r.data.feed ?? []).map(simplify).filter(Boolean);
    posts[t.did] = items;
    status[t.did] = { label: t.label, handle: t.handle, status: items.length ? "ok" : "empty", items: items.length };
  } else {
    status[t.did] = { label: t.label, handle: t.handle, status: `error ${r.status}`, message: r.message, items: 0 };
  }
  n++;
  if (n % 25 === 0) {
    await save();
    console.log(`  ${n} of ${todo.length} done`);
  }
  await sleep(args.delay);
}
await save();

const counts = {};
for (const s of Object.values(status)) counts[s.status] = (counts[s.status] ?? 0) + 1;
console.log("\n=== SUMMARY ===");
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${v}`);
const withItems = Object.values(status).filter((s) => s.items > 0);
const avg = withItems.reduce((s, x) => s + x.items, 0) / Math.max(1, withItems.length);
console.log(`Average items per account (accounts with items): ${avg.toFixed(0)}`);
console.log(`\nSaved: ${POSTS_FILE} and ${STATUS_FILE}`);
