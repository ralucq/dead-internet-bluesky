// cleanup_comparison.mjs
// Removes bridged accounts (handles ending in .brid.gy) from the comparison group.
// Bridged accounts are automatic copies of a person's website or Mastodon account,
// so they do not belong in a group of ordinary accounts.
//
// Reads  data/comparison.json        (left untouched)
// Writes data/comparison_clean.json  (the group without bridged accounts)
//        data/comparison_removed.json (what was removed, for the record)
//
// Usage: node cleanup_comparison.mjs      (Node 18+, no packages, no network)

import { readFile, writeFile } from "node:fs/promises";

const IN = "data/comparison.json";
let all;
try {
  all = JSON.parse(await readFile(IN, "utf8"));
} catch {
  console.log(`Could not read ${IN}. Run it from the folder where comparison.mjs was run.`);
  process.exit(1);
}

const isBridged = (a) => (a.handle ?? "").toLowerCase().endsWith(".brid.gy");
const removed = all.filter(isBridged);
const kept = all.filter((a) => !isBridged(a));

await writeFile("data/comparison_clean.json", JSON.stringify(kept, null, 2));
await writeFile("data/comparison_removed.json", JSON.stringify(removed, null, 2));

console.log(`Before: ${all.length} accounts`);
console.log(`Removed (handle ends in .brid.gy): ${removed.length}`);
console.log(`After:  ${kept.length} accounts`);
const byMonth = new Map();
for (const a of removed) byMonth.set(a.month, (byMonth.get(a.month) ?? 0) + 1);
console.log("\nRemoved per creation month:");
for (const [m, n] of [...byMonth].sort()) console.log(`  ${m}: ${n}`);
console.log("\nSaved: data/comparison_clean.json and data/comparison_removed.json");
