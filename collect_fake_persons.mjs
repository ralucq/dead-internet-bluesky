// collect_fake_persons.mjs
// Collect profile, posts, graph and score for accounts identified as fake-person bots.
// Each entry in data/fake_persons.json includes the reason it was included and a citation.
//
// Usage:
//   node collect_fake_persons.mjs <handle> [--reason "text"] [--source "url"] [--delay 500]
//   node collect_fake_persons.mjs --file candidates.txt   (one line per handle, optionally tab-separated: handle<TAB>reason<TAB>source)
//
// Re-runnable: handles already in the file are skipped (use --force to re-collect).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { collectAccount, computeSignals, scoreAccount } from "./app/signals.js";
import modelData from "./app/model.json" with { type: "json" };

const API = "https://public.api.bsky.app/xrpc";
const OUT = "data/fake_persons.json";

// --- parse args ---
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 2), args[i + 1 - 1] ?? null) : null; };
// flag() removes from args, so call order matters
const delayMs = Number(flag("--delay") ?? 500);
const reason  = flag("--reason") ?? "not specified";
const source  = flag("--source") ?? "";
const force   = args.includes("--force");
const filePath = flag("--file");

if (force) args.splice(args.indexOf("--force"), 1);

// build list of {handle, reason, source}
const candidates = [];
if (filePath) {
  const lines = (await readFile(filePath, "utf8")).split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("#")) continue;
    const [h, r, s] = line.split("\t");
    candidates.push({ handle: h.trim(), reason: r?.trim() || reason, source: s?.trim() || source });
  }
} else {
  const handles = args.filter((a) => !a.startsWith("--"));
  for (const h of handles) candidates.push({ handle: h, reason, source });
}

if (candidates.length === 0) {
  console.error("Usage: node collect_fake_persons.mjs <handle> [--reason '...'] [--source '...']");
  console.error("       node collect_fake_persons.mjs --file candidates.txt");
  process.exit(1);
}

// --- load existing results ---
let results = [];
if (existsSync(OUT)) {
  try { results = JSON.parse(await readFile(OUT, "utf8")); } catch {}
}
const done = new Set(results.map((r) => r.handle));

// --- SIGINT: save on Ctrl+C ---
process.on("SIGINT", async () => {
  await writeFile(OUT, JSON.stringify(results, null, 2));
  console.log(`\nSaved ${results.length} entries to ${OUT}`);
  process.exit(0);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- collect ---
let collected = 0, skipped = 0, failed = 0;
for (const { handle, reason: r, source: s } of candidates) {
  if (done.has(handle) && !force) {
    console.log(`skip  ${handle} (already collected)`);
    skipped++;
    continue;
  }
  process.stdout.write(`fetch ${handle} ... `);
  try {
    const { profile, items, graph } = await collectAccount(handle, { api: API });
    const signals = computeSignals(profile, items, graph);
    const result  = scoreAccount(modelData, signals);

    // remove any old entry for this handle (for --force)
    const idx = results.findIndex((e) => e.handle === handle);
    const entry = {
      handle,
      did: profile.did,
      collectedAt: new Date().toISOString(),
      reason: r,
      source: s || undefined,
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
    };
    if (idx >= 0) results[idx] = entry; else results.push(entry);
    collected++;
    console.log(`score ${Math.round(result.score)} (${result.band.name})  missing ${result.missing.length}/${modelData.signals.length}`);
    await writeFile(OUT, JSON.stringify(results, null, 2));
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    failed++;
  }
  await sleep(delayMs);
}

console.log(`\nDone. collected ${collected}, skipped ${skipped}, failed ${failed}. Results in ${OUT}`);
