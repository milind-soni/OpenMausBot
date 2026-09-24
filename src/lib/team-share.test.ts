import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  describePart,
  describeSkip,
  includedSkills,
  notesLine,
  PICTURE_MAX_BYTES,
  PICTURES_BASE64_BUDGET,
  preparePictures,
  requestedSkills,
  SHARE_DIALOG_DEFAULTS,
  SHARE_VIEW_START,
  shareAnswered,
  shareRefused,
  shareRequestBody,
  skillChoicesFrom,
  startingTicks,
  tickedSkills,
  type PictureTools,
  type ShareResponse,
} from "./team-share";
import { packageSummary, parsePackageDocument } from "../../shared/package-format";

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

// Lead holds pricing-policy; Scout holds pricing-policy and research-brief.
const full = parsePackageDocument(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8")));
const leadOverLimit = { part: "agents[lead].skills[pricing-policy]", reason: "bot_skill_limit" };

describe("share team request", () => {
  it("builds the v2 export body without empty text or empty pictures", () => {
    expect(shareRequestBody({ team: "Sales desk", name: " Sales ", tagline: "  ", skills: "all", includeMemory: true, avatars: {}, dryRun: true }))
      .toEqual({ format: "package", version: 2, team: "Sales desk", name: "Sales", tagline: undefined, summary: undefined, release: undefined,
        notes: undefined, skills: "all", includeMemory: true, dryRun: true });
    expect(shareRequestBody({ team: "", skills: ["a"], includeMemory: false, avatars: { b1: "data:x" } }))
      .toMatchObject({ team: "", skills: ["a"], includeMemory: false, avatars: { b1: "data:x" } });
  });
});

describe("skill choices", () => {
  const names = Array.from({ length: 31 }, (_, index) => `step-${String(index + 1).padStart(2, "0")}`);

  it("reads the team's skills from an answer and from a refusal alike", () => {
    expect(skillChoicesFrom({ choices: { skills: names } })).toEqual(names);
    expect(skillChoicesFrom({ error: "Morgan has more than 30 skills.", choices: { skills: ["a"] } })).toEqual(["a"]);
    for (const nothing of [undefined, null, {}, { choices: {} }, { choices: { skills: [1] } }, { choices: { skills: "all" } }]) {
      expect(skillChoicesFrom(nothing)).toBeNull();
    }
    expect(includedSkills(document)).toEqual([]);
  });

  it("asks for all until a box changes, then exactly the ticked skills the team still has", () => {
    expect(requestedSkills(null, names)).toBe("all");
    expect(requestedSkills(new Set(["step-01", "gone"]), names)).toEqual(["step-01"]);
    expect(requestedSkills(new Set(["step-01"]), null)).toEqual(["step-01"]);
  });

  it("ticks what the file holds first, so changing one box keeps a choice that fits", () => {
    const fits = names.slice(0, 30);
    expect([...tickedSkills(null, fits, names)]).toEqual(fits);
    expect([...tickedSkills(null, null, names)]).toEqual(names);
    expect([...tickedSkills(new Set(["step-31"]), fits, names)]).toEqual(["step-31"]);
    expect([...tickedSkills(null, null, null)]).toEqual([]);
  });

  it("starts without a name a bot left out over its limit, even when another bot's copy is in the file", () => {
    // Lead holds pricing-policy over its 30; Scout's copy is in the file.
    // Ticked, it would be asked for on both bots and refused.
    expect(includedSkills(full)).toEqual(["pricing-policy", "research-brief", "objection-handling"]);
    expect(startingTicks({ document: full, skipped: [
      leadOverLimit,
      { part: "skills[research-brief]", reason: "skill_changed" },
      { part: "agents[lead].appearance.avatar", reason: "picture_too_large" },
    ] })).toEqual(["research-brief", "objection-handling"]);
    expect(startingTicks({ document: full, skipped: [] })).toEqual(includedSkills(full));
  });
});

describe("the dialog's state", () => {
  const answer = (skills: string[], extra: Partial<ShareResponse> = {}): ShareResponse => ({
    document, filename: "desk-1.0.0.openmaus.json", redacted: [], skipped: [], summary: packageSummary(document), choices: { skills }, ...extra,
  });

  it("starts with pictures and starter notes included, and says so under the notes box", () => {
    expect(SHARE_DIALOG_DEFAULTS).toEqual({ includePictures: true, includeMemory: true });
    expect(shareRequestBody({ team: "Desk", skills: "all", includeMemory: SHARE_DIALOG_DEFAULTS.includeMemory })).toMatchObject({ includeMemory: true });
    expect(notesLine(SHARE_DIALOG_DEFAULTS.includeMemory)).toMatch(/^Starter notes are included/);
    expect(notesLine(false)).toMatch(/^Starter notes are not included/);
  });

  it("shows counts from an answer, and sets the starting ticks only from the first look", () => {
    const first = shareAnswered({ ...SHARE_VIEW_START, error: "old" }, answer(["a", "b"], { document: full, skipped: [leadOverLimit] }), true);
    expect(first).toMatchObject({ available: ["a", "b"], included: ["research-brief", "objection-handling"], error: "" });
    expect(first.preview?.filename).toBe("desk-1.0.0.openmaus.json");
    const chosen = shareAnswered({ ...first, included: ["a"] }, answer(["a", "b", "c"]), false);
    expect(chosen).toMatchObject({ available: ["a", "b", "c"], included: ["a"] });
  });

  it("drops the counts on a refusal (no Save) but keeps every skill box", () => {
    const counted = shareAnswered(SHARE_VIEW_START, answer(["a", "b"]), true);
    const refusal = Object.assign(new Error("Morgan has more than 30 skills. Choose fewer skills and try again."),
      { body: { error: "Morgan has more than 30 skills.", choices: { skills: ["a", "b", "c"] } } });
    expect(shareRefused(counted, refusal)).toEqual({ preview: null, available: ["a", "b", "c"], included: [],
      error: "Morgan has more than 30 skills. Choose fewer skills and try again." });
    // A refusal that names no skills (a network error) keeps the boxes already drawn.
    expect(shareRefused(counted, new Error("offline"))).toEqual({ preview: null, available: ["a", "b"], included: [], error: "offline" });
    expect(shareRefused(SHARE_VIEW_START, "down")).toEqual({ ...SHARE_VIEW_START, error: "down" });
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
    expect(describeSkip({ part: "agents[scout].skills[step-31]", reason: "bot_skill_limit" }, document))
      .toBe("Scout · skill · step-31 — a bot can share at most 30 skills (switched-on skills go first)");
    expect(describeSkip({ part: "skills[pricing]", reason: "skill_conflict" }, document)).toBe("pricing · skill — two bots have different skills with this name");
    expect(describeSkip({ part: "skills[extra]", reason: "team_skill_limit" }, document)).toBe("extra · skill — a team can share at most 60 skills");
  });
});
