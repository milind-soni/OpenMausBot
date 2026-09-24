import { describe, expect, it } from "vitest";

import {
  describePart,
  describeSkip,
  PICTURE_MAX_BYTES,
  PICTURES_BASE64_BUDGET,
  preparePictures,
  shareRequestBody,
  type PictureTools,
} from "./team-share";
import { parsePackageDocument } from "../../shared/package-format";

const document = parsePackageDocument({
  format: "openmaus.package", version: 2,
  package: {
    id: "desk", release: "1.0.0", name: "Desk", tagline: "A desk.", summary: "A desk team.", category: "Sales",
    author: { name: "Mira" }, license: "MIT", outcomes: ["Answers."], setupMinutes: 2, requirements: { apps: [], capabilities: [] },
    team: { name: "Desk" },
    agents: [{ key: "scout", name: "Scout", appearance: { color: "cyan" } }],
    connections: [{ key: "crm", label: "CRM", reason: "Accounts.", mcp: { transport: "http", url: "https://example.com/mcp", valueNames: [] } }],
  },
});

describe("share team request", () => {
  it("builds the v2 export body without empty text or empty pictures", () => {
    expect(shareRequestBody({ team: "Sales desk", name: " Sales ", tagline: "  ", skills: "all", includeMemory: true, avatars: {}, dryRun: true }))
      .toEqual({ format: "package", version: 2, team: "Sales desk", name: "Sales", tagline: undefined, summary: undefined, release: undefined,
        notes: undefined, skills: "all", includeMemory: true, dryRun: true });
    expect(shareRequestBody({ team: "", skills: ["a"], includeMemory: false, avatars: { b1: "data:x" } }))
      .toMatchObject({ team: "", skills: ["a"], includeMemory: false, avatars: { b1: "data:x" } });
  });
});

describe("pictures", () => {
  const tools = (sizes: Record<string, number | null>, dataUrlLength = 100): PictureTools => ({
    fetchBlob: async (url) => new Blob([url]),
    shrink: async (blob) => {
      const size = sizes[await blob.text()];
      if (size === undefined) throw new Error("unreadable");
      return size === null ? null : new Blob([new Uint8Array(size)], { type: "image/webp" });
    },
    toDataUrl: async () => `data:image/webp;base64,${"A".repeat(dataUrlLength)}`,
  });

  it("offers each bot's own picture, skipping mascots, oversized and unreadable ones", async () => {
    const result = await preparePictures([
      { id: "mascot", avatarUrl: "/a/mascot.png", avatarCrop: "mascot" },
      { id: "none" },
      { id: "ok", avatarUrl: "/a/ok.png", avatarCrop: "circle" },
      { id: "big", avatarUrl: "/a/big.png", avatarCrop: "square" },
      { id: "broken", avatarUrl: "/a/broken.png", avatarCrop: "rounded" },
      { id: "undrawable", avatarUrl: "/a/null.png", avatarCrop: "rounded" },
    ], tools({ "/a/ok.png": 1_000, "/a/big.png": PICTURE_MAX_BYTES + 1, "/a/null.png": null }));
    expect(Object.keys(result.avatars)).toEqual(["ok"]);
    expect(result.skipped).toEqual([
      { botId: "big", reason: "picture_too_large" },
      { botId: "broken", reason: "picture_invalid" },
      { botId: "undrawable", reason: "picture_invalid" },
    ]);
  });

  it("stops adding pictures once they would pass the file's picture budget", async () => {
    const perPicture = Math.floor(PICTURES_BASE64_BUDGET / 2);
    const result = await preparePictures(
      ["a", "b", "c"].map((id) => ({ id, avatarUrl: `/a/${id}.png`, avatarCrop: "circle" })),
      tools({ "/a/a.png": 10, "/a/b.png": 10, "/a/c.png": 10 }, perPicture),
    );
    expect(Object.keys(result.avatars)).toEqual(["a"]);
    expect(result.skipped).toEqual([{ botId: "b", reason: "pictures_budget" }, { botId: "c", reason: "pictures_budget" }]);
  });
});

describe("part names", () => {
  it("turns part paths into words and never shows a value", () => {
    expect(describePart("agents[scout].soul", document)).toBe("Scout · standing instructions");
    expect(describePart('agents[scout].seed.memory["memory/pricing.md"]', document)).toBe("Scout · starter notes · memory/pricing.md");
    expect(describePart("connections[crm].mcp.url", document)).toBe("CRM · address");
    expect(describePart("team.brief", document)).toBe("shared instructions");
    expect(describePart("package.summary", document)).toBe("summary");
    expect(describeSkip({ part: "connections[local]", reason: "stdio_server" }, document)).toBe("local · connection — runs a command on this computer, so it is not shared");
    expect(describeSkip({ part: "agents[scout].appearance.avatar", reason: "something_new" }, document)).toBe("Scout · picture — something_new");
  });
});
