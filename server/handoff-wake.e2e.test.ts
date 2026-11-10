// A hand-off sent after a suspended Cloud wakes. Only the hand-off tick starts a queued hand-off; a person's own line needs no tick.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { HANDOFF_TICK_MS } from "./handoff-ticks.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

const HOUR = 60 * 60_000;

it("starts a hand-off at once on a Cloud that just woke, with a dozen teammates about", async () => {
  const session = await launchVerificationServer({ ...process.env, OMB_TEST_RESUME_CLOCK: "1" }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body: unknown, method: string) => request(path, { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const bots = [];
    for (let at = 0; at < 13; at += 1) bots.push((await cli("new-bot", "--name", `Teammate ${at}`, "--section", "Team")).bot);
    const [chief, teammate] = bots;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Team"], acknowledgePeerScope: true }, "PATCH");
    writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({
      [chief.id]: { steps: [{ arguments: { bot_ids: [teammate.id], message: "Fetch the setting" } }], reply: "Asked", resumeReply: "Have it" },
      [teammate.id]: { reply: "Here it is" },
    }));
    // Nothing is due, so the tick has settled on its slowest pace.
    await new Promise((resolve) => setTimeout(resolve, 2 * HANDOFF_TICK_MS.busy + 3_000));
    // The machine was suspended overnight and has just woken.
    writeFileSync(join(session.info.dataDir, "resume-clock-ms"), String(9 * HOUR));
    await new Promise((resolve) => setTimeout(resolve, 200));

    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Please ask your teammate for the setting.");
    await expect.poll(() => readHandoffs(session.info.dataDir).find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBeDefined();
    await expect.poll(() => readHandoffs(session.info.dataDir).find((node: any) => node.parentId)?.status, { timeout: 15_000 }).toBe("completed");
    const handoff = readHandoffs(session.info.dataDir).find((node: any) => node.parentId)!;
    const db = new DatabaseSync(join(session.info.dataDir, "runtime.db"), { readOnly: true });
    try {
      const kinds = (db.prepare("SELECT kind FROM assignment_events WHERE assignment_id = ? ORDER BY id").all(handoff.id) as Array<{ kind: string }>).map((row) => row.kind);
      expect(kinds.slice(0, 3)).toEqual(["enqueued", "admitted", "started"]);
    } finally { db.close(); }
  } finally { await session.close(); }
}, 90_000);
