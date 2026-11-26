// The fake Claude CLI's sign-in is its own files (FAKE_CLAUDE_HOME_FILES, FAKE_CLAUDE_AUTH=file), written here as a
// terminal's `claude auth login` would.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Row = { id: string; parentId?: string | null; role: string; kind: string; text?: string; tool?: { name: string; ok: boolean; setup?: boolean; nameCode?: string } };

async function withSignedOutClaude(check: (fixture: {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  control: (...args: string[]) => Promise<any>;
  /** How many prompts the fake CLI was given that carry `text`. */
  promptsWith: (text: string) => number;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** The conversation as it reads now: its active branch, from the root to the active leaf. */
  activePath: (threadId: string) => Promise<Row[]>;
  all: (threadId: string) => Promise<Row[]>;
  evidence: unknown[];
}) => Promise<void>) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-sign-in-resume-e2e-"));
  const promptsFile = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_HOME_FILES: "1", FAKE_CLAUDE_AUTH: "file", FAKE_CLAUDE_PROMPTS: promptsFile });
  const { url, dataDir } = fixture.info;
  const evidence: unknown[] = [];
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json() as any;
      expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
      return result;
    };
    const page = async (threadId: string) => await api("GET", `/api/threads/${threadId}/messages?limit=500`) as { messages: Row[]; activeLeafId?: string | null };
    const signedIn = async () => ((await api("GET", "/api/instances?fresh=1")).instances as any[]).find((instance) => instance.instanceId === "claude")?.snapshot.authenticated;
    const claudeHome = join(dataDir, ".claude");

    await api("PUT", "/api/config", { automaticRecovery: { enabled: false } });
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    const starter = bots.find((bot) => bot.chiefOfStaff);
    if (starter) await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    await expect.poll(signedIn, { timeout: 20_000 }).toBe(false);

    await check({
      api, evidence,
      control: async (...args: string[]) => await runControlOmb([...args, "--url", url]) as any,
      promptsWith: (text) => (existsSync(promptsFile) ? readFileSync(promptsFile, "utf8").split("\n").filter(Boolean) : []).filter((line) => line.includes(text)).length,
      signIn: async () => {
        mkdirSync(claudeHome, { recursive: true });
        writeFileSync(join(claudeHome, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token-not-a-credential" } }));
        writeFileSync(join(claudeHome, "fake-auth.json"), JSON.stringify({ email: "fixture@example.com" }));
        await expect.poll(signedIn, { timeout: 20_000 }).toBe(true);
      },
      signOut: async () => {
        for (const file of [".credentials.json", "fake-auth.json"]) rmSync(join(claudeHome, file), { force: true });
        await expect.poll(signedIn, { timeout: 20_000 }).toBe(false);
      },
      activePath: async (threadId) => {
        const { messages, activeLeafId } = await page(threadId);
        const byId = new Map(messages.map((row) => [row.id, row]));
        const path: Row[] = [];
        for (let row = activeLeafId ? byId.get(activeLeafId) : messages.at(-1); row; row = row.parentId ? byId.get(row.parentId) : undefined) path.unshift(row);
        return path;
      },
      all: async (threadId) => (await page(threadId)).messages,
    });
  } finally {
    try {
      writeFileSync(join(scratch, "evidence.json"), JSON.stringify(evidence, null, 2));
      console.info(JSON.stringify({ log: fixture.info.logPath, evidence: join(scratch, "evidence.json") }));
    } finally {
      await fixture.close();
    }
  }
}

const setupRows = (rows: Row[]) => rows.filter((row) => row.tool?.setup);

it("signing in again runs each stuck conversation's message once more, and its sign-out rows leave the conversation", async () => {
  await withSignedOutClaude(async ({ control, promptsWith, signIn, activePath, all, evidence }) => {
    const kai = (await control("new-bot", "--name", "Kai")).bot;
    const rosa = (await control("new-bot", "--name", "Rosa")).bot;
    for (const bot of [kai, rosa]) {
      await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", `Draft the plan for ${bot.name}`);
      expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("failed");
      const stuck = await activePath(bot.activeTaskId);
      evidence.push({ bot: bot.name, stuck });
      expect(setupRows(stuck).map((row) => row.tool!.name)).toEqual([
        "error: Not logged in · Please run /login",
        expect.stringMatching(/^notice: Verification fixture is signed out on this computer\. .*Until then .* can't run: they have no backup\.$/),
      ]);
      expect(promptsWith(`Draft the plan for ${bot.name}`)).toBe(1);
    }

    await signIn();

    for (const bot of [kai, rosa]) {
      await expect.poll(() => promptsWith(`Draft the plan for ${bot.name}`), { timeout: 30_000 }).toBe(2);
      expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30")).status).toBe("settled");
      const now = await activePath(bot.activeTaskId);
      evidence.push({ bot: bot.name, resumed: now });
      expect(setupRows(now), "no sign-out row on the conversation as it reads now").toEqual([]);
      expect(now.filter((row) => row.role === "user").map((row) => row.text)).toEqual([`Draft the plan for ${bot.name}`]);
      expect(now.some((row) => row.role === "bot" && row.kind === "text" && row.text && !row.text.startsWith("Hi, I'm"))).toBe(true);
      await expect.poll(async () => (await all(bot.activeTaskId)).some((row) => row.tool?.nameCode === "chat.notice.signedInAgain"), { timeout: 30_000 }).toBe(true);
      const history = await all(bot.activeTaskId);
      expect(setupRows(history).map((row) => row.tool!.name), "the failed try stays on its own version").toEqual(["error: Not logged in · Please run /login"]);
      expect(history.filter((row) => row.tool?.nameCode === "chat.notice.signedInAgain"), "and its notice says the AI is signed in again").toHaveLength(1);
    }
  });
}, hostTimeout(240_000));

it("a conversation moved to another model meanwhile is not run again, and its notice says the AI is signed in again", async () => {
  await withSignedOutClaude(async ({ api, control, promptsWith, signIn, activePath, evidence }) => {
    const kai = (await control("new-bot", "--name", "Kai")).bot;
    await control("send", "--bot", kai.id, "--task", kai.activeTaskId, "--text", "Draft the launch plan");
    expect((await control("wait", "--bot", kai.id, "--task", kai.activeTaskId, "--timeout", "30")).status).toBe("failed");
    const { instances } = await api("GET", "/api/instances") as { instances: any[] };
    const claude = instances.find((instance) => instance.instanceId === "claude");
    const other = claude.models.options.find((option: any) => option.id !== kai.modelSelection.model);
    expect(other, "the fixture's Claude offers a second model").toBeTruthy();
    await api("PATCH", `/api/bots/${kai.id}/tasks/${kai.activeTaskId}`, { modelSelection: { instanceId: "claude", model: other.id } });

    await signIn();
    await expect.poll(async () => (await activePath(kai.activeTaskId)).some((row) => row.tool?.nameCode === "chat.notice.signedInAgain"), { timeout: 30_000 }).toBe(true);
    const now = await activePath(kai.activeTaskId);
    evidence.push({ moved: now });
    expect(now.filter((row) => row.tool?.name.startsWith("notice:")).map((row) => row.tool)).toEqual([
      { name: "notice: Verification fixture is signed in again.", nameCode: "chat.notice.signedInAgain", nameParams: { engine: "Verification fixture" }, ok: true },
    ]);
    expect(setupRows(now).map((row) => row.tool!.name)).toEqual(["error: Not logged in · Please run /login"]);
    expect(promptsWith("Draft the launch plan")).toBe(1);
  });
}, hostTimeout(240_000));

it("a message refused between two sign-ins a few seconds apart runs again after the second, and its notice says so", async () => {
  await withSignedOutClaude(async ({ control, promptsWith, signIn, signOut, activePath, all, evidence }) => {
    const kai = (await control("new-bot", "--name", "Kai")).bot;
    const started = Date.now();
    await signIn();
    await signOut();
    await control("send", "--bot", kai.id, "--task", kai.activeTaskId, "--text", "Draft the launch plan");
    expect((await control("wait", "--bot", kai.id, "--task", kai.activeTaskId, "--timeout", "30")).status).toBe("failed");
    expect(promptsWith("Draft the launch plan")).toBe(1);
    await signIn();
    evidence.push({ secondsBetweenSignIns: (Date.now() - started) / 1000 });
    expect(Date.now() - started, "both sign-ins within a minute").toBeLessThan(60_000);
    await expect.poll(() => promptsWith("Draft the launch plan"), { timeout: 30_000 }).toBe(2);
    expect((await control("wait", "--bot", kai.id, "--task", kai.activeTaskId, "--timeout", "30")).status).toBe("settled");
    await expect.poll(async () => (await all(kai.activeTaskId)).some((row) => row.tool?.nameCode === "chat.notice.signedInAgain"), { timeout: 30_000 }).toBe(true);
    const now = await activePath(kai.activeTaskId);
    evidence.push({ now });
    expect(now.filter((row) => row.tool?.setup)).toEqual([]);
  });
}, hostTimeout(240_000));
