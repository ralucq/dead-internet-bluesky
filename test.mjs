const base = "https://public.api.bsky.app/xrpc";
const actor = process.argv[2] ?? "bsky.app";

async function call(method, params) {
    const url = `${base}/${method}?${new URLSearchParams(params)}`;
    const res = await fetch(url);
    if (!res.ok) {
        console.log(`${method} FAILED: ${res.status} ${await res.text()}`);
        return null;
    }
    return res.json();
}

// 1. Profile: creation date, counts, labels
const profile = await call("app.bsky.actor.getProfile", { actor });
if (profile) {
    console.log("\n--- PROFILE ---");
    console.log({
        handle: profile.handle,
        createdAt: profile.createdAt,
        followers: profile.followersCount,
        follows: profile.followsCount,
        posts: profile.postsCount,
        labels: profile.labels,
    });
}

// 2. Recent posts: timestamps and text
const feed = await call("app.bsky.feed.getAuthorFeed", { actor, limit: "10" });
if (feed) {
    console.log("\n--- LAST 10 FEED ITEMS ---");
    for (const item of feed.feed) {
        const r = item.post.record;
        console.log(r.createdAt, "|", (r.text ?? "").slice(0, 60));
    }
}

// 3. Followers
const followers = await call("app.bsky.graph.getFollowers", { actor, limit: "5" });
if (followers) {
    console.log("\n--- 5 FOLLOWERS ---");
    for (const f of followers.followers) {
        console.log(f.handle, "| created:", f.createdAt, "| indexed:", f.indexedAt);
    }
}

// 4. Who the account follows
const follows = await call("app.bsky.graph.getFollows", { actor, limit: "5" });
if (follows) {
    console.log("\n--- 5 FOLLOWS ---");
    for (const f of follows.follows) {
        console.log(f.handle, "| created:", f.createdAt, "| indexed:", f.indexedAt);
    }
}