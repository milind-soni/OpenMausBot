import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const podman = process.env.OMB_VERIFY_PODMAN;
const machine = process.env.OMB_VERIFY_MACHINE;
if (!podman || !isAbsolute(podman) || !machine) {
  throw new Error("Set OMB_VERIFY_PODMAN to an absolute executable path and OMB_VERIFY_MACHINE explicitly");
}
type Connection = { Name: string; URI: string; Identity: string };
const connections = JSON.parse(execFileSync(podman, ["system", "connection", "list", "--format", "json"], {
  encoding: "utf8", timeout: 15_000,
})) as Connection[];
const connection = connections.find(c => c.Name === machine);
if (!connection) throw new Error("The requested Podman connection does not exist");
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const fixture = await launchVerificationServer(process.env, controller.signal, {
  binDir: dirname(podman), host: connection.URI, sshKey: connection.Identity, staticDir: resolve("dist"),
});
async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", cleanup = false): Promise<any> {
  if (!cleanup) controller.signal.throwIfAborted();
  const timeout = AbortSignal.timeout(120_000);
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json" },
    // Finish an in-flight mutation before cleanup; aborting HTTP does not
    // cancel the server-side container creation.
    signal: cleanup || method !== "GET" ? timeout : AbortSignal.any([controller.signal, timeout]),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
  return response.json();
}
type Evidence = { id: string; computerArgs: string[]; target: string; status: string };
const ids: string[] = [];
const evidence: Evidence[] = [];
let groupId: string | undefined;
let receipt: Record<string, unknown> | undefined;
const errors: unknown[] = [];
try {
  console.log(JSON.stringify({ stage: "isolated-fixture", ...fixture.info }));
  await api("/api/config", { localVm: { mode: "per-bot", maxInstances: 2 } }, "PUT");
  for (const name of ["Fixture GUI A", "Fixture GUI B"]) {
    const { bot } = await api("/api/bots", { name });
    ids.push(bot.id);
    await api(`/api/bots/${bot.id}`, { computer: "vm" }, "PATCH");
    await api(`/api/bots/${bot.id}/local-computer/run`, {});
    console.log(JSON.stringify({ stage: "fixture-desktop", id: bot.id }));
  }
  const { group } = await api("/api/groups", { name: "Isolated Goal GUI routing", memberIds: ids,
    setup: { bulletin: "Fixture only", defaultResponder: { kind: "member", botId: ids[0] } } });
  groupId = group.id;
  async function turn(id: string) {
    await api(`/api/groups/${group.id}`, { defaultResponder: { kind: "member", botId: id } }, "PATCH");
    // A stale dump must never count as proof of this dispatch.
    rmSync(fixture.fixtureDumpPath, { force: true });
    await api(`/api/groups/${group.id}/messages`, { mode: "goal", text: "Reply once for isolated GUI routing verification." });
    const wait = await runControlOmb(["wait", "--channel", group.id, "--timeout", "60", "--url", fixture.info.url]) as { status: string };
    controller.signal.throwIfAborted();
    assert.equal(wait.status, "settled", "Goal turn must settle");
    return { wait, dump: JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) };
  }
  for (const id of ids) {
    const { wait, dump } = await turn(id);
    const computer = dump.mcpConfig?.mcpServers?.computer;
    assert(computer, "Goal speaker must receive computer MCP");
    const target = (await api(`/api/bots/${id}/local-computer`)).container_name;
    assert.equal(typeof target, "string");
    assert(computer.args.includes(target), "MCP must target exactly the speaking bot GUI container");
    assert(String(dump.systemPrompt).includes("computer"), "Goal must include computer instructions");
    // Settled capabilities must already be revoked, including the final speaker.
    const gate = await fetch(computer.env.OMB_CONTROL_URL, {
      headers: { authorization: `Bearer ${computer.env.OMB_CONTROL_TOKEN}` }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(gate.status, 401, "A settled speaker must lose computer authority");
    evidence.push({ id, computerArgs: computer.args, target, status: wait.status });
  }
  assert.notEqual(evidence[0].target, evidence[1].target, "Different speakers must use different desktops");
  await api(`/api/bots/${ids[0]}`, { computer: "off" }, "PATCH");
  const { dump: offDump } = await turn(ids[0]);
  assert(!offDump.mcpConfig?.mcpServers?.computer, "Computer off must not receive desktop tools");
  receipt = { passed: true, fixture: fixture.info.url, evidence, computerOff: true, settledCapabilitiesRevoked: true };
} catch (error) {
  errors.push(error);
} finally {
  if (groupId) await api(`/api/groups/${groupId}/interrupt`, {}, "POST", true).catch(e => errors.push(e));
  for (const id of ids) {
    // Stop before removing: an interrupted acceptance run may still own a lease.
    await api(`/api/bots/${id}/interrupt`, {}, "POST", true).catch(e => errors.push(e));
    await api(`/api/bots/${id}/local-computer/remove`, {}, "POST", true).catch(e => errors.push(e));
  }
  await fixture.close().catch(e => errors.push(e));
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
if (errors.length) throw new AggregateError(errors, "Fixture verification or cleanup failed; inspect the exact fixture IDs above");
const evidenceDir = resolve(".omb-scratch/verification-logs");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, "group-vm-routing.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
