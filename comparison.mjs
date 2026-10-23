// comparison.mjs
// Builds the COMPARISON GROUP: ordinary Bluesky accounts to test the bot score against.
//
// How the accounts are picked, and why:
//   1. Bluesky's public account directory (plc.directory) lists every account in the order
//      it was created, with the creation time. For each creation month we jump to random
//      moments inside that month and take the first few new accounts created right after.
//      No search words are used, so the sample is not steered towards (or away from)
//      accounts that sound like bots.
//   2. The number of accounts per creation month matches the curated bots in
//      data/bots_curated.json (times --ratio). Reason: the labeled bots are newer than the
//      average account, and without matching, "account age" would look useful only because
//      of that.
//   3. Each candidate's profile is fetched. An account is KEPT only if it has at least
//      --min-posts posts (the same rule as for the bots) and does not carry the bot
//      self-label. Accounts already in labeled_bots.json are never used.
//   4. A random sample of the kept accounts is written to review_sample.csv, to be read by
//      hand: unlabeled does not mean human, and this is how you estimate how many look
//      automated (the "contamination" of the comparison group).
//
// Usage:
//   node comparison.mjs                    as many comparison accounts as curated bots
//   node comparison.mjs --ratio 2          twice as many
//   node comparison.mjs --min-posts 100    use the same value as in curate.mjs
//   node comparison.mjs --seed 7           different random choices
//
// Output (in ./data):
//   comparison.json         the comparison accounts, each with its full profile
//   comparison_stats.json   parameters, counters and the table per month
//   comparison_report.txt   the report printed on screen
//   review_sample.csv       accounts to check by hand (fill in the last two columns)
//
// Needs Node 18+. Nothing to install. Needs internet. Safe to stop with Ctrl+C: progress is
// saved. Run it again to start over (it does not continue an earlier run).
//
// Privacy: comparison.json and review_sample.csv hold public profile data of ordinary
// people. Keep them on your computer, do not publish them, and pseudonymise in the thesis.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const OUT_DIR = "data";
const ALL_BOTS_FILE = `${OUT_DIR}/labeled_bots.json`;
const CURATED_FILE = `${OUT_DIR}/bots_curated.json`;
const OUT_FILE = `${OUT_DIR}/comparison.json`;
const STATS_FILE = `${OUT_DIR}/comparison_stats.json`;
const REPORT_FILE = `${OUT_DIR}/comparison_report.txt`;
const REVIEW_FILE = `${OUT_DIR}/review_sample.csv`;
const PROFILE_BATCH = 25; // accounts per profile request

function parseArgs(argv) {
  const out = {
    ratio: 1, // comparison accounts per curated bot
    minPosts: 100, // same rule as for the bots
    seed: 1,
    perStamp: 3, // new accounts taken after each random moment
    plcCount: 100, // directory records requested per call
    maxRounds: 25,
    review: 100, // size of the sample to check by hand
    delay: 200, // pause between requests, in milliseconds
    plcUrl: "https://plc.directory",
    apiUrl: "https://public.api.bsky.app/xrpc",
  };
  const flags = {
    "--ratio": "ratio", "--min-posts": "minPosts", "--seed": "seed", "--per-stamp": "perStamp",
    "--plc-count": "plcCount", "--max-rounds": "maxRounds", "--review": "review",
    "--delay": "delay", "--plc-url": "plcUrl", "--api-url": "apiUrl",
  };
  for (let i = 2; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (!key) continue;
    const value = argv[++i];
    out[key] = typeof out[key] === "number" ? Number(value) : value;
  }
  return out;
}

// ------------------------------------------------------------------ small helpers
const lines = [];
const out = (s = "") => {
  console.log(s);
  lines.push(s);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

// Seeded random generator: the same --seed always gives the same random choices.
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
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
};

const csv = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

const monthOf = (iso) => (iso ?? "").slice(0, 7); // "2025-02"

// A random moment inside a month (UTC). The current month stops at "now".
function randomTimeIn(month, random) {
  const [y, m] = month.split("-").map(Number);
  const start = Date.UTC(y, m - 1, 1);
  const end = Math.min(Date.UTC(y, m, 1), Date.now());
  if (!(end > start)) return null;
  return new Date(start + random() * (end - start)).toISOString();
}

// ------------------------------------------------------------------------- network
const args = parseArgs(process.argv);
const { ratio, minPosts, seed, perStamp, plcCount, maxRounds, review, delay, plcUrl, apiUrl } = args;

// One GET request, retried on rate limits (429), server errors and network hiccups.
async function httpGet(url, asText = false) {
  const shortUrl = url.split("?")[0];
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === 5) throw err;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.ok) return asText ? res.text() : res.json();
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get("retry-after")) || 10 * attempt;
      console.log(`  ${res.status} from the server, waiting ${wait}s (attempt ${attempt}/5)...`);
      await sleep(wait * 1000);
      continue;
    }
    throw new Error(`${shortUrl} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`${shortUrl} failed after 5 attempts`);
}

async function fetchProfiles(dids) {
  const qs = new URLSearchParams();
  dids.forEach((d) => qs.append("actors", d));
  const data = await httpGet(`${apiUrl}/app.bsky.actor.getProfiles?${qs}`);
  return data.profiles ?? [];
}

// --------------------------------------------------------------------------- load
await mkdir(OUT_DIR, { recursive: true });

const curated = await loadJson(CURATED_FILE, null);
if (!curated || !curated.length) {
  console.log(`Could not read ${CURATED_FILE}. Run curate.mjs first, from this same folder.`);
  process.exit(1);
}
const excluded = new Set((await loadJson(ALL_BOTS_FILE, [])).map((b) => b.did));
for (const b of curated) excluded.add(b.did);

// How many comparison accounts we want per creation month: the same as the curated bots.
const botMonths = countBy(curated, (b) => monthOf(b.profile?.createdAt ?? b.createdAt));
const quota = new Map(botMonths.map(([m, n]) => [m, Math.max(1, Math.round(n * ratio))]));
const months = [...quota.keys()].sort();
const totalQuota = [...quota.values()].reduce((a, b) => a + b, 0);

const accepted = new Map(); // did -> comparison account
const filled = new Map(); // month -> accounts kept so far
const seenDids = new Set(excluded);
const counters = {
  plcCalls: 0, plcEmpty: 0, candidates: 0, profilesFound: 0, noProfile: 0,
  tooFewPosts: 0, botLabeled: 0, otherMonth: 0, monthFull: 0, accepted: 0,
};
const random = seededRandom(seed);
const startedAt = new Date().toISOString();

async function save() {
  await writeFile(OUT_FILE, JSON.stringify([...accepted.values()], null, 2));
  const table = months.map((m) => ({
    month: m,
    curatedBots: botMonths.find(([k]) => k === m)?.[1] ?? 0,
    wanted: quota.get(m),
    kept: filled.get(m) ?? 0,
  }));
  await writeFile(
    STATS_FILE,
    JSON.stringify({ startedAt, savedAt: new Date().toISOString(), node: process.version, parameters: args, counters, table }, null, 2)
  );
}

process.on("SIGINT", async () => {
  console.log("\nStopped. Saving what we have so far...");
  await save();
  process.exit(0);
});

console.log(`Curated bots: ${curated.length}, spread over ${months.length} creation months.`);
console.log(`Wanted: ${totalQuota} comparison accounts (ratio ${ratio}), at least ${minPosts} posts each.\n`);

// ------------------------------------------------------------------------ main loop
for (let round = 1; round <= maxRounds; round++) {
  const deficits = months
    .map((m) => [m, quota.get(m) - (filled.get(m) ?? 0)])
    .filter(([, d]) => d > 0);
  if (!deficits.length) break;

  // Share of random accounts that turn out to be usable. Starts as a guess, then learned.
  const usableShare =
    counters.profilesFound >= 100
      ? Math.max(0.02, (counters.profilesFound - counters.tooFewPosts - counters.botLabeled) / counters.profilesFound)
      : 0.3;
  const stillNeeded = deficits.reduce((a, [, d]) => a + d, 0);
  console.log(`Round ${round}: still need ${stillNeeded} accounts in ${deficits.length} months (usable share so far about ${(usableShare * 100).toFixed(0)}%).`);

  // Step 1: candidate accounts from random moments in each month.
  const pending = new Map(); // did -> month we were aiming at
  for (const [month, deficit] of deficits) {
    const want = Math.min(Math.ceil((deficit / usableShare) * 1.3), 300);
    const maxCalls = Math.ceil(want / perStamp) * 3 + 5;
    let got = 0;
    let calls = 0;
    while (got < want && calls < maxCalls) {
      calls++;
      const when = randomTimeIn(month, random);
      if (!when) break;
      counters.plcCalls++;
      let text;
      try {
        text = await httpGet(`${plcUrl}/export?count=${plcCount}&after=${encodeURIComponent(when)}`, true);
      } catch (err) {
        console.log(`  ${month}: ${err.message}`);
        break;
      }
      let taken = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let op;
        try {
          op = JSON.parse(line);
        } catch {
          continue;
        }
        // A "genesis" record (prev is null) means the account was created at that moment.
        const isCreation = op.operation?.prev === null && op.nullified === false;
        if (!isCreation || typeof op.did !== "string" || !op.did.startsWith("did:plc:")) continue;
        if (seenDids.has(op.did)) continue;
        seenDids.add(op.did);
        pending.set(op.did, month);
        got++;
        taken++;
        if (taken >= perStamp) break;
      }
      if (!taken) counters.plcEmpty++;
      await sleep(delay);
    }
  }
  counters.candidates += pending.size;

  // Step 2: fetch the profiles and keep the usable ones.
  const ids = [...pending.keys()];
  for (let i = 0; i < ids.length; i += PROFILE_BATCH) {
    const batch = ids.slice(i, i + PROFILE_BATCH);
    let profiles = [];
    try {
      profiles = await fetchProfiles(batch);
    } catch (err) {
      console.log(`  profile batch failed: ${err.message}`);
    }
    const returned = new Set(profiles.map((p) => p.did));
    counters.noProfile += batch.filter((d) => !returned.has(d)).length;

    for (const p of profiles) {
      counters.profilesFound++;
      if ((p.postsCount ?? 0) < minPosts) {
        counters.tooFewPosts++;
        continue;
      }
      if ((p.labels ?? []).some((l) => l.val === "bot" && l.src === p.did)) {
        counters.botLabeled++;
        continue;
      }
      // Same definition of creation month as for the bots: the profile's own date.
      const month = monthOf(p.createdAt) || pending.get(p.did);
      if (!quota.has(month)) {
        counters.otherMonth++;
        continue;
      }
      if ((filled.get(month) ?? 0) >= quota.get(month)) {
        counters.monthFull++;
        continue;
      }
      accepted.set(p.did, {
        did: p.did,
        handle: p.handle,
        displayName: p.displayName ?? null,
        description: p.description ?? null,
        createdAt: p.createdAt ?? null,
        month,
        profile: p,
      });
      filled.set(month, (filled.get(month) ?? 0) + 1);
      counters.accepted++;
    }
    await sleep(delay);
  }
  console.log(`  checked ${ids.length} candidates, kept so far: ${accepted.size} of ${totalQuota}`);
  await save();
}

// ---------------------------------------------------------------------------- report
const list = [...accepted.values()];
const unfilled = months.filter((m) => (filled.get(m) ?? 0) < quota.get(m));

out("\n=== HOW TO READ THIS REPORT ===");
out("The comparison accounts are random accounts created in the same months as the curated");
out("bots, with the same minimum number of posts. They are NOT guaranteed to be human:");
out("check review_sample.csv by hand to see how many look automated.\n");

out("=== 1. RESULT ===");
out(`Wanted:            ${totalQuota} accounts (ratio ${ratio})`);
out(`Collected:         ${list.length}${unfilled.length ? `   (${unfilled.length} months not filled, see section 3)` : ""}`);
out(`Minimum posts:     ${minPosts}   Seed: ${seed}\n`);

out("=== 2. WHAT HAPPENED TO THE RANDOM ACCOUNTS ===");
const found = counters.profilesFound;
const enough = found - counters.tooFewPosts;
out(`Directory requests made:                  ${String(counters.plcCalls).padStart(6)}`);
out(`Random accounts checked:                  ${String(counters.candidates).padStart(6)}`);
out(`  deleted or hidden (no profile):         ${String(counters.noProfile).padStart(6)}`);
out(`  profile found:                          ${String(found).padStart(6)}`);
out(`    fewer than ${minPosts} posts:                ${String(counters.tooFewPosts).padStart(6)}  (${pct(counters.tooFewPosts, found)} of profiles found)`);
out(`    ${minPosts}+ posts, carry the bot label:    ${String(counters.botLabeled).padStart(6)}  (${pct(counters.botLabeled, enough)} of accounts with ${minPosts}+ posts)`);
out(`    ${minPosts}+ posts, creation month not used: ${String(counters.otherMonth).padStart(6)}`);
out(`    ${minPosts}+ posts, month already full:   ${String(counters.monthFull).padStart(6)}`);
out(`    kept:                                 ${String(counters.accepted).padStart(6)}\n`);
out("Meaning: the share 'fewer than N posts' tells you how many random accounts are nearly");
out("empty. The bot-label share is how common self-declared bots are among random accounts");
out("with enough posts (a real finding about Bluesky, not about your sample size).\n");

out("=== 3. PER CREATION MONTH ===");
out("  month     curated bots   wanted   kept");
for (const m of months) {
  const bots = botMonths.find(([k]) => k === m)?.[1] ?? 0;
  const k = filled.get(m) ?? 0;
  out(`  ${m}   ${String(bots).padStart(10)}   ${String(quota.get(m)).padStart(6)}   ${String(k).padStart(4)}${k < quota.get(m) ? "   <- not filled" : ""}`);
}

out("\n=== 4. FIRST LOOK: COMPARISON ACCOUNTS vs CURATED BOTS ===");
out("25% / median / 75%. Differences here are what the score will try to pick up. They are");
out("not results yet: nothing has been scored.\n");
const quartiles = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return [0.25, 0.5, 0.75].map((p) => quantile(s, p)).join(" / ");
};
for (const [name, get] of [
  ["posts", (x) => x.profile?.postsCount ?? 0],
  ["followers", (x) => x.profile?.followersCount ?? 0],
  ["follows", (x) => x.profile?.followsCount ?? 0],
]) {
  out(`${name}:`);
  out(`  curated bots:        ${quartiles(curated.map(get))}`);
  out(`  comparison accounts: ${list.length ? quartiles(list.map(get)) : "n/a"}`);
}

// Sample for reading by hand.
const sample = shuffle([...list], seededRandom(seed + 1)).slice(0, review);
const rows = [["handle", "display_name", "bio", "posts", "followers", "follows", "created", "profile_url", "looks_automated (yes/no/unsure)", "notes"]];
for (const c of sample) {
  rows.push([
    c.handle,
    c.displayName,
    oneLine(c.description, 300),
    c.profile.postsCount,
    c.profile.followersCount,
    c.profile.followsCount,
    c.createdAt,
    `https://bsky.app/profile/${c.handle && c.handle !== "handle.invalid" ? c.handle : c.did}`,
    "",
    "",
  ]);
}
await writeFile(REVIEW_FILE, rows.map((r) => r.map(csv).join(",")).join("\n") + "\n");

out(`\n=== 5. NEXT: CHECK ${sample.length} ACCOUNTS BY HAND ===`);
out(`Open ${REVIEW_FILE} in Excel. For each account, open the profile link, look at the bio and`);
out("the recent posts, and write yes, no or unsure in the last-but-one column. The share of");
out("'yes' is your estimate of how contaminated the comparison group is.");

await save();
await writeFile(REPORT_FILE, lines.join("\n") + "\n");
console.log(`\nSaved: ${OUT_FILE}, ${STATS_FILE}, ${REPORT_FILE}, ${REVIEW_FILE}`);
