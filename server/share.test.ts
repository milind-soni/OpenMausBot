import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { redactSecretsInText } from "../shared/redact.ts";
import type { TemplateCard } from "../shared/share-card.ts";
import { readShareFolder } from "../shared/share-folder.ts";
import { createShareToolRoute, importSource, type ShareToolContext } from "./routes/share.ts";
import { GithubTemplateError } from "./share-github.ts";
import { createCommunityPublisher, type CommunityResult } from "./share-publish.ts";
import { pagesHomeSignature } from "./pages/access.ts";
import type { ExportablePackageSkill } from "./package-export.ts";
import { createShareHost, creditName, readFolderFromDisk } from "./share.ts";
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

/** A bot whose words hold no key, which Publish sends. */
const clean = (overrides: Partial<BotRecord> = {}) => bot({ soul: "Be brief.", ...overrides });

function host(options: { submit?: (submission: unknown) => Promise<CommunityResult>; signedIn?: boolean; bots?: BotRecord[]; picture?: (bot: BotRecord) => string | undefined; brief?: string;
  personNames?: Array<string | undefined>; suggestedCredit?: string; skills?: ExportablePackageSkill[] } = {}) {
  const dataDir = scratch(), botFolder = scratch();
  const patches: Array<{ messageId: string; card: TemplateCard }> = [];
  const bots = options.bots ?? [bot()];
  const publisher = createCommunityPublisher({ access: () => options.signedIn === false ? null : { kind: "desktop", url: "https://admin.example.com/api/cloud/pages/token", token: "t" } });
  const share = createShareHost({
    dataDir, bots: () => bots, groups: () => [], routines: () => [routine], brief: () => options.brief,
    collectTeamSkills: (list) => ({ ok: true, skipped: [], skillsByBot: new Map(list.map((each) => [each.id,
      (options.skills ?? [{ name: "triage", description: "Sort the inbox.", instructions: skillText, enabled: true }]).map((skill) => ({ ...skill }))])) }),
    picture: options.picture ?? (() => undefined), botFolder: (id) => join(botFolder, id),
    publisher: options.submit ? { ...publisher, submit: options.submit } : publisher,
    patch: (_threadId, messageId, _text, card) => patches.push({ messageId, card }),
    ...(options.personNames ? { personNames: () => options.personNames! } : {}),
    ...(options.suggestedCredit ? { suggestedCredit: () => options.suggestedCredit } : {}),
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

  it("never shows a department's shared instructions as its line, and says what arrives for a bot or a department", () => {
    const { share } = host({ brief: "We sell a team plan at 49 per seat.\nNever promise discounts." });
    const department = share.export({ scope: "department", section: "Ops", bots: [bot()] }, [routine]);
    expect(department.card.tagline).toBe("");
    const departmentDetails = share.get(department.card.id).details;
    expect(departmentDetails.summary).toMatch(/^Shared from MausBot\. Its bots, skills, group chats and routines arrive/);
    expect(departmentDetails.brief).toContain("49 per seat");
    const quiet = host({ bots: [bot({ title: undefined, description: undefined })] });
    const lone = quiet.share.export({ scope: "bot", bot: bot({ title: undefined, description: undefined }) }, []);
    expect(lone.card.tagline).toBe("");
    const loneSummary = quiet.share.get(lone.card.id).details.summary ?? "";
    expect(loneSummary).toMatch(/^Shared from MausBot\. The bot arrives as a new copy/);
    expect(loneSummary).not.toMatch(/group chats|OpenMausBot/);
    const titled = share.export({ scope: "bot", bot: bot() }, []);
    expect(titled.card.tagline).toBe("Inbox helper");
    expect(share.get(titled.card.id).details.summary).toBe("Keeps the inbox tidy.");
  });

  it("leaves a switched-off skill out of a bot's and a department's template and names it under Left out", () => {
    const off = "---\nname: drafts\ndescription: Old drafts.\n---\n\n# Drafts\n\nRead C:/Users/janedoe/Documents/drafts first.\n";
    const skills = [
      { name: "triage", description: "Sort the inbox.", instructions: skillText, enabled: true },
      { name: "drafts", description: "Old drafts.", instructions: off, enabled: false },
    ];
    const { share } = host({ skills });
    for (const [target, part] of [[{ scope: "bot" as const, bot: bot() }, "skills[drafts]"], [{ scope: "department" as const, section: "Ops", bots: [bot()] }, "Helper: skills[drafts]"]] as const) {
      const made = share.export(target, []);
      expect(made.card.counts.skills).toBe(1);
      expect(made.card.skipped).toContain(`skills switched off on the bot (${part})`);
      expect(existsSync(join(made.dir, "skills", "triage", "SKILL.md"))).toBe(true);
      expect(existsSync(join(made.dir, "skills", "drafts"))).toBe(false);
      expect(JSON.stringify(share.get(made.card.id).details)).not.toMatch(/drafts|janedoe/);
    }
  });

  it("keeps every switched-on skill, and a skill with no switch, in the template", () => {
    const { share } = host({ skills: [
      { name: "triage", description: "Sort the inbox.", instructions: skillText, enabled: true },
      { name: "notes", description: "Keep notes.", instructions: "---\nname: notes\ndescription: Keep notes.\n---\n\nWrite to C:/Users/janedoe/notes.md.\n" },
    ] });
    const made = share.export({ scope: "bot", bot: bot() }, []);
    expect(made.card.counts.skills).toBe(2);
    expect(made.card.skipped).not.toEqual(expect.arrayContaining([expect.stringContaining("switched off")]));
    expect(readFileSync(join(made.dir, "skills", "notes", "SKILL.md"), "utf8")).toContain("Write to ~/notes.md.");
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
    const { share } = host({ signedIn: false, bots: [clean()] });
    const made = share.export({ scope: "bot", bot: clean() }, []);
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
    const pictured = clean({ id: "bot-2", name: "Painter" });
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const { share } = host({ bots: [clean(), pictured], picture: (each) => each.id === "bot-2" ? png : undefined, submit: async (submission) => { sent = submission as never; return { ok: false, reason: "failed", message: "x" }; } });
    const made = share.export({ scope: "department", section: "Ops", bots: [clean(), pictured] }, [routine]);
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
    await single.share.publish(single.share.export({ scope: "bot", bot: clean() }, []).card.id);
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
    const made = share.export({ scope: "bot", bot: clean() }, []);
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

describe("publishing without the person's details", () => {
  const botFile = (submission: unknown) => String((submission as { files: Record<string, string> }).files["bot.md"]);
  const frontmatter = (text: string) => parseYaml(text.match(/^---\n([\s\S]*?)\n---/)![1]!);
  const ok: CommunityResult = { ok: true, link: "https://github.com/milind-soni/openmausbot-teams/tree/a/teams/helper", prUrl: "https://github.com/milind-soni/openmausbot-teams/pull/1" };

  it("never publishes a template with a key in what it carries, even scrubbed, and sends nothing", async () => {
    let sent = 0;
    const { share } = host({ submit: async () => { sent += 1; return ok; } });
    const made = share.export({ scope: "bot", bot: bot() }, []);
    expect(made.card.secret).toBe(true);
    expect(await share.publish(made.card.id)).toMatchObject({ status: "failed", secret: true, error: expect.stringMatching(/looks like a key or token/) });
    expect(sent).toBe(0);
    const remade = share.export({ scope: "bot", bot: clean() }, []);
    expect(remade.card.secret).toBeUndefined();
    expect(await share.publish(remade.card.id)).toMatchObject({ status: "published" });
    expect(sent).toBe(1);
  });

  it("takes home folders, the app's workspace folders, emails and phone numbers out of the folder before it can be published, and says how many", async () => {
    let sent: unknown = null;
    const words = "Work in /Users/janedoe/WorkSpace/acme. Reports go to /Users/janedoe/.openmausbot/workspaces/0b9c3a52-8d61-4f0e-a2b7-5c1e9d4f3a10/out.md. "
      + "Ask jane@acme.io or +1 (415) 555-0132. Runs at anchorAt 1794748391525.";
    const helper = clean({ description: words });
    const { share } = host({ bots: [helper], submit: async (submission) => { sent = submission; return ok; } });
    const made = share.export({ scope: "bot", bot: helper }, []);
    expect(made.card.scrubbed).toEqual({ paths: 2, emails: 1, phones: 1, names: 0 });
    const onDisk = readFileSync(join(made.dir, "bot.md"), "utf8");
    expect(onDisk).toContain("Work in ~/WorkSpace/acme. Reports go to <workspace>/out.md. Ask <email> or <phone>. Runs at anchorAt 1794748391525.");
    expect(share.get(made.card.id).details.bots[0]!.description).not.toMatch(/janedoe|acme\.io|555/);
    await share.publish(made.card.id);
    expect(botFile(sent)).not.toMatch(/janedoe|acme\.io|555-0132/);
    expect((await share.publish(made.card.id)).scrubbed).toEqual({ paths: 2, emails: 1, phones: 1, names: 0 });
  });

  it("takes out what the bot wrote into the folder after the template was made", async () => {
    let sent: unknown = null;
    const { share } = host({ bots: [clean()], submit: async (submission) => { sent = submission; return ok; } });
    const made = share.export({ scope: "bot", bot: clean() }, []);
    const file = join(made.dir, "bot.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("Keeps the inbox tidy.", "Keeps C:\\Users\\Jane\\inbox tidy."));
    const card = await share.publish(made.card.id);
    expect(botFile(sent)).toContain("Keeps ~\\inbox tidy.");
    expect(card.scrubbed).toEqual({ paths: 1, emails: 0, phones: 0, names: 0 });
  });

  it("uploads only the fields a template carries from a folder edited to hold connections, memory, approval and unknown keys", async () => {
    let sent: { files: Record<string, string | { base64: string }> } | null = null;
    const { share, patches } = host({ bots: [clean()], submit: async (submission) => { sent = submission as never; return ok; } });
    const made = share.export({ scope: "bot", bot: clean() }, []);
    share.shown(made.card.id, "thread-1", "message-1");
    const file = join(made.dir, "bot.md");
    const [, head, body] = readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)!;
    const meta = parseYaml(head!);
    meta.author = { name: "Community", url: "https://example.com/me" };
    meta.publisher = { organization: "acme", name: "Acme" };
    meta.privateNotes = "UNKNOWN_TOP_LEVEL";
    meta.connections = [{ key: "crm", label: "CRM", reason: "Used by Helper", mcp: { transport: "http", url: "https://crm.example.com/mcp/CONNECTION_PATH", valueNames: ["X-CRM-TOKEN"] } }];
    meta.presets = [{ key: "p", name: "PRESET_NAME", bot: {} }];
    Object.assign(meta.agents[0], { connections: ["crm"], seed: { memory: { "MEMORY.md": "SEED_MEMORY_LINE" } }, approval: "ask", model: "UNKNOWN_AGENT_KEY" });
    meta.agents[0].appearance.ring = "UNKNOWN_LOOK";
    writeFileSync(file, `---\n${stringifyYaml(meta)}---\n${body}`);
    const skill = join(made.dir, "skills", "triage", "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace("description: Sort the inbox.", "description: Sort the inbox.\nallowed-tools: Bash(SKILL_TOOL:*)\nmetadata:\n  owner: SKILL_OWNER"));

    const card = await share.publish(made.card.id);
    expect(card.status).toBe("published");
    const everything = JSON.stringify(sent!.files);
    for (const gone of ["UNKNOWN_TOP_LEVEL", "CONNECTION_PATH", "X-CRM-TOKEN", "PRESET_NAME", "SEED_MEMORY_LINE", "UNKNOWN_AGENT_KEY", "UNKNOWN_LOOK", "SKILL_TOOL", "SKILL_OWNER", "example.com/me", "acme"]) {
      expect(everything).not.toContain(gone);
    }
    const published = frontmatter(botFile(sent));
    expect(published).not.toHaveProperty("connections");
    expect(published).not.toHaveProperty("publisher");
    expect(published.author).toEqual({ name: "Community" });
    expect(Object.keys(published.agents[0]).sort()).toEqual(["appearance", "description", "key", "name", "skills", "soul", "title", "tools"]);
    expect(frontmatter(String(sent!.files["skills/triage/SKILL.md"]))).toEqual({ name: "triage", description: "Sort the inbox." });
    expect(card.skipped).toEqual(expect.arrayContaining(["connection addresses", "the connections a bot uses", "a bot's starter memory", "a bot's approval level",
      "preset bots", "skill settings other than name and description", "fields a template doesn't carry"]));
    expect(patches.at(-1)!.card.skipped).toEqual(card.skipped);
    expect(readFileSync(file, "utf8")).not.toMatch(/SEED_MEMORY_LINE|CONNECTION_PATH|approval/);
  });

  it("takes a picture's metadata out before it is uploaded, its pixels as they were", async () => {
    let sent: { files: Record<string, string | { base64: string }> } | null = null;
    const segment = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    const pixels = Buffer.from([0x12, 0x34, 0x56]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
      segment(0xe1, Buffer.from("Exif\0\0GPS 37.7749 -122.4194 Canon EOS", "latin1")),
      segment(0xfe, Buffer.from("taken at home", "latin1")),
      segment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
      segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
      pixels,
      Buffer.from([0xff, 0xd9]),
    ]);
    const pictured = clean();
    const { share } = host({ bots: [pictured], picture: () => `data:image/jpeg;base64,${jpeg.toString("base64")}`, submit: async (submission) => { sent = submission as never; return ok; } });
    await share.publish(share.export({ scope: "bot", bot: pictured }, []).card.id);
    const [path, value] = Object.entries(sent!.files).find(([name]) => name.startsWith("avatars/"))!;
    expect(path).toMatch(/\.jpg$/);
    const uploaded = Buffer.from((value as { base64: string }).base64, "base64");
    expect(uploaded.toString("latin1")).not.toMatch(/Exif|GPS|Canon|taken at home/);
    expect(uploaded.includes(pixels)).toBe(true);
    expect(uploaded.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("credits the name in Published by, the community when it is cleared, and the last one when a bot publishes", async () => {
    let sent: unknown = null;
    const { share } = host({ bots: [clean()], suggestedCredit: "Jane Doe", submit: async (submission) => { sent = submission; return ok; } });
    const made = share.export({ scope: "bot", bot: clean() }, []);
    expect(made.card.author).toBeUndefined();
    expect(frontmatter(readFileSync(join(made.dir, "bot.md"), "utf8")).author).toEqual({ name: "Community" });
    const published = await share.publish(made.card.id, { author: "Jane D." });
    expect(frontmatter(botFile(sent)).author).toEqual({ name: "Jane D." });
    expect(published).toMatchObject({ status: "published", publishedBy: "Jane D.", author: "Jane D." });
    expect((await share.publish(made.card.id)).author).toBe("Jane D.");
    expect(frontmatter(botFile(sent)).author).toEqual({ name: "Jane D." });
    const cleared = await share.publish(made.card.id, { author: "" });
    expect(frontmatter(botFile(sent)).author).toEqual({ name: "Community" });
    expect(cleared.publishedBy).toBeUndefined();
    expect(cleared.author).toBe("");
  });

  it("credits the community when a bot publishes a template nobody named", async () => {
    let sent: unknown = null;
    const { share } = host({ bots: [clean()], suggestedCredit: "Jane Doe", submit: async (submission) => { sent = submission; return ok; } });
    await share.publish(share.export({ scope: "bot", bot: clean() }, []).card.id);
    expect(frontmatter(botFile(sent)).author).toEqual({ name: "Community" });
  });

  it("takes out the person's user name, and their profile name unless they publish under it", async () => {
    let sent: unknown = null;
    const helper = clean({ description: "Made by Jane Doe on ~janedoe/laptop for root, and janedoe will know." });
    const { share } = host({ bots: [helper], personNames: ["janedoe", "Jane Doe"], suggestedCredit: "Jane Doe", submit: async (submission) => { sent = submission; return ok; } });
    const made = share.export({ scope: "bot", bot: helper }, []);
    expect(made.card.scrubbed).toEqual({ paths: 0, emails: 0, phones: 0, names: 1 });
    await share.publish(made.card.id, { author: "Jane Doe" });
    expect(frontmatter(botFile(sent)).agents[0].description).toBe("Made by Jane Doe on ~<name>/laptop for root, and janedoe will know.");
    const card = await share.publish(made.card.id, { author: "JD" });
    expect(frontmatter(botFile(sent)).agents[0].description).toBe("Made by <name> on ~<name>/laptop for root, and janedoe will know.");
    expect(card.scrubbed).toEqual({ paths: 0, emails: 0, phones: 0, names: 2 });
  });

  it("reads Published by as one line of plain words and never an email address", () => {
    expect(creditName(undefined)).toBeUndefined();
    expect(creditName("")).toBe("");
    expect(creditName("  Jane\n\u200b Doe ")).toBe("Jane Doe");
    expect(creditName("jane@acme.io")).toBeNull();
    expect(creditName(42)).toBeNull();
    expect(creditName("x".repeat(300))).toHaveLength(100);
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
