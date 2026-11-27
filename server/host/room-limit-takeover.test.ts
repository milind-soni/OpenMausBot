import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelSelection, RuntimeEvent } from "../contracts.ts";
import type { Message } from "../store.ts";
import { createRoomLimitTakeover, type RoomLimitTakeoverDeps } from "./room-limit-takeover.ts";

const CLAUDE: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const CODEX: ModelSelection = { instanceId: "codex", model: "gpt-6" };
const ANA = { id: "ana", name: "Ana", modelSelection: CLAUDE, fallback: [CODEX] };
const LIMIT = "You've hit your weekly limit · resets Oct 12 at 2:30pm (Asia/Calcutta)";
const ended = (extra: Partial<Extract<RuntimeEvent, { type: "turn.completed" }>> = {}) =>
  ({ eventId: "e", provider: "claudeAgent", createdAt: new Date(0).toISOString(), threadId: "room", turnId: "turn-1", type: "turn.completed", ok: false, stopReason: "quota", ...extra }) as Extract<RuntimeEvent, { type: "turn.completed" }>;

function room(overrides: { rows?: Message[]; cause?: string; held?: boolean } = {}) {
  const takeover = {
    takeoverAtStart: vi.fn(() => ({ to: CODEX, scope: "engine" as const })),
    heldAtStart: vi.fn(() => (overrides.held === false ? null : { scope: "engine" as const })),
    noteRuntimeEvent: vi.fn(),
  };
  const deps: RoomLimitTakeoverDeps = {
    store: { activePath: () => overrides.rows ?? [] },
    turnStops: { read: () => undefined, failureCause: () => overrides.cause ?? LIMIT },
    takeover: () => takeover,
  };
  return { limits: createRoomLimitTakeover(deps), takeover };
}

describe("a room member at its usage limit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts its turn on a backup of the bot's own, at the member's own approval level", () => {
    const { limits, takeover } = room();
    expect(limits.atStart(ANA, "full")).toEqual({ to: CODEX, scope: "engine" });
    expect(takeover.takeoverAtStart).toHaveBeenCalledWith({ id: "ana", name: "Ana", approvalMode: "full" }, CLAUDE, [CODEX]);
    limits.atStart({ ...ANA, fallback: undefined }, "full");
    expect(takeover.takeoverAtStart, "no backup of its own: none, whatever the installation has").toHaveBeenLastCalledWith(expect.anything(), CLAUDE, []);
  });

  it("notes the room's events as the speaker's, on the model its turn ran on", () => {
    const { limits, takeover } = room();
    limits.dispatched("room", CODEX);
    const event = ended({ ok: true });
    limits.noteEvent("ana", event);
    expect(takeover.noteRuntimeEvent).toHaveBeenCalledWith("ana", CODEX, event);
  });

  it("sends a turn refused before anything ran once more, and never again from within that resend", async () => {
    const { limits } = room();
    const inner = vi.fn(async () => true);
    const again = vi.fn(async () => (await limits.resendOnce("room", ANA, "full", ended(), 0, inner)) ?? "not again");
    expect(await limits.resendOnce("room", ANA, "full", ended(), 0, again)).toBe("not again");
    expect(again).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
    expect(await limits.resendOnce("room", ANA, "full", ended(), 0, inner), "a later turn may be resent again").toBe(true);
  });

  it.each<[string, Parameters<typeof room>[0], ReturnType<typeof ended> | undefined]>([
    ["a turn that worked", {}, ended({ ok: true })],
    ["a turn with no end seen", {}, undefined],
    ["a failure that is no limit", { cause: "The model crashed" }, ended({ stopReason: "error" })],
    ["a turn that already said something", { rows: [{ id: "m", at: 5, role: "bot", kind: "text", text: "Half an answer" } as Message] }, ended()],
    ["a turn that already ran a tool", { rows: [{ id: "m", at: 5, role: "bot", kind: "activity", tool: { name: "ls", ok: true, itemId: "i1" } } as Message] }, ended()],
    ["a member with no backup to take it", { held: false }, ended()],
  ])("sends nothing again for %s", async (_name, overrides, end) => {
    const { limits } = room(overrides);
    const again = vi.fn(async () => true);
    expect(await limits.resendOnce("room", ANA, "full", end, 0, again)).toBeUndefined();
    expect(again).not.toHaveBeenCalled();
  });
});
