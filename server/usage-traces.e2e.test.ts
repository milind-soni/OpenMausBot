import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import type { TraceDetail, TraceList, TraceNode, TraceTool, TraceTurn } from "../shared/usage-trace.ts";

const turnsOf = (node: TraceNode): TraceTurn[] => node.kind === "turn" ? [node, ...node.children.flatMap(turnsOf)] : [];
const toolsOf = (turn: TraceTurn): TraceTool[] => turn.children.flatMap((child) =>
  child.kind === "tool" ? [child] : child.kind === "group" ? child.children.filter((inner): inner is TraceTool => inner.kind === "tool") : []);

it("traces a person's message to the Chief through the teammate it delegated to and the tools that teammate used", async () => {
  const session = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Leadership")).bot;
    const researcher = (await cli("new-bot", "--name", "Researcher", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({
      [chief.id]: { steps: [{ arguments: { bot_ids: [researcher.id], message: "Compare the pricing pages" } }], reply: "Assigned", resumeReply: "Pricing compared" },
      [researcher.id]: { steps: [{ tool: "list_bots", arguments: {} }, { tool: "list_rooms", arguments: {} }], reply: "Two pages compared" },
    }));
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Launch the new pricing page by Friday");
    expect((await cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "30")).status).toBe("settled");
    const today = new Date().toISOString().slice(0, 10);
    const settled = async () => {
      const list: TraceList = await api(`/api/usage/traces?from=${today}&to=${today}`, undefined, "GET");
      const root = list.roots.length === 1 && !list.roots[0]!.running ? list.roots[0]! : null;
      if (!root) return null;
      const detail: TraceDetail = await api(`/api/usage/traces/${encodeURIComponent(root.id)}?at=${root.startedAt}`, undefined, "GET");
      return turnsOf(detail.turns[0]!).length === 3 ? { list, root, detail } : null;
    };
    await expect.poll(settled, { timeout: 20_000, interval: 250 }).toBeTruthy();
    const { list, root, detail } = (await settled())!;
    expect(root).toMatchObject({
      title: "Launch the new pricing page by Friday", source: "owner", timed: true, running: false, errors: 0,
      bots: [{ id: chief.id, name: "Clive" }, { id: researcher.id, name: "Researcher" }],
    });
    expect(list.totals).toMatchObject({ tools: root.tools, steps: root.steps, input: root.input, output: root.output });

    const [first] = detail.turns;
    expect(first).toMatchObject({ kind: "turn", botId: chief.id, threadId: chief.activeTaskId, timed: true, status: "ok" });
    const nested = first!.children.filter((child): child is TraceTurn => child.kind === "turn");
    expect(nested.map((turn) => turn.botId).sort()).toEqual([chief.id, researcher.id].sort());
    const research = nested.find((turn) => turn.botId === researcher.id)!;
    expect(research.threadId).not.toBe(researcher.activeTaskId);
    expect(toolsOf(research).map((tool) => tool.name)).toEqual(["list_room_targets", "list_bots", "list_rooms"]);
    for (const tool of toolsOf(research)) {
      expect(tool).toMatchObject({ timedBy: "omb", status: "ok", icon: "bots" });
      expect(tool.endedAt! - tool.startedAt).toBeGreaterThanOrEqual(0);
      expect(tool.startedAt).toBeGreaterThanOrEqual(research.startedAt);
      expect(tool.endedAt!).toBeLessThanOrEqual(research.endedAt!);
    }
    expect(toolsOf(first!).map((tool) => tool.name)).toEqual(["list_room_targets", "coordinate_bots"]);
    const all = turnsOf(first!);
    expect(all).toHaveLength(3);
    const toolTotal = all.reduce((sum, turn) => sum + toolsOf(turn).length, 0);
    expect(root.tools).toBe(toolTotal);
    expect(root.input).toBe(all.reduce((sum, turn) => sum + turn.tokens.input, 0));
    expect(root.output).toBe(all.reduce((sum, turn) => sum + turn.tokens.output, 0));
    expect(root.durationMs).toBe(Math.max(...all.map((turn) => turn.endedAt!)) - first!.startedAt);
    const byResearcher = await api(`/api/usage/traces/${encodeURIComponent(`${research.threadId}~${research.turnId}`)}?at=${research.startedAt}`, undefined, "GET");
    expect(byResearcher.root.id).toBe(root.id);
  } finally {
    await session.close();
  }
}, 90_000);
