// trawl_llm_bots.mjs
// Method 1 from "How to trawl for bots on Bluesky" (poorolive51, Medium):
// Search for characteristic LLM phrases used by reply-guy bots pretending to be human.
//
// Setup (one time):
//   1. Bluesky → Settings → Privacy & Security → App Passwords → Add App Password
//   2. Create a file called .env in this directory:
//        BSKY_HANDLE=yourhandle.bsky.social
//        BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
//
// Usage:
//   node trawl_llm_bots.mjs                     (use default phrases)
//   node trawl_llm_bots.mjs --phrase "your phrase here"   (add one phrase)
//   node trawl_llm_bots.mjs --limit 50 --delay 400
//   node trawl_llm_bots.mjs --collect           (also save suspects to data/fake_persons.json)
//
// Output: prints suspicious accounts + optionally calls collect_fake_persons logic.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { collectAccount, computeSignals, scoreAccount } from "./app/signals.js";
import modelData from "./app/model.json" with { type: "json" };

// --- load .env ---
async function loadEnv() {
  if (!existsSync(".env")) {
    console.error("Missing .env file. Create one with:\n  BSKY_HANDLE=yourhandle.bsky.social\n  BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx");
    process.exit(1);
  }
  const lines = (await readFile(".env", "utf8")).split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
await loadEnv();

const HANDLE   = process.env.BSKY_HANDLE;
const PASSWORD = process.env.BSKY_APP_PASSWORD;
if (!HANDLE || !PASSWORD) {
  console.error("BSKY_HANDLE or BSKY_APP_PASSWORD missing from .env"); process.exit(1);
}

// --- parse args ---
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; args.splice(i, 2); return args[i + 1 - 1] ?? null; };
const limitPerPhrase = Number(flag("--limit") ?? 25);
const delayMs        = Number(flag("--delay") ?? 400);
const extraPhrase    = flag("--phrase");
const doCollect      = args.includes("--collect");

// LLM "reply guy" phrases: characteristic of ChatGPT/LLM-generated social media posts.
// Sources: poorolive51 Medium article; community observation (2024–2025 wave);
//          additional phrases identified by researcher (November 2026).
const PHRASES = [
  // --- debate / reply phrases (from poorolive51 article) ---
  "ignores the complexity",
  "oversimplifies the issue",
  "the notion that",
  "it's worth noting that",
  "i respectfully disagree",
  "while i understand your perspective",
  "this is a nuanced issue",
  "it's more nuanced than",
  "fails to consider",
  "in reality, the situation",
  // --- filler / structural phrases common in LLM output ---
  "plays a significant role in",
  "in today's fast-paced world",
  "it is important to remember that",
  "here's the thing nobody talks about",
  "the truth nobody wants to hear",
  "significant role in shaping",
  "delve into",
  "make no mistake",
  "speaks volumes",
  "more people need to hear this",
  "it cannot be overstated",
  "at the end of the day",
  "in today's rapidly evolving",
];
if (extraPhrase) PHRASES.push(extraPhrase);

const API = "https://bsky.social/xrpc";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- authenticate ---
console.log("Authenticating as", HANDLE, "...");
const sessRes = await fetch(`${API}/com.atproto.server.createSession`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ identifier: HANDLE, password: PASSWORD }),
});
if (!sessRes.ok) {
  const e = await sessRes.json().catch(() => ({}));
  console.error("Auth failed:", e.message ?? sessRes.status); process.exit(1);
}
const { accessJwt } = await sessRes.json();
console.log("Authenticated.\n");

const authHeaders = { Authorization: `Bearer ${accessJwt}` };

async function searchPosts(phrase) {
  const url = `${API}/app.bsky.feed.searchPosts?q=${encodeURIComponent(`"${phrase}"`)}&limit=${limitPerPhrase}`;
  const r = await fetch(url, { headers: authHeaders });
  if (!r.ok) return [];
  const d = await r.json();
  return d.posts ?? [];
}

async function getRecentPosts(did) {
  const url = `${API}/app.bsky.feed.getAuthorFeed?actor=${did}&limit=50&filter=posts_no_replies`;
  const r = await fetch(url, { headers: authHeaders });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.feed ?? []).map((i) => i.post?.record?.createdAt).filter(Boolean).sort();
}

// --- collect suspects ---
// suspect = {did, handle, displayName, description, matchedPhrase, matchCount, minGapMinutes}
const suspects = new Map(); // did -> suspect

for (const phrase of PHRASES) {
  process.stdout.write(`Searching: "${phrase}" ... `);
  const posts = await searchPosts(phrase);
  console.log(posts.length, "posts");
  for (const post of posts) {
    const author = post.author ?? {};
    const did = author.did;
    if (!did) continue;
    if (suspects.has(did)) {
      suspects.get(did).matchCount++;
      if (!suspects.get(did).matchedPhrases.includes(phrase))
        suspects.get(did).matchedPhrases.push(phrase);
    } else {
      suspects.set(did, {
        did,
        handle: author.handle ?? "",
        displayName: author.displayName ?? "",
        description: author.description ?? "",
        matchedPhrases: [phrase],
        matchCount: 1,
        minGapMinutes: null,
      });
    }
  }
  await sleep(delayMs);
}

console.log(`\nFound ${suspects.size} unique accounts using LLM phrases. Checking posting frequency...\n`);

// For accounts matching 2+ phrases, check their reply posting speed (bots post every 5-10 mins)
const botLikely = [];
for (const s of suspects.values()) {
  if (s.matchCount < 2 && suspects.size > 20) continue; // skip low-confidence if we have many
  const times = await getRecentPosts(s.did);
  if (times.length >= 5) {
    const gaps = [];
    for (let i = 1; i < times.length; i++) {
      gaps.push((new Date(times[i]) - new Date(times[i - 1])) / 60000);
    }
    gaps.sort((a, b) => a - b);
    s.minGapMinutes = +gaps[0].toFixed(1);
    s.medianGapMinutes = +gaps[Math.floor(gaps.length / 2)].toFixed(1);
    s.postCount = times.length;
  }
  botLikely.push(s);
  await sleep(delayMs);
}

// sort: most phrase matches first, then fastest posters
botLikely.sort((a, b) => b.matchCount - a.matchCount || (a.minGapMinutes ?? 999) - (b.minGapMinutes ?? 999));

console.log("=== RESULTS ===\n");
for (const s of botLikely) {
  const freq = s.minGapMinutes !== null
    ? `min gap ${s.minGapMinutes} min, median ${s.medianGapMinutes} min (${s.postCount} posts sampled)`
    : "posting frequency unknown";
  console.log(`@${s.handle}  [${s.displayName}]`);
  console.log(`  phrases matched (${s.matchCount}): ${s.matchedPhrases.join(", ")}`);
  console.log(`  posting: ${freq}`);
  if (s.description) console.log(`  bio: ${s.description.replace(/\n/g, " ").slice(0, 80)}`);
  console.log();
}

// --- optionally collect + score suspects into data/fake_persons.json ---
if (doCollect && botLikely.length > 0) {
  const OUT = "data/fake_persons.json";
  const PUB_API = "https://public.api.bsky.app/xrpc";
  let results = [];
  if (existsSync(OUT)) {
    try { results = JSON.parse(await readFile(OUT, "utf8")); } catch {}
  }
  const done = new Set(results.map((r) => r.handle));
  let added = 0, failed = 0;

  console.log("\nScoring and saving suspects...\n");
  for (const s of botLikely) {
    if (done.has(s.handle)) { console.log(`skip  ${s.handle} (already collected)`); continue; }
    process.stdout.write(`score ${s.handle} ... `);
    try {
      const { profile, items, graph } = await collectAccount(s.handle, { api: PUB_API });
      const signals = computeSignals(profile, items, graph);
      const result  = scoreAccount(modelData, signals);
      results.push({
        handle: s.handle,
        did: s.did,
        collectedAt: new Date().toISOString(),
        reason: `LLM phrase bot: matched ${s.matchCount} phrase(s) — ${s.matchedPhrases.join("; ")}`,
        source: "trawl_llm_bots.mjs",
        displayName: profile.displayName ?? null,
        description: profile.description ?? null,
        avatar: profile.avatar ?? null,
        createdAt: profile.createdAt ?? null,
        followersCount: profile.followersCount ?? null,
        followsCount: profile.followsCount ?? null,
        postsCount: profile.postsCount ?? null,
        score: Math.round(result.score),
        band: result.band.name,
        missing: result.missing,
        signals: result.parts.map((p) => ({ signal: p.signal, value: p.value, contribution: +p.contribution.toFixed(4) })),
        trawl: { matchedPhrases: s.matchedPhrases, matchCount: s.matchCount, minGapMinutes: s.minGapMinutes, medianGapMinutes: s.medianGapMinutes ?? null },
      });
      console.log(`score ${Math.round(result.score)} (${result.band.name})  missing ${result.missing.length}/${modelData.signals.length}`);
      added++;
    } catch (err) {
      console.log(`ERROR: ${err.message} — skipping`);
      failed++;
    }
    done.add(s.handle);
    await writeFile(OUT, JSON.stringify(results, null, 2));
    await sleep(delayMs);
  }
  console.log(`\nDone. ${added} saved and scored, ${failed} failed. Results in ${OUT}`);
}
