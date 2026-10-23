// signals.js
// The signals of the thesis, for ONE account, as an ES module that runs in the browser and in Node.
// Every function is a copy of the code in features_profile.mjs, features_behaviour.mjs,
// features_graph.mjs and features_content.mjs, and collect_posts.mjs / collect_graph.mjs, so that
// a live account gets exactly the same numbers as the accounts in the study.
// verify_signals.mjs checks this against the files of the study.

const DAY = 86400000;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const share = (arr, f) => arr.filter(f).length / arr.length;
const maxShare = (values) => {
  const c = new Map();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  return Math.max(...c.values()) / values.length;
};

// ------------------------------------------------------------ what is fetched (collectors)
export function simplifyItem(item) {
  if (item.reason?.$type === "app.bsky.feed.defs#reasonPin") return null;
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
    to: didOf(rec.reply?.parent?.uri),
    qu: quoted,
    me: [...new Set(mentions)],
    rc: post.replyCount ?? 0,
    rp: post.repostCount ?? 0,
    lk: post.likeCount ?? 0,
    qt: post.quoteCount ?? 0,
    link: hasLinkFacet || embedType.includes("external"),
    img: embedType.includes("images") || embedType.includes("video"),
    ln: rec.langs ?? [],
    x: typeof rec.text === "string" ? rec.text : "",
  };
}
export const slimProfile = (p) => ({
  d: p.did,
  h: p.handle,
  c: p.createdAt ?? p.indexedAt ?? null,
  av: Boolean(p.avatar),
  nm: Boolean((p.displayName ?? "").trim()),
  bio: Boolean((p.description ?? "").trim()),
  bot: (p.labels ?? []).some((l) => l.val === "bot" && l.src === p.did),
});

// Fetches one account from the public API. `fetchFn` is fetch (browser or Node 18+).
export async function collectAccount(actor, { api = "https://public.api.bsky.app/xrpc", fetchFn = fetch } = {}) {
  const get = async (method, params) => {
    const url = `${api}/${method}?${new URLSearchParams(params)}`;
    let res;
    try { res = await fetchFn(url); } catch { throw new Error("network"); }
    if (res.status === 429) throw new Error("rate");
    if (!res.ok) { const e = new Error("api"); e.status = res.status; throw e; }
    return res.json();
  };
  const profile = await get("app.bsky.actor.getProfile", { actor });
  const did = profile.did;
  const [feed, fo, fg] = await Promise.all([
    get("app.bsky.feed.getAuthorFeed", { actor: did, limit: 100, filter: "posts_with_replies" }),
    get("app.bsky.graph.getFollowers", { actor: did, limit: 100 }),
    get("app.bsky.graph.getFollows", { actor: did, limit: 100 }),
  ]);
  return {
    profile,
    items: (feed.feed ?? []).map(simplifyItem).filter(Boolean),
    graph: { followers: (fo.followers ?? []).map(slimProfile), follows: (fg.follows ?? []).map(slimProfile) },
  };
}

// ------------------------------------------------------------ text helpers
const normalize = (s) =>
  s.toLowerCase().replace(/https?:\/\/\S+/g, " ").replace(/[0-9]+/g, "0").replace(/[^\p{L}\p{N}#@\s]/gu, " ").replace(/\s+/g, " ").trim();
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function tokensOf(text) {
  const w = text.split(" ").filter(Boolean);
  const set = new Set();
  if (w.length < 3) w.forEach((x) => set.add(x));
  else for (let i = 0; i + 1 < w.length; i++) set.add(w[i] + " " + w[i + 1]);
  return set;
}
const grams = (t) => {
  const c = [...t.replace(/\s+/g, " ")];
  const set = new Set();
  if (c.length < 4) { if (c.length) set.add(c.join("")); return set; }
  for (let i = 0; i + 4 <= c.length; i++) set.add(c.slice(i, i + 4).join(""));
  return set;
};

// ------------------------------------------------------------ profile (features_profile.mjs)
function profileFeatures(p, nowMs) {
  const handle = (p.handle ?? "").toLowerCase();
  const local = handle.split(".")[0] ?? "";
  const created = Date.parse(p.createdAt ?? "");
  const ageDays = Number.isFinite(created) ? Math.max(1, (nowMs - created) / DAY) : NaN;
  const posts = p.postsCount ?? NaN;
  const name = (p.displayName ?? "").trim();
  return {
    postsPerDay: posts / ageDays,
    followers: p.followersCount ?? NaN,
    follows: p.followsCount ?? NaN,
    hasBanner: p.banner ? 1 : 0,
    hasDisplayName: name ? 1 : 0,
    handleDigitShare: local.length ? (local.match(/[0-9]/g) ?? []).length / local.length : 0,
  };
}

// ------------------------------------------------------------ behaviour (features_behaviour.mjs)
function behaviourFeatures(items, ctx) {
  const minItems = 20, minText = 10;
  const f = {};
  const timed = items.map((i) => ({ ...i, ms: Date.parse(i.t) })).filter((i) => Number.isFinite(i.ms)).sort((a, b) => a.ms - b.ms);
  f.items = timed.length;
  if (timed.length >= minItems) {
    const span = (timed[timed.length - 1].ms - timed[0].ms) / DAY;
    f.itemsPerDay = (timed.length - 1) / Math.max(span, 1 / 24);
    const gaps = [];
    for (let i = 1; i < timed.length; i++) gaps.push((timed[i].ms - timed[i - 1].ms) / 1000);
    const mu = mean(gaps);
    const sg = sd(gaps);
    f.gapCV = mu > 0 ? sg / mu : NaN;
    f.sameGapShare = maxShare(gaps.map((g) => Math.round(g / 60)));
    const dates = timed.map((i) => new Date(i.ms));
    f.minuteModeShare = maxShare(dates.map((d) => d.getUTCMinutes()));
    f.secondModeShare = maxShare(dates.map((d) => d.getUTCSeconds()));
    f.repostShare = share(timed, (i) => i.k === "repost");
  }
  const own = items.filter((i) => i.k === "post");
  if (own.length >= minText) {
    f.replyShare = share(own, (i) => i.re);
    f.linkShare = share(own, (i) => i.link);
    f.imageShare = share(own, (i) => i.img);
    f.textLength = mean(own.map((i) => i.x.length));
    f.languages = new Set(own.flatMap((i) => i.ln)).size;
    f.quoteShare = share(own, (i) => Boolean(i.qu));
    const originals = own.filter((i) => !i.re);
    if (originals.length >= minText) {
      const eng = originals.map((i) => (i.lk ?? 0) + (i.rp ?? 0) + (i.rc ?? 0) + (i.qt ?? 0));
      const perPost = mean(eng);
      f.engagementPerFollower = perPost / ((ctx.followers || 0) + 1);
      f.zeroEngagementShare = share(eng, (e) => e === 0);
    }
    const texts = own.map((i) => normalize(i.x)).filter((t) => t.length > 0);
    if (texts.length >= minText) {
      const counts = new Map();
      for (const t of texts) counts.set(t, (counts.get(t) ?? 0) + 1);
      f.exactDupShare = share(texts, (t) => counts.get(t) > 1);
      const sets = texts.map(tokensOf);
      let total = 0, pairs = 0;
      for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) { total += similarity(sets[i], sets[j]); pairs++; }
      f.meanSimilarity = total / pairs;
      const starts = texts.map((t) => t.split(" ").slice(0, 3).join(" "));
      const sc = new Map();
      for (const s of starts) sc.set(s, (sc.get(s) ?? 0) + 1);
      f.templateShare = share(starts, (s) => sc.get(s) > 1);
    }
  }
  return f;
}

// ------------------------------------------------------------ graph (features_graph.mjs)
const digitShare = (h) => { const l = (h ?? "").split(".")[0]; return l.length ? (l.match(/[0-9]/g) ?? []).length / l.length : NaN; };
const empty = (a) => !a.av && !a.nm && !a.bio;
function graphFeatures(g, p, nowMs) {
  const minSample = 10;
  const ageDays = (a) => { const ms = Date.parse(a.c ?? ""); return Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / DAY) : NaN; };
  const f = {};
  const F = g.followers, G = g.follows;
  f.sampleFollowers = F.length;
  if (F.length >= minSample) {
    const ages = F.map(ageDays).filter(Number.isFinite);
    f.followerAgeMedianDays = median(ages);
    const days = F.map((a) => (a.c ?? "").slice(0, 10)).filter(Boolean);
    if (days.length) f.followerDayModeShare = maxShare(days);
    f.followerEmptyShare = share(F, empty);
    f.followerNoAvatarShare = share(F, (a) => !a.av);
    f.followerBotShare = share(F, (a) => a.bot);
    if (p.follows <= 100) {
      const followed = new Set(G.map((a) => a.d));
      f.mutualOfFollowers = share(F, (a) => followed.has(a.d));
    }
  }
  if (G.length >= minSample) {
    f.followsBotShare = share(G, (a) => a.bot);
  }
  return f;
}

// ------------------------------------------------------------ content (features_content.mjs)
function contentFeatures(items) {
  const minText = 10, maxPairs = 60;
  const f = {};
  const arr = items.filter((i) => i.k === "post").map((i) => ({ raw: i.x ?? "", norm: normalize(i.x ?? ""), link: Boolean(i.link) }));
  if (arr.length < minText) return f;
  const lens = arr.map((a) => [...a.raw].length);
  if (mean(lens) > 0) f.lengthCV = sd(lens) / mean(lens);
  const allChars = arr.reduce((s, a) => s + [...a.raw].length, 0);
  if (allChars > 0) f.digitCharShare = arr.reduce((s, a) => s + (a.raw.match(/[0-9]/g) ?? []).length, 0) / allChars;
  f.headlineLinkShare = arr.filter((a) => a.link && a.raw.trim().split(/\s+/).filter(Boolean).length <= 25).length / arr.length;
  const words = arr.flatMap((a) => a.norm.split(" ").filter(Boolean));
  if (words.length >= 100) f.ttr100 = new Set(words.slice(0, 100)).size / 100;
  const texts = arr.filter((a) => a.norm.length > 0).slice(0, maxPairs);
  if (texts.length >= minText) {
    const sets = texts.map((a) => grams(a.norm));
    let total = 0, pairs = 0;
    const hasNear = new Array(sets.length).fill(false);
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const s = (() => { const a = sets[i], b = sets[j]; if (!a.size || !b.size) return 0; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter); })();
        total += s;
        pairs++;
        if (s >= 0.7) { hasNear[i] = true; hasNear[j] = true; }
      }
    }
    f.charSimilarity = total / pairs;
    f.nearDupShare = hasNear.filter(Boolean).length / sets.length;
  }
  return f;
}

// ------------------------------------------------------------ the signal list of the score
// Same names and order as score_combined.mjs, without the two copy-between-accounts signals,
// which cannot be measured for a single account.
const v = (x) => (x === undefined ? NaN : x);
export const SIGNAL_DEFS = [
  ["profile", "logPostsPerDay", (s) => Math.log(v(s.pf.postsPerDay))],
  ["profile", "logFollowers", (s) => Math.log1p(v(s.pf.followers))],
  ["profile", "logFollows", (s) => Math.log1p(v(s.pf.follows))],
  ["profile", "handleDigitShare", (s) => v(s.pf.handleDigitShare)],
  ["profile", "hasDisplayName", (s) => v(s.pf.hasDisplayName)],
  ["profile", "hasBanner", (s) => v(s.pf.hasBanner)],
  ["behaviour", "logItemsPerDay", (s) => Math.log(v(s.bh.itemsPerDay))],
  ["behaviour", "gapCV", (s) => v(s.bh.gapCV)],
  ["behaviour", "sameGapShare", (s) => v(s.bh.sameGapShare)],
  ["behaviour", "minuteModeShare", (s) => v(s.bh.minuteModeShare)],
  ["behaviour", "secondModeShare", (s) => v(s.bh.secondModeShare)],
  ["behaviour", "repostShare", (s) => v(s.bh.repostShare)],
  ["behaviour", "replyShare", (s) => v(s.bh.replyShare)],
  ["behaviour", "quoteShare", (s) => v(s.bh.quoteShare)],
  ["behaviour", "zeroEngagementShare", (s) => v(s.bh.zeroEngagementShare)],
  ["behaviour", "logEngagementPerFollower", (s) => Math.log1p(100 * v(s.bh.engagementPerFollower))],
  ["behaviour", "templateShare", (s) => v(s.bh.templateShare)],
  ["behaviour", "meanSimilarity", (s) => v(s.bh.meanSimilarity)],
  ["behaviour", "exactDupShare", (s) => v(s.bh.exactDupShare)],
  ["behaviour", "logTextLength", (s) => Math.log1p(v(s.bh.textLength))],
  ["behaviour", "languages", (s) => v(s.bh.languages)],
  ["behaviour", "linkShare", (s) => v(s.bh.linkShare)],
  ["behaviour", "imageShare", (s) => v(s.bh.imageShare)],
  ["graph", "mutualOfFollowers", (s) => v(s.gr.mutualOfFollowers)],
  ["graph", "followerBotShare", (s) => v(s.gr.followerBotShare)],
  ["graph", "followerEmptyShare", (s) => v(s.gr.followerEmptyShare)],
  ["graph", "followerNoAvatarShare", (s) => v(s.gr.followerNoAvatarShare)],
  ["graph", "logFollowerAge", (s) => Math.log1p(v(s.gr.followerAgeMedianDays))],
  ["graph", "followerDayModeShare", (s) => v(s.gr.followerDayModeShare)],
  ["graph", "followsBotShare", (s) => v(s.gr.followsBotShare)],
  ["graph", "logSampleFollowers", (s) => Math.log1p(v(s.gr.sampleFollowers))],
  ["content", "ttr100", (s) => v(s.ct.ttr100)],
  ["content", "lengthCV", (s) => v(s.ct.lengthCV)],
  ["content", "digitCharShare", (s) => v(s.ct.digitCharShare)],
  ["content", "headlineLinkShare", (s) => v(s.ct.headlineLinkShare)],
  ["content", "charSimilarity", (s) => v(s.ct.charSimilarity)],
  ["content", "nearDupShare", (s) => v(s.ct.nearDupShare)],
];

// profile: the getProfile response; items: simplified items; graph: {followers, follows}
export function rawFeatures(profile, items, graph, nowMs = Date.now()) {
  const pf = profileFeatures(profile, nowMs);
  const bh = behaviourFeatures(items, { did: profile.did, followers: pf.followers });
  const gr = graphFeatures(graph, { follows: pf.follows, followers: pf.followers }, nowMs);
  const ct = contentFeatures(items);
  return { pf, bh, gr, ct };
}
export function computeSignals(profile, items, graph, nowMs = Date.now()) {
  const pf = profileFeatures(profile, nowMs);
  const bh = behaviourFeatures(items, { did: profile.did, followers: pf.followers });
  const gr = graphFeatures(graph, { follows: pf.follows, followers: pf.followers }, nowMs);
  const ct = contentFeatures(items);
  const s = { pf, bh, gr, ct };
  return SIGNAL_DEFS.map(([group, name, fn]) => ({ group, name, value: fn(s) }));
}

// ------------------------------------------------------------ the model (exported by export_web_model.mjs)
// model = { signals:[names], cols:[{j, marker}], mean, sd, med, w, bands:[...] }
export function scoreAccount(model, signalValues) {
  const byName = new Map(signalValues.map((s) => [s.name, s.value]));
  const x = model.signals.map((n) => byName.get(n));
  let z = model.w[0];
  const parts = [];
  model.cols.forEach((c, i) => {
    const raw = c.marker ? (Number.isFinite(x[c.j]) ? 0 : 1) : Number.isFinite(x[c.j]) ? x[c.j] : model.med[c.j];
    const std = (raw - model.mean[i]) / model.sd[i];
    z += model.w[i + 1] * std;
    parts.push({ signal: model.signals[c.j], marker: c.marker, contribution: model.w[i + 1] * std, value: x[c.j] });
  });
  const score = 100 / (1 + Math.exp(-z));
  const band = model.bands.findIndex((b) => score >= b.lo && score < b.hi);
  return { score, band: model.bands[Math.max(0, band)], parts, missing: signalValues.filter((s) => !Number.isFinite(s.value)).map((s) => s.name) };
}
