// Every turn reaches the engine with the time it was sent, through the real
// server and the fake Claude CLI: both turns of one long-lived 1:1 session
// carry their own line (a CLI session never hears its system prompt again,
// so a clock there would freeze at the first turn), and so does a room turn.
// TZ pins the server's timezone so the line does not depend on the runner.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { turnClockLine } from "./turn-clock.ts";

const ZONE = "Asia/Kolkata";
// ICU may report the zone by its older alias (Asia/Calcutta); the server's
// line names whatever the runtime reports, so the test asks the same runtime.
const REPORTED = new Intl.DateTimeFormat("en-US", { timeZone: ZONE }).resolvedOptions().timeZone;
const CLOCK = new RegExp(`^Current time when this message was sent: \\w+day, (\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}) ${REPORTED.replace("/", "\\/")} \\(UTC\\+05:30\\)\\.\n\n`);

/** The local minute the line names, as the line would spell it. */
const minute = (at: number) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.exec(turnClockLine(at, REPORTED))![0];

it("stamps every direct and room turn with the time it was sent", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-turn-clock-"));
  const prompts = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({ ...process.env, TZ: ZONE, FAKE_CLAUDE_PROMPTS: prompts });
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const sent = (): string[] => {
    try {
      return readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as { message?: { content?: unknown } } | string)
        // a stream-json user message: plain text, or text blocks beside images
        .map((prompt) => {
          const content = typeof prompt === "string" ? prompt : prompt.message?.content;
          if (typeof content === "string") return content;
          return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("") : JSON.stringify(prompt);
        });
    } catch {
      return [];
    }
  };
  const promptWith = (marker: string) => sent().find((prompt) => prompt.includes(marker));
  /** The prompt carrying `marker` opens with exactly one clock line, naming
   * a minute between the send and the reply. */
  const expectStamped = (marker: string, from: number, to: number) => {
    const prompt = promptWith(marker);
    expect(prompt, marker).toBeDefined();
    const match = CLOCK.exec(prompt!);
    expect(match, prompt).not.toBeNull();
    expect([minute(from), minute(to)]).toContain(match![1]);
    expect(prompt!.match(/Current time when this message was sent/g)).toHaveLength(1);
  };
  const turn = async (botId: string, threadId: string, text: string) => {
    const from = Date.now();
    await control("send", "--bot", botId, "--task", threadId, "--text", text);
    expect(await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
    return { from, to: Date.now() };
  };
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Clockwise" }, 201);
    const first = await turn(bot.id, bot.threadId, "First message about the quarterly plan");
    const second = await turn(bot.id, bot.threadId, "Second message in the same session");
    expectStamped("First message about the quarterly plan", first.from, first.to);
    expectStamped("Second message in the same session", second.from, second.to);

    const { bot: mate } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Roommate" }, 201);
    const room = (await api<{ group: { id: string } }>("/api/groups", "POST", {
      name: "Clock room",
      memberIds: [bot.id, mate.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: mate.id } },
    }, 201)).group;
    const from = Date.now();
    await api(`/api/groups/${room.id}/messages`, "POST", { text: "Room message about the launch date" }, 202);
    await expect.poll(() => promptWith("Room message about the launch date") !== undefined, { timeout: 20_000 }).toBe(true);
    expectStamped("Room message about the launch date", from, Date.now());
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
