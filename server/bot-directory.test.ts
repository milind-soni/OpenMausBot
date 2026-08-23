import { describe, expect, it, vi } from "vitest";

import {
  BOT_DIRECTORY_API_URL,
  fetchBotDirectory,
  matchDirectoryBots,
  parseBotDirectory,
  type DirectoryBot,
} from "./bot-directory.ts";
import type { ProjectProfile } from "./project-scout.ts";

const entry = (over: Partial<Record<string, unknown>> = {}) => ({
  slug: "release-scribe",
  name: "Release Scribe",
  category: "Docs",
  integrations: ["GitHub"],
  prompt: "Set up a bot that drafts release notes.",
  detailUrl: "https://botdirectory.ai/bots/release-scribe/",
  ...over,
});

describe("parseBotDirectory", () => {
  it("accepts the published shape and keeps only the fields we use", () => {
    const bots = parseBotDirectory({ version: 1, bots: [entry({ contributor: "someone", addedAt: "2026" })] });
    expect(bots).toEqual([
      {
        slug: "release-scribe",
        name: "Release Scribe",
        category: "Docs",
        integrations: ["GitHub"],
        prompt: "Set up a bot that drafts release notes.",
        detailUrl: "https://botdirectory.ai/bots/release-scribe/",
      },
    ]);
  });

  it("drops malformed entries instead of failing the whole directory", () => {
    const bots = parseBotDirectory({
      version: 1,
      bots: [
        entry(),
        entry({ slug: "UPPER CASE" }),
        entry({ slug: "no-prompt", prompt: "" }),
        entry({ slug: "elsewhere", detailUrl: "https://evil.example/bots/x/" }),
        entry(), // duplicate slug
        "not an object",
      ],
    });
    expect(bots.map((bot) => bot.slug)).toEqual(["release-scribe"]);
  });

  it("rejects a response that is not the directory", () => {
    expect(() => parseBotDirectory({ version: 2, bots: [] })).toThrow("not supported");
    expect(() => parseBotDirectory([])).toThrow("not supported");
  });
});

describe("fetchBotDirectory", () => {
  it("fetches, validates, and passes errors through", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ version: 1, bots: [entry()] })));
    await expect(fetchBotDirectory(ok as unknown as typeof fetch)).resolves.toHaveLength(1);
    expect(ok).toHaveBeenCalledWith(BOT_DIRECTORY_API_URL, expect.objectContaining({ redirect: "error" }));

    const down = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(fetchBotDirectory(down as unknown as typeof fetch)).rejects.toThrow("HTTP 503");
  });

  it("rejects an oversized response while reading, not after buffering it whole", async () => {
    // no content-length header on purpose: the announced-size shortcut must
    // not be the only guard. The stream never ends on its own — the fetch
    // has to bail the moment the cap is crossed, or this test times out.
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const big = vi.fn(async () => new Response(endless));
    await expect(fetchBotDirectory(big as unknown as typeof fetch)).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
    // barely past the 1 MB cap — nowhere near what an unbounded read would take
    expect(sent).toBeLessThan(2_000_000);

    const announced = vi.fn(async () =>
      new Response("{}", { headers: { "content-length": String(50_000_000) } }),
    );
    await expect(fetchBotDirectory(announced as unknown as typeof fetch)).rejects.toThrow("too large");
  });
});

describe("matchDirectoryBots", () => {
  const profile: ProjectProfile = {
    name: "Shop",
    summary: "A storefront with payments.",
    stacks: ["TypeScript", "React"],
    signals: [{ role: "frontend", evidence: ["react"] }],
  };
  const bots: DirectoryBot[] = [
    { ...entry(), slug: "react-reviewer", name: "React Reviewer", category: "Engineering", integrations: ["GitHub"] } as DirectoryBot,
    { ...entry(), slug: "payments-auditor", name: "Payments Auditor", category: "Finance", integrations: ["Stripe"] } as DirectoryBot,
    { ...entry(), slug: "gig-closer", name: "Gig Closer", category: "Ops", integrations: ["QuickBooks"] } as DirectoryBot,
  ];

  it("returns only bots that overlap the profile, best match first, with the matched terms", () => {
    const matched = matchDirectoryBots(profile, bots);
    expect(matched.map((bot) => bot.slug)).toEqual(["react-reviewer", "payments-auditor"]);
    expect(matched[0]!.matched).toContain("react");
    expect(matched[1]!.matched).toContain("payments");
  });

  it("honors the limit", () => {
    expect(matchDirectoryBots(profile, bots, 1)).toHaveLength(1);
  });

  it("ignores stack names too short to mean anything as substrings", () => {
    const goProfile: ProjectProfile = { name: "svc", summary: "", stacks: ["Go"], signals: [] };
    const google = { ...entry(), slug: "google-helper", name: "Google Helper", category: "Ops", integrations: [] } as DirectoryBot;
    expect(matchDirectoryBots(goProfile, [google])).toEqual([]);
  });
});
