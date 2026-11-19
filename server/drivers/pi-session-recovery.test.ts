import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { piSessionDir } from "./pi-session.ts";
import { PiDriver } from "./pi.ts";

const cli = fileURLToPath(new URL("../testing/fake-pi-cli.ts", import.meta.url));
const setup = async (mode = "happy") => {
  ensureDirs();
  chmodSync(cli, 0o755);
  const dump = join(mkdtempSync(join(tmpdir(), "omb-pi-recovery-")), "rpc.jsonl");
  const instance = await PiDriver.create({ instanceId: "pi-recovery", displayName: undefined, enabled: true,
    environment: { FAKE_PI_DUMP: dump, FAKE_PI_MODE: mode, FAKE_PI_PERSIST_SESSION: "1", FAKE_PI_SESSION_FILE_IN_STATE_ONLY: "1" },
    config: { cli, fullAuto: false } });
  return { instance, dump, recorder: recordEvents(instance.adapter) };
};

describe("Pi persisted session correctness", () => {
  it.each(["session-error", "session-cancelled"])("does not send a resumed prompt after %s", async (mode) => {
    const { instance, dump, recorder } = await setup(mode);
    const threadId = "resume-fails-" + mode;
    try {
      const cursor = join(piSessionDir({ threadId }, "pi-recovery"), "missing.json");
      const { turnId } = await instance.adapter.sendTurn({ threadId, text: "follow-up", resumeCursor: cursor,
        model: "openai/gpt-4o", recoveryText: "Prior conversation: important context.\nfollow-up" });
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(done).toMatchObject({ ok: false });
      expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(true);
      expect(recorder.events.some((event) => event.type === "session.started")).toBe(false);
      const rows = readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.some((row) => row.prompt || row.setModel)).toBe(false);
      expect(instance.adapter.hasSession(threadId)).toBe(false);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("starts a cursor from another folder afresh, from the conversation the harness rebuilt", async () => {
    const { instance, dump, recorder } = await setup();
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "moved-here", text: "follow-up",
        resumeCursor: join(tmpdir(), "another-computer", "old-session.json"), recoveryText: "Prior conversation: important context.\nfollow-up" });
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(done).toMatchObject({ ok: true });
      const rows = readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row) => row.rpc).map((row) => row.rpc)).toEqual(["new_session"]);
      expect(rows.find((row) => row.prompt)?.prompt.message).toContain("Prior conversation: important context.");
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("a reset gets a fresh file and full standing prompt without truncating the previous session", async () => {
    const { instance, dump, recorder } = await setup();
    const input = { threadId: "reset-persists-old", system: "Standing rules.", systemStable: "Standing rules.", systemVolatile: "" };
    const session = (turnId: string) => {
      const event = recorder.events.find((event) => event.type === "session.started" && event.turnId === turnId);
      if (event?.type !== "session.started" || !event.sessionId) throw new Error("missing session");
      return event.sessionId;
    };
    try {
      const first = await instance.adapter.sendTurn({ ...input, text: "first" });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === first.turnId);
      const previous = session(first.turnId);
      const original = readFileSync(previous, "utf8");
      const reset = await instance.adapter.sendTurn({ ...input, text: "start over", resumeCursor: previous, sessionReset: true });
      await recorder.until((event) => event.type === "turn.completed" && event.turnId === reset.turnId);
      expect(session(reset.turnId)).not.toBe(previous);
      expect(readFileSync(previous, "utf8")).toBe(original);
      expect(JSON.parse(readFileSync(session(reset.turnId), "utf8"))).toEqual(["Standing rules.\n\nstart over"]);
      const rows = readFileSync(dump, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row) => row.rpc).map((row) => row.rpc)).toEqual(["new_session", "new_session"]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });

  it("a rejected prompt is not persisted in the fake session history", async () => {
    const { instance, recorder } = await setup("prompt-reject");
    try {
      const { turnId } = await instance.adapter.sendTurn({ threadId: "rejected-persistent-prompt", text: "not accepted" });
      const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
      expect(done).toMatchObject({ ok: false });
      const event = recorder.events.find((event) => event.type === "session.started" && event.turnId === turnId);
      if (event?.type !== "session.started" || !event.sessionId) throw new Error("missing session");
      expect(JSON.parse(readFileSync(event.sessionId, "utf8"))).toEqual([]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});
