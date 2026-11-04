import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { workerPort } from "./testing/worker-port.ts";


const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = workerPort(18800, 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

interface Msg {
  id: string;
  role: string;
  kind: string;
  text?: string;
  parentId?: string | null;
  queued?: boolean;
}

function activePath(messages: Msg[], leafId: string | null): Msg[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const path: Msg[] = [];
  let cur = leafId ? byId.get(leafId) : undefined;
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

posixOnly("conversation branching e2e (fake ACP fleet)", () => {
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

  const getBot = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 25_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-branch-test-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          happy: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: true } },
          // a second engine for the mid-thread model switch: same fake, its
          // own instance, so it starts with no session cursor for the thread
          second: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: true } },
          hang: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "hang" },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
        },
      }),
    );

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "forks on edit, replies on the new branch, and switches versions cleanly",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "happy", model: "fake-model" },
      });

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "original question" })).status).toBe(202);
      await waitFor(async () => {
        const b = await getBot(created.id);
        return !b.busy && b.messages.some((m: Msg) => m.role === "bot" && m.kind === "text" && m.text?.includes("fake acp"));
      }, "the first reply");

      let bot = await getBot(created.id);
      const original: Msg = bot.messages.find((m: Msg) => m.role === "user" && m.text === "original question");
      const originalLeaf = bot.activeLeafId;

      const editBody = { text: "edited question", sendId: "edit-retry-0000000001" };
      const firstEdit = await api("POST", `/api/bots/${created.id}/messages/${original.id}/edit`, editBody);
      expect(firstEdit.status).toBe(202);
      expect(firstEdit.body.message.sendId).toBe("edit-retry-0000000001");
      const retried = await api("POST", `/api/bots/${created.id}/messages/${original.id}/edit`, editBody);
      expect(retried.status).toBe(202);
      expect(retried.body.message.id).toBe(firstEdit.body.message.id);
      const reused = await api("POST", `/api/bots/${created.id}/messages/${original.id}/edit`, { text: "something else", sendId: "edit-retry-0000000001" });
      expect(reused.status).toBe(409);
      await waitFor(async () => {
        const b = await getBot(created.id);
        const edited = b.messages.find((m: Msg) => m.role === "user" && m.text === "edited question");
        if (!edited || b.busy) return false;
        return activePath(b.messages, b.activeLeafId).some(
          (m) => m.role === "bot" && m.kind === "text" && m.id !== originalLeaf,
        );
      }, "the reply on the edited branch");

      bot = await getBot(created.id);
      const edited: Msg = bot.messages.find((m: Msg) => m.role === "user" && m.text === "edited question");
      expect(edited.parentId).toBe(original.parentId);
      expect(bot.messages.filter((m: Msg) => m.role === "user" && m.text === "edited question")).toHaveLength(1);

      const path = activePath(bot.messages, bot.activeLeafId);
      expect(path.map((m) => m.text)).toContain("edited question");
      expect(path.map((m) => m.text)).not.toContain("original question");
      expect(bot.messages.map((m: Msg) => m.id)).toContain(original.id);

      const switched = await api("POST", `/api/bots/${created.id}/active-branch`, { messageId: original.id });
      expect(switched.status).toBe(200);
      bot = await getBot(created.id);
      const backPath = activePath(bot.messages, bot.activeLeafId);
      expect(backPath.map((m) => m.text)).toContain("original question");
      expect(backPath.map((m) => m.text)).not.toContain("edited question");
    },
    40_000,
  );

  it(
    "refuses to rewind a live thread, then edits cleanly once it is stopped",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "hang", model: "fake-model" },
      });

      // start a turn that will never finish on its own
      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first try" })).status).toBe(202);
      await waitFor(async () => (await getBot(created.id)).busy === true, "the hung turn to start");

      const backendBefore = (await getBot(created.id)).cloudBackend;
      const backendChange = await api("PATCH", `/api/bots/${created.id}`, { cloudBackend: "vps" });
      expect(backendChange.status).toBe(409);
      expect(backendChange.body.error).toContain("stop the active turn");
      expect((await getBot(created.id)).cloudBackend).toBe(backendBefore);

      const parallel = await api("POST", `/api/bots/${created.id}/messages`, { text: "sneaky second" });
      expect(parallel.status).toBe(202);
      expect(parallel.body.queued).toBe(true);
      expect((await getBot(created.id)).busy).toBe(true);

      const bot0 = await getBot(created.id);
      const anyMsg = bot0.messages[0];
      expect((await api("POST", `/api/bots/${created.id}/active-branch`, { messageId: anyMsg.id })).status).toBe(409);

      const first: Msg = bot0.messages.find((m: Msg) => m.role === "user" && m.text === "first try");
      const midTurn = await api("POST", `/api/bots/${created.id}/messages/${first.id}/edit`, { text: "second try" });
      expect(midTurn.status).toBe(409);
      expect((await getBot(created.id)).messages.filter((m: Msg) => m.text === "second try")).toHaveLength(0);

      // Stopping the turn auto-runs the queued "sneaky second" (stop-then-steer), so that drained turn must be stopped too.
      expect((await api("POST", `/api/bots/${created.id}/interrupt`)).status).toBe(200);
      await waitFor(async () => {
        const b = await getBot(created.id);
        return b.busy === true && b.messages.some((m: Msg) => m.text === "sneaky second" && !m.queued);
      }, "the queued message to drain into its own turn", 20_000);
      expect((await api("POST", `/api/bots/${created.id}/interrupt`)).status).toBe(200);
      await waitFor(async () => (await getBot(created.id)).busy === false, "the drained turn to settle", 20_000);
      expect((await api("POST", `/api/bots/${created.id}/messages/${first.id}/edit`, { text: "second try" })).status).toBe(202);

      await waitFor(async () => {
        const b = await getBot(created.id);
        return b.messages.some((m: Msg) => m.role === "user" && m.text === "second try");
      }, "the forked message", 30_000);

      const bot = await getBot(created.id);
      const second: Msg = bot.messages.find((m: Msg) => m.role === "user" && m.text === "second try");
      expect(second.parentId).toBe(first.parentId);
      const path = activePath(bot.messages, bot.activeLeafId);
      expect(path.at(-1)?.id).toBe(second.id);
      expect(path.map((m) => m.text)).not.toContain("first try");
      expect(bot.messages.filter((m: Msg) => m.text === "first try")).toHaveLength(1);
      expect(bot.messages.filter((m: Msg) => m.text === "second try")).toHaveLength(1);
    },
    45_000,
  );

  it(
    "replays the thread to a fresh engine after a mid-thread model switch",
    async () => {
      const created = (await api("POST", "/api/bots")).body.bot;
      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "happy", model: "fake-model" },
      });

      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "my dog is named Biscuit" })).status).toBe(202);
      await waitFor(async () => {
        const b = await getBot(created.id);
        return !b.busy && b.messages.some((m: Msg) => m.role === "bot" && m.kind === "text");
      }, "the first reply");

      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "second", model: "fake-model" },
      });
      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "what is my dog called?" })).status).toBe(202);
      await waitFor(async () => {
        const b = await getBot(created.id);
        return !b.busy && b.messages.filter((m: Msg) => m.role === "bot" && m.kind === "text").length >= 2;
      }, "the reply from the second engine");

      await api("PATCH", `/api/bots/${created.id}`, {
        modelSelection: { instanceId: "happy", model: "fake-model" },
      });
      expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "and again?" })).status).toBe(202);
      await waitFor(async () => {
        const b = await getBot(created.id);
        return !b.busy && b.messages.filter((m: Msg) => m.role === "bot" && m.kind === "text").length >= 3;
      }, "the reply after switching back");

      // the fake's reply is fixed, so the proof lives in the native protocol
      // tee: the prompt each engine received must carry the history it lacks
      const bot = await getBot(created.id);
      const log = readFileSync(join(home, ".openmausbot", "native", `${bot.threadId}.ndjson`), "utf8");
      const prompts = log
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((e) => e.dir === "out" && e.msg?.method === "session/prompt")
        .map((e) => JSON.stringify(e.msg.params));
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).not.toContain("joining this conversation");
      expect(prompts[1]).toMatch(/joining this conversation[\s\S]*User: my dog is named Biscuit[\s\S]*what is my dog called\?/);
      expect(prompts[1]).not.toContain("rewound");
      expect(prompts[2]).toMatch(/joining this conversation[\s\S]*User: what is my dog called\?[\s\S]*and again\?/);
    },
    40_000,
  );
});
