import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("offers configured Cline to Chief team setup and runs a Cline specialist in the isolated server", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true }, ["cline"]);
  const { url, dataDir } = fixture.info;
  const plan = join(dataDir, "room-plan.json");
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result as any;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  try {
    const chief = (await cli("new-bot", "--name", "Fixture Chief")).bot;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    writeFileSync(plan, JSON.stringify({ [chief.id]: { turns: [{ steps: [{ tool: "list_team_setup", arguments: {} }], reply: "Catalog checked" }] } }));
    await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Check the team catalog");
    expect((await cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "25")).status).toBe("settled");
    const turn = JSON.parse(readFileSync(`${plan}.evidence.jsonl`, "utf8").trim().split("\n").at(-1)!);
    const call = turn.evidence.find((entry: any) => entry.step?.tool === "list_team_setup");
    const catalog = JSON.parse(call.response.result.content[0].text);
    expect(catalog.instances).toContainEqual(expect.objectContaining({ instanceId: "cline", driverKind: "clineAgent", state: "available",
      models: expect.objectContaining({ default: "cline-default" }) }));
    const specialist = (await cli("new-bot", "--name", "Cline specialist")).bot;
    await api("PATCH", `/api/bots/${specialist.id}`, { modelSelection: { instanceId: "cline", model: "cline-default" } });
    await cli("send", "--bot", specialist.id, "--task", specialist.activeTaskId, "--text", "Hello from the Cline specialist");
    expect((await cli("wait", "--bot", specialist.id, "--task", specialist.activeTaskId, "--timeout", "25")).status).toBe("settled");
    const messages = (await api("GET", `/api/threads/${specialist.activeTaskId}/messages?limit=50`)).messages;
    expect(messages.some((message: any) => message.role === "bot" && message.text?.includes("hello from fake acp"))).toBe(true);
    const session = JSON.parse(readFileSync(join(dataDir, "cline-launch.json.session.json"), "utf8"));
    expect(session.mcpServers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "agents" })]));
  } finally {
    await fixture.close();
  }
}, 90_000);
