import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { TrainingLog, type TrainingDataMode } from "./training-log.ts";
import { sharedTurns, trainingDataEndpoint, TrainingUploader, UPLOAD_LIMITS } from "./training-upload.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

const HOUR = 60 * 60_000;

function setup(answer: (call: number) => Response | Promise<Response> = () => new Response('{"accepted":1}', { status: 201 })) {
  const dir = mkdtempSync(join(tmpdir(), "omb-training-upload-"));
  dirs.push(dir);
  let now = Date.UTC(2026, 10, 9, 9);
  let mode: TrainingDataMode = "local";
  let allowed = true;
  const log = new TrainingLog();
  log.configure({ dir, mode: () => mode, now: () => now });
  const sent: Array<{ contributorId: string; consentVersion: number; turns: Array<{ turnId: string; messages: unknown[] }> }> = [];
  let calls = 0;
  const uploader = new TrainingUploader({
    log, dir, endpoint: () => "https://cloud.example/api/training-data", allowed: () => allowed, now: () => now,
    fetch: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(gunzipSync(Buffer.from(init.body as Uint8Array)).toString()));
      return answer(++calls);
    }) as typeof fetch,
  });
  const turn = (turnId: string, ok = true) => {
    const request = log.capture([{ role: "user", content: `do ${turnId}` }], [])!;
    log.step(request, { threadId: "t", turnId, round: 0, model: "m", driverKind: "openai-compat", local: false, safeText: (text) => text }, { text: `done ${turnId}`, toolCalls: [] });
    now += 1000;
    log.outcome({ threadId: "t", turnId, ok });
    now += 1000;
  };
  return {
    log, uploader, sent, turn,
    set: (next: TrainingDataMode) => { mode = next; },
    block: () => { allowed = false; },
    later: (ms: number) => { now += ms; },
  };
}

describe("sharing training data", () => {
  it("sends only turns that ended well and began after sharing was turned on, whole, once", async () => {
    const f = setup();
    f.turn("before");
    f.set("share");
    await f.uploader.tick(); // notes when sharing began; sends nothing yet
    expect(f.sent).toEqual([]);
    f.turn("good");
    f.turn("failed", false);
    f.later(HOUR);
    await f.uploader.tick();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ consentVersion: 1, contributorId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(f.sent[0]!.turns.map((turn) => turn.turnId)).toEqual(["good"]);
    expect(f.sent[0]!.turns[0]!.messages).toEqual([{ role: "user", content: "do good" }, { role: "assistant", content: "done good" }]);
    f.later(HOUR);
    await f.uploader.tick();
    expect(f.sent).toHaveLength(1);
    expect(f.uploader.status()).toMatchObject({ sentTurns: 1, lastError: null });
  });

  it("waits and tries again after a limit or a server error, and drops a batch the endpoint refuses", async () => {
    const answers = [
      new Response('{"error":"slow down","retryAfter":120}', { status: 429 }),
      new Response('{"error":"bad rows"}', { status: 400 }),
    ];
    const f = setup((call) => answers[call - 1] ?? new Response("{}", { status: 201 }));
    f.set("share");
    await f.uploader.tick();
    f.turn("one");
    f.later(HOUR);
    await f.uploader.tick();
    expect(f.uploader.status()).toMatchObject({ sentTurns: 0, lastError: "slow down" });
    await f.uploader.tick();
    expect(f.sent).toHaveLength(1); // still inside the 2 minutes it asked for
    f.later(121_000);
    await f.uploader.tick();
    expect(f.uploader.status()).toMatchObject({ sentTurns: 0, refusedTurns: 1, lastError: "bad rows" });
    f.later(HOUR);
    await f.uploader.tick();
    expect(f.sent).toHaveLength(2); // the refused turn is not sent again
  });

  it("stops at once when sharing is turned off or not allowed here, and starts afresh when it is turned on again", async () => {
    const f = setup();
    f.set("share");
    await f.uploader.tick();
    f.turn("one");
    f.set("local");
    f.later(HOUR);
    await f.uploader.tick();
    expect(f.sent).toEqual([]);
    expect(f.uploader.status().shareSince).toBeNull();
    f.set("share");
    await f.uploader.tick();
    f.later(HOUR);
    await f.uploader.tick();
    expect(f.sent).toEqual([]); // "one" began before sharing was turned on again
    f.block();
    f.turn("two");
    f.later(HOUR);
    await f.uploader.tick();
    expect(f.sent).toEqual([]);
  });

  it("finds a turn whose steps were written the day before its outcome", () => {
    const f = setup();
    f.set("share");
    const dir = (f.log as unknown as { dir: string }).dir;
    const log = new TrainingLog();
    let now = Date.UTC(2026, 10, 9, 23, 59, 59);
    log.configure({ dir, mode: () => "local", now: () => now });
    log.step(log.capture([{ role: "user", content: "late" }], []), { threadId: "t", turnId: "night", round: 0, model: "m", driverKind: "x", local: false, safeText: (text) => text }, { text: "ok", toolCalls: [] });
    now += 2000;
    log.outcome({ threadId: "t", turnId: "night", ok: true });
    expect(sharedTurns(log, "2026-11-09T00:00:00.000Z", "2026-11-09T00:00:00.000Z").map((turn) => turn.turnId)).toEqual(["night"]);
  });

  it("goes to the configured endpoint only over https, or http on this machine", () => {
    expect(trainingDataEndpoint({})).toBe("https://cloud.openmausbot.com/api/training-data");
    expect(trainingDataEndpoint({ OMB_CLOUD_STAGING: "1" })).toBe("https://omb-cloud-staging.fly.dev/api/training-data");
    expect(trainingDataEndpoint({}, "https://admin.example.com/")).toBe("https://admin.example.com/api/training-data");
    expect(trainingDataEndpoint({ OMB_TRAINING_DATA_URL: "http://127.0.0.1:9/x" })).toBe("http://127.0.0.1:9/x");
    expect(trainingDataEndpoint({ OMB_TRAINING_DATA_URL: "http://evil.example/x" })).toBe("https://cloud.openmausbot.com/api/training-data");
    expect(UPLOAD_LIMITS.gzipBytes).toBe(1024 * 1024);
  });
});
