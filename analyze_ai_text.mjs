// analyze_ai_text.mjs
// Calls Sapling.ai's AI detector on the recent posts of each account in
// data/fake_persons.json and stores the result as an aiText field.
//
// Setup (one time):
//   Add SAPLING_API_KEY=... to your .env file.
//   Get a key at https://sapling.ai -- sign up, then visit the API settings.
//
// Usage:
//   node analyze_ai_text.mjs                              (skip already analyzed)
//   node analyze_ai_text.mjs --force                      (re-analyze all)
//   node analyze_ai_text.mjs --handle foo.bsky.social     (one account only)

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// --- load .env ---
async function loadEnv() {
  if (!existsSync(".env")) {
    console.error("Missing .env file. Add SAPLING_API_KEY=... to it.");
    process.exit(1);
  }
  for (const line of (await readFile(".env", "utf8")).split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
await loadEnv();

const SAPLING_KEY = process.env.SAPLING_API_KEY;
if (!SAPLING_KEY) {
  console.error("SAPLING_API_KEY missing from .env"); process.exit(1);
}

// --- parse args ---
const args = process.argv.slice(2);
const doForce  = args.includes("--force");
const hi       = args.indexOf("--handle");
const handleArg = hi >= 0 ? args[hi + 1] : null;

const PUB_API    = "https://public.api.bsky.app/xrpc";
const SAPLING_URL = "https://api.sapling.ai/api/v1/aidetect";
const MIN_CHARS   = 300;   // Sapling recommends at least 300 chars
const TARGET_CHARS = 3000; // aim for 3 KB of text for a reliable score
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch up to 100 recent posts (including replies) and return their text.
async function fetchPostTexts(handle) {
  const url = `${PUB_API}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=100&filter=posts_with_replies`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const d = await r.json();
  const texts = [];
  for (const item of (d.feed ?? [])) {
    // Skip reposts: they have a reason record and no original text from this author.
    if (item.reason?.$type === "app.bsky.feed.defs#reasonRepost") continue;
    const text = (item.post?.record?.text ?? "").trim();
    if (text.length >= 10) texts.push(text);
  }
  return texts;
}

// Call Sapling.ai and return the raw response object.
async function detectAI(text) {
  const r = await fetch(SAPLING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: SAPLING_KEY, text, sent_scores: false }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${body}`);
  }
  return r.json();
}

// --- main ---
const OUT = "data/fake_persons.json";
if (!existsSync(OUT)) { console.error(`${OUT} not found. Run collect_fake_persons.mjs first.`); process.exit(1); }

const results = JSON.parse(await readFile(OUT, "utf8"));

const toAnalyze = handleArg
  ? results.filter((e) => e.handle === handleArg)
  : results.filter((e) => doForce || !e.aiText);

if (!toAnalyze.length) {
  console.log("Nothing to analyze (all accounts already have aiText; use --force to redo).");
  process.exit(0);
}

console.log(`Analyzing ${toAnalyze.length} account(s)...\n`);

let done = 0, skipped = 0, failed = 0;

for (const entry of toAnalyze) {
  process.stdout.write(`${entry.handle} ... `);
  try {
    const texts = await fetchPostTexts(entry.handle);
    if (!texts.length) { console.log("no posts found — skip"); skipped++; continue; }

    // Concatenate posts (separated by blank lines) up to TARGET_CHARS.
    let combined = "";
    let usedPosts = 0;
    for (const t of texts) {
      combined += (combined ? "\n\n" : "") + t;
      usedPosts++;
      if (combined.length >= TARGET_CHARS) break;
    }

    if (combined.length < MIN_CHARS) {
      console.log(`only ${combined.length} chars (need ${MIN_CHARS}) — skip`);
      skipped++;
      continue;
    }

    const res = await detectAI(combined);
    entry.aiText = {
      score:         +res.score.toFixed(3),
      verdict:        res.verdict       ?? null,
      lowConfidence:  res.low_confidence ?? false,
      aiFraction:    res.ai_fraction != null ? +res.ai_fraction.toFixed(3) : null,
      charCount:     combined.length,
      postsUsed:     usedPosts,
      analyzedAt:    new Date().toISOString(),
    };
    const conf = entry.aiText.lowConfidence ? "  [low confidence]" : "";
    console.log(`score ${entry.aiText.score}  verdict: ${entry.aiText.verdict}${conf}`);
    done++;
  } catch (err) {
    console.log(`ERROR: ${err.message} — skip`);
    failed++;
  }

  // Save after every account so progress is not lost on a crash or rate-limit error.
  await writeFile(OUT, JSON.stringify(results, null, 2));
  await sleep(500);
}

console.log(`\nDone. ${done} analyzed, ${skipped} skipped (too little text or not found), ${failed} failed.`);
console.log("Results saved to", OUT);
