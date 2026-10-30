import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  TEAM_LIBRARY_CATALOG_URL,
  TEAM_LIBRARY_RAW_ROOT,
  fetchGithubTeam,
  fetchGrokTemplateCard,
  grokShareIdFromMarketplace,
  fetchLibraryTeam,
  grokCardFromHtml,
  githubManifestUrls,
  libraryTeamRoles,
  parseTeamCatalog,
} from "./team-library.ts";

const manifest = {
  format: "openmaus.team",
  version: 2,
  team: {
    name: "Engineering",
    members: [
      {
        key: "lead",
        name: "Ada",
        title: "Tech Lead",
        description: "Coordinates the work",
        appearance: { color: "purple" },
      },
    ],
  },
};

const catalog = {
  format: "openmaus.catalog",
  version: 1,
  teams: [
    {
      slug: "engineering",
      name: "Engineering Team",
      summary: "Plan and ship software.",
      category: "Engineering",
      manifest: "teams/engineering/team.mausteam.json",
      readme: "teams/engineering/README.md",
      members: 1,
      skills: ["teams/engineering/skills/release/SKILL.md"],
      requires: { apps: ["GitHub"] },
    },
  ],
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("team library", () => {
  it("validates catalog paths and adds the trusted repository URL", () => {
    const parsed = parseTeamCatalog(catalog);
    expect(parsed.repositoryUrl).toBe("https://github.com/milind-soni/openmausbot-teams");
    expect(parsed.teams[0]).toMatchObject({ slug: "engineering", members: 1 });

    const unsafe = structuredClone(catalog);
    unsafe.teams[0]!.manifest = "../private.json";
    expect(() => parseTeamCatalog(unsafe)).toThrow("safe catalog path");
  });

  it("loads only the manifest selected by the trusted catalog", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === TEAM_LIBRARY_CATALOG_URL) return response(catalog);
      if (target === `${TEAM_LIBRARY_RAW_ROOT}/teams/engineering/team.mausteam.json`) return response(manifest);
      return response({}, 404);
    }) as unknown as typeof fetch;

    const loaded = await fetchLibraryTeam("engineering", fetcher);
    if (loaded.format !== "openmaus.team") throw new Error("expected a legacy team");
    expect(loaded.team.name).toBe("Engineering");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("normalizes public GitHub repository, blob, and raw links", () => {
    expect(githubManifestUrls("https://github.com/acme/team")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/botmrr.md",
      "https://raw.githubusercontent.com/acme/team/main/team.md",
      "https://raw.githubusercontent.com/acme/team/main/team.mausteam.json",
      "https://raw.githubusercontent.com/acme/team/master/botmrr.md",
      "https://raw.githubusercontent.com/acme/team/master/team.md",
      "https://raw.githubusercontent.com/acme/team/master/team.mausteam.json",
    ]);
    expect(githubManifestUrls("https://github.com/acme/team/blob/main/presets/seo.mausteam.json")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/presets/seo.mausteam.json",
    ]);
    expect(githubManifestUrls("https://raw.githubusercontent.com/acme/team/main/team.mausteam.json")).toEqual([
      "https://raw.githubusercontent.com/acme/team/main/team.mausteam.json",
    ]);
    expect(() => githubManifestUrls("http://example.com/team.json")).toThrow("public HTTPS GitHub");
    expect(() => githubManifestUrls("https://github.com/acme/team/blob/main/run.sh")).toThrow("Markdown playbook");
  });

  it("falls back from main to master for a repository link", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("team.mausteam.json") && String(url).includes("/master/")
        ? response(manifest)
        : response({}, 404),
    ) as unknown as typeof fetch;

    const loaded = await fetchGithubTeam("https://github.com/acme/team", fetcher);
    if (loaded.format !== "openmaus.team") throw new Error("expected a legacy team");
    expect(loaded.team.members[0]?.name).toBe("Ada");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("loads a shared team file (package v2) from GitHub as a file, without its claimed publisher", async () => {
    const shared = JSON.parse(readFileSync(join(import.meta.dirname, "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8"));
    const fetcher = vi.fn(async () => response(shared)) as unknown as typeof fetch;
    const loaded = await fetchGithubTeam("https://github.com/acme/team/blob/main/sales-desk-1.3.0.openmaus.json", fetcher);
    if (loaded.format !== "openmaus.package" || loaded.version !== 2) throw new Error("expected a shared team");
    expect(loaded.package.team?.name).toBe("Sales desk");
    expect(loaded.package.publisher).toBeUndefined();
  });
});

describe("the team library as a Chief of Staff reads it", () => {
  const entry = (slug: string, name: string, summary: string, file: { package?: string }) => ({
    ...catalog.teams[0]!, slug, name, summary, ...file,
    manifest: `teams/${slug}/team.mausteam.json`, readme: `teams/${slug}/README.md`, members: 2, skills: [],
  });
  const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "shared", "package-fixtures", name), "utf8");
  const long = { ...manifest, team: { ...manifest.team, members: [{ ...manifest.team.members[0]!, description: `Plans the work.\n\n${"Checks every step. ".repeat(30)}` }] } };
  const library = {
    ...catalog,
    teams: [
      catalog.teams[0]!,
      entry("signal-desk", "Signal Desk", "Find and explain the signal.", { package: "packages/signal-desk.md" }),
      entry("sales-desk", "Sales Desk", "Sell the team plan.", {}),
      entry("gone", "Gone", "Its file is missing.", {}),
      entry("long", "Long", "One very long role.", {}),
    ],
  };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const target = String(url).slice(TEAM_LIBRARY_RAW_ROOT.length + 1);
    if (String(url) === TEAM_LIBRARY_CATALOG_URL) return response(library);
    if (target === "teams/engineering/team.mausteam.json") return response(manifest);
    if (target === "packages/signal-desk.md") return new Response(fixture("legacy-botmrr.v1.md"));
    if (target === "teams/sales-desk/team.mausteam.json") return new Response(fixture("full-team.v2.json"));
    if (target === "teams/long/team.mausteam.json") return response(long);
    return response({}, 404);
  }) as unknown as typeof fetch;

  it("lists every ready-made team with its summary and roles, marks the team's own lead, and keeps a team whose file is missing", async () => {
    const teams = await libraryTeamRoles(fetcher);
    expect(teams.slice(0, 4)).toEqual([
      { name: "Engineering Team", summary: "Plan and ship software.", roles: [{ name: "Ada", title: "Tech Lead", does: "Coordinates the work" }] },
      { name: "Signal Desk", summary: "Find and explain the signal.", roles: [
        { name: "Package Scout", title: "Researcher", does: "Find evidence.", lead: true },
        { name: "Package Editor", title: "Editor", does: "Explain the result." },
      ] },
      { name: "Sales Desk", summary: "Sell the team plan.", roles: [
        { name: "Morgan", title: "Sales lead", does: "Owns the pipeline and the final answer.", lead: true },
        { name: "Scout", title: "Prospect researcher", does: "Finds and qualifies prospects." },
        { name: "Quill", title: "Outreach writer", does: "Drafts outreach for approval." },
      ] },
      { name: "Gone", summary: "Its file is missing.", roles: [] },
    ]);
    const does = teams[4]!.roles[0]!.does!;
    expect(does.startsWith("Plans the work. Checks every step.")).toBe(true);
    expect(does.length).toBe(280);
    expect(does.endsWith("…")).toBe(true);
  });

  it("fails when the catalog itself can't be read", async () => {
    await expect(libraryTeamRoles(vi.fn(async () => response({}, 503)) as unknown as typeof fetch)).rejects.toThrow("HTTP 503");
  });
});

const GROK_ID = "d8OshqLZvtcKDcNluPuyo";
const grokPage = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html", ...headers } });

describe("Grok Bot share cards", () => {
  it("reads the page's embedded record: name, creator, full description and colour", async () => {
    const fetcher = vi.fn(async () => html(grokPage("grok-share-page.html"))) as unknown as typeof fetch;
    const card = await fetchGrokTemplateCard(`https://www.x.ai/bot/${GROK_ID}/?ref=share`, fetcher);
    expect(card).toEqual({
      shareId: GROK_ID,
      name: "DOGE (Department of Grok Efficiency)",
      creator: "Avid",
      description: "A Grok Bot whose only job is to audit your other bots and routines, flag what to cut or merge, and find bottlenecks. It never changes anything without your yes.",
      url: `https://x.ai/bot/${GROK_ID}`,
      color: "#FF9800",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`https://x.ai/bot/${GROK_ID}`);
    expect(init).toMatchObject({ redirect: "manual" });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts the grokbot:// button link and a page without a creator", async () => {
    const fetcher = vi.fn(async () => html(grokPage("grok-share-page-anonymous.html"))) as unknown as typeof fetch;
    const card = await fetchGrokTemplateCard("grokbot://app/v1/bot-template?id=NIEguoGUjA648fUPle8F5", fetcher);
    expect(card).toMatchObject({ shareId: "NIEguoGUjA648fUPle8F5", name: "Overheard", url: "https://x.ai/bot/NIEguoGUjA648fUPle8F5" });
    expect(card.creator).toBeUndefined();
    expect(card.description).toMatch(/never posts on your behalf\.$/);
  });

  it("follows a marketplace page to the share link its Add button points at", async () => {
    const market = `<script>self.__next_f.push([1,"{\\"id\\":\\"dr-eggbot-v2\\",\\"addHref\\":\\"/bot/aaaaaaaaaaaaaaaaaaaaa\\"},{\\"id\\":\\"overheard\\",\\"name\\":\\"Overheard\\",\\"addHref\\":\\"/bot/NIEguoGUjA648fUPle8F5\\"}"])</script>`;
    const fetcher = vi.fn(async (url: string) => html(url.includes("/marketplace/") ? market : grokPage("grok-share-page-anonymous.html"))) as unknown as typeof fetch;
    const card = await fetchGrokTemplateCard("https://x.ai/bot/marketplace/bots/overheard", fetcher);
    expect(card).toMatchObject({ shareId: "NIEguoGUjA648fUPle8F5", name: "Overheard", url: "https://x.ai/bot/NIEguoGUjA648fUPle8F5" });
    const urls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url);
    expect(urls).toEqual(["https://x.ai/bot/marketplace/bots/overheard", "https://x.ai/bot/NIEguoGUjA648fUPle8F5"]);
    expect(grokShareIdFromMarketplace(market, "dr-eggbot-v2")).toBe("aaaaaaaaaaaaaaaaaaaaa");
    expect(grokShareIdFromMarketplace(market, "missing")).toBeNull();
    const none = vi.fn(async () => html("<html>nothing</html>")) as unknown as typeof fetch;
    await expect(fetchGrokTemplateCard("https://x.ai/bot/marketplace/bots/overheard", none)).rejects.toMatchObject({ status: 404 });
  });

  it("falls back to the og tags when the embedded record is missing", () => {
    const page = grokPage("grok-share-page.html").replace(/<script>self\.__next_f[\s\S]*?<\/script>/, "");
    expect(page).not.toContain("botName");
    expect(grokCardFromHtml(page, GROK_ID)).toEqual({
      shareId: GROK_ID,
      name: "DOGE (Department of Grok Efficiency)",
      creator: "Avid",
      description: "A Grok Bot whose only job is to audit your other bots and routines, flag what to cut or merge, and find bottlenecks. It never changes anything without...",
      url: `https://x.ai/bot/${GROK_ID}`,
    });
    expect(grokCardFromHtml('<meta property="og:title" content="Tom &amp; Jerry&#39;s bot"/>', GROK_ID)).toMatchObject({ name: "Tom & Jerry's bot" });
    expect(() => grokCardFromHtml("<html><title>Grok</title></html>", GROK_ID)).toThrow("did not show a Grok Bot");
  });

  it("never fetches anything but an x.ai share page", async () => {
    const fetcher = vi.fn(async () => html(grokPage("grok-share-page.html"))) as unknown as typeof fetch;
    for (const link of [
      `https://evil.example/bot/${GROK_ID}`,
      `https://x.ai.evil.example/bot/${GROK_ID}`,
      `http://x.ai/bot/${GROK_ID}`,
      "https://x.ai/bot/marketplace",
      "https://github.com/acme/team",
    ]) {
      await expect(fetchGrokTemplateCard(link, fetcher), link).rejects.toMatchObject({ status: 400 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("follows a redirect only while it stays on x.ai over https", async () => {
    const hop = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith("https://x.ai/")
        ? html("", 308, { location: `https://www.x.ai/bot/${GROK_ID}` })
        : html(grokPage("grok-share-page.html"))) as unknown as typeof fetch;
    expect((await fetchGrokTemplateCard(`https://x.ai/bot/${GROK_ID}`, hop)).name).toBe("DOGE (Department of Grok Efficiency)");
    expect(hop).toHaveBeenCalledTimes(2);

    for (const location of ["https://evil.example/steal", "http://www.x.ai/bot/x", "https://x.ai:444/bot/x"]) {
      const offHost = vi.fn(async (url: string | URL | Request) =>
        String(url) === `https://x.ai/bot/${GROK_ID}` ? html("", 302, { location }) : html(grokPage("grok-share-page.html"))) as unknown as typeof fetch;
      await expect(fetchGrokTemplateCard(`https://x.ai/bot/${GROK_ID}`, offHost), location).rejects.toThrow("tried to leave x.ai");
      expect(offHost, location).toHaveBeenCalledTimes(1);
    }

    const loop = vi.fn(async () => html("", 301, { location: `https://x.ai/bot/${GROK_ID}` })) as unknown as typeof fetch;
    await expect(fetchGrokTemplateCard(`https://x.ai/bot/${GROK_ID}`, loop)).rejects.toThrow("did not show the Grok Bot page");
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it("caps the page at 2 MB, names a missing bot, and reports a timeout", async () => {
    const big = vi.fn(async () => html(`${grokPage("grok-share-page.html")}${" ".repeat(2 * 1024 * 1024)}`)) as unknown as typeof fetch;
    await expect(fetchGrokTemplateCard(`https://x.ai/bot/${GROK_ID}`, big)).rejects.toThrow("too large");
    const announced = vi.fn(async () => html("", 200, { "content-length": String(3 * 1024 * 1024) })) as unknown as typeof fetch;
    await expect(fetchGrokTemplateCard(`https://x.ai/bot/${GROK_ID}`, announced)).rejects.toThrow("too large");
    const missing = vi.fn(async () => html("Not found", 404)) as unknown as typeof fetch;
    await expect(fetchGrokTemplateCard(`https://x.ai/bot/${GROK_ID}`, missing)).rejects.toMatchObject({ status: 404 });
    const slow = vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    await expect(fetchGrokTemplateCard(`https://x.ai/bot/${GROK_ID}`, slow)).rejects.toThrow("within 20 seconds");
  });
});
