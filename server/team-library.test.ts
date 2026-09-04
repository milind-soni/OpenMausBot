import { describe, expect, it, vi } from "vitest";

import {
  BOT_SHARE_ORIGIN,
  TEAM_LIBRARY_CATALOG_URL,
  TEAM_LIBRARY_RAW_ROOT,
  fetchGithubTeam,
  fetchLibraryTeam,
  fetchSharedBotPackage,
  githubManifestUrls,
  parseTeamCatalog,
  sharedPackageUrl,
} from "./team-library.ts";
import { renderBotPackageMarkdown, type ParsedBotPackage } from "./bot-package.ts";

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

  it("fetches, validates, and parses only exact OpenMausBot shared package links", async () => {
    const shareId = "Abcdefghijklmnopqrstu";
    const url = `${BOT_SHARE_ORIGIN}/v1/bot-shares/${shareId}/package`;
    const document: ParsedBotPackage = {
      format: "openmaus.package",
      version: 1,
      package: {
        id: "shared-researcher",
        release: "1.0.0",
        name: "Shared Researcher",
        tagline: "Research a focused question.",
        summary: "A portable shared bot.",
        category: "Research",
        author: { name: "OpenMausBot user" },
        license: "Unspecified",
        outcomes: ["Produce a concise brief."],
        setupMinutes: 2,
        requirements: { apps: [], capabilities: [] },
        agents: [{ key: "researcher", name: "Shared Researcher", appearance: { color: "blue" } }],
        chiefOfStaff: "researcher",
      },
    };
    const markdown = renderBotPackageMarkdown(document);
    const fetcher = vi.fn(async (target: string | URL | Request) => {
      expect(String(target)).toBe(url);
      return new Response(markdown, { headers: { "content-type": "text/markdown" } });
    }) as unknown as typeof fetch;

    expect(sharedPackageUrl(url)).toBe(url);
    expect(sharedPackageUrl(`${BOT_SHARE_ORIGIN}/s/${shareId}`)).toBe(url);
    const loaded = await fetchSharedBotPackage(url, fetcher);
    expect(loaded).toEqual(document);
    expect(fetcher).toHaveBeenCalledOnce();
    for (const unsafe of [
      `${url}?version=1`,
      `${BOT_SHARE_ORIGIN}:443/v1/bot-shares/${shareId}/package`,
      `${BOT_SHARE_ORIGIN}/v1/bot-shares/short/package`,
      `https://accounts.openmausbot.com.evil.example/v1/bot-shares/${shareId}/package`,
      `${BOT_SHARE_ORIGIN}/share/${shareId}`,
    ]) {
      expect(() => sharedPackageUrl(unsafe)).toThrow("exact OpenMausBot");
    }
  });
});
