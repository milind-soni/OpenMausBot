# X Research Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bots the user switches on can search, read and monitor X through four read-only `x_*` tools, paid from the user's own twitterapi.io key.

**Architecture:** A small scraper client (`server/x-research.ts`) maps twitterapi.io responses to compact posts and plain-language errors. Internal routes (`server/routes/x-research.ts`) re-check the key and the bot's switch on every call. The four tools live in the existing `agents` tool server, so every engine gets them. The key is stored like the xAI key. The per-bot switch is a `xResearch` boolean edited in Bot settings → Access.

**Tech Stack:** TypeScript on Node (type stripping, so type-only imports must be `import type`), zod 4, vitest 4, React.

**Spec:** `docs/superpowers/specs/2026-10-08-x-research-tools-design.md`

**Worktree:** `/Users/omkar/Desktop/openmaus/OpenGrokBot-x-research`, branch `feat/x-research-tools`. Run every command from there. Never push.

## Global Constraints

- Tools are read-only. No posting, liking, replying, following or DMs.
- A tool is shown and served only when a key is saved **and** `bot.xResearch === true`. An absent field means off.
- The route re-checks key and switch on every call. Never trust the catalog alone.
- The key never reaches an engine environment, a prompt, the renderer or a response body.
- Config section `twitterapi`, field `key`, env `OMB_TWITTERAPI_KEY`, Electron credential name `twitterapiKey`.
- Base URL `https://api.twitterapi.io`, auth header `X-API-Key`, 15 s timeout, `redirect: "error"`, 2 MiB body cap.
- `limit` is 1–50 and defaults to 20. Post `text` is cut at 1,500 code points and `quoted.text` at 300, each with `…`.
- `sinceId` must match `^\d{1,25}$`.
- Route statuses: `bad_input` 400, `not_found` 404, other scraper failures 502, a missing key or a switched-off bot 403. Never 401.
- Error sentences come only from `X_MESSAGES` in `server/x-research.ts` (see Task 1).
- No new `path ===` guard in `server/index.ts`: `scripts/testing/index-route-ratchet.test.ts` pins the count.
- Phones change nothing. Phone tokens already cannot patch `xResearch` (`CLIENT_BOT_PATCH_FIELDS`).

## Review Focus

1. An emoji or other surrogate pair right at the 1,500-character cut must not be split into a broken character. Task 1 pins this.
2. A handle given as `@name`, `name`, or an `x.com/name` link must all work, and a non-X link must be refused. Task 1 pins this.
3. `sinceId` with `sort: "top"` must filter out old posts but must not stop at the first old one, because top results are not newest-first. Task 1 pins this.
4. A key cleared mid-session must refuse the very next call, even though the bot's tool list was built earlier. The route reads the key per call; Task 4 pins this.
5. twitterapi.io answering HTTP 200 with `{"status":"error","msg":"…credits…"}` must give the no-credit message, not a generic failure. Task 1 pins this.

---

### Task 1: Scraper client

**Files:**
- Create: `server/x-research.ts`
- Test: `server/x-research.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (exact names used by Tasks 4 and 6):
  - `TWITTERAPI_BASE_URL`, `MAX_POSTS = 50`, `DEFAULT_POSTS = 20`, `CREDITS_PER_DOLLAR = 100_000`
  - `type XResearchErrorCode = "bad_input" | "bad_key" | "no_credit" | "rate_limited" | "not_found" | "unavailable"`
  - `class XResearchError extends Error { code: XResearchErrorCode }`
  - `X_MESSAGES` (see code)
  - `interface XPost`, `XPostList`, `XPostWithReplies`, `XProfile`, `XResearchClient`
  - `createTwitterApiClient(options: { key: string; fetcher?: typeof fetch; baseUrl?: string; timeoutMs?: number }): XResearchClient`
  - `normalizeHandle(raw: string): string | null`, `parsePostRef(raw: string): string | null`, `toPost(raw)`, `errorFor(status, body)`

- [ ] **Step 1: Write the failing test**

Create `server/x-research.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createTwitterApiClient, errorFor, normalizeHandle, parsePostRef, toPost, X_MESSAGES, XResearchError } from "./x-research.ts";

const tweet = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "tweet",
  id,
  url: `https://x.com/maus/status/${id}`,
  text: `post ${id}`,
  createdAt: "Thu Oct 08 00:12:34 +0000 2026",
  likeCount: 18,
  retweetCount: 2,
  replyCount: 5,
  quoteCount: 0,
  viewCount: 3800,
  isReply: false,
  author: { type: "user", userName: "maus", name: "Maus" },
  ...extra,
});

function fakeFetch(...responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

const clientWith = (fetcher: typeof fetch) => createTwitterApiClient({ key: "test-key", fetcher });

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
  it("reads a bare id and x.com or twitter.com status links", () => {
    expect(parsePostRef("2107987482155561188")).toBe("2107987482155561188");
    expect(parsePostRef("https://x.com/pbteja1998/status/2107987482155561188/photo/1")).toBe("2107987482155561188");
    expect(parsePostRef("https://twitter.com/maus/status/42")).toBe("42");
    expect(parsePostRef("https://mobile.twitter.com/i/web/status/43")).toBe("43");
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

  it("refuses non-X links and names X does not allow", () => {
    expect(normalizeHandle("https://example.com/maus")).toBeNull();
    expect(normalizeHandle("not a handle!")).toBeNull();
    expect(normalizeHandle("a".repeat(16))).toBeNull();
    expect(normalizeHandle("")).toBeNull();
  });
});

describe("toPost", () => {
  it("keeps the fields a person reads, with an ISO time", () => {
    expect(toPost(tweet("7"))).toEqual({
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

  it("builds a link and a placeholder author when the scraper leaves them out", () => {
    const post = toPost({ id: "8", text: "hi" });
    expect(post.url).toBe("https://x.com/i/status/8");
    expect(post.author).toBe("@unknown");
    expect(JSON.parse(JSON.stringify(post))).toEqual({ id: "8", url: "https://x.com/i/status/8", author: "@unknown", text: "hi" });
  });

  it("cuts long text at a whole character, emoji included", () => {
    const text = `${"a".repeat(1_499)}😀😀`;
    const post = toPost(tweet("9", { text }));
    expect(post.text).toBe(`${"a".repeat(1_499)}😀…`);
  });

  it("summarizes a quoted post in at most 300 characters", () => {
    const post = toPost(tweet("10", { quoted_tweet: { id: "11", text: "q".repeat(400), author: { userName: "grok" } } }));
    expect(post.quoted).toEqual({ url: "https://x.com/grok/status/11", author: "@grok", text: `${"q".repeat(300)}…` });
  });
});

describe("search", () => {
  it("sends the key, the query and Latest, and returns compact posts", async () => {
    const { fetcher, calls } = fakeFetch({ body: { tweets: [tweet("12"), tweet("11")], has_next_page: false, next_cursor: "" } });
    const result = await clientWith(fetcher).search({ query: "mausbot", sort: "latest", limit: 20 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe("/twitter/tweet/advanced_search");
    expect(calls[0]!.url.searchParams.get("query")).toBe("mausbot");
    expect(calls[0]!.url.searchParams.get("queryType")).toBe("Latest");
    expect(calls[0]!.url.searchParams.get("cursor")).toBe("");
    expect(new Headers(calls[0]!.init.headers).get("x-api-key")).toBe("test-key");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(result.posts.map((post) => post.id)).toEqual(["12", "11"]);
    expect(result.newestId).toBe("12");
    expect(result.more).toBe(false);
  });

  it("pages until the limit and reports that more exist", async () => {
    const page = (start: number) => ({
      tweets: Array.from({ length: 20 }, (_, i) => tweet(String(start - i))),
      has_next_page: true,
      next_cursor: `after-${start}`,
    });
    const { fetcher, calls } = fakeFetch({ body: page(1000) }, { body: page(980) }, { body: page(960) });
    const result = await clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 50 });
    expect(calls.map((call) => call.url.searchParams.get("cursor"))).toEqual(["", "after-1000", "after-980"]);
    expect(result.posts).toHaveLength(50);
    expect(result.newestId).toBe("1000");
    expect(result.more).toBe(true);
  });

  it("with sinceId, asks X for newer posts and stops at the first one already seen", async () => {
    const { fetcher, calls } = fakeFetch({
      body: { tweets: ["103", "102", "101", "100", "99"].map((id) => tweet(id)), has_next_page: true, next_cursor: "c2" },
    });
    const result = await clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20, sinceId: "100" });
    expect(calls[0]!.url.searchParams.get("query")).toBe("maus since_id:100");
    expect(result.posts.map((post) => post.id)).toEqual(["103", "102", "101"]);
    expect(result.more).toBe(false);
  });

  it("with sinceId and top sort, drops old posts but keeps reading past them", async () => {
    const { fetcher } = fakeFetch({ body: { tweets: ["105", "90", "104"].map((id) => tweet(id)), has_next_page: false, next_cursor: "" } });
    const result = await clientWith(fetcher).search({ query: "maus", sort: "top", limit: 20, sinceId: "100" });
    expect(result.posts.map((post) => post.id)).toEqual(["105", "104"]);
    expect(result.newestId).toBe("105");
  });

  it("skips a malformed post instead of failing the call", async () => {
    const { fetcher } = fakeFetch({ body: { tweets: [tweet("5"), { id: "not-a-number" }, "junk"], has_next_page: false } });
    const result = await clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20 });
    expect(result.posts.map((post) => post.id)).toEqual(["5"]);
  });
});

describe("userPosts", () => {
  it("reads an account's posts with replies off by default", async () => {
    const { fetcher, calls } = fakeFetch({ body: { tweets: [tweet("3")], has_next_page: false, status: "success" } });
    const result = await clientWith(fetcher).userPosts({ handle: "maus", limit: 20, includeReplies: false });
    expect(calls[0]!.url.pathname).toBe("/twitter/user/last_tweets");
    expect(calls[0]!.url.searchParams.get("userName")).toBe("maus");
    expect(calls[0]!.url.searchParams.get("includeReplies")).toBe("false");
    expect(result.posts.map((post) => post.id)).toEqual(["3"]);
  });

  it("names the missing account", async () => {
    const { fetcher } = fakeFetch({ status: 404, body: { status: "error", msg: "User not found" } });
    const error = await failure(clientWith(fetcher).userPosts({ handle: "ghost", limit: 20, includeReplies: false }));
    expect(error.code).toBe("not_found");
    expect(error.message).toBe(X_MESSAGES.accountNotFound("ghost"));
  });
});

describe("post", () => {
  it("returns one post, and its first page of replies when asked", async () => {
    const { fetcher, calls } = fakeFetch(
      { body: { tweets: [tweet("42")], status: "success" } },
      { body: { replies: [tweet("43"), tweet("44")], has_next_page: true, next_cursor: "r2", status: "success" } },
    );
    const result = await clientWith(fetcher).post({ id: "42", replies: true });
    expect(calls[0]!.url.pathname).toBe("/twitter/tweets");
    expect(calls[0]!.url.searchParams.get("tweet_ids")).toBe("42");
    expect(calls[1]!.url.pathname).toBe("/twitter/tweet/replies");
    expect(calls[1]!.url.searchParams.get("tweetId")).toBe("42");
    expect(result.post.id).toBe("42");
    expect(result.replies?.map((post) => post.id)).toEqual(["43", "44"]);
    expect(result.moreReplies).toBe(true);
  });

  it("makes one request when replies are not asked for", async () => {
    const { fetcher, calls } = fakeFetch({ body: { tweets: [tweet("42")] } });
    const result = await clientWith(fetcher).post({ id: "42", replies: false });
    expect(calls).toHaveLength(1);
    expect(result).toEqual({ post: toPost(tweet("42")) });
  });

  it("says plainly when the post is gone", async () => {
    const { fetcher } = fakeFetch({ body: { tweets: [], status: "success" } });
    const error = await failure(clientWith(fetcher).post({ id: "42", replies: false }));
    expect(error.code).toBe("not_found");
    expect(error.message).toBe(X_MESSAGES.postNotFound);
  });
});

describe("profile", () => {
  it("maps the profile fields", async () => {
    const { fetcher, calls } = fakeFetch({ body: { status: "success", data: {
      userName: "maus", name: "Maus", description: "Open source Grok Bot", location: "Baramati", url: "https://mausbot.com",
      followers: 1200, following: 80, statusesCount: 340, isBlueVerified: true, createdAt: "Mon Jan 01 00:00:00 +0000 2024",
    } } });
    expect(await clientWith(fetcher).profile("maus")).toEqual({
      handle: "@maus", name: "Maus", bio: "Open source Grok Bot", location: "Baramati", website: "https://mausbot.com",
      followers: 1200, following: 80, posts: 340, verified: true, createdAt: "2024-01-01T00:00:00.000Z", url: "https://x.com/maus",
    });
    expect(calls[0]!.url.pathname).toBe("/twitter/user/info");
    expect(calls[0]!.url.searchParams.get("userName")).toBe("maus");
  });

  it("treats an unavailable account as not found", async () => {
    const { fetcher } = fakeFetch({ body: { status: "success", data: { userName: "gone", unavailable: true } } });
    const error = await failure(clientWith(fetcher).profile("gone"));
    expect(error.message).toBe(X_MESSAGES.accountNotFound("gone"));
  });
});

describe("accountInfo", () => {
  it("returns the remaining credits", async () => {
    const { fetcher, calls } = fakeFetch({ body: { recharge_credits: 420_000 } });
    expect(await clientWith(fetcher).accountInfo()).toEqual({ credits: 420_000 });
    expect(calls[0]!.url.pathname).toBe("/oapi/my/info");
  });
});

describe("errors", () => {
  it("maps HTTP statuses to plain sentences", () => {
    expect(errorFor(401, {}).code).toBe("bad_key");
    expect(errorFor(403, {}).code).toBe("bad_key");
    expect(errorFor(402, {}).code).toBe("no_credit");
    expect(errorFor(429, {}).code).toBe("rate_limited");
    expect(errorFor(404, {}).code).toBe("not_found");
    expect(errorFor(500, {}).code).toBe("unavailable");
    expect(errorFor(500, {}).message).toBe(X_MESSAGES.unavailable);
  });

  it("reads the scraper's own words on an HTTP 200 error body", async () => {
    const { fetcher } = fakeFetch({ body: { status: "error", msg: "Insufficient credits, please recharge" } });
    const error = await failure(clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20 }));
    expect(error.code).toBe("no_credit");
    expect(error.message).toBe(X_MESSAGES.noCredit);
  });

  it("treats a network failure, a timeout, junk and an oversized body as unavailable", async () => {
    for (const response of [
      new Error("socket hang up"),
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      { body: "<html>oops</html>" },
      { body: JSON.stringify({ tweets: [], pad: "x".repeat(2_100_000) }) },
    ]) {
      const { fetcher } = fakeFetch(response);
      const error = await failure(clientWith(fetcher).search({ query: "maus", sort: "latest", limit: 20 }));
      expect(error.code).toBe("unavailable");
    }
  });

  it("names a rejected key", async () => {
    const { fetcher } = fakeFetch({ status: 401, body: { error: 401, message: "Unauthorized" } });
    const error = await failure(clientWith(fetcher).accountInfo());
    expect(error.code).toBe("bad_key");
    expect(error.message).toBe(X_MESSAGES.badKey);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run server/x-research.test.ts`
Expected: FAIL, because `./x-research.ts` cannot be found.

- [ ] **Step 3: Write the implementation**

Create `server/x-research.ts`:

```ts
// X research: the x_* agents tools' only way out. A thin client over
// twitterapi.io, a third-party X scraper the user pays per result with their
// own key. It hands back compact posts and profiles, never the vendor's raw
// JSON, and turns every failure into an XResearchError carrying a sentence a
// bot can pass on. A managed relay (step 2) replaces this module only.
import { z } from "zod";

export const TWITTERAPI_BASE_URL = "https://api.twitterapi.io";
/** Posts one call may return: three scraper pages of up to 20. Fifty compact
 * posts also stay under the agents server's result cap. */
export const MAX_POSTS = 50;
export const DEFAULT_POSTS = 20;
/** twitterapi.io prices 15 credits at $0.00015. */
export const CREDITS_PER_DOLLAR = 100_000;
const PAGE_SIZE = 20;
const TEXT_LIMIT = 1_500;
const QUOTE_LIMIT = 300;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export type XResearchErrorCode = "bad_input" | "bad_key" | "no_credit" | "rate_limited" | "not_found" | "unavailable";

/** Every sentence a bot or the Settings page can be shown about X research. */
export const X_MESSAGES = {
  noKey: "X research isn't set up. Add a twitterapi.io key in Settings → API keys.",
  botOff: "X research is off for this bot. Turn it on in this bot's settings under Access.",
  badKey: "twitterapi.io rejected the API key. Check it in Settings → API keys.",
  noCredit: "The twitterapi.io balance has run out. Top up at twitterapi.io, then try again.",
  rateLimited: "twitterapi.io is rate-limiting requests. Wait a minute and try again.",
  unavailable: "twitterapi.io didn't answer properly. Try again shortly.",
  postNotFound: "That X post was not found. It may be deleted or private.",
  accountNotFound: (handle: string) => `No X account named @${handle}.`,
} as const;

export class XResearchError extends Error {
  readonly code: XResearchErrorCode;
  constructor(code: XResearchErrorCode, message: string) {
    super(message);
    this.name = "XResearchError";
    this.code = code;
  }
}

export interface XQuoted { url: string; author: string; text: string }
export interface XPost {
  id: string;
  url: string;
  author: string;
  authorName?: string;
  createdAt?: string;
  text: string;
  likes?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  views?: number;
  isReply?: boolean;
  quoted?: XQuoted;
}
export interface XPostList { posts: XPost[]; newestId?: string; more: boolean }
export interface XPostWithReplies { post: XPost; replies?: XPost[]; moreReplies?: boolean }
export interface XProfile {
  handle: string;
  name?: string;
  bio?: string;
  location?: string;
  website?: string;
  followers?: number;
  following?: number;
  posts?: number;
  verified?: boolean;
  createdAt?: string;
  url: string;
}

export interface XResearchClient {
  search(input: { query: string; sort: "latest" | "top"; limit: number; sinceId?: string }): Promise<XPostList>;
  userPosts(input: { handle: string; limit: number; sinceId?: string; includeReplies: boolean }): Promise<XPostList>;
  post(input: { id: string; replies: boolean }): Promise<XPostWithReplies>;
  profile(handle: string): Promise<XProfile>;
  accountInfo(): Promise<{ credits: number }>;
}

const POST_ID = /^\d{1,25}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);

// Lenient on purpose: the scraper adds and drops fields, and one odd post
// must cost that post, not the whole answer.
const count = z.number().nullish();
const words = z.string().nullish();
const rawAuthor = z.object({
  userName: words,
  name: words,
  description: words,
  location: words,
  url: words,
  followers: count,
  following: count,
  statusesCount: count,
  isBlueVerified: z.boolean().nullish(),
  createdAt: words,
  unavailable: z.boolean().nullish(),
});
const rawQuoted = z.object({ id: z.string().regex(POST_ID), url: words, text: words, author: rawAuthor.nullish() });
const rawTweet = z.object({
  id: z.string().regex(POST_ID),
  url: words,
  text: words,
  createdAt: words,
  likeCount: count,
  retweetCount: count,
  replyCount: count,
  quoteCount: count,
  viewCount: count,
  isReply: z.boolean().nullish(),
  author: rawAuthor.nullish(),
  quoted_tweet: rawQuoted.nullish(),
});
type RawAuthor = z.infer<typeof rawAuthor>;
type RawTweet = z.infer<typeof rawTweet>;

/** "@maus", "maus" or an x.com profile link → "maus"; anything else → null. */
export function normalizeHandle(raw: string): string | null {
  let value = raw.trim();
  try {
    const url = new URL(value);
    if (!X_HOSTS.has(url.hostname)) return null;
    value = url.pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    // Not a link: a handle.
  }
  value = value.replace(/^@/, "");
  return HANDLE.test(value) ? value : null;
}

/** A post id from a bare id or an x.com / twitter.com status link. */
export function parsePostRef(raw: string): string | null {
  const value = raw.trim();
  if (POST_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!X_HOSTS.has(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("status");
  const id = at >= 0 ? parts[at + 1] : undefined;
  return id && POST_ID.test(id) ? id : null;
}

/** Cut at a code point, so an emoji is never split in half. */
function clip(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join("")}…`;
}

function isoTime(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

function num(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function postUrl(id: string, handle: string | undefined, given: string | null | undefined): string {
  return given || (handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`);
}

/** Undefined fields are dropped by JSON.stringify, so a field the scraper
 * left out never reaches the bot as a made-up zero. */
export function toPost(raw: RawTweet): XPost {
  const handle = raw.author?.userName || undefined;
  const quoted = raw.quoted_tweet;
  const quotedHandle = quoted?.author?.userName || undefined;
  return {
    id: raw.id,
    url: postUrl(raw.id, handle, raw.url),
    author: handle ? `@${handle}` : "@unknown",
    authorName: raw.author?.name || undefined,
    createdAt: isoTime(raw.createdAt),
    text: clip(raw.text ?? "", TEXT_LIMIT),
    likes: num(raw.likeCount),
    reposts: num(raw.retweetCount),
    replies: num(raw.replyCount),
    quotes: num(raw.quoteCount),
    views: num(raw.viewCount),
    isReply: raw.isReply ?? undefined,
    quoted: quoted
      ? { url: postUrl(quoted.id, quotedHandle, quoted.url), author: quotedHandle ? `@${quotedHandle}` : "@unknown", text: clip(quoted.text ?? "", QUOTE_LIMIT) }
      : undefined,
  };
}

function toProfile(raw: RawAuthor & { userName: string }): XProfile {
  return {
    handle: `@${raw.userName}`,
    name: raw.name || undefined,
    bio: raw.description || undefined,
    location: raw.location || undefined,
    website: raw.url || undefined,
    followers: num(raw.followers),
    following: num(raw.following),
    posts: num(raw.statusesCount),
    verified: raw.isBlueVerified ?? undefined,
    createdAt: isoTime(raw.createdAt),
    url: `https://x.com/${raw.userName}`,
  };
}

function tweetsFrom(list: unknown): RawTweet[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const parsed = rawTweet.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function newestOf(posts: XPost[]): string | undefined {
  let newest: bigint | undefined;
  for (const post of posts) {
    const id = BigInt(post.id);
    if (newest === undefined || id > newest) newest = id;
  }
  return newest?.toString();
}

function vendorWords(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  for (const key of ["msg", "message", "error"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

/** An HTTP status, or the scraper's own words on a 200 error body, as one of
 * the sentences in X_MESSAGES. */
export function errorFor(status: number, body: unknown): XResearchError {
  const said = vendorWords(body);
  if (status === 401 || status === 403 || /api[ -]?key|unauthori[sz]ed|invalid key/i.test(said)) return new XResearchError("bad_key", X_MESSAGES.badKey);
  if (status === 402 || /credit|balance|insufficient|recharge/i.test(said)) return new XResearchError("no_credit", X_MESSAGES.noCredit);
  if (status === 429 || /rate.?limit|too many/i.test(said)) return new XResearchError("rate_limited", X_MESSAGES.rateLimited);
  if (status === 404 || /not found|does not exist|no such|suspended/i.test(said)) return new XResearchError("not_found", X_MESSAGES.postNotFound);
  return new XResearchError("unavailable", X_MESSAGES.unavailable);
}

const unavailable = () => new XResearchError("unavailable", X_MESSAGES.unavailable);

/** Read the body in chunks and give up the moment it crosses the cap. */
async function readCapped(response: Response): Promise<string> {
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (announced > MAX_BODY_BYTES) throw unavailable();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw unavailable();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** An account-level not-found names the account, not "that post". */
function accountMissing(error: unknown, handle: string): unknown {
  return error instanceof XResearchError && error.code === "not_found"
    ? new XResearchError("not_found", X_MESSAGES.accountNotFound(handle))
    : error;
}

export function createTwitterApiClient(options: { key: string; fetcher?: typeof fetch; baseUrl?: string; timeoutMs?: number }): XResearchClient {
  const fetcher = options.fetcher ?? fetch;
  const base = options.baseUrl ?? TWITTERAPI_BASE_URL;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  async function get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    let raw: string;
    let status: number;
    let ok: boolean;
    try {
      const response = await fetcher(url, {
        headers: { "X-API-Key": options.key, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      ok = response.ok;
      raw = await readCapped(response);
    } catch (error) {
      if (error instanceof XResearchError) throw error;
      throw unavailable();
    }
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (!ok) throw errorFor(status, body);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw unavailable();
    const record = body as Record<string, unknown>;
    if (record.status === "error") throw errorFor(status, record);
    return record;
  }

  /** Newest-first lists stop at the first post already seen; top results are
   * not in id order, so there an old post is skipped and reading goes on. */
  async function collect(path: string, params: Record<string, string>, limit: number, sinceId: string | undefined, newestFirst: boolean): Promise<XPostList> {
    const since = sinceId === undefined ? undefined : BigInt(sinceId);
    const posts: XPost[] = [];
    let cursor = "";
    let more = false;
    const maxPages = Math.ceil(limit / PAGE_SIZE) + 1;
    for (let page = 0; page < maxPages; page++) {
      const body = await get(path, { ...params, cursor });
      let reachedSeen = false;
      for (const tweet of tweetsFrom(body.tweets)) {
        if (since !== undefined && BigInt(tweet.id) <= since) {
          if (newestFirst) {
            reachedSeen = true;
            break;
          }
          continue;
        }
        posts.push(toPost(tweet));
      }
      const next = typeof body.next_cursor === "string" ? body.next_cursor : "";
      const hasNext = body.has_next_page === true && next !== "";
      if (reachedSeen || !hasNext) {
        more = false;
        break;
      }
      more = true;
      if (posts.length >= limit) break;
      cursor = next;
    }
    if (posts.length > limit) {
      posts.length = limit;
      more = true;
    }
    return { posts, newestId: newestOf(posts), more };
  }

  return {
    search({ query, sort, limit, sinceId }) {
      const q = sinceId === undefined ? query : `${query} since_id:${sinceId}`;
      return collect("/twitter/tweet/advanced_search", { query: q, queryType: sort === "top" ? "Top" : "Latest" }, limit, sinceId, sort === "latest");
    },
    async userPosts({ handle, limit, sinceId, includeReplies }) {
      try {
        return await collect("/twitter/user/last_tweets", { userName: handle, includeReplies: String(includeReplies) }, limit, sinceId, true);
      } catch (error) {
        throw accountMissing(error, handle);
      }
    },
    async post({ id, replies }) {
      const body = await get("/twitter/tweets", { tweet_ids: id });
      const [first] = tweetsFrom(body.tweets);
      if (!first) throw new XResearchError("not_found", X_MESSAGES.postNotFound);
      if (!replies) return { post: toPost(first) };
      const page = await get("/twitter/tweet/replies", { tweetId: id, cursor: "" });
      const next = typeof page.next_cursor === "string" ? page.next_cursor : "";
      return { post: toPost(first), replies: tweetsFrom(page.replies).map(toPost), moreReplies: page.has_next_page === true && next !== "" };
    },
    async profile(handle) {
      try {
        const body = await get("/twitter/user/info", { userName: handle });
        const parsed = rawAuthor.safeParse(body.data);
        if (!parsed.success || !parsed.data.userName || parsed.data.unavailable) {
          throw new XResearchError("not_found", X_MESSAGES.accountNotFound(handle));
        }
        return toProfile({ ...parsed.data, userName: parsed.data.userName });
      } catch (error) {
        throw accountMissing(error, handle);
      }
    },
    async accountInfo() {
      const body = await get("/oapi/my/info", {});
      const credits = body.recharge_credits;
      if (typeof credits !== "number" || !Number.isFinite(credits)) throw unavailable();
      return { credits };
    },
  };
}
```

`toPost` takes the parsed shape, but the tests call it with plain objects. If tsc complains about the test's literals, export `type RawTweet` and cast in the test: `toPost(tweet("7") as RawTweet)`. Do not loosen the function.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run server/x-research.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc -p tsconfig.server.json --noEmit
git add server/x-research.ts server/x-research.test.ts
git commit -m "feat(x-research): twitterapi.io client with compact posts and plain errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Store the twitterapi.io key like the xAI key

**Files:**
- Modify: `server/config.ts`:
  - schema, near `:430` (`cerebras: z.object(...)`)
  - `AppConfig`, near `:621`
  - env override, near `:1046-1049`
  - `syncCredentialEnv`, near `:1131`
  - `WORKSPACE_CREDENTIAL_ENV`, after `"OMB_OPENAI_LIVE_KEY"` near `:1193`
  - `saveConfig` section list, `:1366`
- Modify: `electron/workspace-credentials.mjs:10-20`, `electron/diagnostics.mjs:14-36`
- Modify: `server/index.ts` `configStatus()` near `:15433`
- Modify: `src/state/store.tsx`: the `ConfigStatus` interface near `:632`, the `ConfigStatusFrame` pick list near `:761`, and `configStatusFromFrame` near `:768`
- Test: `server/config.test.ts`, `electron/diagnostics.test.mjs`, `electron/workspace-credentials.test.mjs`. The existing parity tests cover the lists; one new config test is added.

**Interfaces:**
- Consumes: nothing.
- Produces: `cfg.twitterapi?.key: string | undefined`, env `OMB_TWITTERAPI_KEY`, `ConfigStatus.twitterapi?: { configured: boolean }`. Tasks 4, 5 and 7 read these.

- [ ] **Step 1: Write the failing test**

Append to `server/config.test.ts`, in its top-level `describe` or a new one. Add `WORKSPACE_CREDENTIAL_ENV` and `syncCredentialEnv` to the file's existing import from `./config.ts` if they are not imported already:

```ts
describe("twitterapi.io key", () => {
  it("is a workspace credential that never reaches an engine", () => {
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("OMB_TWITTERAPI_KEY");
  });

  it("follows a save into the running process and leaves on a clear", () => {
    const before = process.env.OMB_TWITTERAPI_KEY;
    try {
      syncCredentialEnv({ twitterapi: { key: "new-key" } });
      expect(process.env.OMB_TWITTERAPI_KEY).toBe("new-key");
      syncCredentialEnv({ twitterapi: { key: "" } });
      expect(process.env.OMB_TWITTERAPI_KEY).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.OMB_TWITTERAPI_KEY;
      else process.env.OMB_TWITTERAPI_KEY = before;
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run server/config.test.ts -t "twitterapi"`
Expected: FAIL. tsc-level: `twitterapi` is not in the patch type. Vitest: `WORKSPACE_CREDENTIAL_ENV` does not contain the name.

- [ ] **Step 3: Implement the plumbing**

In `server/config.ts`:

```ts
// schema, next to `cerebras: z.object({ key: optionalText }).optional(),`
  /** twitterapi.io: the X research tools' scraper, paid from this key. */
  twitterapi: z.object({ key: optionalText }).optional(),
```

```ts
// AppConfig, next to `cerebras?: { key?: string };`
  twitterapi?: { key?: string };
```

```ts
// loadConfig env override, after the cerebras lines
  cfg.twitterapi = { ...cfg.twitterapi };
  if (process.env.OMB_TWITTERAPI_KEY !== undefined) cfg.twitterapi.key = process.env.OMB_TWITTERAPI_KEY;
```

```ts
// syncCredentialEnv `secrets`, after [patch.live?.key, "OMB_OPENAI_LIVE_KEY"],
    [patch.twitterapi?.key, "OMB_TWITTERAPI_KEY"],
```

```ts
// WORKSPACE_CREDENTIAL_ENV, directly after "OMB_OPENAI_LIVE_KEY",
  "OMB_TWITTERAPI_KEY",
```

In the `saveConfig` section list at `:1366`, add `"twitterapi"` right after `"cerebras"`.

In `electron/diagnostics.mjs` `CREDENTIAL_ENV_NAMES`, add `"OMB_TWITTERAPI_KEY",` directly after `"OMB_OPENAI_LIVE_KEY",`. It must be the same position as in `WORKSPACE_CREDENTIAL_ENV`, because the parity test compares order.

In `electron/workspace-credentials.mjs`, add a row after the `live` row:

```js
  { section: "twitterapi", field: "key", name: "twitterapiKey", env: "OMB_TWITTERAPI_KEY" },
```

In `server/index.ts` `configStatus()`, after the `cerebras` line:

```ts
    // configured flag only: the key itself never leaves the server
    twitterapi: { configured: Boolean(cfg.twitterapi?.key) },
```

In `src/state/store.tsx`:

```ts
// ConfigStatus, after cerebras
  /** The twitterapi.io key the X research tools use. */
  twitterapi?: { configured: boolean };
```

Then add `| "twitterapi"` after `"cerebras"` in the `ConfigStatusFrame` pick list, and add `twitterapi: frame.twitterapi,` after `cerebras: frame.cerebras,` in `configStatusFromFrame`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run server/config.test.ts && pnpm exec vitest run electron/diagnostics.test.mjs electron/workspace-credentials.test.mjs`
Expected: PASS. Check how `pnpm test:electron` runs the `.test.mjs` files in `package.json` and use that exact command if it differs.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add server/config.ts server/config.test.ts electron/workspace-credentials.mjs electron/diagnostics.mjs server/index.ts src/state/store.tsx
git commit -m "feat(x-research): store the twitterapi.io key as an encrypted workspace credential

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The per-bot `xResearch` switch (data and API)

**Files:**
- Modify: `shared/wire.ts:303-307` (Bot type, after `voiceNotes`)
- Modify: `src/state/store.tsx:456-459` (client Bot type, after `voiceNotes`)
- Modify: `src/state/bot-patch-queue.ts:27` (allowed patch keys)
- Modify: `server/index.ts`, the `PATCH /api/bots/:id` handler, after the `voiceNotes` block near `:21515`
- Test: `server/request-auth.test.ts` near `:130`

**Interfaces:**
- Consumes: nothing.
- Produces: `Bot.xResearch?: boolean` on the server and client, and `PATCH /api/bots/:id` accepting `{ xResearch: boolean }` from the desktop only. Tasks 4, 5 and 7 read this.

- [ ] **Step 1: Write the failing test**

In `server/request-auth.test.ts`, in the test that holds `expect(clientBotPatchViolation({ cwd: "/" })).toBe("cwd");`, add:

```ts
    // X research spends the workspace's twitterapi.io credit: a paired
    // phone may not switch it on.
    expect(clientBotPatchViolation({ xResearch: true })).toBe("xResearch");
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run server/request-auth.test.ts`
Expected: PASS already, because `xResearch` is not in `CLIENT_BOT_PATCH_FIELDS`. This test pins that it stays out. Do not add `xResearch` to that set.

- [ ] **Step 3: Add the field and the PATCH validation**

`shared/wire.ts`, after `voiceNotes?: boolean;`:

```ts
  /** Whether this bot may use the X research tools (x_search, x_user_posts,
   * x_post, x_profile), which spend the workspace's twitterapi.io credit.
   * Absent/false = off: the person turns it on per bot. */
  xResearch?: boolean;
```

`src/state/store.tsx` Bot, after `voiceNotes?: boolean;`:

```ts
  /** whether this bot may search and read X (off unless switched on) */
  xResearch?: boolean;
```

`src/state/bot-patch-queue.ts`: add `| "xResearch"` after `| "voiceNotes"`.

`server/index.ts`, after the `voiceNotes` block in the bot PATCH handler:

```ts
      // per-bot gate on the X research tools: they spend the workspace's
      // twitterapi.io credit, so like voiceNotes this is an admin decision,
      // never part of the client-writable profile surface.
      if (body.xResearch !== undefined) {
        if (typeof body.xResearch !== "boolean") return json(res, 400, { error: "xResearch must be true or false" });
        patch.xResearch = body.xResearch;
      }
```

- [ ] **Step 4: Typecheck and run the tests**

Run: `pnpm typecheck && pnpm vitest run server/request-auth.test.ts`
Expected: PASS. If `patch` is typed by a narrower server type than `Bot`, add `xResearch` there the same way `voiceNotes` is declared.

- [ ] **Step 5: Commit**

```bash
git add shared/wire.ts src/state/store.tsx src/state/bot-patch-queue.ts server/index.ts server/request-auth.test.ts
git commit -m "feat(x-research): per-bot xResearch switch, desktop-only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Internal routes and the key Test route

**Files:**
- Create: `server/routes/x-research.ts`
- Test: `server/routes/x-research.test.ts`
- Modify: `server/index.ts`:
  - one import next to the other `./routes/` imports, `:630-641`
  - `ROUTES.push(...)` next to the other pushes, `:15908-15965`
  - one call inside the `/api/internal/` block, right after `requireActiveInternalCapability` is defined, `:16632`

**Interfaces:**
- Consumes:
  - from Task 1: `createTwitterApiClient`, `DEFAULT_POSTS`, `MAX_POSTS`, `CREDITS_PER_DOLLAR`, `normalizeHandle`, `parsePostRef`, `X_MESSAGES`, `XResearchError`, `type XResearchClient`, `type XResearchErrorCode`
  - `cfg.twitterapi?.key` (Task 2) and `store.bot(id)?.xResearch` (Task 3)
- Produces:
  - `POST /api/internal/x/search | user-posts | post | profile` → 200 with the client's result JSON, or `{ error, code? }` with 400/403/404/502
  - `POST /api/x-research/test` → `{ ok: true, credits, dollars }` or `{ ok: false, reason: "rejected" | "unreachable" | "unexpected", message }`
  - `createXResearchInternalRoutes(deps)`, `createXResearchKeyTestRoute(deps)`, `interface XInternalContext`

- [ ] **Step 1: Write the failing test**

Create `server/routes/x-research.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { X_MESSAGES, XResearchError, type XResearchClient } from "../x-research.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createXResearchInternalRoutes, createXResearchKeyTestRoute, type XInternalContext } from "./x-research.ts";

function fakeClient(overrides: Partial<XResearchClient> = {}): XResearchClient {
  return {
    search: vi.fn(async () => ({ posts: [], more: false })),
    userPosts: vi.fn(async () => ({ posts: [], more: false })),
    post: vi.fn(async () => ({ post: { id: "1", url: "https://x.com/i/status/1", author: "@a", text: "hi" } })),
    profile: vi.fn(async () => ({ handle: "@a", url: "https://x.com/a" })),
    accountInfo: vi.fn(async () => ({ credits: 420_000 })),
    ...overrides,
  };
}

function sink() {
  const sent: { status?: number; body?: any } = {};
  const json = ((_res: unknown, status: number, body: unknown) => {
    sent.status = status;
    sent.body = body;
  }) as XInternalContext["json"];
  const res = { setHeader: vi.fn() } as unknown as XInternalContext["res"];
  return { sent, json, res };
}

async function callInternal(
  handler: ReturnType<typeof createXResearchInternalRoutes>,
  { path = "/api/internal/x/search", method = "POST", body = {} as unknown, botId = "bot-1" } = {},
) {
  const { sent, json, res } = sink();
  const out = await handler({ method, path, res, json, botId, readBody: async () => body });
  return { out, ...sent };
}

describe("X research internal routes", () => {
  const enabled = (client = fakeClient(), key: () => string | undefined = () => "k") =>
    ({ client, handler: createXResearchInternalRoutes({ key, botEnabled: (id) => id === "bot-1", client: () => client }) });

  it("passes requests that are not its own", async () => {
    const { handler } = enabled();
    expect((await callInternal(handler, { path: "/api/internal/voice-note" })).out).toBe(PASS);
    expect((await callInternal(handler, { path: "/api/internal/x/unknown" })).out).toBe(PASS);
    expect((await callInternal(handler, { method: "GET" })).out).toBe(PASS);
  });

  it("refuses without a key, and refuses a bot that is not switched on, before any spend", async () => {
    const client = fakeClient();
    const noKey = createXResearchInternalRoutes({ key: () => undefined, botEnabled: () => true, client: () => client });
    expect(await callInternal(noKey, { body: { query: "maus" } })).toMatchObject({ status: 403, body: { error: X_MESSAGES.noKey } });
    const { handler } = enabled(client);
    expect(await callInternal(handler, { botId: "bot-2", body: { query: "maus" } })).toMatchObject({ status: 403, body: { error: X_MESSAGES.botOff } });
    expect(client.search).not.toHaveBeenCalled();
  });

  it("reads the key on every call, so clearing it stops the next one", async () => {
    let key: string | undefined = "k";
    const { handler } = enabled(fakeClient(), () => key);
    expect((await callInternal(handler, { body: { query: "maus" } })).status).toBe(200);
    key = undefined;
    expect((await callInternal(handler, { body: { query: "maus" } })).status).toBe(403);
  });

  it("validates input with a reason a retry can use", async () => {
    const { handler } = enabled();
    for (const [path, body] of [
      ["/api/internal/x/search", {}],
      ["/api/internal/x/search", { query: "maus", sinceId: "abc" }],
      ["/api/internal/x/search", { query: "maus", limit: 51 }],
      ["/api/internal/x/user-posts", { handle: "not a handle!" }],
      ["/api/internal/x/post", { post: "https://example.com/1" }],
      ["/api/internal/x/profile", { handle: "" }],
    ] as const) {
      const result = await callInternal(handler, { path, body });
      expect(result.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(typeof result.body.error).toBe("string");
    }
  });

  it("hands the client normalized input with defaults filled in", async () => {
    const { client, handler } = enabled();
    await callInternal(handler, { body: { query: "maus" } });
    expect(client.search).toHaveBeenCalledWith({ query: "maus", sort: "latest", limit: 20 });
    await callInternal(handler, { path: "/api/internal/x/user-posts", body: { handle: "@maus", sinceId: "99", limit: 5 } });
    expect(client.userPosts).toHaveBeenCalledWith({ handle: "maus", limit: 5, includeReplies: false, sinceId: "99" });
    await callInternal(handler, { path: "/api/internal/x/post", body: { post: "https://x.com/maus/status/42", replies: true } });
    expect(client.post).toHaveBeenCalledWith({ id: "42", replies: true });
    await callInternal(handler, { path: "/api/internal/x/profile", body: { handle: "https://x.com/maus" } });
    expect(client.profile).toHaveBeenCalledWith("maus");
  });

  it("returns the client's result as the body", async () => {
    const posts = { posts: [{ id: "5", url: "https://x.com/a/status/5", author: "@a", text: "t" }], newestId: "5", more: false };
    const { handler } = enabled(fakeClient({ search: vi.fn(async () => posts) }));
    expect(await callInternal(handler, { body: { query: "maus" } })).toMatchObject({ status: 200, body: posts });
  });

  it("turns scraper failures into 404 or 502 with the plain sentence, never 401", async () => {
    const gone = enabled(fakeClient({ post: vi.fn(async () => { throw new XResearchError("not_found", X_MESSAGES.postNotFound); }) }));
    expect(await callInternal(gone.handler, { path: "/api/internal/x/post", body: { post: "42" } }))
      .toMatchObject({ status: 404, body: { error: X_MESSAGES.postNotFound, code: "not_found" } });
    const badKey = enabled(fakeClient({ search: vi.fn(async () => { throw new XResearchError("bad_key", X_MESSAGES.badKey); }) }));
    expect(await callInternal(badKey.handler, { body: { query: "maus" } }))
      .toMatchObject({ status: 502, body: { error: X_MESSAGES.badKey, code: "bad_key" } });
  });
});

describe("X research key test route", () => {
  async function callTest(handler: ReturnType<typeof createXResearchKeyTestRoute>, path = "/api/x-research/test", method = "POST") {
    const { sent, json, res } = sink();
    const out = await handler({ method, path, res, json } as unknown as RouteContext);
    return { out, ...sent };
  }

  it("passes other requests", async () => {
    const handler = createXResearchKeyTestRoute({ key: () => "k", client: () => fakeClient() });
    expect((await callTest(handler, "/api/keys/test")).out).toBe(PASS);
    expect((await callTest(handler, "/api/x-research/test", "GET")).out).toBe(PASS);
  });

  it("asks for a key first", async () => {
    const handler = createXResearchKeyTestRoute({ key: () => "  ", client: () => fakeClient() });
    expect(await callTest(handler)).toMatchObject({ status: 400 });
  });

  it("reports the balance in credits and dollars", async () => {
    const handler = createXResearchKeyTestRoute({ key: () => "k", client: () => fakeClient() });
    expect(await callTest(handler)).toMatchObject({ status: 200, body: { ok: true, credits: 420_000, dollars: 4.2 } });
  });

  it("names a rejected key", async () => {
    const client = fakeClient({ accountInfo: vi.fn(async () => { throw new XResearchError("bad_key", X_MESSAGES.badKey); }) });
    const handler = createXResearchKeyTestRoute({ key: () => "k", client: () => client });
    expect(await callTest(handler)).toMatchObject({ status: 200, body: { ok: false, reason: "rejected", message: X_MESSAGES.badKey } });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run server/routes/x-research.test.ts`
Expected: FAIL, because `./x-research.ts` cannot be found in `server/routes/`.

- [ ] **Step 3: Write the route module**

Create `server/routes/x-research.ts`:

```ts
// X research routes: the four internal calls behind the agents server's x_*
// tools, and Settings → API keys' Test for the twitterapi.io key.
//
// The internal handler runs inside index.ts's /api/internal/ block, after the
// capability bearer is checked (the table runs before that block). It still
// re-checks the key and the bot's own switch on every call: the tool list a
// bot was shown at the start of its turn is not permission to spend.
import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { json as sendJson } from "../harness/http.ts";
import {
  CREDITS_PER_DOLLAR,
  createTwitterApiClient,
  DEFAULT_POSTS,
  MAX_POSTS,
  normalizeHandle,
  parsePostRef,
  X_MESSAGES,
  XResearchError,
  type XResearchClient,
  type XResearchErrorCode,
} from "../x-research.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface XResearchDeps {
  /** The saved twitterapi.io key, read per request. */
  key: () => string | undefined;
  /** bot.xResearch === true */
  botEnabled: (botId: string) => boolean;
  /** Tests pass a fake; the server builds the real client per call. */
  client?: (key: string) => XResearchClient;
}

export interface XInternalContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  /** The capability's own bot, never a body field. */
  botId: string;
  /** index.ts's readInternalBody: re-checks the capability after the read. */
  readBody: () => Promise<unknown>;
}

const PREFIX = "/api/internal/x/";
const ACTIONS = new Set(["search", "user-posts", "post", "profile"]);

/** 401 is never used: on internal routes it means the capability expired. */
function statusFor(code: XResearchErrorCode): number {
  return code === "bad_input" ? 400 : code === "not_found" ? 404 : 502;
}

const limit = z.number().int().min(1).max(MAX_POSTS).optional();
const sinceId = z.string().regex(/^\d{1,25}$/, "sinceId must be the digits of an X post id, such as a newestId from an earlier call").optional();
const searchBody = z.object({ query: z.string().trim().min(1).max(512), sort: z.enum(["latest", "top"]).optional(), limit, sinceId });
const userPostsBody = z.object({ handle: z.string(), limit, sinceId, includeReplies: z.boolean().optional() });
const postBody = z.object({ post: z.string(), replies: z.boolean().optional() });
const profileBody = z.object({ handle: z.string() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new XResearchError("bad_input", `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`);
}

function handleFrom(raw: string): string {
  const handle = normalizeHandle(raw);
  if (!handle) throw new XResearchError("bad_input", "handle must be an X handle such as @openmausbot, or an x.com profile link.");
  return handle;
}

async function run(action: string, body: unknown, client: XResearchClient): Promise<unknown> {
  if (action === "search") {
    const input = parse(searchBody, body);
    return client.search({ query: input.query, sort: input.sort ?? "latest", limit: input.limit ?? DEFAULT_POSTS, ...(input.sinceId ? { sinceId: input.sinceId } : {}) });
  }
  if (action === "user-posts") {
    const input = parse(userPostsBody, body);
    return client.userPosts({
      handle: handleFrom(input.handle),
      limit: input.limit ?? DEFAULT_POSTS,
      includeReplies: input.includeReplies ?? false,
      ...(input.sinceId ? { sinceId: input.sinceId } : {}),
    });
  }
  if (action === "post") {
    const input = parse(postBody, body);
    const id = parsePostRef(input.post);
    if (!id) throw new XResearchError("bad_input", "post must be an x.com or twitter.com post link, or a post id.");
    return client.post({ id, replies: input.replies ?? false });
  }
  const input = parse(profileBody, body);
  return client.profile(handleFrom(input.handle));
}

export function createXResearchInternalRoutes(deps: XResearchDeps) {
  const clientFor = deps.client ?? ((key: string) => createTwitterApiClient({ key }));
  return async (ctx: XInternalContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || !ctx.path.startsWith(PREFIX)) return PASS;
    const action = ctx.path.slice(PREFIX.length);
    if (!ACTIONS.has(action)) return PASS;
    const key = deps.key()?.trim();
    if (!key) return void ctx.json(ctx.res, 403, { error: X_MESSAGES.noKey });
    if (!deps.botEnabled(ctx.botId)) return void ctx.json(ctx.res, 403, { error: X_MESSAGES.botOff });
    const body = await ctx.readBody();
    try {
      ctx.json(ctx.res, 200, await run(action, body, clientFor(key)));
    } catch (error) {
      if (!(error instanceof XResearchError)) throw error;
      ctx.json(ctx.res, statusFor(error.code), { error: error.message, code: error.code });
    }
  };
}

/** Settings → API keys' Test: one free account call; the verdict never
 * carries the key. Admin-only like every route not opened to clients. */
export function createXResearchKeyTestRoute(deps: Pick<XResearchDeps, "key" | "client">): RouteHandler {
  const clientFor = deps.client ?? ((key: string) => createTwitterApiClient({ key }));
  return async ({ method, path, res, json }) => {
    if (method !== "POST" || path !== "/api/x-research/test") return PASS;
    res.setHeader("cache-control", "no-store");
    const key = deps.key()?.trim();
    if (!key) return void json(res, 400, { error: "No key to test. Paste one or save one first." });
    try {
      const { credits } = await clientFor(key).accountInfo();
      json(res, 200, { ok: true, credits, dollars: credits / CREDITS_PER_DOLLAR });
    } catch (error) {
      if (!(error instanceof XResearchError)) throw error;
      const reason = error.code === "bad_key" ? "rejected" : error.code === "unavailable" ? "unreachable" : "unexpected";
      json(res, 200, { ok: false, reason, message: error.message });
    }
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm vitest run server/routes/x-research.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the server**

In `server/index.ts`:

1. Next to the other route imports (`:630-641`), add:

```ts
import { createXResearchInternalRoutes, createXResearchKeyTestRoute } from "./routes/x-research.ts";
```

Change the existing `import { ROUTES, dispatchRoutes } from "./routes/table.ts";` to `import { PASS, ROUTES, dispatchRoutes } from "./routes/table.ts";`.

2. After the last `ROUTES.push(...)` in the route-modules block (after `ROUTES.push(desktopViewer.route);`), add:

```ts
// X research (server/routes/x-research.ts): Settings' key Test runs from the
// table; the four tool routes run inside the /api/internal/ block below,
// after the capability bearer is checked. `cfg` is reassigned on reload, so
// both read it per request.
ROUTES.push(createXResearchKeyTestRoute({ key: () => cfg.twitterapi?.key }));
const xResearchRoutes = createXResearchInternalRoutes({
  key: () => cfg.twitterapi?.key,
  botEnabled: (botId) => store.bot(botId)?.xResearch === true,
});
```

3. Inside `if (path.startsWith("/api/internal/")) {`, right after the `const requireActiveInternalCapability = () => { … };` block, add:

```ts
      if (await xResearchRoutes({ method, path, res, json, botId: internalSender.id, readBody: readInternalBody }) !== PASS) return;
```

- [ ] **Step 6: Run the route ratchet, the request-auth tests and typecheck**

Run: `pnpm vitest run scripts/testing/index-route-ratchet.test.ts server/request-auth.test.ts server/routes && pnpm typecheck`
Expected: PASS. The ratchet count is unchanged, because no `path === "/` literal was added to `index.ts`.

- [ ] **Step 7: Commit**

```bash
git add server/routes/x-research.ts server/routes/x-research.test.ts server/index.ts
git commit -m "feat(x-research): internal tool routes that re-check key and bot switch, plus key Test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The four tools in the agents catalog, gated per bot

**Files:**
- Modify: `server/drivers/agents-catalog.ts`:
  - `CatalogProfile`, `:20-43`
  - `catalogProfileFromEnv`, `:47-59`
  - tool definitions, after `send_voice_note` near `:588`
  - gating, `:925` and `:971-975`
- Modify: `server/index.ts` `agentsIntegration()` env, `:2496-2502`
- Modify: `server/drivers/agents-catalog-wire.test.ts`:
  - `profiles()`, `:82-101`
  - `FULL`, `:113`
  - `BUDGET_BASELINE`, `:118-172`
  - add a new test
- Regenerate: `server/drivers/agents-catalog-goldens/*.json`

**Interfaces:**
- Consumes: env `OMB_X_RESEARCH`, set from `cfg.twitterapi?.key` (Task 2) and `bot.xResearch` (Task 3).
- Produces: tool names `x_search`, `x_user_posts`, `x_post`, `x_profile` with the argument names `query`, `sort`, `limit`, `sinceId`, `handle`, `includeReplies`, `post`, `replies`. Task 6's handlers pass these through unchanged.

- [ ] **Step 1: Write the failing test**

In `server/drivers/agents-catalog-wire.test.ts`:

(a) In `profiles()`, directly after the `+cloud-home` loop, add:

```ts
  // X research is one more switch, on only for a bot its person turned on.
  // The fullest profiles carry it, so every other profile stays a subset.
  for (const name of ["direct+skills+shared+voice", "room+own-thread+skills+shared+voice"]) {
    all[`${name}+x`] = { family: all[name]!.family, env: { ...all[name]!.env, OMB_X_RESEARCH: "1" } };
  }
```

(b) In `all["external+everything"].env`, add `OMB_X_RESEARCH: "1",`.

(c) Change `FULL` to:

```ts
const FULL = { direct: "direct+skills+shared+voice+x", room: "room+own-thread+skills+shared+voice+x", external: "external" } as const;
```

(d) Add this test inside the same `describe`, after the Chief-of-Staff test:

```ts
  it("shows the X tools only to a bot switched on for X research, and never to an external runtime", () => {
    const X = ["x_search", "x_user_posts", "x_post", "x_profile"];
    for (const [name, profile] of Object.entries(PROFILES)) {
      const names = toolsOf(wires[name]!).map((tool) => tool.name);
      const on = profile.env.OMB_X_RESEARCH === "1" && profile.family !== "external";
      for (const tool of X) expect(names.includes(tool), `${name}: ${tool}`).toBe(on);
    }
    const switchedOn = Object.keys(PROFILES).filter((name) => name.endsWith("+x"));
    expect(switchedOn).toHaveLength(2);
    for (const name of switchedOn) {
      const without = toolsOf(wires[name.slice(0, -"+x".length)]!).map((tool) => tool.name);
      expect(toolsOf(wires[name]!).map((tool) => tool.name).filter((tool) => !X.includes(tool))).toEqual(without);
    }
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run server/drivers/agents-catalog-wire.test.ts`
Expected: FAIL. The new test finds no `x_search` in the `+x` profiles, and the `+x` profiles have no `BUDGET_BASELINE` entry.

- [ ] **Step 3: Add the tools and the gate**

In `server/drivers/agents-catalog.ts`:

`CatalogProfile`, after `voiceNotes: boolean;`:

```ts
  /** The bot is switched on for X research and a twitterapi.io key is saved.
   * Absent means off: these tools spend the person's credit. */
  xResearch?: boolean;
```

`catalogProfileFromEnv`, after `voiceNotes: …,`:

```ts
    xResearch: env.OMB_X_RESEARCH === "1",
```

Tool definitions: insert directly after the `send_voice_note` entry:

```ts
  {
    name: "x_search",
    description:
      "Search posts on X (Twitter) without an X account, through the user's twitterapi.io account. Each call spends a little of their credit, so write one well-filtered query instead of many broad ones. The query takes X operators: from:handle, to:handle, \"exact phrase\", since:YYYY-MM-DD, until:YYYY-MM-DD, min_faves:N, -filter:replies, lang:en, OR. Returns compact posts (link, author, time, text, likes, reposts, replies, quotes, views) and newestId. To monitor X, for example in a routine, keep newestId and pass it back as sinceId next time to get only newer posts. Read-only: you cannot post, like or reply.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 512, description: "The X search query; operators allowed." },
        sort: { type: "string", enum: ["latest", "top"], description: "latest (default) or top." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many posts, 1-50. Default 20." },
        sinceId: { type: "string", pattern: "^\\d{1,25}$", description: "Only posts newer than this post id: a newestId from an earlier call." },
      },
      required: ["query"],
    },
  },
  {
    name: "x_user_posts",
    description:
      "Read an X account's recent posts, newest first, through the user's twitterapi.io account (each call spends a little credit). Returns compact posts and newestId; pass newestId back as sinceId later to get only newer posts. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", minLength: 1, description: "The account: @handle, handle, or an x.com profile link." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many posts, 1-50. Default 20." },
        sinceId: { type: "string", pattern: "^\\d{1,25}$", description: "Only posts newer than this post id." },
        includeReplies: { type: "boolean", description: "Include the account's replies to others. Default false." },
      },
      required: ["handle"],
    },
  },
  {
    name: "x_post",
    description:
      "Read one X post from its link or id, and optionally the first page of up to 20 replies to it, through the user's twitterapi.io account (each call spends a little credit). Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        post: { type: "string", minLength: 1, description: "An x.com or twitter.com post link, or the post id." },
        replies: { type: "boolean", description: "Also return replies to the post. Default false." },
      },
      required: ["post"],
    },
  },
  {
    name: "x_profile",
    description:
      "Look up an X account's profile: name, bio, location, website, followers, following, post count, verified, joined date. Spends a little of the user's twitterapi.io credit. Read-only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        handle: { type: "string", minLength: 1, description: "The account: @handle, handle, or an x.com profile link." },
      },
      required: ["handle"],
    },
  },
```

Gating: after `const VOICE_TOOL_NAMES = new Set(["send_voice_note"]);`, add:

```ts
// And for X research: these spend the person's twitterapi.io credit, so a
// bot sees them only when its person switched X research on for it and a key
// is saved. The routes re-check both on every call.
const X_TOOL_NAMES = new Set(["x_search", "x_user_posts", "x_post", "x_profile"]);
```

In `catalogTools`, replace:

```ts
  const ROLE_TOOLS = profile.chief
    ? VOICE_READY_TOOLS
    : VOICE_READY_TOOLS.filter((tool) => !CHIEF_ONLY_TOOL_NAMES.has(tool.name)).map((tool) => {
```

with:

```ts
  const X_READY_TOOLS = profile.xResearch === true
    ? VOICE_READY_TOOLS
    : VOICE_READY_TOOLS.filter((tool) => !X_TOOL_NAMES.has(tool.name));
  const ROLE_TOOLS = profile.chief
    ? X_READY_TOOLS
    : X_READY_TOOLS.filter((tool) => !CHIEF_ONLY_TOOL_NAMES.has(tool.name)).map((tool) => {
```

In `server/index.ts` `agentsIntegration()`, after the `OMB_VOICE_NOTES` entry:

```ts
      // X research spends the person's own twitterapi.io credit, so the tools
      // are shown only to a bot they switched on, and only with a key saved;
      // the routes (server/routes/x-research.ts) re-check both on every call.
      OMB_X_RESEARCH: cfg.twitterapi?.key && store.bot(botId)?.xResearch === true ? "1" : "0",
```

- [ ] **Step 4: Regenerate the goldens, then set the two new budgets by hand**

Run: `UPDATE_AGENTS_CATALOG_GOLDENS=1 pnpm vitest run server/drivers/agents-catalog-wire.test.ts`
Then run it again without the variable: `pnpm vitest run server/drivers/agents-catalog-wire.test.ts`.
Expected: everything passes except the budget test, which reports the measured byte counts for `direct+skills+shared+voice+x` and `room+own-thread+skills+shared+voice+x`. Add those two numbers to `BUDGET_BASELINE`, right after their non-`x` entries:

```ts
  "direct+skills+shared+voice+x": <measured bytes>,
  "room+own-thread+skills+shared+voice+x": <measured bytes>,
```

Run the test again. Expected: PASS.

Check the golden diff with `git diff --stat server/drivers/agents-catalog-goldens`. `direct-full` and `room-full` gain exactly the four `x_*` tools, and `profiles.json` gains two entries. No other profile's sha256 may change. If one does, the gate is wrong; fix the code, not the golden.

- [ ] **Step 5: Run the catalog's other tests and typecheck**

Run: `pnpm vitest run server/drivers && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/drivers/agents-catalog.ts server/drivers/agents-catalog-wire.test.ts server/drivers/agents-catalog-goldens server/index.ts
git commit -m "feat(x-research): x_search, x_user_posts, x_post, x_profile in the agents catalog, per-bot gated

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tool handlers and the Activity label

**Files:**
- Modify: `server/drivers/agents-call.ts`. Add one branch in `callTool`, after the `send_voice_note` branch near `:912`.
- Modify: `server/activity.ts` `describeTool`, `:76-96`.
- Test: `server/drivers/agents-call.test.ts`, `server/activity.test.ts`.

**Interfaces:**
- Consumes: Task 4's routes `POST /api/internal/x/{search,user-posts,post,profile}`, and Task 5's tool names and argument names.
- Produces: the text the bot reads, which is the route's JSON body compacted. Errors come back as the route's `error` sentence with `isError: true`.

- [ ] **Step 1: Write the failing tests**

Append to `server/drivers/agents-call.test.ts`. It already has the `context(overrides)` helper at the top:

```ts
describe("X research tools", () => {
  const ROUTES = { x_search: "search", x_user_posts: "user-posts", x_post: "post", x_profile: "profile" } as const;

  it("sends each tool's arguments to its route and returns the JSON the route gave", async () => {
    for (const [tool, route] of Object.entries(ROUTES)) {
      const calls: Array<{ path: string; body: unknown }> = [];
      const result = await callTool(tool, { query: "maus", handle: "@maus", post: "42" }, context({
        client: {
          api: async () => ({}),
          apiResponse: async (path, init) => {
            calls.push({ path, body: JSON.parse(String(init?.body)) });
            return { ok: true, status: 200, body: { posts: [{ id: "1" }], more: false } };
          },
        },
      }));
      expect(calls).toEqual([{ path: `/api/internal/x/${route}`, body: { query: "maus", handle: "@maus", post: "42" } }]);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.text)).toEqual({ posts: [{ id: "1" }], more: false });
    }
  });

  it("hands the bot the route's own sentence when it refuses", async () => {
    const result = await callTool("x_search", { query: "maus" }, context({
      client: {
        api: async () => ({}),
        apiResponse: async () => ({ ok: false, status: 403, body: { error: "X research is off for this bot. Turn it on in this bot's settings under Access." } }),
      },
    }));
    expect(result).toEqual({ text: "X research is off for this bot. Turn it on in this bot's settings under Access.", isError: true });
  });
});
```

Append to `server/activity.test.ts`, inside `describe("describeTool", …)`:

```ts
  it("files the X research tools under X, not Team", () => {
    expect(describeTool("mcp__agents__x_search")).toEqual({ app: "X", label: "Searched X" });
    expect(describeTool("mcp__agents__x_user_posts")).toEqual({ app: "X", label: "Read X posts" });
    expect(describeTool("mcp__agents__x_post")).toEqual({ app: "X", label: "Read an X post" });
    expect(describeTool("mcp__agents__x_profile")).toEqual({ app: "X", label: "Looked up an X profile" });
    expect(describeTool("mcp__agents__delegate_bot")).toEqual({ app: "Team", label: "Delegate bot" });
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run server/drivers/agents-call.test.ts server/activity.test.ts -t "X research|files the X"`
Expected: FAIL. `callTool` does not know `x_search` (it returns an unknown-tool result), and `describeTool` returns app "Team".

- [ ] **Step 3: Implement**

In `server/drivers/agents-call.ts`, add `X_TOOL_ROUTES` at module scope near the other constants:

```ts
/** The x_* tools and their internal routes (server/routes/x-research.ts),
 * which validate the arguments, re-check the key and the bot's switch, and
 * answer in compact JSON the bot reads as is. */
const X_TOOL_ROUTES: Record<string, string> = {
  x_search: "search",
  x_user_posts: "user-posts",
  x_post: "post",
  x_profile: "profile",
};
```

In `callTool`, after the `send_voice_note` branch, add:

```ts
  const xRoute = X_TOOL_ROUTES[name];
  if (xRoute) {
    const { ok, body } = await apiResponse(`/api/internal/x/${xRoute}`, { method: "POST", body: JSON.stringify(args) });
    if (!ok) return { text: String(body.error ?? "X research failed. Try again shortly."), isError: true };
    return { text: JSON.stringify(body) };
  }
```

In `server/activity.ts`, above `describeTool`:

```ts
/** The agents server's X research tools read as their own app. */
const X_TOOL_LABELS: Record<string, string> = {
  x_search: "Searched X",
  x_user_posts: "Read X posts",
  x_post: "Read an X post",
  x_profile: "Looked up an X profile",
};
```

and change the `agents` line inside `describeTool` to:

```ts
    if (server === "agents") {
      const x = X_TOOL_LABELS[action];
      return x ? { app: "X", label: x } : { app: "Team", label: humanize(action) };
    }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run server/drivers/agents-call.test.ts server/activity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/drivers/agents-call.ts server/drivers/agents-call.test.ts server/activity.ts server/activity.test.ts
git commit -m "feat(x-research): tool handlers and X in the activity log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Settings row, Access switch, docs

**Files:**
- Modify: `src/components/ApiKeys.tsx`:
  - `ConfigSection` and `TestableProvider` unions, `:12-14`
  - `SECTIONS`, `:16-50`
  - `CREDENTIALS`, `:151-160`
  - `test()`, `:274-294`
- Modify: `src/components/SettingsModal.tsx`:
  - keywords, `:87`
  - Integrations rows, after `<ApiKeyRow section="box" />` at `:995`
- Modify: `src/components/bot-settings/AccessSection.tsx`. Add a new `XResearchCard` component and render it after the Browser card, `:666-697`.
- Modify: `src/locales/en.json`. Add keys next to `keys.xai.*` at `:1786`.
- Modify: `apps/docs/content/docs/connected-apps/index.mdx`, in "Connect X (Twitter)".
- Test: `src/components/ApiKeys.test.ts`, `src/components/bot-settings/AccessSection.test.ts`.

**Interfaces:**
- Consumes: `ConfigStatus.twitterapi` (Task 2), `Bot.xResearch` and the PATCH (Task 3), and `POST /api/x-research/test` (Task 4).
- Produces: UI only.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/ApiKeys.test.ts`:

```ts
describe("X research key row", () => {
  it("renders write-only with twitterapi.io linked and a Test button once saved", () => {
    vi.spyOn(store, "useStore").mockReturnValue({
      state: { ...store.initialState, config: { ...store.initialState.config, twitterapi: { configured: true } } as store.ConfigStatus },
      dispatch: vi.fn(),
      flushBotPatches: vi.fn(),
      refreshInstances: vi.fn(),
      refreshModels: vi.fn(),
    });
    const html = render(createElement(ApiKeyRow, { section: "twitterapi", testProvider: "twitterapi" }));
    expect(html).toContain("X research (twitterapi.io) key");
    expect(html).toContain('type="password"');
    expect(html).toContain("Configured");
    expect(html).toContain(">Test<");
  });
});
```

Append to `src/components/bot-settings/AccessSection.test.ts`. It already has `render(bot, derived = makeDerived())` at `:77`, and the `fixture.config` stub its cloud-home test uses at `:200`:

```ts
describe("X research card", () => {
  it("is off by default and points to API keys when no key is saved", () => {
    fixture.config = { twitterapi: { configured: false } } as Partial<ConfigStatus>;
    const html = render(makeBot());
    expect(html).toContain("X research");
    expect(html).toContain("Settings → API keys");
    expect(html).toMatch(/aria-label="Let this bot search and read X"[^>]*disabled/);
  });

  it("shows the switch on for a bot switched on, with a key saved", () => {
    fixture.config = { twitterapi: { configured: true } } as Partial<ConfigStatus>;
    const html = render(makeBot({ xResearch: true }));
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Let this bot search and read X"|aria-label="Let this bot search and read X"[^>]*aria-checked="true"/);
    expect(html).toContain("twitterapi.io credit");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run src/components/ApiKeys.test.ts src/components/bot-settings/AccessSection.test.ts`
Expected: FAIL. `"twitterapi"` is not a `ConfigSection`, and there is no X research card.

- [ ] **Step 3: Implement the API keys row**

`src/components/ApiKeys.tsx`:

```ts
export type ConfigSection = "composio" | "box" | "opencodeGo" | "anthropic" | "openai" | "openrouter" | "openaiCompat" | "xai" | "mistral" | "cerebras" | "twitterapi";
/** Sections whose key can be tried from the server. twitterapi is tried by
 * its own route, which also reports the balance left. */
export type TestableProvider = "anthropic" | "openai" | "openrouter" | "openaiCompat" | "xai" | "mistral" | "cerebras" | "twitterapi";
```

In `SECTIONS`, after `xai`:

```ts
  twitterapi: { body: (v) => ({ twitterapi: { key: v } }), flag: (c) => c.twitterapi?.configured ?? false },
```

In `CREDENTIALS`, after `xai`:

```ts
  twitterapi: {
    labelKey: "keys.twitterapi.label",
    descriptionKey: "keys.twitterapi.desc",
    href: "https://twitterapi.io/dashboard",
    linkLabelKey: "keys.twitterapi.link",
    optional: true,
  },
```

In `test()`, replace the `const result = await api("/api/keys/test", …)` line and the `outcome` computation with:

```ts
      if (testProvider === "twitterapi") {
        const result = await api("/api/x-research/test", { method: "POST", body: "{}" });
        if (generation !== testGeneration.current) return;
        const outcome = result.ok
          ? t("keys.twitterapi.testOk", { dollars: Number(result.dollars ?? 0).toFixed(2) })
          : result.reason === "rejected" ? t("keys.testRejected")
            : result.reason === "unreachable" ? t("keys.testUnreachable")
              : String(result.message ?? t("keys.testUnexpected", { status: "?" }));
        setVerdict(`${t("keys.testSaved")} ${outcome}`);
        return;
      }
      const result = await api("/api/keys/test", { method: "POST", body: JSON.stringify({ provider: testProvider }) });
      if (generation !== testGeneration.current) return;
      const outcome = result.ok
        ? result.check === "authentication" ? t("keys.testAuthenticated")
          : result.models?.length ? t("keys.testCatalog", { models: result.models.join(", ") }) : t("keys.testCatalogNoModels")
        : result.reason === "rejected" ? t("keys.testRejected")
          : result.reason === "unreachable" ? t("keys.testUnreachable")
            : t("keys.testUnexpected", { status: String(result.status ?? "?") });
      setVerdict(`${t("keys.testSaved")} ${outcome}`);
```

The surrounding `try / catch / finally` stays as it is, and the early `return` still reaches the `finally`.

`src/locales/en.json`, after `"keys.xai.link"`:

```json
  "keys.twitterapi.label": "X research (twitterapi.io) key",
  "keys.twitterapi.desc": "Lets the bots you choose search and read X without an X account. Pay as you go from your own twitterapi.io balance. Bots only read X, never post. Turn it on per bot in its settings under Access.",
  "keys.twitterapi.link": "twitterapi.io dashboard",
  "keys.twitterapi.testOk": "Works. About ${dollars} of credit left.",
```

`src/components/SettingsModal.tsx`: add `"x", "twitter", "twitterapi", "scraper"` to the `connections` keywords array. Add the row directly after `<ApiKeyRow section="box" />`:

```tsx
              <ApiKeyRow section="twitterapi" testProvider="twitterapi" />
```

- [ ] **Step 4: Implement the Access card**

In `src/components/bot-settings/AccessSection.tsx`, add above `export function AccessSection`:

```tsx
/** X research: four read-only X tools paid from the workspace's own
 * twitterapi.io key. Off unless the person turns it on for this bot; a bot
 * already on can always be switched off, even after the key is cleared. */
function XResearchCard({ bot, patch }: { bot: Bot; patch: (patch: { xResearch: boolean }) => void }) {
  const { state, dispatch } = useStore();
  const keySaved = state.config?.twitterapi?.configured === true;
  const on = bot.xResearch === true;
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4" data-testid="access-x-research">
      <div>
        <div className="text-[15px] font-medium text-ink">X research</div>
        <div className="mt-0.5 text-[13px] text-ink-secondary">
          {!keySaved ? (
            <>
              Add a twitterapi.io key in{" "}
              <button
                type="button"
                className="underline"
                onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
              >
                Settings → API keys
              </button>{" "}
              to let bots search and read X.
            </>
          ) : on ? (
            "This bot can search and read X. Each search spends a little of your twitterapi.io credit."
          ) : (
            "Let this bot search and read X without an X account. It only reads, never posts."
          )}
        </div>
      </div>
      <Switch
        checked={on}
        aria-label="Let this bot search and read X"
        disabled={!keySaved && !on}
        onClick={() => patch({ xResearch: !on })}
        className="disabled:cursor-not-allowed"
      />
    </div>
  );
}
```

Render it right after the Browser card's closing `</div>` (before the Webhooks card):

```tsx
      <XResearchCard bot={bot} patch={patch} />
```

If `patch`'s type does not accept `{ xResearch: boolean }`, Task 3's `bot-patch-queue.ts` change is missing. Fix it there; do not cast.

- [ ] **Step 5: Docs**

In `apps/docs/content/docs/connected-apps/index.mdx`, insert directly under the `## Connect X (Twitter)` heading:

```mdx
To let bots **search and read** X, you do not need an X account or this connector. Paste a [twitterapi.io](https://twitterapi.io) key under **App Settings → API keys → X research**, then turn on **X research** in a bot's settings under **Access**. The bot gets read-only tools to search posts, read an account's posts, read a post with its replies, and look up a profile. Each call spends a little of your twitterapi.io balance. A routine on that bot can check X on a schedule and report only new posts.

The steps below are only needed to **post** to X through Composio.
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm vitest run src/components/ApiKeys.test.ts src/components/bot-settings/AccessSection.test.ts src/components/SettingsModal.connections.test.ts src/locales src/lib/i18n.test.ts`
Expected: PASS. If a vocabulary or locale test flags a new string, fix the wording, not the test.

- [ ] **Step 7: Commit**

```bash
git add src/components/ApiKeys.tsx src/components/ApiKeys.test.ts src/components/SettingsModal.tsx src/components/bot-settings/AccessSection.tsx src/components/bot-settings/AccessSection.test.ts src/locales/en.json apps/docs/content/docs/connected-apps/index.mdx
git commit -m "feat(x-research): API keys row with balance Test, per-bot Access switch, docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Whole-branch verification and the local build

**Files:** none new.

- [ ] **Step 1: Lint, typecheck and the full suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green. Fix any failure where it comes from. Never update a golden or a baseline you did not mean to change.

- [ ] **Step 2: Real-key checks**

These need Omkar's twitterapi.io key, entered by him in the app, never in a shell or a file. With the OMB2 build from Step 3:
  - Press Test in Settings → API keys. It should show "Works. About $X of credit left." Confirm the dollar figure matches the twitterapi.io dashboard. If it does not, fix `CREDITS_PER_DOLLAR`.
  - Ask a switched-on bot: "Search X for posts mentioning MausBot this week." Confirm the posts and links are real.
  - Ask it to run the same search with the `newestId` it got as `sinceId`. Confirm it returns no repeats. If `since_id:` breaks the query, the client-side filter alone must still return no repeats.
  - Temporarily paste a wrong key, then call `x_search`. The bot should say "twitterapi.io rejected the API key…". Record twitterapi.io's actual error body in the PR notes, and adjust `errorFor` if its words differ.

- [ ] **Step 3: Hand off for a local test**

Use the `test-locally` skill to build OMB2 from `feat/x-research-tools`. Do not touch `/Applications/OpenMausBot.app`. Report the branch, the commits, and what Omkar should try. Do not push or open a PR.
