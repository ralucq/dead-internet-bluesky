// verify_signals.mjs
// Checks that signals.js (the code used by the web app) gives the SAME numbers as the scripts of
// the study. For every account in your data it recomputes the signals from posts.json and
// graph.json and compares them with features_behaviour.csv, features_graph.csv, features_content.csv
// and features_profile.csv.
//
// Usage (from the folder that contains the data folder and the app folder):
//         node app/verify_signals.mjs
// Needs Node 18+. No packages, no network.

import { readFile, stat } from "node:fs/promises";
import { rawFeatures, computeSignals, scoreAccount } from "./signals.js";

const DIR = "data";
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function table(name) {
  let text;
  try { text = await readFile(`${DIR}/${name}`, "utf8"); } catch { console.log(`Could not read ${DIR}/${name}. Run it from the folder that contains the data folder.`); process.exit(1); }
  const t = parseCsv(text.trim());
  const m = new Map();
  for (const r of t.slice(1)) { const o = {}; t[0].forEach((n, i) => { o[n] = r[i] === "" ? NaN : Number.isNaN(Number(r[i])) ? r[i] : Number(r[i]); }); m.set(o.did, o); }
  return { m, mtime: (await stat(`${DIR}/${name}`)).mtimeMs };
}
const json = async (name) => { try { return JSON.parse(await readFile(`${DIR}/${name}`, "utf8")); } catch { console.log(`Could not read ${DIR}/${name}.`); process.exit(1); } };

const P = await table("features_profile.csv");
const B = await table("features_behaviour.csv");
const G = await table("features_graph.csv");
const C = await table("features_content.csv");
const posts = await json("posts.json");
const graph = await json("graph.json");
const bots = await json("bots_curated.json");
const comp = await json("comparison_clean.json");
const entries = new Map([...bots, ...comp].map((e) => [e.did, e]));

// Compared pairs: [group in rawFeatures, name in app, source table, name in table]
const PAIRS = [
  ["pf", "postsPerDay", P, "postsPerDay", 0.03], ["pf", "followers", P, "followers", 0], ["pf", "follows", P, "follows", 0],
  ["pf", "handleDigitShare", P, "handleDigitShare", 0], ["pf", "hasDisplayName", P, "hasDisplayName", 0], ["pf", "hasBanner", P, "hasBanner", 0],
  ...["itemsPerDay", "gapCV", "sameGapShare", "minuteModeShare", "secondModeShare", "repostShare", "replyShare", "quoteShare", "zeroEngagementShare", "engagementPerFollower", "templateShare", "meanSimilarity", "exactDupShare", "textLength", "languages", "linkShare", "imageShare"].map((n) => ["bh", n, B, n, 0]),
  ...["sampleFollowers", "mutualOfFollowers", "followerBotShare", "followerEmptyShare", "followerNoAvatarShare", "followerAgeMedianDays", "followerDayModeShare", "followsBotShare"].map((n) => ["gr", n, G, n, n === "followerAgeMedianDays" ? 0.03 : 0]),
  ...["ttr100", "lengthCV", "digitCharShare", "headlineLinkShare", "charSimilarity", "nearDupShare"].map((n) => ["ct", n, C, n, 0]),
];
const stats = new Map(PAIRS.map((p) => [`${p[0]}.${p[1]}`, { n: 0, bad: 0, nanMismatch: 0, maxDiff: 0, example: "" }]));
let accounts = 0;
for (const [did, row] of P.m) {
  if (!posts[did] || !graph[did] || !B.m.has(did)) continue;
  const e = entries.get(did) ?? {};
  const profile = { ...(e.profile ?? {}), did, handle: e.handle ?? e.profile?.handle ?? row.handle };
  const now = P.mtime; // the study measured ages on the day the files were made
  const f = rawFeatures(profile, posts[did], graph[did], now);
  // graph signals were measured on the day features_graph.csv was made
  const fg = rawFeatures(profile, posts[did], graph[did], G.mtime);
  accounts++;
  for (const [grp, name, tab, tname, rel] of PAIRS) {
    const a = (grp === "gr" ? fg : f)[grp][name];
    const b = tab.m.get(did)?.[tname];
    const st = stats.get(`${grp}.${name}`);
    const aOk = Number.isFinite(a), bOk = Number.isFinite(b);
    if (!aOk && !bOk) continue;
    st.n++;
    if (aOk !== bOk) { st.nanMismatch++; st.bad++; if (!st.example) st.example = `${row.handle}: app ${a} vs study ${b}`; continue; }
    const d = Math.abs(a - b);
    const tol = 1e-5 + Math.max(1e-4, rel) * Math.abs(b);
    st.maxDiff = Math.max(st.maxDiff, d);
    if (d > tol) { st.bad++; if (!st.example) st.example = `${row.handle}: app ${a} vs study ${b}`; }
  }
}
console.log(`Accounts compared: ${accounts}\n`);
console.log("signal                              compared   different   one missing   largest difference");
let total = 0;
for (const [k, s] of stats) {
  total += s.bad;
  console.log(`${k.padEnd(34)} ${String(s.n).padStart(8)}   ${String(s.bad).padStart(9)}   ${String(s.nanMismatch).padStart(12)}   ${s.maxDiff.toExponential(2).padStart(18)}${s.example ? "   e.g. " + s.example : ""}`);
}
console.log(total === 0 ? "\nALL SIGNALS MATCH the study (within rounding)." : `\n${total} differences found. Send me this output.`);

// ---- the model: does the app give the same SCORE as the study's own final model?
let model = null, check = [];
try { model = JSON.parse(await readFile("app/model.json", "utf8")); } catch {}
try { check = JSON.parse(await readFile(`${DIR}/model_check.json`, "utf8")); } catch {}
if (!model) console.log("\n(app/model.json not found yet: run export_web_model.mjs, then run this check again.)");
else {
  let worst = 0, n = 0;
  console.log("\nScore check (app vs final model of the study, 20 accounts):");
  for (const c of check) {
    if (!posts[c.did] || !graph[c.did]) continue;
    const e = entries.get(c.did) ?? {};
    const profile = { ...(e.profile ?? {}), did: c.did, handle: e.handle ?? e.profile?.handle ?? c.handle };
    const r = scoreAccount(model, computeSignals(profile, posts[c.did], graph[c.did], G.mtime));
    const d = Math.abs(r.score - c.score);
    worst = Math.max(worst, d); n++;
    console.log(`  ${c.handle.padEnd(40)} study ${c.score.toFixed(1).padStart(6)}   app ${r.score.toFixed(1).padStart(6)}   difference ${d.toFixed(2)}`);
  }
  console.log(worst < 1 ? `\nSCORES MATCH (largest difference ${worst.toFixed(2)} points over ${n} accounts).` : `\nSCORES DIFFER (largest difference ${worst.toFixed(2)}). Send me this output.`);
}
