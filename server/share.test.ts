import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { redactSecretsInText } from "../shared/redact.ts";
import type { TemplateCard } from "../shared/share-card.ts";
import { readShareFolder } from "../shared/share-folder.ts";
import { createShareToolRoute, importSource, type ShareToolContext } from "./routes/share.ts";
import { GithubTemplateError } from "./share-github.ts";
import { createCommunityPublisher, type CommunityResult } from "./share-publish.ts";
import { pagesHomeSignature } from "./pages/access.ts";
import { createShareHost, readFolderFromDisk } from "./share.ts";
import type { Routine } from "./routines.ts";
import type { BotRecord } from "./store.ts";

const KEY = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const skillText = "---\nname: triage\ndescription: Sort the inbox.\n---\n\n# Triage\n\nNewest first.\n";
const folders: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-share-test-"));
  folders.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: "bot-1", name: "Helper", title: "Inbox helper", description: "Keeps the inbox tidy.", soul: `Be brief. The admin key is ${KEY}.`, color: "blue",
    section: "Ops", mcpServers: ["crm"], connectorTools: { gmail: { tools: "*" } }, toolsOff: ["images"], ...overrides,
  } as BotRecord;
}

const routine = { id: "r1", name: "Morning sweep", botId: "bot-1", prompt: "Sweep the inbox.", runOn: "maus", enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, durationMinutes: 30 } as unknown as Routine;

function host(options: { submit?: (submission: unknown) => Promise<CommunityResult>; signedIn?: boolean; bots?: BotRecord[]; picture?: (bot: BotRecord) => string | undefined } = {}) {
  const dataDir = scratch(), botFolder = scratch();
  const patches: Array<{ messageId: string; card: TemplateCard }> = [];
  const bots = options.bots ?? [bot()];
  const publisher = createCommunityPublisher({ access: () => options.signedIn === false ? null : { kind: "desktop", url: "https://admin.example.com/api/cloud/pages/token", token: "t" } });
  const share = createShareHost({
    dataDir, bots: () => bots, groups: () => [], routines: () => [routine], brief: () => undefined,
    collectTeamSkills: (list) => ({ ok: true, skipped: [], skillsByBot: new Map(list.map((each) => [each.id, [{ name: "triage", description: "Sort the inbox.", instructions: skillText, enabled: true }]])) }),
    picture: options.picture ?? (() => undefined), botFolder: (id) => join(botFolder, id),
    publisher: options.submit ? { ...publisher, submit: options.submit } : publisher,
    patch: (_threadId, messageId, _text, card) => patches.push({ messageId, card }),
  });
  return { share, dataDir, botFolder, patches, bots };
}

describe("making a template", () => {
  it("writes the bot's folder with no key, memory, chat or connection address, routines paused and apps by name", () => {
    const { share, botFolder } = host();
    const made = share.export({ scope: "bot", bot: bot() }, [routine]);
    expect(made.dir).toBe(join(botFolder, "bot-1", "templates", "helper"));
    expect(made.card).toMatchObject({ scope: "bot", name: "Helper", status: "draft", counts: { bots: 1, skills: 1, routines: 1, apps: 2 } });
    expect(made.card.redacted).toBeGreaterThan(0);
    const manifest = readFileSync(join(made.dir, "bot.md"), "utf8");
    expect(manifest).not.toContain(KEY);
    expect(manifest).not.toMatch(/https?:\/\/|seed:|MEMORY|approval|modelSelection|enabledAfterInstall: true/);
    expect(manifest).toContain("enabledAfterInstall: false");
    const folder = readShareFolder(readFolderFromDisk(made.dir));
    if (folder.kind !== "package") throw new Error("not a package");
    expect(folder.document.package.requirements.apps.map((app) => app.label)).toEqual(["Crm", "Gmail"]);
    expect(folder.document.package.agents[0]).toMatchObject({ tools: { off: ["images"] } });
    expect(folder.document.package.agents[0]).not.toHaveProperty("connections");
    expect(folder.document.package).not.toHaveProperty("connections");
  });

  it("makes the same template again in the same folder and keeps its card", () => {
    const { share } = host();
    const first = share.export({ scope: "bot", bot: bot() }, [routine]);
    const again = share.export({ scope: "bot", bot: bot({ name: "Helper" }) }, []);
    expect(again.card.id).toBe(first.card.id);
    expect(again.card.counts.routines).toBe(0);
  });

  it("refuses to publish a folder an edit put a key back into", async () => {
    const { share } = host({ submit: async () => ({ ok: true, link: "x", prUrl: "y" }) });
    const made = share.export({ scope: "bot", bot: bot() }, []);
    writeFileSync(join(made.dir, "skills", "triage", "SKILL.md"), `${skillText}\nUse ${KEY}.\n`);
    const card = await share.publish(made.card.id);
    expect(card.status).toBe("failed");
    expect(card.error).toMatch(/looks like a key or password/);
  });
});

describe("publishing", () => {
  it("offers the folder and GitHub's upload page when this app isn't signed in or the service isn't there", async () => {
    const { share } = host({ signedIn: false });
    const made = share.export({ scope: "bot", bot: bot() }, []);
    expect(made.card.fallback).toBe("sign_in");
    expect(await share.publish(made.card.id)).toMatchObject({ status: "draft", fallback: "sign_in" });
    for (const status of [404, 501]) {
      const publisher = createCommunityPublisher({ access: () => ({ kind: "desktop", url: "https://admin.example.com/api/cloud/pages/token", token: "t" }),
        fetch: (async () => new Response("{}", { status })) as typeof fetch });
      const result = await publisher.submit({ slug: "helper", files: {} });
      expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    }
  });

  it("posts the folder's files to the Admin with the account's sign-in, and shows the link it answers with", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    const publisher = createCommunityPublisher({
      access: () => ({ kind: "desktop", url: "https://admin.example.com/api/cloud/pages/token", token: "omb_pd_token" }),
      fetch: (async (url: string, init: RequestInit) => {
        sent = { url, init };
        return Response.json({ link: "https://github.com/milind-soni/openmausbot-teams/tree/abc/teams/helper", prUrl: "https://github.com/milind-soni/openmausbot-teams/pull/7" });
      }) as typeof fetch,
    });
    const result = await publisher.submit({ slug: "helper", files: { "bot.md": "x", "avatars/helper.png": { base64: "iVBORw0K" } } });
    expect(result).toEqual({ ok: true, link: "https://github.com/milind-soni/openmausbot-teams/tree/abc/teams/helper", prUrl: "https://github.com/milind-soni/openmausbot-teams/pull/7" });
    expect(sent!.url).toBe("https://admin.example.com/api/cloud/community/submissions");
    expect(sent!.init.redirect).toBe("error");
    expect((sent!.init.headers as Record<string, string>).authorization).toBe("Bearer omb_pd_token");
    expect(JSON.parse(String(sent!.init.body))).toEqual({ slug: "helper", files: { "bot.md": "x", "avatars/helper.png": { base64: "iVBORw0K" } } });
  });

  it("signs a Cloud home's submission over the community label, and shows the Admin's own sentence when it refuses", async () => {
    const home = { kind: "home" as const, url: "https://admin.example.com/api/cloud/pages/token", machineId: "cm-home", secret: "s".repeat(43) };
    let headers: Record<string, string> = {}, body = "";
    let answer = Response.json({ error: "slug_taken", message: "Someone else already shares a template by that name." }, { status: 409 });
    const publisher = createCommunityPublisher({ access: () => home, now: () => 1_792_670_400_000,
      fetch: (async (_url: string, init: RequestInit) => { headers = init.headers as Record<string, string>; body = String(init.body); return answer; }) as typeof fetch });
    expect(await publisher.submit({ slug: "a", files: { "bot.md": "x" } })).toEqual({ ok: false, reason: "failed", message: "Someone else already shares a template by that name." });
    const expected = pagesHomeSignature(home.secret, home.machineId, headers["x-omb-cloud-timestamp"]!, headers["x-omb-cloud-nonce"]!, body, "omb-community-v1");
    expect(headers["x-omb-cloud-signature"]).toBe(`v1=${expected}`);
    expect(expected).not.toBe(pagesHomeSignature(home.secret, home.machineId, headers["x-omb-cloud-timestamp"]!, headers["x-omb-cloud-nonce"]!, body));
    answer = Response.json({ prUrl: "https://github.com/milind-soni/openmausbot-teams/pull/2", link: "https://github.com/milind-soni/openmausbot-teams/tree/b/teams/a", updated: true });
    expect(await publisher.submit({ slug: "a", files: { "bot.md": "x" } })).toMatchObject({ ok: true, prUrl: "https://github.com/milind-soni/openmausbot-teams/pull/2" });
  });

  it("sends a folder the Admin's checks accept: BotMRR v2 frontmatter, skills named as their folders, pictures as base64, paused routines, under the caps", async () => {
    let sent: { slug: string; files: Record<string, string | { base64: string }> } | null = null;
    const pictured = bot({ id: "bot-2", name: "Painter" });
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const { share } = host({ bots: [bot(), pictured], picture: (each) => each.id === "bot-2" ? png : undefined, submit: async (submission) => { sent = submission as never; return { ok: false, reason: "failed", message: "x" }; } });
    const made = share.export({ scope: "department", section: "Ops", bots: [bot(), pictured] }, [routine]);
    await share.publish(made.card.id);
    const files = sent!.files;
    expect(Object.keys(files).filter((path) => path.startsWith("avatars/"))).toHaveLength(1);
    expect(Object.keys(files).length).toBeLessThanOrEqual(200);
    const total = Object.values(files).reduce((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : Buffer.from(value.base64, "base64").byteLength), 0);
    expect(total).toBeLessThanOrEqual(4 * 1024 * 1024);
    for (const [path, value] of Object.entries(files)) {
      expect(path).toMatch(/^(team\.md|bot\.md|README\.md|skills\/[a-z0-9-]+\/SKILL\.md|avatars\/[a-z0-9_-]+\.(webp|png|jpg))$/);
      if (path.startsWith("avatars/")) expect(typeof value === "object" && Buffer.from(value.base64, "base64").byteLength).toBeLessThanOrEqual(64 * 1024);
      else expect(typeof value).toBe("string");
      if (typeof value === "string") expect(redactSecretsInText(value)).toBe(value);
      const skill = path.match(/^skills\/([^/]+)\/SKILL\.md$/);
      if (skill) expect(parseYaml(String(value).match(/^---\n([\s\S]*?)\n---/)![1]!).name).toBe(skill[1]);
    }
    const meta = parseYaml(String(files["team.md"]).match(/^---\n([\s\S]*?)\n---/)![1]!);
    expect(meta).toMatchObject({ botmrr: 2, name: "Ops", tagline: expect.any(String) });
    expect(meta.tagline.length).toBeLessThanOrEqual(160);
    expect(meta.agents.length).toBeGreaterThanOrEqual(1);
    expect(meta.agents.length).toBeLessThanOrEqual(50);
    expect(meta.routines.every((each: { enabledAfterInstall: boolean }) => each.enabledAfterInstall === false)).toBe(true);
    for (const agent of meta.agents) for (const name of agent.skills ?? []) expect(files[`skills/${name}/SKILL.md`]).toBeTypeOf("string");
    const single = host({ submit: async (submission) => { sent = submission as never; return { ok: false, reason: "failed", message: "x" }; } });
    await single.share.publish(single.share.export({ scope: "bot", bot: bot() }, []).card.id);
    expect(parseYaml(String(sent!.files["bot.md"]).match(/^---\n([\s\S]*?)\n---/)![1]!).agents).toHaveLength(1);
  });

  it("never shows a link outside the community repository", async () => {
    const publisher = createCommunityPublisher({ access: () => ({ kind: "desktop", url: "https://admin.example.com/x", token: "t" }),
      fetch: (async () => Response.json({ link: "https://github.com/someone/else/tree/main/teams/a", prUrl: "https://github.com/milind-soni/openmausbot-teams/pull/1" })) as typeof fetch });
    expect(await publisher.submit({ slug: "a", files: {} })).toMatchObject({ ok: false, reason: "failed" });
  });

  it("re-draws every card that shows the template as it is published, fails and is deleted", async () => {
    let answer: CommunityResult = { ok: false, reason: "failed", message: "You've published a lot today. Try again tomorrow." };
    const { share, patches } = host({ submit: async () => answer });
    const made = share.export({ scope: "bot", bot: bot() }, []);
    share.shown(made.card.id, "thread-1", "message-1");
    expect(await share.publish(made.card.id)).toMatchObject({ status: "failed", error: "You've published a lot today. Try again tomorrow." });
    expect(patches.map((patch) => patch.card.status)).toEqual(["publishing", "failed"]);
    answer = { ok: true, link: "https://github.com/milind-soni/openmausbot-teams/tree/a/teams/helper", prUrl: "https://github.com/milind-soni/openmausbot-teams/pull/1" };
    expect(await share.publish(made.card.id)).toMatchObject({ status: "published", link: answer.link });
    expect(share.delete(made.card.id).status).toBe("gone");
    expect(existsSync(made.dir)).toBe(false);
    expect(patches.at(-1)!.card.status).toBe("gone");
  });
});

describe("reading a folder from disk", () => {
  it("reads only the template's files and nothing a link points out to", () => {
    const outside = scratch(), folder = scratch();
    writeFileSync(join(outside, "SKILL.md"), "---\nname: leak\ndescription: secret\n---\nOUTSIDE\n");
    writeFileSync(join(outside, "bot.md"), "OUTSIDE");
    mkdirSync(join(folder, "skills", "leak"), { recursive: true });
    symlinkSync(join(outside, "SKILL.md"), join(folder, "skills", "leak", "SKILL.md"));
    symlinkSync(outside, join(folder, "skills", "linked"));
    symlinkSync(join(outside, "bot.md"), join(folder, "bot.md"));
    writeFileSync(join(folder, "secrets.env"), KEY);
    expect(readFolderFromDisk(folder)).toEqual({});
  });

  it("looks one folder down, and caps the size", () => {
    const folder = scratch();
    mkdirSync(join(folder, "helper"));
    writeFileSync(join(folder, "helper", "bot.md"), "x");
    expect(Object.keys(readFolderFromDisk(folder))).toEqual(["helper/bot.md"]);
    writeFileSync(join(folder, "helper", "bot.md"), Buffer.alloc(6 * 1024 * 1024));
    expect(() => readFolderFromDisk(folder)).toThrow(/larger than 4 MB/);
    expect(() => readFolderFromDisk(join(folder, "missing"))).toThrow(/can't be opened/);
  });
});

describe("the share tool", () => {
  function call(body: Record<string, unknown>, personMessage: string | null, roots: string[] = []) {
    const { share } = host();
    let reached = 0;
    const route = createShareToolRoute({
      host: share, localFolders: false, bots: () => [bot()], routines: () => [], publicBot: (each) => each as never, publicGroup: (each) => each as never, broadcast: () => {},
      importDeps: async () => { throw new Error("not reached"); },
      fetchTemplate: async () => { reached += 1; throw new GithubTemplateError("Nothing was found at that GitHub link.", 404); },
    });
    let answer: { status: number; body: Record<string, unknown> } | null = null;
    const ctx: ShareToolContext = {
      method: "POST", path: "/api/internal/share", res: {} as ServerResponse,
      json: ((_res: unknown, status: number, value: Record<string, unknown>) => { answer = { status, body: value }; }) as never,
      readBody: async () => body, bot: bot(), threadId: "thread-1", personMessage, roots, post: () => "message-1",
    };
    return route(ctx).then(() => ({ ...answer!, reached }));
  }

  it("imports only a link the person wrote in their own message this turn", async () => {
    const link = "https://github.com/acme/teams/tree/main/teams/helper";
    expect(await call({ action: "import", url: link }, null)).toMatchObject({ status: 403, reached: 0 });
    expect(await call({ action: "import", url: link }, "Please import the helper from the community")).toMatchObject({ status: 403, reached: 0 });
    expect(await call({ action: "import", url: link }, `import ${link}`)).toMatchObject({ status: 404, reached: 1 });
  });

  it("reads a folder path only inside the bot's own folders off the desktop", async () => {
    const root = scratch(), elsewhere = scratch();
    expect(await call({ action: "import", path: elsewhere }, `add ${elsewhere}`, [root])).toMatchObject({ status: 403, body: { error: "That folder isn't one you can read here." } });
    expect((await call({ action: "import", path: root }, `add ${root}`, [root])).body.error).toMatch(/no bot.md or team.md/);
  });

  it("makes and shows a card for export; a department only for its Chief", async () => {
    expect(await call({ action: "export" }, null)).toMatchObject({ status: 200, body: { text: expect.stringContaining("take out anything personal") } });
    expect(await call({ action: "export", department: true }, null)).toMatchObject({ status: 403 });
    expect(await call({ action: "publish" }, null)).toMatchObject({ status: 404 });
  });

  it("takes exactly one import source of the right shape", () => {
    expect(importSource({ url: "https://github.com/a/b", path: "/x" })).toBeTypeOf("string");
    expect(importSource({ path: "relative/dir" })).toBeTypeOf("string");
    expect(importSource({ files: { "bot.md": 5 } })).toBeTypeOf("string");
    expect(importSource({ files: { "bot.md": "x" } })).toEqual({ files: { "bot.md": "x" } });
  });
});
