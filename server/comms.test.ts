// Agent-to-agent comms, end to end: boots the real harness server with the
// grokAgent driver pointed at the fake ACP CLI in ask-peer mode, then has
// bot A's "agent" reach bot B through the injected agents proxy (list_bots →
// ask_bot → B runs a real depth-1 turn → reply folds back into A's answer).
// This exercises the whole chain the packaged app uses: startTurn →
// session/new mcpServers → agents-proxy → /api/internal/ask-bot →
// askBotAndWait → bus fold. The internal endpoints' auth is pinned too.
//
// The fake CLI is a shebang script, so the e2e half is POSIX-only (same
// gating as acp.test.ts); the mention-resolution unit tests run everywhere.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { automaticHandoffBots, mentionedBots } from "./store.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

describe("mentionedBots", () => {
  const peers = [
    { id: "1", name: "New Bot" },
    { id: "2", name: "New Bot 2" },
    { id: "3", name: "Milind" },
    { id: "4", name: "Ghost", hidden: true },
  ];
  it("matches a tag at a word start, case-insensitively", () => {
    expect(mentionedBots("hey @milind, look", peers).map((b) => b.id)).toEqual(["3"]);
    expect(mentionedBots("@Milind first thing", peers).map((b) => b.id)).toEqual(["3"]);
  });
  it("prefers the longest name so prefixes never half-match", () => {
    expect(mentionedBots("ask @New Bot 2 about it", peers).map((b) => b.id)).toEqual(["2"]);
  });
  it("dedupes repeats and collects multiple bots", () => {
    expect(mentionedBots("@Milind and @New Bot and @Milind", peers).map((b) => b.id)).toEqual(["3", "1"]);
  });
  it("matches mentions wrapped in common Markdown punctuation", () => {
    expect(mentionedBots("**@Milind** and [@New Bot]", peers).map((b) => b.id)).toEqual(["3", "1"]);
  });
  it("matches mentions after quotes and punctuation", () => {
    expect(mentionedBots(`"@Milind" over to you`, peers).map((b) => b.id)).toEqual(["3"]);
    expect(mentionedBots("thanks,@Milind — and “@New Bot”", peers).map((b) => b.id)).toEqual(["3", "1"]);
    expect(mentionedBots("done.\n—@Milind", peers).map((b) => b.id)).toEqual(["3"]);
  });
  it("ignores emails, hidden bots, and mid-word @", () => {
    expect(mentionedBots("mail milind@milind.dev please", peers)).toEqual([]);
    expect(mentionedBots("prefix@Milind and path/@New Bot", peers)).toEqual([]);
    expect(mentionedBots("@Ghost around?", peers)).toEqual([]);
  });
  it("gates automatic handoffs without changing mention resolution", () => {
    expect(automaticHandoffBots(false, "**@Milind**", peers)).toEqual([]);
    expect(automaticHandoffBots(true, "**@Milind**", peers).map((bot) => bot.id)).toEqual(["3"]);
    expect(automaticHandoffBots(true, "`@Milind` and ```\n@Milind\n```", peers)).toEqual([]);
    expect(automaticHandoffBots(true, "Hey @Milind, what about `@New Bot`?", peers).map((bot) => bot.id)).toEqual(["3"]);
  });
});

posixOnly("comms e2e (fake ACP fleet)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "gbs-comms-test-"));
    mkdirSync(join(home, ".gbs"), { recursive: true });
    writeFileSync(
      join(home, ".gbs", "config.json"),
      JSON.stringify({
        instances: {
          grok: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "ask-peer" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        GBS_PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("seals the internal comms endpoints behind the boot token", async () => {
    const agents = await api("GET", "/api/internal/agents?self=x");
    expect(agents.status).toBe(401);
    const ask = await api("POST", "/api/internal/ask-bot", { toBotId: "x", message: "hi" });
    expect(ask.status).toBe(401);
  });

  it(
    "carries a question from bot A through the agents proxy to bot B and back",
    async () => {
      // deterministic roster: hide the seeded bot, add Asker + Helper
      const seeded = (await api("GET", "/api/bots")).body.bots[0];
      await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
      const selection = { instanceId: "grok", model: "fake-model" };
      const helper = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${helper.id}`, { name: "Helper", modelSelection: selection });
      const asker = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${asker.id}`, { name: "Asker", modelSelection: selection });

      const send = await api("POST", `/api/bots/${asker.id}/messages`, { text: "hey @Helper ping" });
      expect(send.status).toBe(202);

      // wait for A's turn to settle with the peer's reply folded in
      const deadline = Date.now() + 25_000;
      let askerBot: any;
      for (;;) {
        askerBot = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === asker.id);
        const settled = askerBot.messages.some(
          (m: any) => m.kind === "text" && m.role === "bot" && m.text?.includes("peer says:"),
        );
        if (settled && !askerBot.busy) break;
        if (Date.now() > deadline) {
          throw new Error(
            `A never got the peer reply. messages: ${JSON.stringify(askerBot.messages.slice(-6))}\nstderr: ${stderr.slice(-2000)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // A's answer contains B's actual reply, via the proxy's wrapper
      const reply = askerBot.messages.findLast((m: any) => m.kind === "text" && m.role === "bot");
      expect(reply.text).toContain("Helper replied:");
      expect(reply.text).toContain("hello from fake acp"); // B's happy-path turn text

      // visibility: A's thread shows a clickable "Messaged @Helper" chip
      // that links to the auto-created bot⇄bot channel
      const note = askerBot.messages.find((m: any) => m.kind === "activity" && m.tool?.name === "Messaged @Helper");
      expect(note).toBeTruthy();
      expect(note.comm?.groupId).toBeTruthy();
      expect(note.comm?.withName).toBe("Helper");

      // the exchange is mirrored into that channel, attributed to each bot
      const state = (await api("GET", "/api/bots")).body;
      const channel = state.groups.find((g: any) => g.id === note.comm.groupId);
      expect(channel?.dm).toBe(true);
      expect(channel.memberIds).toContain(asker.id);
      expect(channel.memberIds).toContain(helper.id);
      expect(channel.messages.some((m: any) => m.from?.botId === asker.id)).toBe(true);
      expect(channel.messages.some((m: any) => m.from?.botId === helper.id && m.text?.includes("hello from fake acp"))).toBe(true);

      // B's thread received the attributed message and ran a real turn,
      // plus a receive-side chip pointing at the same channel
      const helperBot = state.bots.find((b: any) => b.id === helper.id);
      const inbound = helperBot.messages.find((m: any) => m.role === "user" && m.kind === "text");
      expect(inbound.text).toContain("[Message from @Asker");
      expect(inbound.text).toContain("ping from fake");
      const rnote = helperBot.messages.find((m: any) => m.kind === "activity" && m.tool?.name === "Message from @Asker");
      expect(rnote?.comm?.groupId).toBe(note.comm.groupId);
      expect(helperBot.busy).toBeFalsy();
    },
    40_000,
  );
});
