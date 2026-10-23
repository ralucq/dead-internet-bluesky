import { collectAccount, computeSignals, scoreAccount } from "./signals.js";

// Plain-language name, how to show a value, and how to undo the logarithm used by the model.
const pct = (x) => `${Math.round(100 * x)}%`;
const num = (x) => (x >= 100 ? Math.round(x).toLocaleString("en") : x >= 10 ? x.toFixed(0) : x.toFixed(1));
const yn = (x) => (x >= 0.5 ? "yes" : "no");
const L = {
  logPostsPerDay: ["Posts per day since the account was created", (x) => num(Math.exp(x)) ],
  logFollowers: ["Followers", (x) => num(Math.expm1(x))],
  logFollows: ["Accounts it follows", (x) => num(Math.expm1(x))],
  handleDigitShare: ["Digits in the handle", pct],
  hasDisplayName: ["Has a display name", yn],
  hasBanner: ["Has a banner image", yn],
  logItemsPerDay: ["Recent posts, replies and reposts per day", (x) => num(Math.exp(x))],
  gapCV: ["Irregular timing (0 = like a clock)", (x) => x.toFixed(2)],
  sameGapShare: ["Waiting times between posts that are the same", pct],
  minuteModeShare: ["Posts made in the same minute of the hour", pct],
  secondModeShare: ["Posts made in the same second of the minute", pct],
  repostShare: ["Share of items that are reposts", pct],
  replyShare: ["Share of posts that are replies", pct],
  quoteShare: ["Share of posts that quote another post", pct],
  zeroEngagementShare: ["Posts nobody reacted to", pct],
  logEngagementPerFollower: ["Reactions per post compared with followers", (x) => (Math.expm1(x) / 100).toFixed(3)],
  templateShare: ["Posts that start like another post", pct],
  meanSimilarity: ["Similarity between posts (word pairs)", (x) => x.toFixed(2)],
  exactDupShare: ["Posts repeated word for word", pct],
  logTextLength: ["Average post length in characters", (x) => num(Math.expm1(x))],
  languages: ["Languages used", (x) => String(Math.round(x))],
  linkShare: ["Posts with a link", pct],
  imageShare: ["Posts with an image or video", pct],
  mutualOfFollowers: ["Followers that it follows back", pct],
  followerBotShare: ["Followers labelled as bots", pct],
  followerEmptyShare: ["Followers with an empty profile", pct],
  followerNoAvatarShare: ["Followers without a picture", pct],
  logFollowerAge: ["Typical age of followers' accounts in days", (x) => num(Math.expm1(x))],
  followerDayModeShare: ["Followers who joined on the same day", pct],
  followsBotShare: ["Accounts it follows that are labelled bots", pct],
  logSampleFollowers: ["Followers found (up to 100)", (x) => num(Math.expm1(x))],
  ttr100: ["Word variety", (x) => x.toFixed(2)],
  lengthCV: ["Variation in post length", (x) => x.toFixed(2)],
  digitCharShare: ["Digits in the text", pct],
  headlineLinkShare: ["Short posts with a link", pct],
  charSimilarity: ["Similarity between posts (letters)", (x) => x.toFixed(2)],
  nearDupShare: ["Posts with a near-copy among its own posts", pct],
};
const BAND_TEXT = {
  "very low": ["No sign of scheduled automation", "Its posting rhythm, repetition and connections look like the ordinary accounts of the study. This does NOT show that a real person runs it."],
  "low": ["Little sign of scheduled automation", "Mostly like the ordinary accounts of the study. This does NOT show that a real person runs it."],
  "slightly low": ["Slightly more like ordinary accounts", "A mixed picture that leans towards ordinary accounts. This does NOT show that a real person runs it."],
  "unclear": ["Unclear", "The account shares traits with both groups. The measurements do not decide."],
  "raised": ["Some sign of automation", "More like the declared bots than the ordinary accounts, but not decisive."],
  "high": ["Strong sign of automation", "It looks much like the declared bots of the study."],
  "very high": ["Very strong sign of automation", "It looks like the declared bots of the study in almost every measurement."],
};
const COLORS = ["--b0", "--b1", "--b2", "--b3", "--b4", "--b5", "--b6"];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let model;
try { model = await (await fetch("model.json")).json(); } catch { $("out").innerHTML = '<div class="card err">The model file (model.json) could not be loaded.</div>'; }

function reasons(res) {
  const show = (p) => {
    const lab = L[p.signal]?.[0] ?? p.signal;
    if (p.marker) return `<li><b>${esc(lab)}</b><div class="nums">Could not be measured for this account, which is itself informative.</div></li>`;
    const j = model.signals.indexOf(p.signal), f = L[p.signal]?.[1] ?? String;
    const own = Number.isFinite(p.value) ? f(p.value) : "n/a";
    return `<li><b>${esc(lab)}</b><div class="nums">this account: ${own} &middot; typical declared bot: ${f(model.refBots[j])} &middot; typical ordinary account: ${f(model.refComparison[j])}</div></li>`;
  };
  const sorted = [...res.parts].sort((a, b) => b.contribution - a.contribution);
  const up = sorted.filter((p) => p.contribution > 0.15).slice(0, 4), down = sorted.reverse().filter((p) => p.contribution < -0.15).slice(0, 4);
  return `${up.length ? `<h2>What points towards a bot</h2><ul class="r">${up.map(show).join("")}</ul>` : ""}${down.length ? `<h2>What points towards an ordinary account</h2><ul class="r">${down.map(show).join("")}</ul>` : ""}`;
}

function render(profile, items, graph, res) {
  const band = res.band, k = model.bands.indexOf(band), [title, text] = BAND_TEXT[band.name] ?? [band.name, ""];
  const sb = Math.round((100 * band.bots) / model.trainedOn.bots), sc = Math.round((100 * band.comparison) / model.trainedOn.comparison);
  const selfBot = (profile.labels ?? []).some((l) => l.val === "bot" && l.src === profile.did);
  const notes = [];
  if (selfBot) notes.push("This account carries the <b>bot</b> label that its owner set. The score does not use that label, so it works as an independent check.");
  if (items.length < 20) notes.push(`Only ${items.length} recent items were found, so most behaviour measurements are missing and the result is weak.`);
  else if (res.missing.length > 8) notes.push(`${res.missing.length} of ${model.signals.length} measurements could not be made for this account (for example because of few followers or few posts), so the result is less reliable.`);
  const lowBand = k <= 2;
  notes.push(lowBand
    ? "<b>Important:</b> this measures scheduled, repetitive, one-way posting, the way declared feed bots behave. It cannot see fake-person or AI-run accounts that post and interact like people (for example accounts with stolen or generated photos). A low result does not mean the account is a real person."
    : "The score compares this account with declared bots (mostly scheduled feed accounts). It cannot see AI-driven accounts that behave like people.");
  $("out").innerHTML = `<div class="card">
    <div class="who">${profile.avatar ? `<img src="${esc(profile.avatar)}" alt="">` : "<img alt=''>"}<div><b>${esc(profile.displayName || profile.handle)}</b><span>@${esc(profile.handle)}</span></div></div>
    <div class="verdict" style="--c:var(${COLORS[k]})"><div class="big">${esc(title)}</div><div>${esc(text)}</div></div>
    <div class="scale" aria-hidden="true">${model.bands.map((_, i) => `<i class="${i === k ? "on" : ""}" style="background:var(${COLORS[i]})"></i>`).join("")}</div>
    <div class="mute">Score ${res.score.toFixed(0)} of 100 &middot; band &ldquo;${esc(band.name)}&rdquo;. In the study, ${sb} of 100 declared bots and ${sc} of 100 ordinary accounts fell in this band (evidence ratio ${band.ratio.toFixed(band.ratio >= 10 ? 0 : 1)}).</div>
    ${notes.map((n) => `<div class="note">${n}</div>`).join("")}
    ${reasons(res)}
  </div>`;
}

function normalize(input) {
  let h = input.trim().replace(/^@/, "").replace(/^https?:\/\/bsky\.app\/profile\//, "").replace(/\/.*$/, "");
  if (h && !h.startsWith("did:") && !h.includes(".")) h += ".bsky.social";
  return h;
}
$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!model) return;
  const actor = normalize($("h").value);
  if (!actor) return;
  $("go").disabled = true;
  $("out").innerHTML = '<div class="card mute">Reading the account&hellip;</div>';
  try {
    const { profile, items, graph } = await collectAccount(actor);
    render(profile, items, graph, scoreAccount(model, computeSignals(profile, items, graph)));
  } catch (err) {
    const msg = err.message === "rate" ? "Bluesky is asking for a pause (too many requests). Try again in a minute."
      : err.message === "network" ? "Could not reach Bluesky. Check your connection."
      : err.status === 400 || err.status === 404 ? "No public account with that handle was found. Check the spelling." : "Bluesky could not give the data for this account.";
    $("out").innerHTML = `<div class="card err">${msg}</div>`;
  } finally { $("go").disabled = false; }
});
