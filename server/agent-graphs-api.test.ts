import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { canonicalJson } from "./observer-task-presence.ts";
import { signAgentGraphDesktopAction } from "./agent-graph-desktop-gate.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE_CLI = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 48000 + Math.floor(Math.random() * 5_000);
const WEBHOOK_PORT = 53000 + Math.floor(Math.random() * 5_000);
const BASE = `http://127.0.0.1:${PORT}`;
const DESKTOP_SECRET = "fake-desktop-approval-secret-that-is-long-enough";
const DESKTOP_BOOT_ID = randomUUID();
const FOREIGN_TELEMETRY_CANARY = "foreign-thread-private-canary-4c9c1f06";
const HANG_PORT = 61_000 + Math.floor(Math.random() * 500);
const HANG_WEBHOOK_PORT = 62_000 + Math.floor(Math.random() * 500);
const HANG_BASE = `http://127.0.0.1:${HANG_PORT}`;
const HANG_DESKTOP_SECRET = "fake-hang-desktop-approval-secret-long-enough";
const HANG_DESKTOP_BOOT_ID = randomUUID();

let child: ChildProcess;
let home: string;
let stderr = "";

function feedPath(): string {
  return join(home, ".local", "state", "self-improve-recs", "latest.json");
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function graphMutation(action: "preview" | "approve" | "cancel" | "verification-preview" | "verify", path: string, body: Record<string, unknown>) {
  const nonce = randomUUID();
  const issuedAt = Date.now();
  const proof = signAgentGraphDesktopAction(DESKTOP_SECRET, action, path, body, nonce, issuedAt, DESKTOP_BOOT_ID);
  return api("POST", path, { ...body, _desktopAuthority: { bootId: DESKTOP_BOOT_ID, issuedAt, nonce, proof } });
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).status === 200) return;
    } catch {
      // Server bootstrap is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`governed graph test server failed to start: ${stderr.slice(-2_000)}`);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-graphs-api-"));
  const data = join(home, ".openmausbot");
  const feedDir = join(home, ".local", "state", "self-improve-recs");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(data, "telemetry"), { recursive: true });
  mkdirSync(feedDir, { recursive: true });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    // A non-product instance id prevents instanceConfigs() from adding the
    // installed Cursor/Qwen/Hermes/Pi fleet to this hermetic server test.
    instances: { "fixture-claude": { driver: "claudeAgent", displayName: "Fixture Claude", config: { cli: FAKE_CLAUDE_CLI } } },
  }));
  writeFileSync(join(data, "telemetry", "turns.ndjson"), `${JSON.stringify({
    schema: "openmaus.telemetry-trace.v1",
    kind: "trace",
    application: "openmausbot",
    traceId: "foreign-trace",
    sourceSha: "foreign-source",
    botId: "foreign-bot",
    threadId: "foreign-thread",
    promptSummary: `private prompt ${FOREIGN_TELEMETRY_CANARY}`,
    responseSummary: `private response ${FOREIGN_TELEMETRY_CANARY}`,
    outcome: "completed",
  })}\n`);
  const generatedAt = new Date().toISOString();
  const proposal = {
    schema: "improvement_proposal.v2",
    proposal_id: "proposal-e2e",
    cluster_id: "cluster-e2e",
    title: "Exercise governed graph flow",
    project_id: "openmausbot",
    category: "verification",
    affected_surfaces: ["openmausbot"],
    target_type: "source",
    state: "proposed",
    recurrence_count: 2,
    expires_at: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString(),
    trust_class: "untrusted_observation_data",
    mutation_authority: "none",
    automatic_mutation: false,
    content_hash: `sha256:${"b".repeat(64)}`,
    evidence_hashes: [`sha256:${"c".repeat(64)}`],
    proposed_diff: "Run a fake-provider graph and preserve its receipt",
    risk: "Fake provider only",
    tests: ["Provider turns complete and emit a calibrated receipt"],
    rollback: "Delete the temporary test home",
  };
  writeFileSync(feedPath(), JSON.stringify({
    schema: "improvement_proposal_feed.v2",
    generated_at: generatedAt,
    expires_at: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString(),
    feed_hash: hashJson([proposal]),
    proposal_only: true,
    mutation_authority: "none",
    automatic_mutation: false,
    action_capabilities: [],
    proposals: [proposal],
  }));

  child = fork(join(SERVER_DIR, "index.ts"), [], {
    cwd: ROOT,
    execPath: process.execPath,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
      OMB_AGENT_GRAPHS_ENABLED: "1",
      OMB_AGENT_GRAPH_APPROVAL_IPC: "1",
      OMB_TELEMETRY_DISABLED: "1",
      DWEB_URL: "http://127.0.0.1:9",
      FAKE_CLAUDE_MODE: "happy",
      FAKE_CLAUDE_DUMP: join(home, "fake-claude-dump.json"),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.once("spawn", () => child.send?.({
    type: "openmaus.agent-graph-authority.v1",
    secret: DESKTOP_SECRET,
    bootId: DESKTOP_BOOT_ID,
  }));
  child.stderr!.on("data", (chunk) => { stderr += chunk; });
  await waitForHealth(120_000);
  if (process.platform !== "win32" && child.pid) {
    const processTable = execFileSync("/bin/ps", ["eww", "-p", String(child.pid)], { encoding: "utf8" });
    expect(processTable).not.toContain(DESKTOP_SECRET);
    expect(processTable).not.toContain(DESKTOP_BOOT_ID);
    expect(processTable).not.toContain("OMB_AGENT_GRAPH_APPROVAL_SECRET");
    expect(processTable).not.toContain("OMB_AGENT_GRAPH_APPROVAL_BOOT_ID");
  }
  const created = await api("POST", "/api/bots");
  if (created.status !== 201) throw new Error(`could not create graph fixture bot: ${JSON.stringify(created.body)}`);
  const fixtureBots = await api("GET", "/api/bots");
  for (const bot of fixtureBots.body.bots as Array<{ id: string }>) {
    const patched = await api("PATCH", `/api/bots/${bot.id}`, { cwd: ROOT });
    if (patched.status !== 200) throw new Error(`could not bind graph fixture workspace: ${JSON.stringify(patched.body)}`);
  }
}, 130_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("governed agent graph HTTP flow", () => {
  it("runs the approved graph and host-verifies only the exact current receipt before observation emission", async () => {
    const inbox = await api("GET", "/api/improvements");
    expect(inbox.status).toBe(200);
    expect(inbox.body).toMatchObject({
      schema: "openmaus.observer_improvement_proposals.v2",
      state: "fresh",
      agent_graphs_enabled: true,
      proposals: [{ proposal_id: "proposal-e2e", instruction_authority: false }],
    });

    const before = await api("GET", "/api/bots");
    const taskCount = before.body.bots.reduce((sum: number, bot: { tasks?: unknown[] }) => sum + (bot.tasks?.length ?? 0), 0);
    expect((await api("POST", "/api/agent-graphs/preview", {
      objective: "Unauthorized graph preview",
    })).status).toBe(403);
    const preview = await graphMutation("preview", "/api/agent-graphs/preview", {
      objective: "Exercise proposal to graph to verified receipt",
      proposalIds: ["proposal-e2e"],
      goalId: "goal-e2e",
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    expect(preview.body.graph).toMatchObject({ status: "draft", maxParallel: 2, proposalIds: ["proposal-e2e"], goalId: "goal-e2e" });
    const afterPreview = await api("GET", "/api/bots");
    expect(afterPreview.body.bots.reduce((sum: number, bot: { tasks?: unknown[] }) => sum + (bot.tasks?.length ?? 0), 0)).toBe(taskCount);

    const graphId = preview.body.graph.id as string;
    const graphHash = preview.body.graph.graphHash as string;
    const rejected = await graphMutation("approve", `/api/agent-graphs/${graphId}/approve`, { graphHash: `sha256:${"0".repeat(64)}` });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toMatch(/hash mismatch/);
    expect((await api("POST", `/api/agent-graphs/${graphId}/approve`, { graphHash })).status).toBe(403);
    expect((await graphMutation("approve", `/api/agent-graphs/${graphId}/approve`, { graphHash })).status).toBe(202);

    await expect.poll(async () => {
      const status = (await api("GET", `/api/agent-graphs/${graphId}`)).body.graph.status;
      return ["completed", "blocked", "cancelled"].includes(status);
    }, {
      timeout: 30_000,
      interval: 100,
    }).toBe(true);
    const graph = (await api("GET", `/api/agent-graphs/${graphId}`)).body.graph;
    expect(graph.status, JSON.stringify(graph.nodes, null, 2)).toBe("completed");
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes.every((node: { taskId?: string; proofRefs: string[]; status: string }) => node.taskId && node.proofRefs.length === 1 && node.status === "completed")).toBe(true);
    expect(new Set(graph.nodes.map((node: { selectedRoute: { engine: string } }) => node.selectedRoute.engine))).toEqual(new Set(["claudeAgent"]));
    // Prove real overlap instead of relying on a host-speed threshold: both
    // independent roots started before either provider turn finished.
    expect(graph.nodes[0].finishedAt).toBeGreaterThanOrEqual(graph.nodes[1].startedAt);
    expect(graph.nodes[1].finishedAt).toBeGreaterThanOrEqual(graph.nodes[0].startedAt);

    const receiptResponse = await api("GET", `/api/agent-graphs/${graphId}/receipt`);
    expect(receiptResponse.status).toBe(200);
    expect(receiptResponse.body.receipt).toMatchObject({
      schema: "openmaus.agent_graph_run_receipt.v1",
      graph_hash: graphHash,
      status: "completed",
      automatic_mutation: false,
      model_weights_changed: false,
      instruction_authority: false,
      verification_status: "unverified",
      completion_claim: "provider_turns_completed_with_task_receipts_unverified",
    });
    expect(receiptResponse.body.receiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const durableBeforeVerification = JSON.parse(readFileSync(join(home, ".openmausbot", "agent-graph-receipts", `${graphId}.json`), "utf8"));
    expect(durableBeforeVerification).toEqual(receiptResponse.body.receipt);
    const observationDir = join(home, ".local", "state", "self-improve-recs", "observations");
    expect(existsSync(observationDir) ? readdirSync(observationDir) : []).toEqual([]);
    expect(JSON.stringify(durableBeforeVerification)).not.toMatch(/api[_-]?key|authorization|bearer/i);

    const evidencePaths = graph.nodes.map((node: { id: string }) => ({ nodeId: node.id, relativePath: "package.json" }));
    const evidencePreviewPath = `/api/agent-graphs/${graphId}/verification-preview`;
    const previewBody = { graphHash, receiptHash: receiptResponse.body.receiptHash as string, paths: evidencePaths };
    expect((await api("POST", evidencePreviewPath, previewBody)).status).toBe(403);
    const stale = await graphMutation("verification-preview", evidencePreviewPath, {
      ...previewBody,
      receiptHash: `sha256:${"0".repeat(64)}`,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/receipt hash mismatch/);
    const evidencePreview = await graphMutation("verification-preview", evidencePreviewPath, previewBody);
    expect(evidencePreview.status, JSON.stringify(evidencePreview.body)).toBe(200);
    expect(evidencePreview.body).toMatchObject({
      graph_id: graphId,
      graph_hash: graphHash,
      receipt_hash: receiptResponse.body.receiptHash,
      evidence: expect.arrayContaining([expect.objectContaining({ relative_path: "package.json" })]),
    });

    const verifyPath = `/api/agent-graphs/${graphId}/verify`;
    const verifyBody = {
      graphHash,
      receiptHash: receiptResponse.body.receiptHash as string,
      evidenceManifestHash: evidencePreview.body.evidence_manifest_hash as string,
      evidence: evidencePreview.body.evidence,
    };
    expect((await api("POST", verifyPath, verifyBody)).status).toBe(403);

    const verificationNonce = randomUUID();
    const verificationIssuedAt = Date.now();
    const verificationProof = signAgentGraphDesktopAction(
      DESKTOP_SECRET,
      "verify",
      verifyPath,
      verifyBody,
      verificationNonce,
      verificationIssuedAt,
      DESKTOP_BOOT_ID,
    );
    const signedVerification = {
      ...verifyBody,
      _desktopAuthority: {
        bootId: DESKTOP_BOOT_ID,
        issuedAt: verificationIssuedAt,
        nonce: verificationNonce,
        proof: verificationProof,
      },
    };
    const verifiedResponse = await api("POST", verifyPath, signedVerification);
    expect(verifiedResponse.status, JSON.stringify(verifiedResponse.body)).toBe(200);
    expect(verifiedResponse.body.receipt).toMatchObject({
      graph_hash: graphHash,
      verification_status: "verified",
      completion_claim: "verified_with_host_checked_evidence",
      automatic_mutation: false,
      model_weights_changed: false,
      instruction_authority: false,
      evidence_manifest_hash: evidencePreview.body.evidence_manifest_hash,
    });
    expect(verifiedResponse.body.receiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifiedResponse.body.receipt.nodes.every((node: { evidence_status: string; verified_evidence: unknown[] }) =>
      node.evidence_status === "verified" && node.verified_evidence.length === 1)).toBe(true);
    expect((await api("POST", verifyPath, signedVerification)).status).toBe(403);
    const durableVerified = JSON.parse(readFileSync(join(home, ".openmausbot", "agent-graph-receipts", `${graphId}.json`), "utf8"));
    expect(durableVerified).toEqual(verifiedResponse.body.receipt);
    const observations = readdirSync(observationDir).filter((name) => name.endsWith(".json"));
    expect(observations).toHaveLength(1);
    const observation = JSON.parse(readFileSync(join(observationDir, observations[0]!), "utf8"));
    expect(observation).toMatchObject({
      schema: "improvement_observation.v1",
      surface: "openmaus",
      project: "openmausbot",
      category: "verified_agent_graph",
    });
    expect(observation.evidence_refs).toContain(graphHash);
    const providerDump = JSON.parse(readFileSync(join(home, "fake-claude-dump.json"), "utf8"));
    expect(providerDump.env.OMB_AGENT_GRAPH_APPROVAL_SECRET).toBeUndefined();
    expect(providerDump.env.OMB_AGENT_GRAPH_APPROVAL_BOOT_ID).toBeUndefined();
    expect(JSON.stringify(providerDump)).not.toContain(FOREIGN_TELEMETRY_CANARY);
    expect(JSON.stringify(providerDump.prompt)).toContain("[OpenMaus approved agent graph");
    const systemIndex = providerDump.argv.indexOf("--system-prompt");
    expect(systemIndex).toBeGreaterThanOrEqual(0);
    const scopedSystemPrompt = String(providerDump.argv[systemIndex + 1] ?? "");
    expect(scopedSystemPrompt).toContain("exact approved OpenMaus agent-graph node");
    expect(scopedSystemPrompt).toContain("Capability manifest: openmaus.capability-profile.v1");
    expect(scopedSystemPrompt).toContain("exact tools=openmaus-host:filesystem_read, openmaus-host:filesystem_stat");
    expect(scopedSystemPrompt).not.toContain("Operate autonomously on the user's current task");
    expect(Object.keys(providerDump.mcpConfig.mcpServers).sort()).toEqual(["ogb", "openmaus_capabilities"]);
  }, 60_000);

  it("rejects approval when proposal evidence changes and protects cancellation from REST clients", async () => {
    const preview = await graphMutation("preview", "/api/agent-graphs/preview", {
      objective: "Reject a proposal changed after exact preview",
      proposalIds: ["proposal-e2e"],
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    const graphId = preview.body.graph.id as string;
    const graphHash = preview.body.graph.graphHash as string;
    const before = await api("GET", "/api/bots");
    const taskCount = before.body.bots.reduce((sum: number, bot: { tasks?: unknown[] }) => sum + (bot.tasks?.length ?? 0), 0);

    const feed = JSON.parse(readFileSync(feedPath(), "utf8"));
    feed.proposals[0] = {
      ...feed.proposals[0],
      proposed_diff: "Changed after preview and therefore requires a fresh draft",
      content_hash: `sha256:${"d".repeat(64)}`,
    };
    feed.generated_at = new Date().toISOString();
    feed.expires_at = new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString();
    feed.feed_hash = hashJson(feed.proposals);
    writeFileSync(feedPath(), JSON.stringify(feed));

    const rejected = await graphMutation("approve", `/api/agent-graphs/${graphId}/approve`, { graphHash });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toMatch(/feed changed after preview/);
    expect((await api("POST", `/api/agent-graphs/${graphId}/cancel`, {})).status).toBe(403);
    const after = await api("GET", "/api/bots");
    expect(after.body.bots.reduce((sum: number, bot: { tasks?: unknown[] }) => sum + (bot.tasks?.length ?? 0), 0)).toBe(taskCount);
  }, 60_000);
});

describe("active agent graph lifecycle guards", () => {
  let hangChild: ChildProcess;
  let hangHome: string;
  let hangStderr = "";

  const hangApi = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${HANG_BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const hangGraphMutation = async (
    action: "preview" | "approve" | "cancel",
    path: string,
    body: Record<string, unknown>,
  ) => {
    const nonce = randomUUID();
    const issuedAt = Date.now();
    const proof = signAgentGraphDesktopAction(
      HANG_DESKTOP_SECRET,
      action,
      path,
      body,
      nonce,
      issuedAt,
      HANG_DESKTOP_BOOT_ID,
    );
    return hangApi("POST", path, {
      ...body,
      _desktopAuthority: { bootId: HANG_DESKTOP_BOOT_ID, issuedAt, nonce, proof },
    });
  };

  beforeAll(async () => {
    hangHome = mkdtempSync(join(tmpdir(), "omb-graphs-hang-api-"));
    const data = join(hangHome, ".openmausbot");
    mkdirSync(data, { recursive: true });
    mkdirSync(join(data, "telemetry"), { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        "fixture-claude": {
          driver: "claudeAgent",
          displayName: "Hanging Fixture Claude",
          config: { cli: FAKE_CLAUDE_CLI },
        },
      },
    }));

    hangChild = fork(join(SERVER_DIR, "index.ts"), [], {
      cwd: ROOT,
      execPath: process.execPath,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: hangHome,
        USERPROFILE: hangHome,
        OMB_PORT: String(HANG_PORT),
        OMB_WEBHOOK_PORT: String(HANG_WEBHOOK_PORT),
        OMB_AGENT_GRAPHS_ENABLED: "1",
        OMB_AGENT_GRAPH_APPROVAL_IPC: "1",
        OMB_TELEMETRY_DISABLED: "1",
        DWEB_URL: "http://127.0.0.1:9",
        FAKE_CLAUDE_MODE: "hang",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    hangChild.once("spawn", () => hangChild.send?.({
      type: "openmaus.agent-graph-authority.v1",
      secret: HANG_DESKTOP_SECRET,
      bootId: HANG_DESKTOP_BOOT_ID,
    }));
    hangChild.stderr!.on("data", (chunk) => { hangStderr += chunk; });

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${HANG_BASE}/api/health`)).status === 200) break;
      } catch {
        // Server bootstrap is still in progress.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if ((await fetch(`${HANG_BASE}/api/health`).catch(() => null))?.status !== 200) {
      throw new Error(`hanging governed graph test server failed to start: ${hangStderr.slice(-2_000)}`);
    }

    // Two admitted bots let the approved graph exercise the manager-wide
    // two-node concurrency path while both provider turns stay in flight.
    const created = await hangApi("POST", "/api/bots");
    if (created.status !== 201) throw new Error(`could not create hanging graph fixture bot: ${JSON.stringify(created.body)}`);
    const bots = await hangApi("GET", "/api/bots");
    for (const bot of bots.body.bots as Array<{ id: string }>) {
      const patched = await hangApi("PATCH", `/api/bots/${bot.id}`, { cwd: ROOT });
      if (patched.status !== 200) throw new Error(`could not bind hanging graph fixture workspace: ${JSON.stringify(patched.body)}`);
    }
  }, 130_000);

  afterAll(async () => {
    await waitForExit(hangChild, { signal: "SIGTERM" });
    await removeTempDir(hangHome);
  });

  it("keeps active graph tasks, bots, turns, and provider config immutable until signed cancellation", async () => {
    const preview = await hangGraphMutation("preview", "/api/agent-graphs/preview", {
      objective: "Hold two fake provider turns open while lifecycle guards are checked",
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(201);
    const graphId = preview.body.graph.id as string;
    const graphHash = preview.body.graph.graphHash as string;
    const approved = await hangGraphMutation("approve", `/api/agent-graphs/${graphId}/approve`, { graphHash });
    expect(approved.status, JSON.stringify(approved.body)).toBe(202);

    await expect.poll(async () => {
      const response = await hangApi("GET", `/api/agent-graphs/${graphId}`);
      const active = response.body.graph?.nodes?.filter((node: Record<string, unknown>) =>
        ["running", "waiting_for_approval"].includes(String(node.status)) &&
        typeof node.threadId === "string" &&
        typeof node.turnId === "string" &&
        node.selectedRoute,
      ) ?? [];
      return active.length;
    }, { timeout: 30_000, interval: 100 }).toBeGreaterThanOrEqual(1);

    const running = (await hangApi("GET", `/api/agent-graphs/${graphId}`)).body.graph;
    expect(running.status).toBe("running");
    const activeNode = running.nodes.find((node: Record<string, unknown>) =>
      ["running", "waiting_for_approval"].includes(String(node.status)) &&
      typeof node.threadId === "string" &&
      typeof node.turnId === "string" &&
      node.selectedRoute,
    );
    expect(activeNode).toBeTruthy();
    const botId = String(activeNode.selectedRoute.botId);
    const taskId = String(activeNode.taskId);
    const configPath = join(hangHome, ".openmausbot", "config.json");
    const exactConfigBefore = readFileSync(configPath);

    const guardedRequests = [
      await hangApi("DELETE", `/api/bots/${botId}/tasks/${taskId}`),
      await hangApi("DELETE", `/api/bots/${botId}`),
      await hangApi("POST", `/api/bots/${botId}/interrupt`),
      await hangApi("PUT", "/api/config", { xai: { url: "http://127.0.0.1:9/not-applied" } }),
      await hangApi("PATCH", "/api/instances/fixture-claude", { cli: "/tmp/not-applied-while-graph-runs" }),
    ];
    for (const response of guardedRequests) {
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(String(response.body.error)).toMatch(/agent graph|graph/i);
      expect(readFileSync(configPath)).toEqual(exactConfigBefore);
    }

    const stillRunning = (await hangApi("GET", `/api/agent-graphs/${graphId}`)).body.graph;
    expect(stillRunning.nodes.some((node: Record<string, unknown>) => node.threadId === taskId)).toBe(true);
    expect((await hangApi("GET", "/api/bots")).body.bots.some((bot: { id: string }) => bot.id === botId)).toBe(true);

    // Cancellation remains an emergency path even while the graph is active,
    // but it still requires a fresh, one-use desktop signature.
    expect((await hangApi("POST", `/api/agent-graphs/${graphId}/cancel`, {})).status).toBe(403);
    const cancelled = await hangGraphMutation("cancel", `/api/agent-graphs/${graphId}/cancel`, {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    await expect.poll(async () => {
      return (await hangApi("GET", `/api/agent-graphs/${graphId}`)).body.graph.status;
    }, { timeout: 30_000, interval: 100 }).toBe("cancelled");
    const terminal = (await hangApi("GET", `/api/agent-graphs/${graphId}`)).body.graph;
    expect(terminal.nodes.some((node: { status: string }) => ["running", "waiting_for_approval"].includes(node.status))).toBe(false);
    expect(readFileSync(configPath)).toEqual(exactConfigBefore);
  }, 60_000);
});
