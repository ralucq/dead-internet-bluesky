// score_survey.mjs — apply the trained model to all accounts in data/survey.json.
// Fetches the full profile for each account (for display-name and banner signals),
// reads posts and graph from the files populated by the collection scripts, then
// runs the same signal computation and model the browser app uses.
//
// Reads:  data/survey.json
//         data/posts.json      (node collect_posts.mjs --bots data/survey.json --comp data/empty.json)
//         data/graph.json      (node collect_graph.mjs + node collect_follower_sample.mjs)
//         app/model.json
// Writes: data/survey_scores.json
//
// Usage:
//   node score_survey.mjs
//   node score_survey.mjs --limit=20     (test on first 20 accounts)

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { computeSignals, scoreAccount } from './app/signals.js';

const flag = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const OUT = 'data/survey_scores.json';

const survey = JSON.parse(readFileSync('data/survey.json', 'utf8'));
const LIMIT = flag('limit') ? parseInt(flag('limit')) : survey.length;
const posts  = existsSync('data/posts.json') ? JSON.parse(readFileSync('data/posts.json', 'utf8')) : {};
const graph  = existsSync('data/graph.json') ? JSON.parse(readFileSync('data/graph.json', 'utf8')) : {};
const model  = JSON.parse(readFileSync('app/model.json', 'utf8'));

const API   = 'https://public.api.bsky.app/xrpc';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchProfile(did, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
      if (r.status === 429) { console.log('\n  rate-limited, waiting 10 s…'); await sleep(10000); continue; }
      if (r.ok) return r.json();
      if (r.status === 400 || r.status === 404) return null; // account deleted/suspended
      throw new Error(`HTTP ${r.status}`);
    } catch { await sleep(2000 * (i + 1)); }
  }
  return null;
}

const accounts = survey.slice(0, LIMIT);
const results  = [];
const NOW      = Date.now();
let errors     = 0;

console.log(`Scoring ${accounts.length} survey accounts (fetching fresh profiles)…\n`);

for (let i = 0; i < accounts.length; i++) {
  const a = accounts[i];
  const profile = await fetchProfile(a.did);
  await sleep(300);

  if (!profile) {
    errors++;
    results.push({ did: a.did, handle: a.handle, isBotLabeled: a.isBotLabeled, score: null, band: null, error: 'unavailable' });
    continue;
  }

  const items = posts[a.did] ?? [];
  const gr    = graph[a.did] ?? { followers: [], follows: [], followerSample: [] };
  if (!gr.followerSample) gr.followerSample = [];

  const signals        = computeSignals(profile, items, gr, NOW);
  const { score, band } = scoreAccount(model, signals);

  results.push({
    did:            a.did,
    handle:         a.handle,
    createdAt:      a.createdAt,
    postsCount:     a.postsCount,
    followersCount: a.followersCount,
    followsCount:   a.followsCount,
    isBotLabeled:   a.isBotLabeled,
    score:          Math.round(score * 10) / 10,
    band:           band?.name ?? null,
  });

  if ((i + 1) % 25 === 0) {
    process.stdout.write(`\r  ${i + 1}/${accounts.length} scored`);
    writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
}

writeFileSync(OUT, JSON.stringify(results, null, 2));

const scored     = results.filter(r => r.score !== null);
const botLike    = scored.filter(r => r.score >= 50).length;
const high       = scored.filter(r => r.score >= 70).length;
const veryHigh   = scored.filter(r => r.score >= 90).length;
const botLabeled = scored.filter(r => r.isBotLabeled).length;

console.log('\n\nDone.');
console.log(`  ${scored.length} accounts scored → ${OUT}`);
console.log(`  ${errors} unavailable (deleted/suspended)`);
console.log(`  ${botLabeled} carry the bot self-label`);
console.log('');
console.log('  score distribution:');
console.log(`    >= 50 (bot-like): ${botLike}  (${(100 * botLike / scored.length).toFixed(1)}%)`);
console.log(`    >= 70:            ${high}  (${(100 * high / scored.length).toFixed(1)}%)`);
console.log(`    >= 90:            ${veryHigh}  (${(100 * veryHigh / scored.length).toFixed(1)}%)`);
