import { describe, expect, it, vi } from "vitest";
import { createXRelayClient, errorFor, X_CLIENT_TIMEOUT_MS, normalizeHandle, parsePostRef, toPost, X_MESSAGES, XResearchError } from "./x-research.ts";

/** 2026-10-08T00:12:34Z */
const CREATED = 1791418354;

/** A row as anyapi's search answers it (treg's published example). */
const searchRow = (id: string, extra: Record<string, unknown> = {}) => ({
  authorName: "Maus",
  authorUsername: "maus",
  authorVerified: true,
  bookmarkCount: 0,
  conversationId: id,
  createdUtc: CREATED,
  id,
  isReply: false,
  lang: "en",
  likeCount: 18,
  media: [],
  quoteCount: 0,
  replyCount: 5,
  retweetCount: 2,
  text: `post ${id}`,
  url: `https://x.com/i/web/status/${id}`,
  viewCount: 3800,
  ...extra,
});

/** anyapi's account timeline row: shorter names and no author. */
const timelineRow = (id: string, extra: Record<string, unknown> = {}) => ({
  bookmarks: 0,
  createdUtc: CREATED,
  id,
  isPinned: null,
  isReply: false,
  lang: "en",
  likes: 2,
  media: [],
  quotes: 0,
  replies: 0,
  retweets: 0,
  text: `post ${id}`,
  url: `https://x.com/i/web/status/${id}`,
  views: 1597,
  ...extra,
});

/** X's own GraphQL row, as a fallback scraper passes it on. */
const graphqlRow = {
  rest_id: "77",
  core: { user_results: { result: { legacy: { screen_name: "grok", name: "Grok" } } } },
  legacy: { full_text: "hello from grok", favorite_count: 3, retweet_count: 1, reply_count: 0, quote_count: 0, created_at: "Thu Oct 08 00:12:34 +0000 2026" },
  views: { count: "99" },
};

/** A catalog call's verbatim body: the provider's own envelope. */
const anyapi = (data: Record<string, unknown>) => ({ output: { data }, provider: "AnyAPI", costUsd: 0.00075 });

type Reply = { status?: number; body: unknown } | Error;

function fakeFetch(...responses: Reply[]) {
  const calls: Array<{ url: URL; method: string; headers: Headers; body: unknown }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

/** The Admin's X relay (a Cloud home's OMB_CLOUD_X_URL, or a desktop's from its Cloud sign-in). */
const RELAY = "https://cloud.example.test/api/cloud/services/x";
const clientWith = (fetcher: typeof fetch) => createXRelayClient({ url: RELAY, token: "omb_xd_test", fetcher });

async function failure(promise: Promise<unknown>): Promise<XResearchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(XResearchError);
    return error as XResearchError;
  }
  throw new Error("expected the call to fail");
}

describe("parsePostRef", () => {
  it("reads a bare id, and an x.com or twitter.com link with its handle", () => {
    expect(parsePostRef("2107987482155561188")).toEqual({ id: "2107987482155561188" });
    expect(parsePostRef("https://x.com/pbteja1998/status/2107987482155561188/photo/1")).toEqual({ id: "2107987482155561188", handle: "pbteja1998" });
    expect(parsePostRef("https://twitter.com/maus/status/42")).toEqual({ id: "42", handle: "maus" });
    expect(parsePostRef("https://mobile.twitter.com/i/web/status/43")).toEqual({ id: "43" });
  });

  it("accepts a status link typed without https://", () => {
    expect(parsePostRef("x.com/maus/status/123")).toEqual({ id: "123", handle: "maus" });
    expect(parsePostRef("mobile.twitter.com/maus/status/124")).toEqual({ id: "124", handle: "maus" });
  });

  it("refuses anything that is not an X post", () => {
    expect(parsePostRef("https://example.com/maus/status/42")).toBeNull();
    expect(parsePostRef("https://x.com/maus")).toBeNull();
    expect(parsePostRef("forty two")).toBeNull();
  });
});

describe("normalizeHandle", () => {
  it("accepts @name, name and an x.com profile link", () => {
    expect(normalizeHandle("@maus")).toBe("maus");
    expect(normalizeHandle("  maus ")).toBe("maus");
    expect(normalizeHandle("https://x.com/maus")).toBe("maus");
    expect(normalizeHandle("https://twitter.com/maus/status/1")).toBe("maus");
  });

  it("accepts links typed without https://", () => {
    expect(normalizeHandle("x.com/maus")).toBe("maus");
    expect(normalizeHandle("www.x.com/maus")).toBe("maus");
    expect(normalizeHandle("twitter.com/maus/status/1")).toBe("maus");
  });

  it("refuses X's own pages, which are not accounts", () => {
    for (const raw of ["https://x.com/home", "https://x.com/i/lists/1", "https://x.com/search?q=maus", "x.com/explore", "https://x.com/settings", "i", "home"]) {
      expect(normalizeHandle(raw), raw).toBeNull();
    }
  });

  it("refuses non-X links and names X does not allow", () => {
    expect(normalizeHandle("https://example.com/maus")).toBeNull();
    expect(normalizeHandle("not a handle!")).toBeNull();
    expect(normalizeHandle("a".repeat(16))).toBeNull();
    expect(normalizeHandle("")).toBeNull();
  });
});

describe("toPost", () => {
  it("reads anyapi's search row", () => {
    expect(toPost(searchRow("7"))).toEqual({
      id: "7",
      url: "https://x.com/maus/status/7",
      author: "@maus",
      authorName: "Maus",
      createdAt: "2026-10-08T00:12:34.000Z",
      text: "post 7",
      likes: 18,
      reposts: 2,
      replies: 5,
      quotes: 0,
      views: 3800,
      isReply: false,
    });
  });

  it("reads anyapi's shorter timeline names, taking the author from the caller", () => {
    expect(toPost(timelineRow("8"), "maus")).toMatchObject({ id: "8", author: "@maus", likes: 2, reposts: 0, replies: 0, quotes: 0, views: 1597 });
  });

  it("reads anyapi's reply row", () => {
    const reply = { authorHandle: "demi", authorName: "Demi", createdUtc: CREATED, id: "9", likeCount: 52, repostCount: 1, replyCount: 0, quoteCount: 0, text: "@jack hi", viewCount: 9460 };
    expect(toPost(reply)).toMatchObject({ id: "9", author: "@demi", authorName: "Demi", likes: 52, reposts: 1, views: 9460 });
  });

  it("reads X's own GraphQL shape from a fallback scraper", () => {
    expect(toPost(graphqlRow)).toEqual({
      id: "77",
      url: "https://x.com/grok/status/77",
      author: "@grok",
      authorName: "Grok",
      createdAt: "2026-10-08T00:12:34.000Z",
      text: "hello from grok",
      likes: 3,
      reposts: 1,
      replies: 0,
      quotes: 0,
      views: 99,
    });
  });

  it("drops a row with no usable id, including one JSON already rounded", () => {
    expect(toPost({ text: "no id" })).toBeNull();
    expect(toPost({ id: "not-a-number", text: "x" })).toBeNull();
    // An id above 2^53 arrives already rounded when a scraper sends a number.
    expect(toPost({ id: Number("2107987482155561188"), text: "x" })).toBeNull();
    expect(toPost({ id: 42, text: "x" })?.id).toBe("42");
    expect(toPost("junk")).toBeNull();
  });

  it("links to the author's own post page whenever the author is known, so a bot never needs its browser to find it", () => {
    expect(toPost({ id: "21", authorUsername: "maus", url: "https://x.com/i/web/status/21", text: "t" })?.url).toBe("https://x.com/maus/status/21");
    expect(toPost(timelineRow("22"), "maus")?.url).toBe("https://x.com/maus/status/22");
    expect(toPost({ id: "23", url: "https://x.com/i/web/status/23", text: "t" })?.url).toBe("https://x.com/i/web/status/23");
  });

  it("builds a link and a placeholder author when the scraper leaves them out", () => {
    const post = toPost({ id: "8", text: "hi" });
    expect(JSON.parse(JSON.stringify(post))).toEqual({ id: "8", url: "https://x.com/i/status/8", author: "@unknown", text: "hi" });
  });

  it("cuts long text at a whole character, emoji included", () => {
    const post = toPost(searchRow("10", { text: `${"a".repeat(1_499)}😀😀` }));
    expect(post?.text).toBe(`${"a".repeat(1_499)}😀…`);
  });

  it("summarizes a quoted post in at most 300 characters", () => {
    const post = toPost(searchRow("11", { quotedTweet: searchRow("12", { authorUsername: "grok", text: "q".repeat(400) }) }));
    expect(post?.quoted).toEqual({ url: "https://x.com/grok/status/12", author: "@grok", text: `${"q".repeat(300)}…` });
  });
});

describe("search", () => {
  it("calls anyapi's search with the token, a cost ceiling and Latest, and returns compact posts", async () => {
    const { fetcher, calls } = fakeFetch({ body: anyapi({ items: [searchRow("12"), searchRow("11")], nextCursor: "" }) });
    const result = await clientWith(fetcher).search({ query: "mausbot", sort: "latest", limit: 20 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.href).toBe(`${RELAY}/call/anyapi.x.search.posts`);
    expect(calls[0]!.body).toEqual({ query: "mausbot", queryType: "Latest", limit: 20 });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer omb_xd_test");
    // Our treg key, the customer tag and the cost ceiling are the relay's to add; nothing of treg's is sent from here.
    expect(calls[0]!.headers.get("x-treg-token")).toBeNull();
    expect(calls[0]!.headers.get("x-treg-route-max-cost")).toBeNull();
    expect(result.posts.map((post) => post.id)).toEqual(["12", "11"]);
    expect(result.newestId).toBe("12");
    expect(result.more).toBe(false);
  });

  it("pages until the limit and reports that more exist", async () => {
    const page = (start: number) => anyapi({
      items: Array.from({ length: 20 }, (_, i) => searchRow(String(start - i))),
      nextCursor: `after-${start}`,
    });
    const { fetcher, calls } = fakeFetch({ body: page(1000) }, { body: page(980) }, { body: page(960) });
    const result = await clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 50 });
    expect(calls.map((call) => (call.body as { cursor?: string }).cursor)).toEqual([undefined, "after-1000", "after-980"]);
    expect(result.posts).toHaveLength(50);
    expect(result.newestId).toBe("1000");
    expect(result.more).toBe(true);
  });

  it("with sinceId, asks X for newer posts and stops at the first one already seen", async () => {
    const { fetcher, calls } = fakeFetch({ body: anyapi({ items: ["103", "102", "101", "100", "99"].map((id) => searchRow(id)), nextCursor: "c2" }) });
    const result = await clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20, sinceId: "100" });
    expect((calls[0]!.body as { query: string }).query).toBe("maus since_id:100");
    expect(result.posts.map((post) => post.id)).toEqual(["103", "102", "101"]);
    expect(result.more).toBe(false);
  });

  it("with top sort, asks for Top, and sinceId drops old posts but keeps reading past them", async () => {
    const { fetcher, calls } = fakeFetch({ body: anyapi({ items: ["105", "90", "104"].map((id) => searchRow(id)) }) });
    const result = await clientWith(fetcher).search({ query: "maus", sort: "top", limit: 20, sinceId: "100" });
    expect((calls[0]!.body as { queryType: string }).queryType).toBe("Top");
    expect(result.posts.map((post) => post.id)).toEqual(["105", "104"]);
    expect(result.newestId).toBe("105");
  });

  it("falls back once to treg's routed search when anyapi is down", async () => {
    const { fetcher, calls } = fakeFetch(
      { status: 503, body: { error: "provider_capacity_unavailable" } },
      { body: { output: { posts: [graphqlRow, searchRow("5")], next_cursor: "n2" }, raw: {}, _treg: { served_by: "tikhub.x.twitter-web-fetch-search-timeline" } } },
    );
    const result = await clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20 });
    expect(calls[1]!.url.href).toBe(`${RELAY}/call/treg.x.search.posts`);
    expect(calls[1]!.body).toEqual({ q: "maus" });
    expect(result.posts.map((post) => post.id)).toEqual(["77", "5"]);
    expect(result.more).toBe(true);
  });

  it("does not fall back on a rejected token or an empty balance", async () => {
    for (const status of [401, 402]) {
      const { fetcher, calls } = fakeFetch({ status, body: { detail: "no" } });
      await failure(clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20 }));
      expect(calls).toHaveLength(1);
    }
  });
});

describe("result size", () => {
  it("keeps a big answer under the agents result cap, newest id and more first", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => searchRow(String(1000 - i), { text: "x".repeat(900) }));
    const { fetcher } = fakeFetch({ body: anyapi({ items: rows, nextCursor: "" }) });
    const result = await clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 50 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(22_000);
    expect(Object.keys(result).slice(0, 2)).toEqual(["newestId", "more"]);
    expect(result.posts.length).toBeLessThan(50);
    expect(result.posts[0]!.id).toBe("1000");
    expect(result.newestId).toBe("1000");
    expect(result.more).toBe(true);
  });

  it("trims a post's replies the same way", async () => {
    const replies = Array.from({ length: 20 }, (_, i) => ({ authorHandle: "r", id: String(500 + i), text: "y".repeat(1_400) }));
    const { fetcher } = fakeFetch(
      { body: { output: { found: true, data: { id: "42", text: "hello" } } } },
      { body: anyapi({ items: replies, nextCursor: "" }) },
    );
    const result = await clientWith(fetcher).post({ id: "42", replies: true });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(22_000);
    expect(result.replies!.length).toBeLessThan(20);
    expect(result.moreReplies).toBe(true);
  });
});

describe("userPosts", () => {
  it("reads an account's posts, naming the author, without its replies by default", async () => {
    const { fetcher, calls } = fakeFetch({ body: anyapi({ tweets: [timelineRow("3"), timelineRow("2", { isReply: true })], nextCursor: "" }) });
    const result = await clientWith(fetcher).userPosts({ handle: "maus", limit: 20, includeReplies: false });
    expect(calls[0]!.url.href).toBe(`${RELAY}/call/anyapi.x.user.posts`);
    expect(calls[0]!.body).toEqual({ handle: "maus", limit: 20 });
    expect(result.posts.map((post) => [post.id, post.author])).toEqual([["3", "@maus"]]);
  });

  it("keeps replies when asked", async () => {
    const { fetcher } = fakeFetch({ body: anyapi({ tweets: [timelineRow("3"), timelineRow("2", { isReply: true })] }) });
    const result = await clientWith(fetcher).userPosts({ handle: "maus", limit: 20, includeReplies: true });
    expect(result.posts.map((post) => post.id)).toEqual(["3", "2"]);
  });

  it("skips an old pinned post instead of stopping at it", async () => {
    const rows = [timelineRow("50", { isPinned: true }), timelineRow("120"), timelineRow("110"), timelineRow("100"), timelineRow("90")];
    const { fetcher } = fakeFetch({ body: anyapi({ tweets: rows, nextCursor: "more" }) });
    const result = await clientWith(fetcher).userPosts({ handle: "maus", limit: 20, sinceId: "100", includeReplies: false });
    expect(result.posts.map((post) => post.id)).toEqual(["120", "110"]);
    expect(result.more).toBe(false);
  });

  it("keeps reading past one old post a scraper lists out of order, such as a retweet under its original id", async () => {
    const rows = [timelineRow("120"), timelineRow("60"), timelineRow("110"), timelineRow("100"), timelineRow("90")];
    const { fetcher } = fakeFetch({ body: anyapi({ tweets: rows, nextCursor: "more" }) });
    const result = await clientWith(fetcher).userPosts({ handle: "maus", limit: 20, sinceId: "100", includeReplies: false });
    expect(result.posts.map((post) => post.id)).toEqual(["120", "110"]);
    expect(result.more).toBe(false);
  });

  it("falls back to treg's routed account posts", async () => {
    const { fetcher, calls } = fakeFetch(
      { status: 502, body: { error: "upstream" } },
      { body: { output: { posts: [timelineRow("4")] }, raw: {}, _treg: { served_by: "tikhub.x.user.posts" } } },
    );
    const result = await clientWith(fetcher).userPosts({ handle: "maus", limit: 20, includeReplies: false });
    expect(calls[1]!.url.href).toBe(`${RELAY}/call/treg.x.user.posts`);
    expect(calls[1]!.body).toEqual({ username: "maus" });
    expect(result.posts.map((post) => [post.id, post.author])).toEqual([["4", "@maus"]]);
  });
});

describe("post", () => {
  const tweet = { authorId: "34743251", bookmarks: 1, createdUtc: CREATED, id: "42", likes: 9, media: [], quotes: 1, replies: 2, retweets: 3, text: "hello", views: 500 };

  it("returns one post, and its first page of replies when asked", async () => {
    const { fetcher, calls } = fakeFetch(
      { body: { output: { found: true, data: tweet }, provider: "AnyAPI" } },
      { body: { output: { found: true, data: { items: [{ authorHandle: "a", id: "43", text: "r1" }, { authorHandle: "b", id: "44", text: "r2" }], nextCursor: "r2" } } } },
    );
    const result = await clientWith(fetcher).post({ id: "42", handle: "maus", replies: true });
    expect(calls[0]!.url.href).toBe(`${RELAY}/call/anyapi.twitter.tweet`);
    expect(calls[0]!.body).toEqual({ url: "https://x.com/maus/status/42" });
    expect(calls[1]!.url.href).toBe(`${RELAY}/call/anyapi.x.post.comments`);
    expect(calls[1]!.body).toEqual({ url: "https://x.com/maus/status/42", limit: 20 });
    expect(result.post).toMatchObject({ id: "42", author: "@maus", likes: 9, reposts: 3, replies: 2, quotes: 1, views: 500 });
    expect(result.replies?.map((post) => post.author)).toEqual(["@a", "@b"]);
    expect(result.moreReplies).toBe(true);
  });

  it("makes one request when replies are not asked for, by a canonical link when the handle is unknown", async () => {
    const { fetcher, calls } = fakeFetch({ body: { output: { found: true, data: tweet } } });
    const result = await clientWith(fetcher).post({ id: "42", replies: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ url: "https://x.com/i/web/status/42" });
    expect(result).toEqual({ post: toPost(tweet) });
  });

  it("says plainly when the post is gone", async () => {
    const { fetcher } = fakeFetch({ body: { output: { found: false } } });
    const error = await failure(clientWith(fetcher).post({ id: "42", replies: false }));
    expect(error.code).toBe("not_found");
    expect(error.message).toBe(X_MESSAGES.postNotFound);
  });
});

describe("profile", () => {
  it("maps treg's normalized profile", async () => {
    const { fetcher, calls } = fakeFetch({ body: { output: {
      username: "maus", user_id: "1", name: "Maus", followers: 1200, following: 80, posts_count: 340, is_verified: true, description: "Open source Grok Bot",
    }, raw: {}, _treg: { served_by: "anyapi.x.user.profile" } } });
    expect(await clientWith(fetcher).profile("maus")).toEqual({
      handle: "@maus", name: "Maus", bio: "Open source Grok Bot", followers: 1200, following: 80, posts: 340, verified: true, url: "https://x.com/maus",
    });
    expect(calls[0]!.url.href).toBe(`${RELAY}/call/treg.x.user.profile`);
    expect(calls[0]!.body).toEqual({ username: "maus" });
  });

  it("names the missing account when every scraper misses", async () => {
    const { fetcher } = fakeFetch({ body: { output: { username: null }, raw: {}, _treg: { served_by: null } } });
    const error = await failure(clientWith(fetcher).profile("ghost"));
    expect(error.code).toBe("not_found");
    expect(error.message).toBe(X_MESSAGES.accountNotFound("ghost"));
  });
});

describe("errors", () => {
  it("maps HTTP statuses to plain sentences", () => {
    // What the Admin's relay answers (openmaus-cloud server/cloud-services.ts).
    expect(errorFor(401, { error: "invalid_api_key" })).toMatchObject({ code: "bad_key", message: X_MESSAGES.badKey });
    expect(errorFor(402, { error: "subscription_inactive" })).toMatchObject({ code: "no_credit", message: X_MESSAGES.noPlan });
    expect(errorFor(422, { error: "invalid_request" }).code).toBe("bad_input");
    expect(errorFor(429, {}).code).toBe("rate_limited");
    for (const status of [404, 500, 502, 503]) expect(errorFor(status, {}).code).toBe("unavailable");
    expect(errorFor(503, { error: "service_unavailable" }).message).toBe(X_MESSAGES.unavailable);
  });

  it("treats a network failure, a timeout, junk and an oversized body as unavailable", async () => {
    for (const response of [
      new Error("socket hang up"),
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      { body: "<html>oops</html>" },
      { body: JSON.stringify({ output: { found: true, data: { id: "1", text: "x".repeat(2_100_000) } } }) },
    ]) {
      const { fetcher } = fakeFetch(response);
      const error = await failure(clientWith(fetcher).post({ id: "1", replies: false }));
      expect(error.code).toBe("unavailable");
    }
  });

  it("asks for a new Cloud sign-in when the relay refuses the token, and does not fall back", async () => {
    const { fetcher, calls } = fakeFetch({ status: 401, body: { error: "invalid_api_key", message: "This X research token is not valid." } });
    const error = await failure(clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20 }));
    expect(error).toMatchObject({ code: "bad_key", message: X_MESSAGES.badKey });
    expect(calls).toHaveLength(1);
  });

  it("does not fall back while the relay says treg is rate-limiting: a second call would only count against the plan too", async () => {
    const { fetcher, calls } = fakeFetch({ status: 503, body: { error: "overloaded", message: "X research is busy right now. Try again in a moment." } });
    const error = await failure(clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20 }));
    expect(error).toMatchObject({ code: "rate_limited", message: X_MESSAGES.rateLimited });
    expect(calls).toHaveLength(1);
  });

  it("waits longer than the relay's own 30 s, so the relay's answer arrives before this side gives up and falls back", () => {
    expect(X_CLIENT_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  it("passes on the relay's own sentence when this month's allowance is used up", async () => {
    const sentence = "Your Pro plan's 5,000 X research calls for October are used up. They reset on 1 November.";
    const { fetcher, calls } = fakeFetch({ status: 429, body: { error: "quota_exceeded", message: sentence } });
    const error = await failure(clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20 }));
    expect(error).toMatchObject({ code: "rate_limited", message: sentence });
    expect(calls).toHaveLength(1);
  });
});
