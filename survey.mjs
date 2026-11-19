// survey.mjs — collect a random population sample of Bluesky accounts for prevalence analysis.
// Accounts are sampled uniformly across Bluesky's history without matching any other set.
// Accounts that carry the bot self-label are included and noted (not excluded).
// Excludes accounts already in bots_curated.json and comparison_clean.json.
//
// Usage:
//   node survey.mjs                       target 2000, min-posts 100, seed 1
//   node survey.mjs --target=3000
//   node survey.mjs --min-posts=50
//   node survey.mjs --seed=2
//   node survey.mjs --resume              skip already-collected accounts, continue to target

import { readFileSync, writeFileSync, existsSync } from 'fs';

// --- config ---
const flag = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const TARGET    = parseInt(flag('target')    ?? '2000');
const MIN_POSTS = parseInt(flag('min-posts') ?? '100');
const SEED      = parseInt(flag('seed')      ?? '1');
const RESUME    = process.argv.includes('--resume');
const OUT       = 'data/survey.json';

// --- seeded RNG (mulberry32) for reproducibility ---
let _rng = SEED >>> 0;
function rand() {
  _rng += 0x6D2B79F5;
  let t = _rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// --- load excluded sets (bots + comparison already scored) ---
const excluded = new Set();
for (const path of ['data/bots_curated.json', 'data/comparison_clean.json']) {
  if (existsSync(path)) {
    for (const a of JSON.parse(readFileSync(path, 'utf8'))) excluded.add(a.did);
  }
}

// --- resume: load existing survey ---
let survey = [];
if (existsSync(OUT)) {
  survey = JSON.parse(readFileSync(OUT, 'utf8'));
  if (!RESUME) {
    console.log(`survey.json already exists with ${survey.length} accounts.`);
    console.log(`Use --resume to continue to ${TARGET}, or delete it to start fresh.`);
    process.exit(1);
  }
  for (const a of survey) excluded.add(a.did);
  console.log(`Resuming: ${survey.length} of ${TARGET} already collected.`);
}

// --- helpers ---
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429) {
        console.log('\n  rate-limited, waiting 10 s…');
        await sleep(10000);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

// fetch DIDs from plc.directory created just after `afterTs` (ISO string)
async function fetchDIDs(afterTs, count = 5) {
  const url = `https://plc.directory/export?count=${count}&after=${encodeURIComponent(afterTs)}`;
  const text = await (await get(url)).text();
  const dids = [];
  for (const line of text.trim().split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (!rec.nullified && rec.did?.startsWith('did:plc:') && rec.operation?.prev == null)
        dids.push(rec.did);
    } catch {}
  }
  return dids;
}

// fetch profiles for up to 25 DIDs (public API, no auth needed)
async function fetchProfiles(dids) {
  if (!dids.length) return [];
  const qs = dids.map(d => `actors[]=${encodeURIComponent(d)}`).join('&');
  const data = await (await get(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?${qs}`
  )).json();
  return data.profiles ?? [];
}

// --- main ---
// Sample timestamps uniformly across Bluesky's full history
const START_MS = Date.parse('2022-11-17T00:00:00Z');
const END_MS   = Date.parse('2026-11-18T00:00:00Z');

let checked = 0, rounds = 0;

console.log(`Collecting ${TARGET} accounts (min ${MIN_POSTS} posts, seed ${SEED})…`);
console.log(`${excluded.size} already-known accounts excluded.\n`);

while (survey.length < TARGET) {
  rounds++;

  // pick a random moment and fetch a handful of DIDs from that point
  const ts = new Date(START_MS + rand() * (END_MS - START_MS)).toISOString();
  let dids;
  try { dids = await fetchDIDs(ts, 5); }
  catch { await sleep(2000); continue; }
  await sleep(75);

  const fresh = dids.filter(d => !excluded.has(d));
  if (!fresh.length) continue;

  let profiles;
  try { profiles = await fetchProfiles(fresh); }
  catch { await sleep(2000); continue; }
  await sleep(300);
  checked += fresh.length;

  for (const p of profiles) {
    if (survey.length >= TARGET) break;
    if (excluded.has(p.did)) continue;
    if ((p.postsCount ?? 0) < MIN_POSTS) continue;

    const isBotLabeled = (p.labels ?? []).some(
      l => l.val === 'bot' && l.src === p.did
    );

    survey.push({
      did:            p.did,
      handle:         p.handle,
      createdAt:      p.createdAt,
      postsCount:     p.postsCount    ?? 0,
      followsCount:   p.followsCount  ?? 0,
      followersCount: p.followersCount ?? 0,
      isBotLabeled,
      collectedAt:    new Date().toISOString(),
    });
    excluded.add(p.did);

    if (survey.length % 25 === 0) {
      process.stdout.write(`\r  ${survey.length}/${TARGET} collected  (${checked} checked, round ${rounds})   `);
      writeFileSync(OUT, JSON.stringify(survey, null, 2));
    }
  }
}

writeFileSync(OUT, JSON.stringify(survey, null, 2));

const labeled = survey.filter(a => a.isBotLabeled).length;
console.log(`\n\nDone.`);
console.log(`  ${survey.length} accounts written to ${OUT}`);
console.log(`  ${labeled} carry the bot self-label (${(100 * labeled / survey.length).toFixed(1)}%)`);
console.log(`  ${checked} profiles checked in ${rounds} rounds`);
console.log(`\nNext: run collect_posts.mjs and collect_graph.mjs on survey.json,`);
console.log(`then features and scoring scripts to get a score for each account.`);
