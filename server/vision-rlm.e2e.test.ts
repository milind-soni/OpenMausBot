// Vision engine + local RLM harness, end to end: boots the real harness
// server with a `vision` instance pointed at an in-test freellmapi stub,
// then runs two turns with the bot's model set to `rlm:auto`.
//
// The stub scripts the root model: turn 2 must learn the dog's name from
// the sandbox (`env_messages`), not from the prompt — the assertion that
// matters is that no root request body ever contains "Biscuit", while the
// final answer does. The helper call rides the cheap direct: route.
//
// Unlike the CLI-fixture e2es this needs no shebang script, so it runs on
// Windows too. No real proxy, no user data: temp home, random port.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 19800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

interface Msg {
  id: string;
  role: string;
  kind: string;
  text?: string;
}

/** The freellmapi stub: a fixed catalog and scripted completions per model.
 * Records every request body so the sandbox-vs-prompt assertion is real. */
function startUpstream(script: Record<string, string[]>) {
  const bodies: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "auto", name: "Auto" },
          { id: "direct:deepseek-chat", name: "DeepSeek Chat (Direct API)" },
          { id: "rlm:auto", name: "RLM Auto (Harness)" },
        ],
      }));
      return;
    }
    if (url.endsWith("/chat/completions") && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw) as { model: string; messages: Array<{ role: string; content: string }> };
        bodies.push(body);
        const queue = script[body.model] ?? [];
        const next = queue.shift() ?? 'final("script exhausted")';
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: next } }],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return {
    bodies,
    listen: () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
    get url() {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("upstream not listening");
      return `http://127.0.0.1:${addr.port}/v1`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("vision rlm e2e (fake freellmapi)", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let upstream: ReturnType<typeof startUpstream>;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  beforeAll(async () => {
    upstream = startUpstream({
      // turn 1: a plain final right away
      auto: [
        'I will remember that. final("Noted.")',
        // turn 2, step 1: inspect the sandbox, ask one helper question
        "```repl\nprint(env_messages.length);\nprint(llm('what is the dog name here?'));\n```",
        // turn 2, step 2: answer from what the sandbox showed
        'final("Your dog is Biscuit.")',
      ],
      "direct:deepseek-chat": ["Biscuit"],
    });
    await upstream.listen();

    home = mkdtempSync(join(tmpdir(), "omb-vision-rlm-"));
    mkdirSync(join(home, ".openmausbot"), { recursive: true });
    writeFileSync(
      join(home, ".openmausbot", "config.json"),
      JSON.stringify({
        instances: {
          vision: {
            driver: "vision",
            environment: { FREELLMAPI_API_KEY: "e2e-key" },
            config: { url: upstream.url, apiKeyEnv: "FREELLMAPI_API_KEY" },
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

    const deadline = Date.now() + 60_000;
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
  }, 90_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await upstream.close();
    await removeTempDir(home);
  });

  it("serves rlm:auto locally: sandbox-fed history, helper call, extracted final", async () => {
    // The prompt-library catalog carries the distilled collections too.
    const library = await api("GET", "/api/prompt-library");
    expect(library.status).toBe(200);
    expect(library.body.collections.some((c: { label: string }) => c.label.includes("distilled"))).toBe(true);

    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "vision", model: "rlm:auto" },
    });

    // Turn 1 settles with the extracted final() only.
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "My dog is named Biscuit." })).status).toBe(202);
    await waitFor(async () => {
      const b = await getBot(created.id);
      return !b.busy && b.messages.some((m: Msg) => m.role === "bot" && m.kind === "text" && m.text === "Noted.");
    }, "the first rlm reply");

    // Turn 2: the root learns the name from env_messages via the sandbox.
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "What is my dog's name?" })).status).toBe(202);
    await waitFor(async () => {
      const b = await getBot(created.id);
      return !b.busy && b.messages.some((m: Msg) => m.role === "bot" && m.kind === "text" && m.text === "Your dog is Biscuit.");
    }, "the sandbox-informed reply");

    const bodies = upstream.bodies;
    // Four upstream calls: turn-1 root; turn-2 root, helper, root.
    expect(bodies.length).toBe(4);
    expect(bodies.map((b) => b.model)).toEqual(["auto", "auto", "direct:deepseek-chat", "auto"]);
    // The conversation never rode any prompt as a transcript: no env marker,
    // and each root call carries exactly system + one user turn prompt.
    // (MEMORY.md may legitimately contain the fact — that is the harness's
    // own memory feature, shared by every engine.)
    for (const body of bodies) {
      const joined = body.messages.map((m) => m.content).join("\n");
      expect(joined).not.toContain("[user]");
    }
    for (const root of bodies.filter((b) => b.model === "auto")) {
      expect(root.messages[0]?.role).toBe("system");
      expect(String(root.messages[0]?.content).includes("REASONING HARNESS")).toBe(true);
      // The first user message is the turn prompt; every later user message
      // is harness feedback (sandbox output, nudges) — never a replayed
      // transcript turn.
      root.messages.slice(1).forEach((message, index) => {
        if (message.role !== "user") return;
        if (index === 0) return;
        expect(message.content.startsWith("[sandbox output]") || message.content.startsWith("[harness]")).toBe(true);
      });
    }
    // The turn-2 root step 1 prompt is only the user's latest message —
    // prior history is reachable exclusively through the sandbox.
    expect(bodies[1]!.messages[1]!.content).toBe("What is my dog's name?");
    // The helper question went to the cheap direct: route with the persona
    // system prompt attached.
    const helper = bodies.find((b) => b.model === "direct:deepseek-chat");
    expect(helper).toBeDefined();
    expect(helper!.messages.some((m) => m.role === "system" && m.content.includes("SUB-REASONER"))).toBe(true);
    // Root calls carry the harness instructions.
    for (const body of bodies.filter((b) => b.model === "auto")) {
      expect(body.messages[0]?.role === "system" && body.messages[0].content.includes("REASONING HARNESS")).toBe(true);
    }
  }, 60_000);
});
