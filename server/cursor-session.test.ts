import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CURSOR_SESSION_FILE, CursorFallback, GROK_BOT_PLAN_NOTE, createCursorSession, cursorLogin } from "./cursor-session.ts";
import { redactSecretsInText } from "./redact.ts";
import type { GrokTemplateCard } from "../shared/grok-import.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const jwt = (exp: number) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "user", exp })).toString("base64url")}.c2lnbmF0dXJlLXZhbHVl`;
const TOKEN = jwt(4_102_444_800); // 2100
const card: GrokTemplateCard = {
  shareId: "NIEguoGUjA648fUPle8F5", name: "Overheard", creator: "Matt", description: "Watches the web for mentions.", url: "https://x.ai/bot/NIEguoGUjA648fUPle8F5",
};
const recipe = {
  profile: { name: "Overheard", description: "Watch Reddit, Hacker News and X for mentions. Stay quiet on dead days.", avatarColor: "#FF6700" },
  memory: "Brand: Acme.",
  gettingStarted: { content: "Ask for the brand names to watch." },
  skills: [{ name: "digest", description: "Write the digest.", content: "# Digest\n\nThree bullets." }],
  routines: [
    { slug: "weekday-digest", name: "Weekday digest", schedule: "0 9 * * 1-5", content: "Send the digest." },
    { slug: "on-mention", description: "When the brand is mentioned on X", content: "Flag it." },
  ],
  plugins: [{ pluginId: "slack" }, { pluginId: "x-search", name: "X search" }],
};

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

type Call = { url: string; init: RequestInit };
function harness(answer: (call: Call) => Response | Promise<Response>, start = 1_800_000_000_000) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-cursor-"));
  dirs.push(dataDir);
  const calls: Call[] = [];
  let clock = start;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const session = createCursorSession({ dataDir, fetcher, now: () => clock, log: (line) => logs.push(line) });
  return { session, calls, logs, dataDir, file: join(dataDir, CURSOR_SESSION_FILE), tick: (ms: number) => { clock += ms; } };
}
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

async function signIn(h: ReturnType<typeof harness>) {
  h.session.startSignIn();
  await h.session.status();
}

/** A Cursor that approves the sign-in, then serves import details and the recipe download. */
const cursorServer = (overrides: { details?: (call: Call) => Response; blob?: (call: Call) => Response } = {}) => (call: Call) => {
  if (call.url.startsWith("https://api2.cursor.sh/auth/poll")) return json({ accessToken: TOKEN, refreshToken: "refresh-value" });
  if (call.url === "https://api2.cursor.sh/aiserver.v1.GrokBotService/GetGrokBotTemplateImportDetails") {
    return overrides.details?.(call) ?? json({ blobGetUrl: "https://blobs.cursor-cdn.example/recipe.json?sig=abc" });
  }
  if (call.url.startsWith("https://blobs.cursor-cdn.example/")) return overrides.blob?.(call) ?? json(recipe);
  return json({ error: "unexpected" }, 500);
};

describe("Cursor sign-in", () => {
  it("builds the CLI's PKCE login: a sha256 challenge of a random verifier, a uuid, mode and redirect target", () => {
    const login = cursorLogin();
    expect(login.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.challenge).toBe(createHash("sha256").update(login.verifier).digest("base64url"));
    const url = new URL(login.url);
    expect(url.origin + url.pathname).toBe("https://cursor.com/loginDeepControl");
    expect(Object.fromEntries(url.searchParams)).toEqual({ challenge: login.challenge, uuid: login.uuid, mode: "login", redirectTarget: "cli" });
    expect(url.searchParams.has("verifier")).toBe(false);
    expect(cursorLogin().verifier).not.toBe(login.verifier);
  });

  it("polls api2.cursor.sh until the person approves, then keeps the token in a 0600 file and never shows it", async () => {
    let approved = false;
    const h = harness(() => (approved ? json({ accessToken: TOKEN }) : new Response("", { status: 404 })));
    const { url } = h.session.startSignIn();
    const challenge = new URL(url).searchParams.get("challenge");
    expect(await h.session.status()).toEqual({ signedIn: false, waiting: true });
    approved = true;
    const status = await h.session.status();
    expect(status).toEqual({ signedIn: true, waiting: false });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    // Not approved yet: the POST poll, then the CLI's GET fallback; approved: the POST answers.
    expect(h.calls.map((call) => call.init.method)).toEqual(["POST", "GET", "POST"]);
    for (const call of h.calls) {
      const poll = new URL(call.url);
      expect(poll.origin + poll.pathname).toBe("https://api2.cursor.sh/auth/poll");
      const sent = call.init.method === "POST" ? JSON.parse(String(call.init.body)) : Object.fromEntries(poll.searchParams);
      expect(sent.uuid).toBe(new URL(url).searchParams.get("uuid"));
      expect(createHash("sha256").update(sent.verifier).digest("base64url")).toBe(challenge);
      expect(header(call, "x-cursor-client-type")).toBe("cli");
      expect(header(call, "authorization")).toBeNull();
      expect(call.init.redirect).toBe("error");
    }
    expect(JSON.parse(readFileSync(h.file, "utf8")).accessToken).toBe(TOKEN);
    if (process.platform !== "win32") expect(statSync(h.file).mode & 0o777).toBe(0o600);
    // Once signed in, a status check calls nobody.
    await h.session.status();
    expect(h.calls).toHaveLength(3);
  });

  it("gives up after ten minutes, and says so when Cursor refuses", async () => {
    const waiting = harness(() => new Response("", { status: 404 }));
    waiting.session.startSignIn();
    waiting.tick(11 * 60_000);
    expect(await waiting.session.status()).toEqual({ signedIn: false, waiting: false, error: "The Cursor sign-in timed out. Try again." });

    const refused = harness(() => new Response("", { status: 403 }));
    refused.session.startSignIn();
    expect(await refused.session.status()).toMatchObject({ signedIn: false, waiting: false, error: expect.stringContaining("HTTP 403") });
    const empty = harness(() => json({}));
    empty.session.startSignIn();
    expect((await empty.session.status()).error).toMatch(/no sign-in/);
    expect(existsSync(empty.file)).toBe(false);
  });

  it("signing out removes the stored session", async () => {
    const h = harness(cursorServer());
    await signIn(h);
    expect(existsSync(h.file)).toBe(true);
    h.session.signOut();
    expect(existsSync(h.file)).toBe(false);
    expect(await h.session.status()).toEqual({ signedIn: false, waiting: false });
    await expect(h.session.fetchTemplate(card)).rejects.toThrow("Sign in with Cursor");
    // A new session over the same folder starts signed out too.
    expect(await createCursorSession({ dataDir: h.dataDir, fetcher: vi.fn() as unknown as typeof fetch }).status()).toMatchObject({ signedIn: false });
  });

  it("forgets an expired token without calling Cursor", async () => {
    const h = harness((call) => (call.url.includes("/auth/poll") ? json({ accessToken: jwt(1_700_000_000) }) : json({})));
    await signIn(h);
    expect(await h.session.status()).toEqual({ signedIn: false, waiting: false, error: "Your Cursor sign-in expired. Sign in again." });
    expect(existsSync(h.file)).toBe(false);
  });
});

describe("Cursor template import", () => {
  it("asks api2.cursor.sh for the import details with the token, downloads the recipe without it, and maps it", async () => {
    const h = harness(cursorServer());
    await signIn(h);
    const x = await h.session.fetchTemplate(card);
    const [, details, blob] = h.calls;
    expect(details!.url).toBe("https://api2.cursor.sh/aiserver.v1.GrokBotService/GetGrokBotTemplateImportDetails");
    expect(details!.init.method).toBe("POST");
    expect(header(details!, "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(header(details!, "connect-protocol-version")).toBe("1");
    expect(JSON.parse(String(details!.init.body))).toEqual({ shareId: card.shareId });
    expect(blob!.url).toBe("https://blobs.cursor-cdn.example/recipe.json?sig=abc");
    expect(header(blob!, "authorization")).toBeNull();
    expect(blob!.init.redirect).toBe("error");
    expect(x).toMatchObject({
      format: "openmaus.grok/1",
      name: "Overheard",
      description: card.description,
      instructions: recipe.profile.description,
      creator: "Matt",
      sourceUrl: card.url,
      color: "#FF6700",
      memories: ["Brand: Acme."],
    });
    expect(x.skills.map((skill) => skill.name)).toEqual(["getting-started", "digest"]);
    expect(x.routines).toEqual([
      { name: "Weekday digest", schedule: "0 9 * * 1-5", cron: "", timeZone: "", prompt: "Send the digest." },
      { name: "on-mention", schedule: "When the brand is mentioned on X", cron: "", timeZone: "", prompt: "Flag it." },
    ]);
    expect(x.plugins.map((plugin) => plugin.name)).toEqual(["slack", "X search"]);
  });

  it("sends the token only to api2.cursor.sh, and refuses a download address that is not public https", async () => {
    for (const blobGetUrl of ["http://blobs.cursor-cdn.example/r.json", "https://127.0.0.1/r.json", "https://localhost/r.json", "https://user:pw@blobs.example/r", "not a url"]) {
      const h = harness(cursorServer({ details: () => json({ blobGetUrl }) }));
      await signIn(h);
      await expect(h.session.fetchTemplate(card), blobGetUrl).rejects.toThrow("does not understand");
      expect(h.calls.map((call) => new URL(call.url).host)).toEqual(["api2.cursor.sh", "api2.cursor.sh"]);
    }
    const h = harness(cursorServer());
    await signIn(h);
    await h.session.fetchTemplate(card);
    const withToken = h.calls.filter((call) => header(call, "authorization"));
    expect(withToken.map((call) => new URL(call.url).origin)).toEqual(["https://api2.cursor.sh"]);
  });

  it("falls back with one line on 401, a bad shape, a failed download or no network", async () => {
    const expired = harness(cursorServer({ details: () => json({ code: "unauthenticated", message: "ERROR_NOT_LOGGED_IN" }, 401) }));
    await signIn(expired);
    // Cursor's own reason is shown and logged, never a token; the refresh was tried once (it failed: no route).
    await expect(expired.session.fetchTemplate(card)).rejects.toThrow(new CursorFallback("Cursor refused the sign-in (HTTP 401: unauthenticated · ERROR_NOT_LOGGED_IN). Sign in again."));
    expect(expired.calls.filter((call) => call.url.endsWith("/oauth/token"))).toHaveLength(1);
    expect(expired.logs.join("\n")).toContain("cursor: template details refused (HTTP 401: unauthenticated · ERROR_NOT_LOGGED_IN)");
    expect(expired.logs.join("\n")).not.toContain(TOKEN);
    expect(existsSync(expired.file)).toBe(false);
    expect(await expired.session.status()).toMatchObject({ signedIn: false });

    for (const [label, overrides, message] of [
      ["no blob", { details: () => json({ template: { name: "x" } }) }, "does not understand"],
      ["bad recipe", { blob: () => json({ hello: "world" }) }, "does not understand"],
      ["not json", { blob: () => new Response("<html>", { status: 200 }) }, "does not understand"],
      ["blob 403", { blob: () => new Response("", { status: 403 }) }, "download failed (HTTP 403)"],
      ["details 500", { details: () => json({}, 500) }, "HTTP 500"],
    ] as const) {
      const h = harness(cursorServer(overrides));
      await signIn(h);
      await expect(h.session.fetchTemplate(card), label).rejects.toThrow(message);
      await expect(h.session.fetchTemplate(card), label).rejects.toBeInstanceOf(CursorFallback);
    }
    const offline = harness((call) => {
      if (call.url.includes("/auth/poll")) return json({ accessToken: TOKEN });
      throw new TypeError("fetch failed");
    });
    await signIn(offline);
    await expect(offline.session.fetchTemplate(card)).rejects.toThrow("Cursor could not be reached.");
  });

  it("says a Grok Bot plan is needed, and keeps the sign-in, when Cursor refuses an account without one", async () => {
    const h = harness(cursorServer({ details: () => json({ code: "unauthenticated", message: "Grok Bot requires an Ultra subscription or a Premium self-serve team seat", details: [{ debug: { error: "ERROR_UNAUTHORIZED" } }] }, 401) }));
    await signIn(h);
    await expect(h.session.fetchTemplate(card)).rejects.toThrow(new CursorFallback(GROK_BOT_PLAN_NOTE));
    expect(existsSync(h.file)).toBe(true);
    expect(await h.session.status()).toMatchObject({ signedIn: true });
  });

  it("refreshes the token once with the refresh token from sign-in, then asks again", async () => {
    const FRESH = jwt(4_102_444_801);
    const h = harness((call) => {
      if (call.url.startsWith("https://api2.cursor.sh/auth/poll")) return json({ accessToken: TOKEN, refreshToken: "refresh-value" });
      if (call.url === "https://api2.cursor.sh/oauth/token") return json({ access_token: FRESH, refresh_token: "refresh-2" });
      if (call.url.endsWith("/GetGrokBotTemplateImportDetails")) {
        return header(call, "authorization") === `Bearer ${FRESH}` ? json({ blobGetUrl: "https://blobs.cursor-cdn.example/recipe.json?sig=abc" }) : json({ code: "unauthenticated" }, 401);
      }
      if (call.url.startsWith("https://blobs.cursor-cdn.example/")) return json(recipe);
      return json({}, 500);
    });
    await signIn(h);
    expect(JSON.parse(readFileSync(h.file, "utf8")).refreshToken).toBe("refresh-value");
    await expect(h.session.fetchTemplate(card)).resolves.toBeTruthy();
    const refresh = h.calls.filter((call) => call.url === "https://api2.cursor.sh/oauth/token");
    expect(refresh).toHaveLength(1);
    expect(JSON.parse(String(refresh[0]!.init.body))).toEqual({ grant_type: "refresh_token", client_id: "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB", refresh_token: "refresh-value" });
    expect(header(refresh[0]!, "authorization")).toBeNull();
    expect(h.calls.filter((call) => call.url.endsWith("/GetGrokBotTemplateImportDetails"))).toHaveLength(2);
    expect(JSON.parse(readFileSync(h.file, "utf8"))).toMatchObject({ accessToken: FRESH, refreshToken: "refresh-2" });
    expect(redactSecretsInText(`a refresh-2 b`)).not.toContain("refresh-2");
  });

  it("takes an inline recipe or a grokbot-bundle/v1 straight from the details", async () => {
    const bundle = { format: "grokbot-bundle/v1", persona: { name: "Side", description: "Be the side chat." }, memories: [], skills: [], routines: [], plugins: [] };
    const h = harness(cursorServer({ details: () => json({ recipe: bundle }) }));
    await signIn(h);
    expect(await h.session.fetchTemplate(card)).toMatchObject({ format: "grokbot-bundle/v1", name: "Side", creator: "Matt", sourceUrl: card.url });
    expect(h.calls).toHaveLength(2);
  });

  it("never writes the token to the console, and masks it wherever the app redacts text", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const h = harness(cursorServer({ details: () => json({}, 401) }));
    await signIn(h);
    await h.session.fetchTemplate(card).catch(() => {});
    await signIn(h);
    await h.session.fetchTemplate(card).catch(() => {});
    const printed = logs.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(" "))).join("\n");
    expect(printed).not.toContain(TOKEN);
    expect(redactSecretsInText(`header ${TOKEN} sent`)).not.toContain(TOKEN);
    // A token with no key shape is masked by value while the session holds it.
    const opaque = "plainCursorSessionValue";
    const held = harness((call) => (call.url.includes("/auth/poll") ? json({ accessToken: opaque }) : json({})));
    expect(redactSecretsInText(`header ${opaque} sent`)).toContain(opaque);
    await signIn(held);
    expect(redactSecretsInText(`header ${opaque} sent`)).toBe("header •••••• sent");
    held.session.signOut();
    expect(redactSecretsInText(`header ${opaque} sent`)).toContain(opaque);
  });
});
