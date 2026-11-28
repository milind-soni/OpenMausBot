import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createCodexLiveSession } from "./live-codex.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cli = fileURLToPath(new URL("./testing/fake-codex-live-cli.ts", import.meta.url));
let dir: string;
let receipt: string;
let close: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mausbot-live-codex-test-"));
  receipt = join(dir, "requests.ndjson");
});

afterEach(() => {
  close?.();
  close = undefined;
  removeTempDir(dir);
});

function start(mode: string) {
  return createCodexLiveSession({ cli, sdp: "v=0\r\noffer", voice: "juniper", environment: {
    CODEX_HOME: dir, FAKE_CODEX_LIVE_MODE: mode, FAKE_CODEX_LIVE_RECEIPT: receipt, OPENAI_API_KEY: "synthetic-key",
  } });
}

function requests() {
  return existsSync(receipt) ? readFileSync(receipt, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

it("negotiates WebRTC with the CLI login, relays user speech and stops the isolated call", async () => {
  const { socket, sdp } = await start("mcp");
  close = socket.close;
  expect(sdp).toBe("v=0\r\nanswer");
  expect(socket.readyState).toBe(1);
  const events: Array<{ type: string; delta?: string }> = [];
  await new Promise<void>((resolve) => {
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(String(data));
      events.push(event);
      if (event.type === "session.delegation.created") socket.send('{"type":"session.close"}');
      if (event.type === "session.closed") resolve();
    };
    socket.send(JSON.stringify({ type: "session.commentary.append", content: "The answer is 391." }));
  });
  expect(events.map(({ type }) => type)).toEqual(["session.input_transcript.delta", "session.delegation.created", "session.closed"]);
  expect(events[0]?.delta).toBe("Calculate seventeen times twenty-three");
  const sent = requests();
  expect(sent.every(({ hasApiKey }) => !hasApiKey)).toBe(true);
  expect(new Set(sent.filter(({ method }) => method === "config/read").map(({ pid }) => pid)).size).toBe(2);
  expect(sent.filter(({ method }) => method === "thread/start")).toMatchObject([{ params: {
    ephemeral: true, environments: [], sandbox: "read-only", approvalPolicy: "never",
  } }]);
  expect(sent).toContainEqual(expect.objectContaining({ method: "thread/realtime/start", params: expect.objectContaining({
    includeStartupContext: false, transport: { type: "webrtc", sdp: "v=0\r\noffer" },
  }) }));
  expect(sent).toContainEqual(expect.objectContaining({ method: "thread/realtime/appendSpeech", params: {
    threadId: "synthetic-thread", text: "The answer is 391.",
  } }));
  expect(sent).toContainEqual(expect.objectContaining({ method: "thread/realtime/stop" }));
});

it.each([["api-key", 401], ["unsafe", 502]] as const)("refuses %s before starting a voice thread", async (mode, status) => {
  await expect(start(mode)).rejects.toMatchObject({ status });
  expect(requests().map(({ method }) => method)).not.toContain("thread/start");
});

it("propagates a refused realtime start without leaving a call open", async () => {
  await expect(start("unsupported")).rejects.toMatchObject({ status: 502 });
});
