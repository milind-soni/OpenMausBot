// Against the real Muse Code CLI, signed in on this machine. Skipped unless
// OMB_LIVE_MUSE=1: it spends the account's Muse usage.
//   OMB_LIVE_MUSE=1 pnpm exec vitest run server/drivers/muse-code.live.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ProviderInstance, RuntimeEvent } from "../contracts.ts";
import { MuseCodeDriver } from "./muse-code.ts";

const live = process.env.OMB_LIVE_MUSE === "1";
// The test setup points HOME at a temp dir; only the engine gets the real one, where `muse login` saved.
const home = userInfo().homedir;
const cli = process.env.OMB_MUSE_CLI ?? join(home, ".local", "bin", "muse");

describe.skipIf(!live)("Muse Code (live)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "omb-muse-live-"));
  const instances: ProviderInstance[] = [];
  afterAll(async () => {
    await Promise.all(instances.map(instance => instance.dispose()));
    rmSync(cwd, { recursive: true, force: true });
  });

  const create = async () => {
    const instance = await MuseCodeDriver.create({ instanceId: "museCode", displayName: "Muse Code", enabled: true,
      environment: { HOME: home }, config: MuseCodeDriver.decodeConfig({ cli }) });
    instances.push(instance);
    return instance;
  };
  const run = async (instance: ProviderInstance, input: Parameters<ProviderInstance["adapter"]["sendTurn"]>[0],
    onRequest?: (event: RuntimeEvent) => void) => {
    const events: RuntimeEvent[] = [];
    const done = new Promise<RuntimeEvent>((resolve) => {
      const stop = instance.adapter.onEvent((event) => {
        if (event.threadId !== input.threadId) return;
        events.push(event);
        if (event.type === "request.opened") onRequest?.(event);
        if (event.type === "turn.completed") { stop(); resolve(event); }
      });
    });
    await instance.adapter.sendTurn(input);
    return { completed: await done, events };
  };
  const text = (events: RuntimeEvent[]) => events.filter(event => event.type === "item.completed" && event.itemType === "assistant_text")
    .map(event => (event as { text: string }).text).join("\n");

  it("lists Muse Wonder, answers on it, asks before a shell command, and resumes after a restart", async () => {
    const instance = await create();
    await instance.refreshModels!();
    expect(instance.models.options.map(option => option.id)).toContain("muse-wonder-1.0");
    expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: true });

    const first = await run(instance, { threadId: "live-1", text: "Reply with exactly: wonder ok", model: "muse-wonder-1.0", cwd, approvalMode: "ask", effort: "low" });
    expect(first.completed).toMatchObject({ ok: true });
    expect(text(first.events).toLowerCase()).toContain("wonder ok");
    const session = first.events.find(event => event.type === "session.started") as { sessionId: string } | undefined;
    expect(session?.sessionId).toBeTruthy();

    const asked: RuntimeEvent[] = [];
    const second = await run(instance, { threadId: "live-1", text: "Run the shell command `echo omb-muse-check` and tell me its output.", cwd, approvalMode: "ask", effort: "low" },
      (event) => { asked.push(event); void instance.adapter.respondToRequest("live-1", event.requestId!, { behavior: "allow" }); });
    expect(second.completed).toMatchObject({ ok: true });
    expect(second.events.some(event => event.type === "item.started" && event.itemType === "tool")).toBe(true);
    expect(text(second.events)).toContain("omb-muse-check");
    console.info(`permission cards: ${asked.length}`);

    await instance.dispose(); // an app restart: the old host is gone
    const restarted = await create();
    const third = await run(restarted, { threadId: "live-1", text: "What exact word did the command print? Answer with just it.", cwd,
      approvalMode: "ask", effort: "low", resumeCursor: session!.sessionId });
    expect(third.completed).toMatchObject({ ok: true });
    expect(text(third.events)).toContain("omb-muse-check");
  }, 300_000);

});
