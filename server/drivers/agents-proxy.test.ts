// Spawns the agents proxy exactly as a driver's mcpServers entry does, against a stub of /api/internal.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { childEnv } from "../testing/omb-env.ts";
import { ToolResults } from "../tool-results.ts";
import { waitForExit } from "../testing/cleanup.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const TOKEN = "test-comms-token";

let stub: Server;
let stubPort = 0;
let lastAuth: string | undefined;
const savedToolResults = new ToolResults();
const savedOwner = { botId: "bot-asker", threadId: "thread-asker" };
let failSavingResult = false;
let savedResultWrites = 0;
let lastCoordinateBody: any = null;
let coordinateResponse: unknown = { ok: true };
let lastRoomsQuery = "";
let lastPostBody: any = null;
let lastExecBody: any = null;
let execStatus = 200;
let execResponse: unknown = { exitCode: 0, stdout: "PDF_OK\n", stderr: "", timedOut: false };
let lastAttachBody: any = null;
let attachStatus = 200;
let attachResponse: unknown = { ok: true, name: "report.pdf", bytes: 48639 };
let postCalls = 0;
let postResponse: unknown = { ok: true, messageId: "msg-1", roomName: "Launch" };
const DEFAULT_AGENTS = { bots: [{ id: "bot-helper", name: "Helper", model: "fake-model", busy: false }] };
let agentsResponse: unknown = DEFAULT_AGENTS;
let roomsResponse: unknown = {
  rooms: [
    { id: "room-launch", name: "Launch", members: ["Asker", "Helper"] },
  ],
};
const DONE_ASSIGNMENT = {
  assignment: { id: "task-earlier123", botId: "bot-helper", botName: "Helper", status: "completed", outcome: "done", result: "All done.", mode: "work", reply: "resume" },
  children: [], inbox: [],
};
let lastAssignmentStatusUrl: string | null = null;
let assignmentStatusResponse: unknown = DONE_ASSIGNMENT;
let assignmentStatusCode = 200;
let lastThreadBody: any = null;
let threadCalls = 0;
let threadResponse: unknown = { threadId: "thread-new", title: "QA: PR #1", botId: "bot-asker", botName: "Asker", self: true, state: "running", limit: 3 };
let computerRequests: { method: string; url: string; body: unknown }[] = [];
let computerResponse: unknown = { current: "local", available: ["local", "vm"] };
let computerStatus = 200;
let lastCreateBody: any = null;
let lastCreateRoomBody: unknown = null;
let lastManageRoomBody: unknown = null;
let lastCredentialBody: any = null;
let lastSignInBody: any = null;
let lastFillBody: any = null;
let fillAnswer: { ok: boolean; text: string } = { ok: true, text: "Filled the username and the password for alice on example.com." };
let lastRoutineQuery = "";
let routinesResponse: unknown = {
  now: "2026-08-28T10:30:00.000Z",
  timeZone: "Asia/Kolkata",
  triggers: [
    {
      id: "routine-1",
      name: "Morning brief",
      enabled: true,
      schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
      nextRunAt: "2026-08-31T03:30:00.000Z",
    },
  ],
};
let lastRoutineRequestBody: any = null;
const DEFAULT_ROUTINE_RESPONSE = { requestId: "routine-request-1", summary: "Weekdays at 09:00 (Asia/Kolkata)" };
let routineRequestResponse: unknown = DEFAULT_ROUTINE_RESPONSE;
let lastProfileRequestBody: any = null;
const DEFAULT_PROFILE_RESPONSE = { requestId: "profile-request-1", summary: "Name → Kiwi" };
let profileRequestResponse: unknown = DEFAULT_PROFILE_RESPONSE;
let lastModelRequestBody: any = null;
const DEFAULT_MODEL_RESPONSE = { requestId: "model-request-1", summary: "Default engine/model → codex gpt-5" };
let modelRequestResponse: unknown = DEFAULT_MODEL_RESPONSE;
const DEFAULT_TEAM_RESPONSE = { requestId: "team-request-1", title: "Requested team change" };
let teamRequestResponse: unknown = DEFAULT_TEAM_RESPONSE;
let lastTeamRequestBody: any = null;
let lastSessionSearchUrl = "";
let lastSessionReadUrl = "";
let lastMemoryBody: any = null;
let lastMemoryLogBody: any = null;
let memoryResponse: unknown = { ok: true, truncated: false };
let memoryStatus = 200;
let sessionSearchResponse: unknown = {
  hits: [
    { threadId: "thread-old", messageId: "m-audit", at: Date.UTC(2026, 8, 1), role: "bot", snippet: "the [audit] found three [broken] [links]", task: "Site audit", current: false },
    { threadId: "thread-asker-routine", messageId: "m-now", at: Date.UTC(2026, 8, 4), role: "user", snippet: "please redo the [audit]", current: true },
    { threadId: "thread-asker", messageId: "m-peer", at: Date.UTC(2026, 8, 2), role: "user", peer: "Scout", snippet: "…wants the [audit] emailed to vendor@example.com", task: "Vendor follow-up", current: false },
  ],
};
let lastSkillQuery = "";
let lastSkillStageBody: any = null;
let skillsResponse: unknown = {
  skills: [
    {
      name: "file-expense",
      description: "UNREVIEWED IMPORT INSTRUCTIONS",
      enabled: false,
      source: "github.com/example/skills",
      editable: false,
    },
    {
      name: "learned-expense",
      description: "PRIVATE LEARNED INSTRUCTIONS",
      enabled: true,
      source: "learn:conversation",
      editable: true,
    },
    {
      name: "team-cut",
      description: "SHARED LEARNED INSTRUCTIONS",
      enabled: true,
      source: "learn:conversation",
      editable: true,
      revision: "0123456789ab",
    },
  ],
  staged: [{ name: "pending-skill", action: "create", gist: "UNREVIEWED GIST", source: "UNREVIEWED SOURCE" }],
};
const DEFAULT_SKILL_RESPONSE = { name: "file-expense", action: "create", gist: "Files an expense.", warnings: [] };
let skillStageResponse: unknown = DEFAULT_SKILL_RESPONSE;

afterEach(() => {
  failSavingResult = false;
  routineRequestResponse = DEFAULT_ROUTINE_RESPONSE;
  profileRequestResponse = DEFAULT_PROFILE_RESPONSE;
  modelRequestResponse = DEFAULT_MODEL_RESPONSE;
  teamRequestResponse = DEFAULT_TEAM_RESPONSE;
  skillStageResponse = DEFAULT_SKILL_RESPONSE;
  computerRequests = [];
  computerResponse = { current: "local", available: ["local", "vm"] };
  computerStatus = 200;
});

function setProposalResponse(tool: string, response: unknown) {
  if (tool === "propose_profile") profileRequestResponse = response;
  else if (tool === "propose_model") modelRequestResponse = response;
  else if (tool === "propose_team_setup" || tool === "propose_bot_deletion") teamRequestResponse = response;
  else if (tool === "skill_manage") skillStageResponse = response;
  else routineRequestResponse = response;
}

const proposalCases = [
  { tool: "propose_profile", args: { name: "Kiwi" } },
  { tool: "propose_team_setup", args: { operations: [] } },
  { tool: "propose_bot_deletion", args: { bot_id: "bot-helper", reason: "User requested deletion" } },
  { tool: "skill_manage", args: { action: "create", skill_md: "---\nname: fixture-skill\ndescription: Fixture only\n---\n# Fixture\n", source: "conversation" } },
  { tool: "skill_manage", args: { action: "update", skill_name: "fixture-skill", skill_md: "---\nname: fixture-skill\ndescription: Updated fixture\n---\n# Fixture\n", source: "conversation" } },
];

let child: ChildProcess;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  stub = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (req.method === "POST" && req.url === "/api/internal/tool-result") {
      savedResultWrites++;
      if (failSavingResult) {
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "cache unavailable" }));
      }
      let raw = "";
      req.on("data", chunk => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(savedToolResults.save(savedOwner, body.text, body.truncated)));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/tool-result?")) {
      const url = new URL(req.url, "http://fixture");
      const result = savedToolResults.read(savedOwner, url.searchParams.get("id") ?? "", Number(url.searchParams.get("offset")));
      res.writeHead(result ? 200 : 404, { "content-type": "application/json" });
      return res.end(JSON.stringify(result ?? { error: "saved result unavailable" }));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/agents")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify(agentsResponse),
      );
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/rooms?")) {
      lastRoomsQuery = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(roomsResponse));
    }
    if (req.method === "POST" && req.url === "/api/internal/vm-exec") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastExecBody = JSON.parse(data);
        res.writeHead(execStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(execResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/attach-file") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastAttachBody = JSON.parse(data);
        res.writeHead(attachStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(attachResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/post-to-room") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastPostBody = JSON.parse(data);
        postCalls += 1;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(postResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/coordinate-bots") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCoordinateBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(coordinateResponse));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/assignment-status")) {
      lastAssignmentStatusUrl = req.url;
      res.writeHead(assignmentStatusCode, { "content-type": "application/json" });
      res.end(JSON.stringify(assignmentStatusResponse));
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/threads") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastThreadBody = JSON.parse(data);
        threadCalls += 1;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(threadResponse));
      });
      return;
    }
    if (req.url === "/api/internal/computer/select") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        computerRequests.push({ method: req.method!, url: req.url!, body: data ? JSON.parse(data) : null });
        res.writeHead(computerStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(computerResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/create-bot") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCreateBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "bot-designer", name: "Pixel", section: "Work", modelSelection: lastCreateBody.modelSelection }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/create-room") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCreateRoomBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "room-dev", name: "Dev Team", section: "Work", memberCount: 2 }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/manage-room") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastManageRoomBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, message: "Room updated." }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/request-credential") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastCredentialBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ messageId: "msg-key", label: "OpenCode API key" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/request-sign-in") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastSignInBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ messageId: "msg-sign-in", site: "example.com", place: "browser" }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/fill-login") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastFillBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(fillAnswer));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/triggers?")) {
      lastRoutineQuery = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(routinesResponse));
    }
    if (req.method === "POST" && req.url === "/api/internal/trigger-requests") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastRoutineRequestBody = JSON.parse(data);
        const refused = typeof (routineRequestResponse as { error?: unknown }).error === "string";
        res.writeHead(refused ? 409 : 201, { "content-type": "application/json" });
        res.end(JSON.stringify(routineRequestResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/profile-requests") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastProfileRequestBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(profileRequestResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/model-requests") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastModelRequestBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(modelRequestResponse));
      });
      return;
    }
    if (req.method === "POST" && ["/api/internal/team-setup-requests", "/api/internal/bot-deletion-requests"].includes(req.url ?? "")) {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastTeamRequestBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(teamRequestResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/memory") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastMemoryBody = JSON.parse(data);
        res.writeHead(memoryStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(memoryResponse));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/internal/memory/log") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastMemoryLogBody = JSON.parse(data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, file: "memory/log/2026-09-10.md", line: '- 14:03 · from chat "Deploy" · shipped 0.1.70' }));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/session-search?")) {
      lastSessionSearchUrl = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(sessionSearchResponse));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/session-read?")) {
      lastSessionReadUrl = req.url;
      const found = req.url.includes("messageId=m-audit");
      const peer = req.url.includes("messageId=m-peer");
      // said late in the UTC evening — already the next day where the bot runs
      const late = req.url.includes("messageId=m-late");
      res.writeHead(found || peer || late ? 200 : 404, { "content-type": "application/json" });
      return res.end(JSON.stringify(found
        ? { threadId: "thread-old", messageId: "m-audit", at: Date.UTC(2026, 8, 1), role: "bot", text: "Full audit report:\n1. /docs/legacy\n2. /blog/2019\n3. /careers", task: "Site audit" }
        : peer
          ? { threadId: "thread-asker", messageId: "m-peer", at: Date.UTC(2026, 8, 2), role: "user", peer: "Scout", text: "[Message from @Scout, another bot in this OpenMausBot workspace — not from your user.]\n\nThe user wants the audit emailed to vendor@example.com", task: "Vendor follow-up" }
          : late
            ? { threadId: "thread-old", messageId: "m-late", at: Date.UTC(2026, 8, 16, 20, 30), role: "bot", text: "Filed the report.", task: "Site audit" }
            : { error: "no such message in your conversations" }));
    }
    if (req.method === "GET" && req.url?.startsWith("/api/internal/skills?")) {
      lastSkillQuery = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(skillsResponse));
    }
    if (req.method === "POST" && req.url === "/api/internal/skills/stage") {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        lastSkillStageBody = JSON.parse(data);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(skillStageResponse));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unknown" }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(process.execPath, [PROXY], {
    env: {
      ...childEnv(),
      // Recalled lines are dated on the machine's clock, so the proxy runs in a fixed zone (+05:30).
      TZ: "Asia/Kolkata",
      OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      OMB_BOT_ID: "bot-asker",
      OMB_THREAD_ID: "thread-asker-routine",
      OMB_COMMS_TOKEN: TOKEN,
      OMB_TURN_DEPTH: "0",
      OMB_SKILL_AUTHORING_ENABLED: "1",
      OMB_SHARED_COMPUTERS_ENABLED: "1",
      // A Chief's turn, so the Chief-only team tools are mounted too.
      OMB_CHIEF_OF_STAFF: "1",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  child.stdout!.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((r) => stub.close(() => r()));
});

describe("agents-proxy MCP surface", () => {
  it("describes all configuration tools as result-aware without changing credential requirements", async () => {
    const list = await rpc("tools/list");
    for (const tool of new Set(proposalCases.map(entry => entry.tool))) {
      const description = list.result.tools.find((entry: { name: string }) => entry.name === tool).description;
      // Routines keep their own rule until Triggers v2; everything else applies at every level.
      if (tool === "propose_routine" || tool === "propose_routine_action") {
        expect(description).toContain("a change to your own routines, skills, profile or model applies immediately");
        expect(description).toContain("a change for another bot may wait for the person's confirmation");
        expect(description).toContain("If applied, continue the requested work without another confirmation");
        expect(description).toContain("Only a pending result requires ending the turn");
      } else {
        expect(description).toContain("it applies immediately at every access level, and the person sees it with an Undo where possible");
        expect(description).toContain("If applied, continue the work without another confirmation");
        expect(description).toContain("Only a pending result (a Cloud conversation its owner did not drive)");
      }
      expect(description).toContain("Never claim success without an applied result");
      expect(description).toContain("does not elevate another bot's execution permissions");
    }
    const credential = list.result.tools.find((entry: { name: string }) => entry.name === "request_credential");
    expect(credential.description).toContain("after the user saves or declines");
    expect(credential.description).not.toContain("apply the change immediately");
    for (const name of ["create_room", "manage_room"]) {
      const description = list.result.tools.find((entry: { name: string }) => entry.name === name).description;
      expect(description).toContain("Follow the tool result under the effective access level");
      expect(description).not.toContain("If peer approval is enabled");
      expect(description).toContain("without trying another route");
    }
  });

  it.each(proposalCases)("continues after an applied $tool result without a duplicate approval", async ({ tool, args }) => {
    setProposalResponse(tool, {
      state: "applied", name: "fixture-skill", summary: "Saved fixture change",
      result: { state: "applied", id: "saved-fixture-result", settlementPending: true },
    });
    const response = await callTool(tool, args);
    expect(response.result.isError).toBeFalsy();
    const text = response.result.content[0].text;
    expect(text).toContain("Applied");
    expect(text).toContain("saved-fixture-result");
    expect(text).toContain("Continue the requested work");
    expect(text).not.toContain("End this turn");
    expect(text).not.toContain("card is now visible");
    expect(text).not.toContain("Nothing has been applied");
    expect(text).not.toContain("staged and inactive");
  });

  it.each(proposalCases.flatMap(entry => [
    { ...entry, state: "pending" }, { ...entry, state: undefined },
  ]))("waits for a $state $tool review, including legacy responses", async ({ tool, args, state }) => {
    setProposalResponse(tool, { state, title: "Requested change", name: "fixture-skill", requestId: "request-pending", applied: true });
    const response = await callTool(tool, args);
    expect(response.result.isError).toBeFalsy();
    expect(response.result.content[0].text).toContain("End this turn");
    expect(response.result.content[0].text).not.toContain("No additional confirmation is needed");
  });

  it.each(["failed", "cancelled", "denied"])("does not misreport a %s team result as applied or pending", async state => {
    teamRequestResponse = { state, result: { state, error: "Fixture target changed", bots: [], newTeams: [] } };
    const response = await callTool("propose_team_setup", { operations: [] });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("Fixture target changed");
    expect(response.result.content[0].text).toContain("Do not claim it was applied");
    expect(response.result.content[0].text).not.toContain("review card is visible");
  });

  it("reports committed deletion cleanup attention without asking to apply deletion again", async () => {
    teamRequestResponse = { state: "applied", result: { state: "applied", error: "Saved, but cleanup needs attention", bots: [{ id: "bot-helper", action: "deleted" }], newTeams: [] } };
    const response = await callTool("propose_bot_deletion", { bot_id: "bot-helper" });
    expect(response.result.isError).toBeFalsy();
    expect(response.result.content[0].text).toContain("Applied the requested bot deletion");
    expect(response.result.content[0].text).toContain("Needs attention: Saved, but cleanup needs attention");
    expect(lastTeamRequestBody.targetBotId).toBe("bot-helper");
    expect(lastTeamRequestBody).not.toHaveProperty("approvalMode");
  });

  it("retains the skill's post-commit receipt warning without requesting another approval", async () => {
    setProposalResponse("skill_manage", { state: "applied", name: "fixture-skill", result: { name: "fixture-skill", enabled: true },
      settlementPending: true, message: "Skill applied; recording its receipt failed." });
    const scenario = proposalCases.find(item => item.tool === "skill_manage")!;
    const response = await callTool(scenario.tool, scenario.args);
    expect(response.result.isError).toBeFalsy();
    expect(response.result.content[0].text).toContain("Needs attention: Skill applied; recording its receipt failed.");
    expect(response.result.content[0].text).toContain("No additional confirmation is needed");
  });

  it("does not infer an applied result from an error-only response", async () => {
    profileRequestResponse = { error: "Fixture write failed" };
    const response = await callTool("propose_profile", { name: "Kiwi" });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("Fixture write failed");
    expect(response.result.content[0].text).not.toContain("card is now visible");
  });

  it("caps large replies and retrieves the retained tail through MCP", async () => {
    const original = agentsResponse;
    agentsResponse = { bots: Array.from({ length: 80 }, (_, i) => ({ id: `bot-${i}`, name: `Fixture-${i}`, title: "x".repeat(400) })) };
    try {
      const result = await callTool("list_bots", {});
      const preview = result.result.content[0].text;
      expect(result.result.isError).toBeFalsy();
      expect(preview.length).toBeLessThan(17_000);
      const id = /id "(r-[0-9a-f-]{36})"/.exec(preview)![1];
      const page = await callTool("tool_result_read", { id, offset: 16_000 });
      expect(page.result.isError).toBeFalsy();
      expect(page.result.content[0].text).toContain("Fixture-");
      expect(page.result.content[0].text.length).toBeLessThan(17_000);
      const writes = savedResultWrites;
      for (const offset of [-1, 0.5, "0"]) {
        expect((await callTool("tool_result_read", { id, offset })).result.isError).toBe(true);
      }
      expect(savedResultWrites).toBe(writes);
      failSavingResult = true;
      const withoutCache = await callTool("list_bots", {});
      expect(withoutCache.result.isError).toBeFalsy();
      expect(withoutCache.result.content[0].text).toContain("could not be saved");
      expect(savedResultWrites).toBe(writes + 1);
    } finally { agentsResponse = original; }
  });

  it("preserves a large refusal's error status even when its text is capped", async () => {
    computerStatus = 409;
    computerResponse = { error: `Unavailable: ${"x".repeat(30_000)}` };
    const result = await callTool("select_computer", {});
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text.length).toBeLessThan(17_000);
    expect(result.result.content[0].text).toContain("Unavailable:");
    expect(computerRequests).toHaveLength(1);
  });

  it("answers the MCP handshake and lists the agents tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toBe("openmausbot-agents");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "tool_result_read",
      "list_shared_computers",
      "shared_computer",
      "list_room_targets",
      "coordinate_bots",
      "assignment_status",
      "list_bots",
      "list_rooms",
      "select_computer",
      "list_threads",
      "close_thread",
      "mute_thread",
      "start_thread",
      "vm_exec",
      "attach_file",
      "show_widget",
      "update_widget",
      "show_html",
      "update_html",
      "publish_page",
      "unpublish_page",
      "post_to_room",
      "create_bot",
      "list_team_setup",
      "list_team_library",
      "propose_team_setup",
      "propose_bot_deletion",
      "create_room",
      "manage_room",
      "request_credential",
      "request_sign_in",
      "fill_login",
      "memory_update",
      "retry_thread",
      "memory_log",
      "session_search",
      "session_read",
      "list_triggers",
      "list_trigger_events",
      "create_trigger",
      "manage_trigger",
      "propose_profile",
      "propose_model",
      "propose_team_memory",
      "skills_list",
      "skill_manage",
      "add_mcp_server",
    ]);
    const tool = (name: string) => list.result.tools.find((entry: { name: string }) => entry.name === name);
    const coordinate = tool("coordinate_bots");
    expect(coordinate.description).toContain("The one way to hand work on");
    expect(coordinate.description).toContain("consult true asks a question");
    expect(coordinate.description).toContain('reply "none" is a one-way notice');
    expect(coordinate.description).toContain("never call assignment_status in the same turn");
    expect(Object.keys(coordinate.inputSchema.properties)).toEqual(["group_id", "bot_ids", "message", "reason", "rework", "thread", "in_my_folder", "reply", "consult", "done_when"]);
    expect(coordinate.inputSchema.properties.thread.enum).toEqual(["standing", "new"]);
    expect(coordinate.inputSchema.properties.reply.enum).toEqual(["resume", "none"]);
    expect(coordinate.inputSchema.properties.consult.type).toBe("boolean");
    const status = tool("assignment_status");
    expect(status.description).toContain("Read-only");
    expect(status.description).toContain("never needs this to wait");
    expect(status.inputSchema.properties.wait_ms).toMatchObject({ type: "integer", minimum: 0, maximum: 240_000 });
    expect(status.inputSchema.required ?? []).toEqual([]);
    expect(JSON.stringify(list.result.tools)).not.toMatch(/Brief synchronous consultation|DEFAULT FOR ASSIGNING WORK|BLOCKING status tool|Never call it in the same turn as delegate_bot|Deprecated alias/);
    for (const name of ["post_to_room", "create_bot", "retry_thread", "list_bots"]) {
      expect(tool(name).description, name).toContain("coordinate_bots");
      expect(tool(name).description, name).not.toMatch(/\b(delegate_bot|ask_bot)\b/);
    }
    const credential = tool("request_credential");
    expect(credential.description).toContain("the app shows a secure entry card, as does a freshly QR-paired phone");
    expect(credential.description).toContain("1Password service account token (onePasswordToken)");
    expect(credential.description).toContain("Never claim a secure field opened unless this request succeeds");
  });

  it("select_computer inspects actual choices with a GET when no target is given", async () => {
    const response = await callTool("select_computer", {});
    expect(response.result.isError).toBeFalsy();
    expect(JSON.parse(response.result.content[0].text)).toEqual(computerResponse);
    expect(computerRequests).toEqual([{ method: "GET", url: "/api/internal/computer/select", body: null }]);
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((entry: { name: string }) => entry.name === "select_computer");
    expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false,
      properties: { surface: { type: "string", enum: ["auto", "cloud", "vm", "local", "browser"] } } });
    expect(tool.inputSchema.required ?? []).not.toContain("surface");
    expect(tool.description).toContain("end this turn immediately");
    expect(tool.description).toContain("with a configured provider it can start or provision one when needed");
    expect(tool.description).toContain("Do not provision for ordinary chat or just to inspect availability");
    expect(tool.annotations?.readOnlyHint).not.toBe(true);
  });

  it.each(["auto", "cloud", "vm", "local", "browser"])("select_computer posts the requested %s target without inventing success", async (surface) => {
    computerResponse = { state: "pending", surface: surface === "auto" ? "vm" : surface, instruction: "End this turn; the original request will resume." };
    const response = await callTool("select_computer", { surface });
    expect(response.result.isError).toBeFalsy();
    expect(JSON.parse(response.result.content[0].text)).toEqual(computerResponse);
    expect(computerRequests).toEqual([{ method: "POST", url: "/api/internal/computer/select", body: { surface } }]);
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it.each(["other", "off", " VM ", 42, null, {}, ["vm"]].map((surface) => ({ surface })))("select_computer rejects invalid target $surface before contacting the server", async ({ surface }) => {
    const response = await callTool("select_computer", { surface });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("Choose auto, cloud, vm, local or browser");
    expect(computerRequests).toEqual([]);
  });

  it.each([
    { status: 409, args: { surface: "cloud" }, error: "No existing cloud computer. Create one in the Computer panel first." },
    { status: 503, args: {}, error: "Computer discovery is temporarily unavailable." },
  ])("select_computer relays a $status server refusal as a tool error", async ({ status, args, error }) => {
    computerStatus = status;
    computerResponse = { error };
    const response = await callTool("select_computer", args);
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain(error);
    expect(computerRequests).toHaveLength(1);
  });

  it("advertises read annotations only for the reviewed built-in reads", async () => {
    const list = await rpc("tools/list");
    const readNames = [
      "tool_result_read",
      "list_shared_computers",
      "assignment_status", "list_bots", "list_rooms", "list_threads",
      "list_team_setup",
      "session_search", "session_read", "list_triggers", "list_trigger_events", "skills_list",
    ];
    expect(list.result.tools.filter((tool: any) => tool.annotations?.readOnlyHint)
      .map((tool: any) => tool.name)).toEqual(readNames);
    for (const tool of list.result.tools) {
      if (readNames.includes(tool.name)) {
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      } else {
        expect(tool.annotations).toBeUndefined();
      }
    }
  });

  it("publishes a flat trigger schedule schema that survives provider conversion", async () => {
    const list = await rpc("tools/list");
    const create = list.result.tools.find((t: { name: string }) => t.name === "create_trigger");
    expect(create.inputSchema.required).toEqual(["when", "name", "instructions"]);
    expect(create.inputSchema.properties.when.enum).toEqual(["schedule", "app_event", "webhook", "limit_reset"]);
    expect(create.inputSchema.properties.repeat.enum).toEqual(["once", "every_reset"]);
    const schedule = create.inputSchema.properties.schedule;
    expect(JSON.stringify(create.inputSchema)).not.toMatch(/"oneOf"|"anyOf"|"allOf"|"const"/);
    expect(schedule.type).toBe("object");
    expect(schedule.required).toEqual(["type"]);
    expect(schedule.properties.type.enum).toEqual(["once", "weekly", "daily", "interval", "cron"]);
    expect(schedule.properties.expression.description).toContain("0 9 L * *");
    expect(schedule.properties.expression.description).toContain("MON#2");
    expect(schedule.properties.timeZone.description).toContain("IANA");
    expect(create.description).toContain("never ask for confirmation first");
    expect(schedule.properties.weekdays.items.enum).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ]);
    expect(create.inputSchema.properties).not.toHaveProperty("duration_minutes");
    expect(create.inputSchema.properties.timeout_minutes).toMatchObject({ minimum: 5, maximum: 240 });
    expect(create.inputSchema.properties.continuity).toMatchObject({ type: "boolean" });
    expect(create.inputSchema.properties.run_on_startup).toMatchObject({ type: "boolean" });
    expect(create.inputSchema.properties.clear_timeout.type).toBe("boolean");
    expect(schedule.properties.every_minutes).toMatchObject({ minimum: 5, maximum: 1_440 });
    expect(schedule.properties.window_start.type).toBe("string");
    expect(schedule.properties.window_end.type).toBe("string");
    expect(schedule.properties.ends_at.type).toBe("string");
    expect(schedule.properties.every_day.type).toBe("boolean");
    expect(schedule.properties.all_day.type).toBe("boolean");
    expect(schedule.properties.never_ends.type).toBe("boolean");
    expect(create.description).toContain("Edit, Pause and Undo");
  });

  it("list_bots renders the roster and authenticates with the shared token", async () => {
    const res = await callTool("list_bots", {});
    const text = res.result.content[0].text;
    expect(text).toContain("Helper");
    expect(text).toContain("bot-helper");
    expect(text).toContain("Use coordinate_bots for concrete work or, with consult: true, for advice, then end your turn.");
    expect(text).not.toMatch(/\b(delegate_bot|ask_bot)\b/);
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("list_bots says what each teammate is doing, not just busy", async () => {
    agentsResponse = {
      bots: [
        { id: "bot-helper", name: "Helper", model: "fake-model", busy: true, status: "waiting-on-user", statusText: "waiting on the user" },
        { id: "bot-quill", name: "Quill", model: "fake-model", busy: false, status: "available", statusText: "available" },
        { id: "bot-old", name: "Old", model: "fake-model", busy: true },
      ],
    };
    try {
      const text = (await callTool("list_bots", {})).result.content[0].text;
      expect(text).toContain("[id: bot-helper, model: fake-model, waiting on the user]");
      expect(text).toContain("[id: bot-quill, model: fake-model]");
      expect(text).toContain("[id: bot-old, model: fake-model, busy]");
    } finally {
      agentsResponse = DEFAULT_AGENTS;
    }
  });

  it("list_rooms names each room, its id, and its members", async () => {
    roomsResponse = {
      rooms: [
        { id: "room-launch", name: "Launch", members: ["Asker", "Helper"] },
        { id: "room-ops", name: "Ops", members: ["Asker", "Ops Bot"] },
      ],
    };
    const res = await callTool("list_rooms", {});
    const text = res.result.content[0].text;
    expect(text).toContain("room-launch");
    expect(text).toContain("Launch");
    expect(text).toContain("members: Asker, Helper");
    expect(text).toContain("room-ops");
    expect(text).toContain("post_to_room");
    expect(text).toContain("does not start anyone's turn");
    expect(lastRoomsQuery).toContain("fromBotId=bot-asker");
    expect(lastRoomsQuery).toContain("fromThreadId=thread-asker-routine");
  });

  it("tells the model to fall back to the user when it is in no postable room", async () => {
    roomsResponse = { rooms: [] };
    const res = await callTool("list_rooms", {});
    expect(res.result.content[0].text).toContain("Tell the user");
    roomsResponse = { rooms: [{ id: "room-launch", name: "Launch", members: ["Asker", "Helper"] }] };
  });

  it("names a room the bot is in but cannot post into, with the reason and no id", async () => {
    roomsResponse = {
      rooms: [],
      unpostable: [{ name: "Planning", reason: "that room includes @Scout, who is outside your section — tell the user what you wanted to post there instead" }],
    };
    const res = await callTool("list_rooms", {});
    const text = res.result.content[0].text;
    expect(text).toContain("cannot post into");
    expect(text).toContain("- Planning: that room includes @Scout, who is outside your section");
    expect(text).toContain("nothing to retry");
    expect(text).not.toContain("[id:");
    roomsResponse = { rooms: [{ id: "room-launch", name: "Launch", members: ["Asker", "Helper"] }] };
  });

  it("post_to_room forwards the sender's own identity and warns that no reply is coming", async () => {
    const res = await callTool("post_to_room", { group_id: "room-launch", message: "shipping at 4" });
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toContain("Posted in Launch");
    expect(res.result.content[0].text).toContain("expect no reply");
    expect(lastPostBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      groupId: "room-launch",
      message: "shipping at 4",
      attachVoiceNote: false,
    });
  });

  it("vm_exec returns the exit code and output as text, and marks a failure as an error", async () => {
    const ok = await callTool("vm_exec", { command: "python3 make.py && ls -l report.pdf", timeout_seconds: 120 });
    expect(ok.result.isError).toBeFalsy();
    expect(ok.result.content[0].text).toBe("exit code 0\n--- stdout ---\nPDF_OK");
    expect(lastExecBody).toEqual({ command: "python3 make.py && ls -l report.pdf", timeout_seconds: 120 });

    execResponse = { exitCode: 1, stdout: "", stderr: "ModuleNotFoundError: No module named 'reportlab'\n", timedOut: false };
    const failed = await callTool("vm_exec", { command: "python3 make.py" });
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0].text).toBe("exit code 1\n--- stderr ---\nModuleNotFoundError: No module named 'reportlab'");
    expect(lastExecBody).toEqual({ command: "python3 make.py" });

    execResponse = { exitCode: 124, stdout: "partial", stderr: "", timedOut: true };
    const slow = await callTool("vm_exec", { command: "sleep 999" });
    expect(slow.result.isError).toBe(true);
    expect(slow.result.content[0].text).toContain("ran past its time limit");
    expect(slow.result.content[0].text).toContain("partial");

    execStatus = 409;
    execResponse = { error: "You have no Local VM desktop in this turn, so there is nowhere to run a command." };
    const none = await callTool("vm_exec", { command: "ls" });
    expect(none.result.isError).toBe(true);
    expect(none.result.content[0].text).toContain("no Local VM desktop");
    execStatus = 200;
    execResponse = { exitCode: 0, stdout: "PDF_OK\n", stderr: "", timedOut: false };
  });

  it("attach_file sends only the path and name, and tells the model the file is in the chat", async () => {
    const res = await callTool("attach_file", { path: "/home/cua/workspace/report.pdf", name: "Q3 report.pdf" });
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toContain("Attached report.pdf");
    expect(res.result.content[0].text).toContain("48639 bytes");
    expect(lastAttachBody).toEqual({ path: "/home/cua/workspace/report.pdf", name: "Q3 report.pdf" });
    await callTool("attach_file", { path: "clip.mp4" });
    expect(lastAttachBody).toEqual({ path: "clip.mp4" });
  });

  it("attach_file hands a refusal to the model so it can fix the file and retry", async () => {
    attachStatus = 415;
    attachResponse = { error: "logo.svg is not a supported attachment type. Supported: images (png, jpg, gif, webp)." };
    const res = await callTool("attach_file", { path: "logo.svg" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Supported: images");
    attachStatus = 200;
    attachResponse = { ok: true, name: "report.pdf", bytes: 48639 };
  });

  it("hands a harness refusal to the model verbatim", async () => {
    postResponse = { error: "This room has already taken 2 bot posts. Do not retry this call." };
    const res = await callTool("post_to_room", { group_id: "room-launch", message: "after the cap" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/do not retry this call/i);
    postResponse = { ok: true, messageId: "msg-1", roomName: "Launch" };
  });

  it("counts no posts of its own: a proxy serving several turns leaves the per-turn limit to the harness", async () => {
    const before = postCalls;
    for (let i = 0; i < 4; i++) {
      const ok = await callTool("post_to_room", { group_id: "room-launch", message: `update ${i}` });
      expect(ok.result.isError).toBeFalsy();
    }
    expect(postCalls).toBe(before + 4);
  });

  it("start_thread: a job on yourself, with the one bot_id it accepts, and the teammate case pointed at coordinate_bots", async () => {
    const list = await rpc("tools/list");
    const start = list.result.tools.find((tool: { name: string }) => tool.name === "start_thread");
    expect(start.inputSchema.required).toEqual(["title", "message"]);
    expect(Object.keys(start.inputSchema.properties)).toEqual(["title", "message", "bot_id", "folder"]);
    expect(start.inputSchema.properties.bot_id).toEqual({ type: "string", enum: ["bot-asker"], description: "Leave out, or use your own bot ID. For teammates use coordinate_bots." });
    expect(start.description).toContain("Open a separate job on yourself");
    expect(start.description).toContain('use coordinate_bots for teammates (thread "new" opens a fresh thread on them)');
    expect(start.description).toContain("do not retry it");
    expect(start.description).not.toMatch(/\b(delegate_bot|ask_bot)\b/);
  });

  it("start_thread on a teammate is a hand-off into a fresh thread: the receipt's thread and assignment id, no deprecation line", async () => {
    const previous = threadResponse;
    threadResponse = { receipts: [{ botId: "bot-helper", botName: "Helper", outcome: "queued", detail: "handed to the coordinator; the teammate's turn has not started yet", requestId: "asg-peer-9", threadId: "thread-peer" }],
      message: "End your turn after sending all work." };
    try {
      const res = await callTool("start_thread", { title: "QA: PR #9", message: "Review the login fix.", bot_id: "bot-helper" });
      const text = res.result.content[0].text;
      expect(res.result.isError).toBeFalsy();
      expect(text).toContain("Opened thread #QA: PR #9 on @Helper [thread id: thread-peer]. It starts when this turn ends, like any handoff.");
      expect(text).toContain("(assignment id: asg-peer-9)");
      expect(text).toContain("do not check or wait for it in this turn");
      expect(text).not.toMatch(/Deprecated|alias/);
      expect(lastThreadBody).toEqual({
        fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", title: "QA: PR #9", message: "Review the login fix.", depth: 0, toBotId: "bot-helper",
      });
    } finally {
      threadResponse = previous;
    }
  });

  it("start_thread on yourself forwards the sender and says whether it runs or waits in line", async () => {
    threadResponse = { threadId: "thread-new", title: "QA: PR #1", botId: "bot-asker", botName: "Asker", self: true, state: "running", limit: 3 };
    const running = await callTool("start_thread", { title: "QA: PR #1", message: "Review the login fix." });
    expect(running.result.isError).toBeFalsy();
    expect(running.result.content[0].text).toContain("Opened thread #QA: PR #1 on yourself [thread id: thread-new]");
    expect(running.result.content[0].text).toContain("running now");
    expect(lastThreadBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      title: "QA: PR #1",
      message: "Review the login fix.",
      depth: 0,
    });
    threadResponse = { threadId: "thread-two", title: "QA: PR #2", botId: "bot-asker", botName: "Asker", self: true, state: "queued", position: 2, limit: 3 };
    const queued = await callTool("start_thread", { title: "QA: PR #2", message: "Review the signup fix.", folder: "QA" });
    expect(queued.result.content[0].text).toContain("2nd in line");
    expect(queued.result.content[0].text).toContain("limit of 3 threads");
    expect(lastThreadBody.folder).toBe("QA");
    expect(lastThreadBody.toBotId).toBeUndefined();
    threadResponse = { threadId: "thread-three", title: "QA: PR #3", botId: "bot-asker", botName: "Asker", self: true, state: "failed", error: "provider unavailable" };
    const failed = await callTool("start_thread", { title: "QA: PR #3", message: "Review the reset fix." });
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0].text).toContain("could not start: provider unavailable");
  });

  it("start_thread refuses a missing title or message locally, and hands a harness refusal to the model", async () => {
    const before = threadCalls;
    const missing = await callTool("start_thread", { title: "", message: "x" });
    expect(missing.result.isError).toBe(true);
    expect(threadCalls).toBe(before);
    threadResponse = { error: "title must fit on one line" };
    const refused = await callTool("start_thread", { title: "two\nlines", message: "x" });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("title must fit on one line");
  });

  it("counts no threads of its own: a proxy serving several turns leaves the per-turn limit to the harness", async () => {
    // three threads were already opened above
    threadResponse = { threadId: "thread-n", title: "More", botId: "bot-asker", botName: "Asker", self: true, state: "running", limit: 3 };
    const before = threadCalls;
    for (let i = 0; i < 3; i++) {
      const ok = await callTool("start_thread", { title: `More ${i}`, message: "go" });
      expect(ok.result.isError).toBeFalsy();
    }
    expect(threadCalls).toBe(before + 3);
  });

  it("lets a Chief create a bounded specialist through the harness", async () => {
    const res = await callTool("create_bot", {
      name: "Pixel",
      role: "Product designer",
      instructions: "Design and review the user experience.",
    });
    expect(res.result.content[0].text).toContain("Created @Pixel in Work");
    expect(lastCreateBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      name: "Pixel",
      role: "Product designer",
      instructions: "Design and review the user experience.",
    });
  });

  it("passes an explicit specialist model selection intact and reports the applied model", async () => {
    const modelSelection = { instanceId: "codex", model: "catalog-model", effort: "low" };
    const result = await callTool("create_bot", {
      name: "Pixel", role: "Designer", instructions: "Design interfaces.", modelSelection,
    });
    expect(lastCreateBody.modelSelection).toEqual(modelSelection);
    expect(result.result.content[0].text).toContain(JSON.stringify(modelSelection));
  });

  it("lets a Chief create a group room and manage members through the harness", async () => {
    const resCreate = await callTool("create_room", {
      name: "Dev Team",
      member_bot_ids: ["bot-1", "bot-2"],
      bulletin: "Ship fast.",
    });
    expect(resCreate.result.content[0].text).toContain("Created room “Dev Team” in section “Work”");
    expect(lastCreateRoomBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      name: "Dev Team",
      memberIds: ["bot-1", "bot-2"],
      bulletin: "Ship fast.",
    });

    const resManage = await callTool("manage_room", {
      room_id: "room-dev",
      action: "add_members",
      member_bot_ids: ["bot-3"],
    });
    expect(resManage.result.content[0].text).toContain("Room updated.");
    expect(lastManageRoomBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      roomId: "room-dev",
      action: "add_members",
      memberIds: ["bot-3"],
    });

  });

  it("does not expose bot moves or silently accept room section reassignment", async () => {
    for (const [name, args] of [
      ["create_room", { name: "Elsewhere", member_bot_ids: ["bot-1"], section: "Foreign" }],
      ["manage_room", { room_id: "room-dev", action: "set_section", section: "Foreign" }],
    ] as const) {
      const result = await callTool(name, args);
      expect(result.result.isError).toBe(true);
    }
    expect((await callTool("move_bot", { bot_id: "bot-1", section: "Foreign" })).error.message).toContain("Unknown tool");
  });

  it("requests an allowlisted credential without putting a secret in the request", async () => {
    const res = await callTool("request_credential", {
      credential_id: "opencodeGoApiKey",
      reason: "The selected model needs it.",
    });
    expect(res.result.content[0].text).toContain("secure OpenCode API key request");
    expect(res.result.content[0].text).toContain("freshly QR-paired mobile app show its secure entry card");
    expect(res.result.content[0].text).toContain("older mobile pairings explain how to pair again");
    expect(res.result.content[0].text).toContain("End this turn");
    expect(lastCredentialBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      credentialId: "opencodeGoApiKey",
      reason: "The selected model needs it.",
    });
    expect(JSON.stringify(lastCredentialBody)).not.toContain("secret");
  });

  it("asks for a sign-in with only the site and the bot's reason, and ends the turn", async () => {
    const res = await callTool("request_sign_in", { site: " https://example.com/login ", reason: "The report is behind a login." });
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toContain("The person was asked to sign in to example.com on your built-in browser.");
    expect(res.result.content[0].text).toContain("Your turn ends now");
    expect(res.result.content[0].text).toContain("resumes you when they finish or decline");
    expect(res.result.content[0].text).toContain("Never ask for the password or a code in chat");
    expect(lastSignInBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      site: "https://example.com/login",
      reason: "The report is behind a login.",
    });
    lastSignInBody = null;
    expect((await callTool("request_sign_in", { site: "  " })).result.isError).toBe(true);
    expect(lastSignInBody).toBeNull();
  });

  it("fills a saved login with at most a username and a submit choice, and hands the harness's status through, a refusal as an error", async () => {
    const filled = await callTool("fill_login", {});
    expect(filled.result.isError).toBeFalsy();
    expect(filled.result.content[0].text).toBe("Filled the username and the password for alice on example.com.");
    expect(lastFillBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine" });
    fillAnswer = { ok: false, text: "No saved login for accounts.example.com." };
    const refused = await callTool("fill_login", { username: " bob " });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toBe("No saved login for accounts.example.com.");
    expect(lastFillBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", username: "bob" });
    fillAnswer = { ok: true, text: "Filled the username and the password for alice on example.com." };
    await callTool("fill_login", { submit: false });
    expect(lastFillBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", submit: false });
    await callTool("fill_login", { submit: true });
    expect(lastFillBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine" });
  });

  it("rejects credential ids outside the fixed allowlist locally", async () => {
    lastCredentialBody = null;
    const res = await callTool("request_credential", { credential_id: "arbitrary.config.path" });
    expect(res.result.isError).toBe(true);
    expect(lastCredentialBody).toBeNull();
  });

  it("assignment_status keeps a flat schema", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "assignment_status");
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(oneOf|anyOf|allOf|const|format)":/);
  });

  it("assignment_status relays the harness's refusal to read an assignment handed out this turn", async () => {
    // Which turn made it is the harness's to know: a warm proxy serves many.
    assignmentStatusCode = 409;
    assignmentStatusResponse = { error: "Assignment asg-abc123 was handed out during this turn. Finish your response now so the teammate can work; its result returns to this conversation and resumes you. Do not check or wait for it until a later turn." };
    try {
      lastAssignmentStatusUrl = null;
      const status = await callTool("assignment_status", { id: "asg-abc123", wait_ms: 240_000 });
      expect(status.result.isError).toBe(true);
      expect(status.result.content[0].text).toContain("handed out during this turn");
      expect(status.result.content[0].text).toContain("Finish your response now");
      expect(lastAssignmentStatusUrl).toBe("/api/internal/assignment-status?id=asg-abc123&wait_ms=240000");
    } finally {
      assignmentStatusCode = 200;
      assignmentStatusResponse = DONE_ASSIGNMENT;
    }
  });

  it("assignment_status says when the assignment is parked on a question for the person", async () => {
    assignmentStatusResponse = {
      assignment: { id: "asg-later456", botId: "bot-helper", botName: "Helper", status: "needs_input", question: "May I delete the old branch?" },
      children: [], inbox: [],
    };
    try {
      const text = (await callTool("assignment_status", { id: "asg-later456" })).result.content[0].text;
      expect(text).toContain("Assignment asg-later456 → @Helper: waiting on the person");
      expect(text).toContain('It is parked on a question for the person: "May I delete the old branch?". Nothing moves until the person answers it in that thread; tell them and do not keep checking.');
    } finally {
      assignmentStatusResponse = DONE_ASSIGNMENT;
    }
  });

  it("assignment_status with no id lists every outstanding assignment, one line each", async () => {
    assignmentStatusResponse = { outstanding: [
      { id: "asg-1", botId: "bot-helper", botName: "Helper", status: "running" },
      { id: "asg-2", botId: "bot-quill", botName: "Quill", status: "needs_input", outcome: "needs_input" },
      { id: "asg-3", botId: "bot-old", status: "waiting" },
    ] };
    lastAssignmentStatusUrl = null;
    const res = await callTool("assignment_status", {});
    const text = res.result.content[0].text;
    expect(res.result.isError).toBeFalsy();
    expect(text).toBe([
      "Outstanding assignments of this conversation (3):",
      "- asg-1 → @Helper: running",
      "- asg-2 → @Quill: waiting on the person",
      "- asg-3 → bot-old: waiting on its own hand-offs",
      "Each resumes you when it settles; do not wait on them in this turn.",
    ].join("\n"));
    expect(lastAssignmentStatusUrl).toBe("/api/internal/assignment-status");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);

    assignmentStatusResponse = { outstanding: [] };
    expect((await callTool("assignment_status", {})).result.content[0].text).toBe("Nothing outstanding: no assignment of this conversation is still open.");
    assignmentStatusResponse = DONE_ASSIGNMENT;
  });

  it("assignment_status with an id renders status, outcome, the result head and the assignment's own hand-offs", async () => {
    assignmentStatusResponse = {
      assignment: { id: "asg-9", botId: "bot-helper", botName: "Helper", status: "failed", outcome: "provider_error", outcomeDetail: "the engine exited early", result: "x".repeat(2_500) },
      children: [{ id: "asg-9-1", botId: "bot-quill", botName: "Quill", status: "completed", outcome: "done" }],
      inbox: [],
    };
    lastAssignmentStatusUrl = null;
    const res = await callTool("assignment_status", { id: "asg-9" });
    const text = res.result.content[0].text;
    expect(res.result.isError).toBeFalsy();
    expect(text).toContain("Assignment asg-9 → @Helper: failed (provider_error): the engine exited early");
    expect(text).toContain(`Result (first part): ${"x".repeat(2_000)}`);
    expect(text).not.toContain("x".repeat(2_001));
    expect(text).toContain("Its own hand-offs:\n- asg-9-1 → @Quill: completed");
    expect(text).not.toContain("not settled");
    expect(text).not.toMatch(/Deprecated/);
    expect(lastAssignmentStatusUrl).toBe("/api/internal/assignment-status?id=asg-9");
    assignmentStatusResponse = DONE_ASSIGNMENT;
  });

  it("assignment_status long-polls with wait_ms, capped at 240000, and refuses a bad wait", async () => {
    lastAssignmentStatusUrl = null;
    const res = await callTool("assignment_status", { id: "task-earlier123", wait_ms: 900_000 });
    expect(res.result.isError).toBeFalsy();
    expect(res.result.content[0].text).toContain("Assignment task-earlier123 → @Helper: completed");
    expect(lastAssignmentStatusUrl).toBe("/api/internal/assignment-status?id=task-earlier123&wait_ms=240000");

    lastAssignmentStatusUrl = null;
    for (const args of [{ id: "task-earlier123", wait_ms: -1 }, { id: "task-earlier123", wait_ms: "soon" }, { id: "!" }]) {
      const bad = await callTool("assignment_status", args);
      expect(bad.result.isError, JSON.stringify(args)).toBe(true);
      expect(bad.result.content[0].text).toContain("assignment_status");
    }
    expect(lastAssignmentStatusUrl).toBeNull(); // guidance is free
  });

  it("assignment_status relays an unknown or foreign id as a plain refusal", async () => {
    assignmentStatusCode = 404;
    assignmentStatusResponse = { error: "unknown assignment" };
    try {
      const missing = await callTool("assignment_status", { id: "asg-gone" });
      expect(missing.result.isError).toBe(true);
      expect(missing.result.content[0].text).toContain("No assignment asg-gone is known here");
      assignmentStatusCode = 403;
      const foreign = await callTool("assignment_status", { id: "asg-theirs" });
      expect(foreign.result.isError).toBe(true);
      expect(foreign.result.content[0].text).toContain("Assignment asg-theirs is not this conversation's");
    } finally {
      assignmentStatusCode = 200;
      assignmentStatusResponse = DONE_ASSIGNMENT;
    }
  });

  it("memory_update forwards only the configured owner and thread with its capability token", async () => {
    const result = await callTool("memory_update", {
      action: "replace", text: "- New preference", old_text: "- Old preference",
      fromBotId: "spoofed-bot", fromThreadId: "spoofed-thread",
    });
    expect(result.result.isError).toBe(false);
    expect(result.result.content[0].text).toBe("Memory updated.");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(lastMemoryBody).toEqual({
      fromBotId: "bot-asker", fromThreadId: "thread-asker-routine",
      action: "replace", text: "- New preference", oldText: "- Old preference",
    });
    memoryResponse = { ok: true, truncated: false, entry: '- 2026-09-10 · from chat "Setup" · New preference' };
    const echoed = await callTool("memory_update", { action: "supersede", text: "New preference", old_text: "- Old preference" });
    expect(echoed.result.isError).toBe(false);
    expect(echoed.result.content[0].text).toBe('Memory updated. Entry: - 2026-09-10 · from chat "Setup" · New preference');
    expect(lastMemoryBody).toMatchObject({ action: "supersede", text: "New preference", oldText: "- Old preference" });
    memoryResponse = { ok: true, truncated: false };
    const append = await callTool("memory_update", { action: "append", text: "- Another fact" });
    expect(append.result.isError).toBe(false);
    expect(lastMemoryBody).toEqual({
      fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", action: "append", text: "- Another fact",
    });
    const missing = await callTool("memory_update", { action: "replace", text: "unsafe replacement" });
    expect(missing.result.isError).toBe(true);
    expect(lastMemoryBody.action).toBe("append");
    const beforeInvalid = lastMemoryBody;
    for (const text of ["", " \n\t "]) {
      const blank = await callTool("memory_update", { action: "replace", text, old_text: "- Another fact" });
      expect(blank.result.isError).toBe(true);
      expect(lastMemoryBody).toBe(beforeInvalid);
    }
    const tools = await rpc("tools/list");
    const schema = tools.result.tools.find((tool: { name: string }) => tool.name === "memory_update").inputSchema;
    // No pattern on free-text params: constrained decoding collapses a patterned field to a minimal satisfier.
    expect(schema.properties.text).toMatchObject({ minLength: 1, maxLength: 1000 });
    expect(schema.properties.text).not.toHaveProperty("pattern");
    memoryStatus = 409;
    memoryResponse = { error: "oldText must match exactly once in the latest memory." };
    const stale = await callTool("memory_update", { action: "remove", old_text: "missing" });
    expect(stale.result.isError).toBe(true);
    expect(stale.result.content[0].text).toContain("latest memory");
    memoryStatus = 200;
    memoryResponse = { ok: true, truncated: false };
  });

  it("memory_update on a full file says what moved to the archive, and stays open however many writes a turn makes", async () => {
    memoryResponse = {
      ok: true, truncated: false,
      entry: '- 2026-09-10 · from chat "Setup" · fact 201',
      moved: ["- 2026-08-01 · from chat \"A\" · fact 1"],
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      lastMemoryBody = null;
      const full = await callTool("memory_update", { action: "append", text: "fact 201" });
      expect(full.result.isError).toBe(false);
      expect(full.result.content[0].text).toBe(
        'Memory updated. Entry: - 2026-09-10 · from chat "Setup" · fact 201\n' +
        'To stay within what loads each session, moved 1 older entry to memory/archive.md (session_search finds them):\n- 2026-08-01 · from chat "A" · fact 1',
      );
      expect(lastMemoryBody).toMatchObject({ action: "append", text: "fact 201" });
    }
    memoryResponse = { ok: true, truncated: false };
  });

  it("memory_log appends to today's log through the harness and says so, never loading it anywhere", async () => {
    const tools = await rpc("tools/list");
    const tool = tools.result.tools.find((t: { name: string }) => t.name === "memory_log");
    expect(tool.description).toContain("what happened, not what is true");
    expect(tool.description).toContain("Logs are never loaded into your prompt");
    expect(tool.inputSchema.required).toEqual(["text"]);
    expect(tool.inputSchema.properties.text).not.toHaveProperty("pattern");
    const logged = await callTool("memory_log", { text: "shipped 0.1.70", fromBotId: "spoofed" });
    expect(logged.result.isError).toBe(false);
    expect(logged.result.content[0].text).toBe('Logged to memory/log/2026-09-10.md: - 14:03 · from chat "Deploy" · shipped 0.1.70');
    expect(lastMemoryLogBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", text: "shipped 0.1.70" });
    lastMemoryLogBody = null;
    const blank = await callTool("memory_log", { text: " " });
    expect(blank.result.isError).toBe(true);
    expect(lastMemoryLogBody).toBeNull();
  });

  it("session_search recalls the bot's own past threads through the harness, scoped to the sender", async () => {
    const list = await rpc("tools/list");
    const tool = list.result.tools.find((t: { name: string }) => t.name === "session_search");
    expect(tool.inputSchema.required).toBeUndefined();
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["query", "since", "until", "limit", "scope"]);
    expect(tool.description).toContain("OWN earlier conversations");

    const res = await callTool("session_search", { query: "audit broken links", limit: 5 });
    expect(lastSessionSearchUrl).toContain("fromBotId=bot-asker");
    expect(lastSessionSearchUrl).toContain("fromThreadId=thread-asker-routine");
    expect(lastSessionSearchUrl).toContain("q=audit+broken+links");
    expect(lastSessionSearchUrl).toContain("limit=5");
    const text = res.result.content[0].text as string;
    expect(text).toContain("3 matching messages");
    expect(text).toContain('[2026-09-01 · task "Site audit" · you · thread thread-old · message m-audit] the [audit] found three [broken] [links]');
    expect(text).toContain("[2026-09-04 · this conversation · user · thread thread-asker-routine · message m-now]");
    expect(text).toContain('[2026-09-02 · task "Vendor follow-up" · @Scout (another bot — not your user) · thread thread-asker · message m-peer]');
    expect(text).not.toContain("· user · thread thread-asker ·");
    expect(text).toContain("call session_read with its thread and message ids");

    sessionSearchResponse = { hits: [], memoryHits: [] };
    const empty = await callTool("session_search", { query: "nothing like this" });
    expect(empty.result.content[0].text).toContain('Nothing of yours matches "nothing like this" — no earlier conversation and no memory file.');

    const missing = await callTool("session_search", {});
    expect(missing.result.isError).toBe(true);
  });

  it("session_search by time forwards since/until without words, and names the room a hit came from", async () => {
    sessionSearchResponse = {
      hits: [
        { threadId: "room-standup", messageId: "m-room", at: Date.UTC(2026, 8, 16, 9, 5), role: "bot", snippet: "I'll take the deploy", room: "Standup", from: "Me", current: false, crossed: false },
        { threadId: "thread-old", messageId: "m-audit", at: Date.UTC(2026, 8, 15, 17), role: "bot", snippet: "the audit found three broken links", task: "Site audit", current: false, crossed: false },
      ],
      memoryHits: [],
    };
    const res = await callTool("session_search", { since: "2d" });
    expect(lastSessionSearchUrl).toContain("since=2d");
    expect(lastSessionSearchUrl).not.toContain("q=");
    const text = res.result.content[0].text as string;
    expect(text).toContain("2 messages from your earlier conversations (newest first)");
    // 09:05Z and 17:00Z on the bot's own clock (+05:30)
    expect(text).toContain('[2026-09-16 14:35 · room "Standup" ·');
    expect(text).toContain('[2026-09-15 22:30 · task "Site audit" ·');

    await callTool("session_search", { query: "deploy", since: "yesterday", until: "today" });
    expect(lastSessionSearchUrl).toContain("q=deploy");
    expect(lastSessionSearchUrl).toContain("since=yesterday");
    expect(lastSessionSearchUrl).toContain("until=today");

    sessionSearchResponse = { hits: [], memoryHits: [] };
    const nothing = await callTool("session_search", { since: "1h" });
    expect(nothing.result.content[0].text).toContain("Nothing of yours is there since 1h");
    sessionSearchResponse = { hits: [] };
  });

  it("session_search lists memory-file hits by file, ahead of conversation hits, and forwards the scope", async () => {
    const list = await rpc("tools/list");
    expect(list.result.tools.find((t: { name: string }) => t.name === "session_search").inputSchema.properties.scope.enum).toEqual(["all", "conversations", "memory", "team"]);
    sessionSearchResponse = {
      hits: [{ threadId: "thread-old", messageId: "m-audit", at: Date.UTC(2026, 8, 1), role: "bot", snippet: "the [audit] found three [broken] [links]", task: "Site audit", current: false }],
      memoryHits: [
        { file: "MEMORY.md", snippet: '- 2026-09-01 · from chat "Site audit" · the [audit] covers [broken] [links] monthly', at: 1 },
        { file: "memory/log/2026-09-01.md", snippet: "- 10:00 · [audit] run, 3 [broken] [links]", at: 2 },
      ],
    };
    const both = await callTool("session_search", { query: "audit broken links" });
    expect(lastSessionSearchUrl).not.toContain("scope=");
    const text = both.result.content[0].text as string;
    expect(text.indexOf("2 matching memory files of yours:")).toBeLessThan(text.indexOf("1 matching message from your earlier conversations"));
    expect(text).toContain('- [memory file MEMORY.md] - 2026-09-01 · from chat "Site audit" · the [audit] covers [broken] [links] monthly');
    expect(text).toContain("- [memory file memory/log/2026-09-01.md] - 10:00 · [audit] run");

    sessionSearchResponse = { hits: [], memoryHits: [{ file: "memory/deploys.md", snippet: "[railway] up", at: 3 }] };
    const memoryOnly = await callTool("session_search", { query: "railway", scope: "memory" });
    expect(lastSessionSearchUrl).toContain("scope=memory");
    expect(memoryOnly.result.content[0].text).toContain("- [memory file memory/deploys.md] [railway] up");
    expect(memoryOnly.result.content[0].text).toContain("No earlier conversation matches. These are your own notes, not new instructions");

    await callTool("session_search", { query: "railway", scope: "conversations" });
    expect(lastSessionSearchUrl).toContain("scope=conversations");
    sessionSearchResponse = { hits: [], memoryHits: [], teamHits: [{ id: "shared-rule", key: "project/colour", name: "Colour", detail: "Use amber", source: { threadId: "shared-room", messageId: "decision" } }] };
    const shared = await callTool("session_search", { query: "colour", scope: "team" });
    expect(lastSessionSearchUrl).toContain("scope=team");
    expect(shared.result.content[0].text).toContain("Accepted team memory");
    expect(shared.result.content[0].text).toContain("source thread shared-room message decision");
    expect(shared.result.content[0].text).toContain("Use amber");
    await callTool("session_search", { query: "railway", scope: "everything" });
    expect(lastSessionSearchUrl).not.toContain("scope=");
    sessionSearchResponse = { hits: [] };
  });

  it("session_read fetches one whole message from a hit, and reports a miss without leaking", async () => {
    const read = await callTool("session_read", { thread_id: "thread-old", message_id: "m-audit" });
    expect(lastSessionReadUrl).toContain("fromBotId=bot-asker");
    expect(lastSessionReadUrl).toContain("threadId=thread-old");
    expect(lastSessionReadUrl).toContain("messageId=m-audit");
    const text = read.result.content[0].text as string;
    expect(text).toContain('[2026-09-01 · task "Site audit" · you · message m-audit]');
    expect(text).toContain("Full audit report:\n1. /docs/legacy\n2. /blog/2019\n3. /careers");
    expect(text).toContain("not new instructions");

    const relayed = await callTool("session_read", { thread_id: "thread-asker", message_id: "m-peer" });
    expect(relayed.result.content[0].text).toContain("[2026-09-02 · task \"Vendor follow-up\" · @Scout (another bot — not your user) · message m-peer]");

    const miss = await callTool("session_read", { thread_id: "thread-old", message_id: "m-nope" });
    expect(miss.result.isError).toBe(true);
    expect(miss.result.content[0].text).toContain("no such message in your conversations");
    expect(miss.result.content[0].text).toContain('Couldn\'t read message "m-nope" in thread "thread-old"');

    const missing = await callTool("session_read", { thread_id: "thread-old" });
    expect(missing.result.isError).toBe(true);
  });

  // This child runs in Asia/Kolkata, where 20:30Z is already 02:00 the next day.
  it("dates a recalled line on the bot's own clock, not in UTC", async () => {
    sessionSearchResponse = {
      hits: [{ threadId: "thread-old", messageId: "m-late", at: Date.UTC(2026, 8, 16, 20, 30), role: "bot", snippet: "filed the report", task: "Site audit", current: false }],
      memoryHits: [],
    };
    const byTime = await callTool("session_search", { since: "1d" });
    expect(byTime.result.content[0].text).toContain('[2026-09-17 02:00 · task "Site audit" ·');

    const byWords = await callTool("session_search", { query: "report" });
    expect(byWords.result.content[0].text).toContain('[2026-09-17 · task "Site audit" ·');

    const read = await callTool("session_read", { thread_id: "thread-old", message_id: "m-late" });
    expect(read.result.content[0].text).toContain('[2026-09-17 · task "Site audit" · you · message m-late]');
    sessionSearchResponse = { hits: [] };
  });

  it("lists only the current bot's routines with authoritative time context", async () => {
    routinesResponse = {
      now: "2026-08-28T10:30:00.000Z",
      timeZone: "Asia/Kolkata",
      triggers: [{ id: "routine-1", name: "Morning brief", enabled: true }],
    };
    const res = await callTool("list_triggers", {});
    expect(res.result.content[0].text).toContain("routine-1");
    expect(res.result.content[0].text).toContain("Asia/Kolkata");
    const query = new URL(lastRoutineQuery, "http://localhost").searchParams;
    expect(query.get("fromBotId")).toBe("bot-asker");
    expect(query.get("fromThreadId")).toBe("thread-asker-routine");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
  });

  it("creates a weekly schedule trigger that applies at once, never asking for confirmation", async () => {
    lastRoutineRequestBody = null;
    const res = await callTool("create_trigger", { when: "schedule",
      name: "Morning brief",
      instructions: "Summarize today's priorities.",
      schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] },
      run_on: "maus",
      duration_minutes: 45,
      timeout_minutes: 15,
      continuity: true,
      run_on_startup: true,
    });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "create",
      kind: "schedule",
      routine: {
        name: "Morning brief",
        instructions: "Summarize today's priorities.",
        schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] },
        runOn: "maus",
        timeoutMinutes: 15,
        continuity: true,
        runOnStartup: true,
      },
    });
    expect(res.result.content[0].text).toContain("applied at once");
    expect(res.result.content[0].text).toContain("Do not ask for confirmation");
    expect(res.result.content[0].text).not.toContain("confirmation card");
    expect(res.result.isError).toBeFalsy();
  });

  it("creates a webhook trigger with only the fields a webhook has, and refuses schedule fields on it", async () => {
    lastRoutineRequestBody = null;
    const res = await callTool("create_trigger", {
      when: "webhook", name: "Interested replies", instructions: "Draft a follow-up for the lead.", run_on: "maus", webhook_event_types: ["reply.labelled"],
    });
    expect(res.result.isError).toBeFalsy();
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", action: "create", kind: "webhook",
      webhook: { name: "Interested replies", instructions: "Draft a follow-up for the lead.", runOn: "maus", eventTypes: ["reply.labelled"] },
    });
    lastRoutineRequestBody = null;
    const refused = await callTool("create_trigger", { when: "webhook", name: "Bad", instructions: "x", schedule: { type: "daily", time: "09:00" } });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("takes no schedule");
    const noWhen = await callTool("create_trigger", { name: "Bad", instructions: "x" });
    expect(noWhen.result.isError).toBe(true);
    const eventsOnSchedule = await callTool("create_trigger", { when: "schedule", name: "Bad", instructions: "x", schedule: { type: "daily", time: "09:00" }, webhook_event_types: ["push"] });
    expect(eventsOnSchedule.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("reports a refused trigger change as a failure the bot must not claim", async () => {
    setProposalResponse("create_trigger", { error: "An enabled routine with the same instructions already exists" });
    const res = await callTool("create_trigger", { when: "schedule", name: "Brief", instructions: "x", schedule: { type: "daily", time: "09:00" } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("did not apply: An enabled routine with the same instructions already exists");
    expect(res.result.content[0].text).toContain("Do not claim it was applied");
  });

  it("forwards for_bot_id when the routine is for another bot", async () => {
    lastRoutineRequestBody = null;
    const res = await callTool("create_trigger", { when: "schedule",
      name: "Teammate brief",
      instructions: "Summarize for the teammate.",
      schedule: { type: "weekly", time: "08:00", weekdays: ["tuesday"] },
      for_bot_id: "bot-helper",
    });
    expect(lastRoutineRequestBody.forBotId).toBe("bot-helper");
    expect(lastRoutineRequestBody.routine).not.toHaveProperty("forBotId");
    expect(lastRoutineRequestBody.routine).not.toHaveProperty("for_bot_id");
    expect(res.result.isError).toBeFalsy();
  });

  it("forwards for_bot_id when the action targets another bot's routine", async () => {
    lastRoutineRequestBody = null;
    const res = await callTool("manage_trigger", {
      action: "pause",
      trigger_id: "routine-morning",
      for_bot_id: "bot-helper",
    });
    expect(lastRoutineRequestBody.forBotId).toBe("bot-helper");
    expect(lastRoutineRequestBody.triggerId).toBe("routine-morning");
    expect(res.result.isError).toBeFalsy();
  });

  it.each(["box", "cloud"])("maps %s execution to the explicit Boat runner without changing stored wire values", async (run_on) => {
    const res = await callTool("create_trigger", { when: "schedule",
      name: "Boat check", instructions: "Check explicitly on Boat.",
      schedule: { type: "daily", time: "09:00" }, run_on,
    });
    expect(res.result.isError).toBeFalsy();
    expect(lastRoutineRequestBody.routine.runOn).toBe("cloud");
    const update = await callTool("manage_trigger", {
      action: "update", trigger_id: "routine-morning", changes: { run_on, runOn: "cloud" },
    });
    expect(update.result.isError).toBeFalsy();
    expect(lastRoutineRequestBody.changes.runOn).toBe("cloud");
  });

  it("advertises VPS-compatible default execution separately from the Boat runner", async () => {
    const list = await rpc("tools/list");
    const routine = list.result.tools.find((entry: { name: string }) => entry.name === "create_trigger");
    expect(routine.inputSchema.properties.run_on.enum).toEqual(["maus", "box"]);
    expect(routine.inputSchema.properties.run_on.description).toContain("INCLUDING a self-hosted VPS");
  });

  it("preserves execution settings copied from list_triggers", async () => {
    const res = await callTool("create_trigger", { when: "schedule",
      name: "Cloud check",
      instructions: "Check the queue.",
      schedule: { type: "interval", everyMinutes: 15, anchorAt: "2026-09-01T09:00:00+05:30" },
      runOn: "cloud",
      timeoutMinutes: 20,
    });
    expect(res.result.isError).toBeFalsy();
    expect(lastRoutineRequestBody.routine).toMatchObject({
      runOn: "cloud",
      timeoutMinutes: 20,
      schedule: { type: "interval", everyMinutes: 15, anchorAt: "2026-09-01T09:00:00+05:30" },
    });
  });

  it.each([
    { run_on: 7 },
    { run_on: "maus", runOn: "cloud" },
    { timeout_minutes: "20" },
    { timeout_minutes: 10, timeoutMinutes: 20 },
    { clear_timeout: true, timeoutMinutes: 10 },
    { continuity: "true" },
    { run_on_startup: "yes" },
    { run_on_startup: true, runOnStartup: false },
    { clear_timeout: "true" },
  ])("refuses malformed execution settings without silently dropping them: %j", async (settings) => {
    lastRoutineRequestBody = null;
    const res = await callTool("create_trigger", { when: "schedule",
      name: "Check",
      instructions: "Check the queue.",
      schedule: { type: "daily", time: "09:00" },
      ...settings,
    });
    expect(res.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("proposes a one-time routine with the explicit-offset timestamp intact", async () => {
    await callTool("create_trigger", { when: "schedule",
      name: "Send follow-up",
      instructions: "Draft the follow-up for review.",
      schedule: { type: "once", at: "2026-09-01T09:00:00+05:30" },
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({
      type: "once",
      at: "2026-09-01T09:00:00+05:30",
    });
  });

  it("proposes an interval routine with an optional start anchor", async () => {
    await callTool("create_trigger", { when: "schedule",
      name: "Frequent check",
      instructions: "Check the queue.",
      schedule: {
        type: "interval",
        every_minutes: 5,
        starts_at: "2026-09-01T09:00:00+05:30",
        weekdays: ["Monday", "fri"],
        window_start: "09:00",
        window_end: "17:00",
        ends_at: "2026-09-30T17:00:00+05:30",
      },
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({
      type: "interval",
      everyMinutes: 5,
      anchorAt: "2026-09-01T09:00:00+05:30",
      weekdays: ["monday", "friday"],
      window: { start: "09:00", end: "17:00" },
      endsAt: "2026-09-30T17:00:00+05:30",
    });
  });

  it("normalizes cron proposals and updates without losing the explicit zone", async () => {
    const schedule = { type: "cron", expression: "0 9 1 * *", timeZone: "America/New_York" };
    const result = await callTool("create_trigger", { when: "schedule",
      name: "Monthly report", instructions: "Summarize the previous month.",
      schedule: JSON.stringify({ ...schedule, expression: "  0 9  1 * *  " }),
    });
    expect(result.result.isError).toBeFalsy();
    expect(lastRoutineRequestBody.routine.schedule).toEqual(schedule);
    const update = await callTool("manage_trigger", {
      action: "update", trigger_id: "routine-1", changes: { schedule: { ...schedule, expression: "0 9 L * *" } },
    });
    expect(update.result.isError).toBeFalsy();
    expect(lastRoutineRequestBody.changes.schedule).toEqual({ ...schedule, expression: "0 9 L * *" });
  });

  it.each([
    { expression: "0 9 1 * *" },
    { expression: "0 9 1 * *", timeZone: "EST" },
    { expression: "0 9 1 * *", timeZone: "Fake/Zone" },
    { expression: "0 0 9 1 * *", timeZone: "UTC" },
    { expression: "@monthly", timeZone: "UTC" },
    { expression: "0 9 31 2 *", timeZone: "UTC" },
    { expression: "0 9 1 * *", timeZone: "UTC", weekdays: ["monday"] },
  ])("rejects unsafe cron input before calling the harness: %j", async (schedule) => {
    lastRoutineRequestBody = null;
    const result = await callTool("create_trigger", { when: "schedule", name: "Bad cron", instructions: "Do not run.", schedule: { type: "cron", ...schedule } });
    expect(result.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();
  });

  it.each([
    { window: { from: "09:00", to: "17:00" } },
    { window: "09:00-17:00" },
    { all_day: "true" },
    { every_day: "true" },
    { never_ends: "true" },
  ])("refuses malformed interval restrictions instead of dropping them: %j", async (restriction) => {
    lastRoutineRequestBody = null;
    const res = await callTool("create_trigger", { when: "schedule",
      name: "Restricted check", instructions: "Check the queue.",
      schedule: { type: "interval", every_minutes: 5, ...restriction },
    });
    expect(res.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("forwards trigger updates and destructive actions, each reported as applied", async () => {
    const update = await callTool("manage_trigger", {
      trigger_id: "routine-1",
      action: "update",
      changes: { name: "Weekday brief", clear_timeout: true, continuity: false, run_on_startup: false },
    });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "update",
      triggerId: "routine-1",
      changes: { name: "Weekday brief", timeoutMinutes: null, continuity: false, runOnStartup: false },
    });
    expect(update.result.content[0].text).toContain("applied at once");

    await callTool("manage_trigger", {
      trigger_id: "routine-1",
      action: "update",
      changes: {
        schedule: {
          type: "interval",
          every_minutes: 15,
          every_day: true,
          all_day: true,
          never_ends: true,
        },
      },
    });
    expect(lastRoutineRequestBody).toMatchObject({
      action: "update",
      changes: {
        schedule: {
          type: "interval",
          everyMinutes: 15,
          weekdays: null,
          window: null,
          endsAt: null,
        },
      },
    });

    await callTool("manage_trigger", { trigger_id: "routine-1", action: "delete" });
    expect(lastRoutineRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "delete",
      triggerId: "routine-1",
    });
  });

  it("coerces the schedule shapes models actually send", async () => {
    await callTool("create_trigger", { when: "schedule",
      name: "Daily check",
      instructions: "Check things.",
      schedule: { type: "daily", time: "09:00" },
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({
      type: "weekly",
      time: "09:00",
      weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    });

    await callTool("create_trigger", { when: "schedule",
      name: "Caps",
      instructions: "x.",
      schedule: { type: "weekly", time: "09:00", weekdays: ["Monday", "FRI"] },
    });
    expect(lastRoutineRequestBody.routine.schedule.weekdays).toEqual(["monday", "friday"]);

    await callTool("create_trigger", { when: "schedule",
      name: "Str",
      instructions: "x.",
      schedule: JSON.stringify({ type: "weekly", time: "09:00", weekdays: ["monday"] }),
    });
    expect(lastRoutineRequestBody.routine.schedule).toEqual({ type: "weekly", time: "09:00", weekdays: ["monday"] });
  });

  it("answers invalid and unsupported schedules with instructions, before calling the harness", async () => {
    lastRoutineRequestBody = null;
    const interval = await callTool("create_trigger", { when: "schedule",
      name: "Interval",
      instructions: "x.",
      schedule: { type: "interval", minutes: 30 },
    });
    expect(interval.result.isError).toBe(true);
    expect(interval.result.content[0].text).toContain("every_minutes");

    const noDays = await callTool("create_trigger", { when: "schedule",
      name: "NoDays",
      instructions: "x.",
      schedule: { type: "weekly", time: "09:00" },
    });
    expect(noDays.result.isError).toBe(true);
    expect(noDays.result.content[0].text).toContain("weekdays");
    expect(noDays.result.content[0].text).toContain("daily");

    const unknown = await callTool("manage_trigger", {
      trigger_id: "routine-1",
      action: "update",
      changes: { schedule: { type: "fortnightly", time: "09:00" } },
    });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0].text).toContain("Unknown schedule type");
    expect(lastRoutineRequestBody).toBeNull();
  });

  it.each([
    { type: "weekly", time: "09:00", weekdays: ["monday"], timezone: "America/New_York" },
    { type: "interval", every_minutes: 15, start_at: "2026-09-01T09:00:00+05:30" },
  ])("refuses scheduling constraints that would otherwise be silently discarded: %j", async (schedule) => {
    lastRoutineRequestBody = null;
    const res = await callTool("create_trigger", { when: "schedule", name: "Check", instructions: "Check the queue.", schedule });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("Unsupported");
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("ignores unused null schedule properties from provider schema conversion", async () => {
    const res = await callTool("create_trigger", { when: "schedule",
      name: "Check",
      instructions: "Check the queue.",
      schedule: { type: "daily", time: "09:00", at: null, every_minutes: null, starts_at: null },
      run_on: null,
      timeout_minutes: null,
      clear_timeout: null,
      continuity: null,
    });
    expect(res.result.isError).toBeFalsy();
    expect(lastRoutineRequestBody.routine.schedule).toMatchObject({ type: "weekly", time: "09:00" });
  });

  it("rejects malformed routine proposals before calling the harness", async () => {
    lastRoutineRequestBody = null;
    const missing = await callTool("create_trigger", { when: "schedule",
      name: "No schedule",
      instructions: "This cannot be scheduled yet.",
    });
    expect(missing.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();

    const badUpdate = await callTool("manage_trigger", {
      trigger_id: "routine-1",
      action: "update",
      changes: {},
    });
    expect(badUpdate.result.isError).toBe(true);
    expect(lastRoutineRequestBody).toBeNull();
  });

  it("propose_profile posts the changed fields and reason to the internal route", async () => {
    lastProfileRequestBody = null;
    const res = await callTool("propose_profile", { name: " Kiwi ", soul: "Be brief.\n", reason: "asked" });
    expect(lastProfileRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      changes: { name: "Kiwi", soul: "Be brief.\n" },
      reason: "asked",
    });
    expect(res.result.content[0].text).toContain("confirmation card is now visible");
    expect(res.result.content[0].text).toContain("do not claim the profile was created or changed");
    expect(res.result.isError).toBeFalsy();
  });

  it("propose_profile forwards for_bot_id when proposing for another bot", async () => {
    lastProfileRequestBody = null;
    await callTool("propose_profile", { title: "Chief of Staff", reason: "asked", for_bot_id: "bot-helper" });
    expect(lastProfileRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      changes: { title: "Chief of Staff" },
      reason: "asked",
      forBotId: "bot-helper",
    });
  });

  it("propose_profile refuses an empty change set without calling the harness", async () => {
    lastProfileRequestBody = null;
    const res = await callTool("propose_profile", { reason: "asked" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("needs at least one of name, title, description, soul, cwd, notifications, or speakReplies");
    expect(lastProfileRequestBody).toBeNull();
  });

  it("propose_model posts the trimmed selection and reason to the internal route", async () => {
    lastModelRequestBody = null;
    const res = await callTool("propose_model", {
      model_selection: { instanceId: " codex ", model: " gpt-5 ", effort: " high " },
      reason: "asked",
    });
    expect(lastModelRequestBody).toEqual({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      modelSelection: { instanceId: "codex", model: "gpt-5", effort: "high" },
      reason: "asked",
    });
    expect(res.result.content[0].text).toContain("confirmation card is now visible");
    expect(res.result.content[0].text).toContain("do not claim the model was created or changed");
    expect(res.result.isError).toBeFalsy();
  });

  it("propose_model forwards for_bot_id when proposing for another bot", async () => {
    lastModelRequestBody = null;
    await callTool("propose_model", {
      model_selection: { instanceId: "codex", model: "gpt-5" },
      reason: "asked",
      for_bot_id: "bot-helper",
    });
    expect(lastModelRequestBody).toMatchObject({ forBotId: "bot-helper" });
  });

  it("propose_model refuses a missing selection without calling the harness", async () => {
    lastModelRequestBody = null;
    const res = await callTool("propose_model", { model_selection: { instanceId: "codex" }, reason: "asked" });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("needs model_selection with instanceId and model");
    expect(lastModelRequestBody).toBeNull();
  });

  it("propose_model refuses wrong-typed effort or variant without calling the harness", async () => {
    lastModelRequestBody = null;
    const res = await callTool("propose_model", {
      model_selection: { instanceId: "codex", model: "gpt-5", effort: 123, variant: "   " },
      reason: "asked",
    });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("effort and variant must be non-empty strings");
    expect(lastModelRequestBody).toBeNull();
  });

  it("rejects unknown tools with -32602", async () => {
    const res = await rpc("tools/call", { name: "made_up", arguments: {} });
    expect(res.error.code).toBe(-32602);
  });

  it("lists, views, and stages skills without enabling them", async () => {
    const list = await rpc("tools/list");
    const manage = list.result.tools.find((t: { name: string }) => t.name === "skill_manage");
    expect(JSON.stringify(manage.inputSchema)).not.toMatch(/"(oneOf|anyOf|allOf|const|format)":/);
    expect(manage.inputSchema.required).toEqual(["action", "skill_md", "source"]);
    expect(manage.inputSchema.properties.action.enum).toEqual(["create", "update"]);

    const listed = await callTool("skills_list", {});
    expect(listed.result.content[0].text).toContain("file-expense");
    expect(listed.result.content[0].text).toContain("file-expense (disabled, imported)");
    expect(listed.result.content[0].text).toContain("learned-expense (enabled, learned/editable)");
    expect(listed.result.content[0].text).toContain("team-cut (enabled, learned/editable, shared with your team, revision 0123456789ab)");
    expect(listed.result.content[0].text).toContain("pending-skill");
    expect(listed.result.content[0].text).not.toContain("UNREVIEWED");
    expect(listed.result.content[0].text).not.toContain("PRIVATE LEARNED");
    expect(lastSkillQuery).toContain("fromBotId=bot-asker");

    const staged = await callTool("skill_manage", {
      action: "create",
      skill_md: "---\nname: file-expense\ndescription: Files an expense in the company portal.\n---\n\n# File expense\n",
      gist: "Files an expense",
      source: "conversation",
    });
    expect(lastSkillStageBody).toMatchObject({
      fromBotId: "bot-asker",
      fromThreadId: "thread-asker-routine",
      action: "create",
      source: "conversation",
    });
    expect(staged.result.content[0].text).toContain("staged and inactive");
    expect(staged.result.content[0].text).toContain("wait for the decision");

    const updated = await callTool("skill_manage", {
      action: "update",
      skill_name: "file-expense",
      skill_md: "---\nname: file-expense\ndescription: Files expenses with a receipt.\n---\n\n# File expense\n",
      source: "conversation",
    });
    expect(lastSkillStageBody).toMatchObject({
      action: "update",
      skill_name: "file-expense",
    });
    expect(updated.result.content[0].text).toContain("current version remains unchanged");

    expect(manage.inputSchema.properties.references.items.required).toEqual(["path", "content"]);
    await callTool("skill_manage", {
      action: "update",
      skill_name: "file-expense",
      skill_md: "---\nname: file-expense\ndescription: Files expenses.\n---\n\nFor edge cases, read references/edge-cases.md.\n",
      references: [{ path: "references/edge-cases.md", content: "# Edge cases\n" }],
      source: "conversation",
    });
    expect(lastSkillStageBody).toMatchObject({
      references: [{ path: "references/edge-cases.md", content: "# Edge cases\n" }],
    });
    await callTool("skill_manage", {
      action: "update",
      skill_name: "team-cut",
      skill_md: "---\nname: team-cut\ndescription: Cuts a rough edit.\n---\n\n# Team cut\n",
      base_revision: "0123456789ab",
      source: "conversation",
    });
    expect(lastSkillStageBody).toMatchObject({ action: "update", skill_name: "team-cut", base_revision: "0123456789ab" });

    lastSkillStageBody = null;
    const missingTarget = await callTool("skill_manage", {
      action: "update",
      skill_md: "---\nname: file-expense\ndescription: Files expenses.\n---\n",
      source: "conversation",
    });
    expect(missingTarget.result.isError).toBe(true);
    expect(missingTarget.result.content[0].text).toContain("needs skill_name");
    expect(lastSkillStageBody).toBeNull();
  });
});

describe("standing external runtime", () => {
  let external: ChildProcess;
  const responses = new Map<number, (message: any) => void>();
  let nextExternalId = 1;
  const externalRpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = nextExternalId++;
    responses.set(id, resolve);
    external.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (responses.delete(id)) reject(new Error(`${method} timed out`)); }, 10_000).unref?.();
  });
  const externalCall = (name: string, args: unknown) => externalRpc("tools/call", { name, arguments: args });

  beforeAll(async () => {
    external = spawn(process.execPath, [PROXY], {
      env: { ...childEnv(), OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`, OMB_BOT_ID: "bot-asker",
        OMB_THREAD_ID: "thread-asker-routine", OMB_COMMS_TOKEN: TOKEN, OMB_TURN_DEPTH: "0",
        OMB_EXTERNAL_RUNTIME: "1", OMB_ROOM_TURN: "1", OMB_OWN_THREAD_CREATION: "1",
        OMB_SKILL_AUTHORING_ENABLED: "1", OMB_SHARED_COMPUTERS_ENABLED: "1" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buffer = "";
    external.stdout!.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        responses.get(message.id)?.(message);
        responses.delete(message.id);
      }
    });
    await externalRpc("initialize", { protocolVersion: "2024-11-05" });
  });
  afterAll(async () => { if (external) await waitForExit(external, { signal: "SIGTERM" }); });

  it("sees the same one tool surface as every turn: the switches it sets change nothing", async () => {
    const list = await externalRpc("tools/list");
    // the main child is a Chief's turn; this one is not, so only the role differs
    const chiefOnly = ["create_bot", "list_team_setup", "list_team_library", "propose_team_setup", "propose_bot_deletion", "create_room", "manage_room", "retry_thread", "mute_thread"];
    const everyTurn = (await rpc("tools/list")).result.tools.filter((tool: any) => !chiefOnly.includes(tool.name));
    const names = list.result.tools.map((tool: any) => tool.name);
    expect(names).toEqual(everyTurn.map((tool: any) => tool.name));
    const teamwork = ["list_room_targets", "coordinate_bots", "assignment_status", "list_bots", "list_rooms", "list_threads", "close_thread", "start_thread", "post_to_room"];
    for (const name of teamwork) {
      expect(list.result.tools.find((tool: any) => tool.name === name), name).toEqual(everyTurn.find((tool: any) => tool.name === name));
    }
    expect(JSON.stringify(list.result.tools)).not.toMatch(/Brief synchronous consultation|BLOCKING status tool|same turn as delegate_bot/);
    const roster = (await externalCall("list_bots", {})).result.content[0].text;
    expect(roster).toContain("Use coordinate_bots for concrete work");
    expect(roster).not.toMatch(/\b(delegate_bot|ask_bot)\b/);
  });

  it("long-polls assignment_status for what it handed on, in the same standing process", async () => {
    coordinateResponse = { receipts: [{ botId: "bot-helper", botName: "Helper", outcome: "queued", detail: "handed to the coordinator; the teammate's turn has not started yet", requestId: "external-asg-123" }],
      message: "End your turn after sending all work. These actual teammates will reply and resume you automatically. Do not poll or wait." };
    try {
      const sent = await externalCall("coordinate_bots", { bot_ids: ["bot-helper"], message: "A standing assignment", done_when: "the report is filed" });
      expect(sent.result.isError).toBeFalsy();
      expect(lastCoordinateBody).toMatchObject({ botIds: ["bot-helper"], message: "A standing assignment", done_when: "the report is filed" });
      expect(JSON.parse(sent.result.content[0].text).receipts[0].requestId).toBe("external-asg-123");
      assignmentStatusResponse = { assignment: { id: "external-asg-123", botId: "bot-helper", botName: "Helper", status: "completed", outcome: "done", result: "All done." }, children: [], inbox: [] };
      lastAssignmentStatusUrl = null;
      const status = await externalCall("assignment_status", { id: "external-asg-123", wait_ms: 1_000 });
      expect(status.result.isError).toBeFalsy();
      expect(status.result.content[0].text).toContain("Assignment external-asg-123 → @Helper: completed");
      expect(status.result.content[0].text).toContain("Result: All done.");
      expect(lastAssignmentStatusUrl).toBe("/api/internal/assignment-status?id=external-asg-123&wait_ms=1000");
      expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    } finally {
      coordinateResponse = { ok: true };
      assignmentStatusResponse = DONE_ASSIGNMENT;
    }
  });

  it("bounds large replies without calling the out-of-scope result-cache route", async () => {
    coordinateResponse = { receipts: [{ botId: "bot-helper", botName: "Helper", outcome: "queued", detail: "x".repeat(30_000), requestId: "external-asg-big" }],
      message: "End your turn after sending all work." };
    const before = savedResultWrites;
    try {
      const result = await externalCall("coordinate_bots", { bot_ids: ["bot-helper"], message: "A short question", consult: true });
      expect(result.result.isError).toBeFalsy();
      expect(result.result.content[0].text.length).toBeLessThan(17_000);
      expect(result.result.content[0].text).toContain("The original operation was not retried");
      expect(savedResultWrites).toBe(before);
    } finally { coordinateResponse = { ok: true }; }
  });
});

// A separate child is the only honest check: the tool list is frozen at module load.
describe("with computer sharing off and no Chief of Staff (the defaults)", () => {
  let gated: ChildProcess;
  const gatedPending = new Map<number, (msg: any) => void>();
  let gatedId = 500;
  const gatedRpc = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = gatedId++;
      gatedPending.set(id, resolve);
      gated.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (gatedPending.delete(id)) reject(new Error(`${method} timed out`));
      }, 10_000).unref?.();
    });

  beforeAll(async () => {
    gated = spawn(process.execPath, [PROXY], {
      env: {
        ...childEnv(),
        OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
        OMB_BOT_ID: "bot-asker",
        OMB_THREAD_ID: "thread-asker-routine",
        OMB_COMMS_TOKEN: TOKEN,
        OMB_TURN_DEPTH: "0",
        OMB_SKILL_AUTHORING_ENABLED: "1",
        // deliberately no OMB_SHARED_COMPUTERS_ENABLED or OMB_CHIEF_OF_STAFF
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    gated.stdout!.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        gatedPending.get(msg.id)?.(msg);
        gatedPending.delete(msg.id);
      }
    });
    await gatedRpc("initialize", { protocolVersion: "2024-11-05" });
  });

  afterAll(() => {
    gated?.kill();
  });

  it("does not advertise the shared-computer tools at all", async () => {
    const list = await gatedRpc("tools/list");
    const names = list.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).not.toContain("list_shared_computers");
    expect(names).not.toContain("shared_computer");
    expect(names).toContain("list_bots");
    expect(names).toContain("skills_list");
  });

  it("refuses the handlers if a model calls them by name anyway", async () => {
    for (const name of ["list_shared_computers", "shared_computer"]) {
      const refused = await gatedRpc("tools/call", { name, arguments: { computer_id: "x", action: "list_files" } });
      expect(refused.error?.message ?? refused.result?.content?.[0]?.text).toMatch(/unknown tool|turned off/i);
    }
  });

  it("shows a bot that is not a Chief none of the Chief-only tools or parameters", async () => {
    type ListedTool = { name: string; description: string; inputSchema: { properties: Record<string, unknown> } };
    const tools = new Map(((await gatedRpc("tools/list")).result.tools as ListedTool[]).map((tool) => [tool.name, tool]));
    for (const name of ["create_bot", "list_team_setup", "propose_team_setup", "propose_bot_deletion", "create_room", "manage_room", "retry_thread"]) {
      expect(tools.has(name), name).toBe(false);
    }
    for (const name of ["propose_profile", "propose_model"]) {
      expect(tools.get(name)!.inputSchema.properties).not.toHaveProperty("for_bot_id");
      expect(tools.get(name)!.description).not.toContain("for_bot_id");
    }
    expect(tools.get("manage_trigger")!.inputSchema.properties).toHaveProperty("for_bot_id");
  });

  it("refuses a Chief-only tool called by name without reaching the harness", async () => {
    lastCreateBody = null;
    lastCreateRoomBody = null;
    const created = await gatedRpc("tools/call", { name: "create_bot", arguments: { name: "Scout", role: "Ops", instructions: "Work." } });
    expect(created.error).toMatchObject({ code: -32602, message: "Unknown tool: create_bot" });
    const room = await gatedRpc("tools/call", { name: "create_room", arguments: { name: "Ops", member_bot_ids: ["bot-helper"] } });
    expect(room.error).toMatchObject({ code: -32602, message: "Unknown tool: create_room" });
    expect(lastCreateBody).toBeNull();
    expect(lastCreateRoomBody).toBeNull();
  });
});

describe("coordinate_bots arguments", () => {
  it("maps camelCase aliases onto the canonical snake_case fields", async () => {
    const res = await callTool("coordinate_bots", {
      botIds: ["bot-helper"], message: "please review the patch",
    });
    expect(res.result.isError).toBeFalsy();
    expect(lastCoordinateBody).toMatchObject({
      botIds: ["bot-helper"], message: "please review the patch",
    });
  });

  it("forwards the contract's fields: reason, thread, reply, consult and done_when", async () => {
    const res = await callTool("coordinate_bots", {
      bot_ids: ["bot-helper"], message: "Is the export idempotent?", reason: "need to know before shipping",
      thread: "new", reply: "resume", consult: true, done_when: "a yes or no with the line that proves it",
    });
    expect(res.result.isError).toBeFalsy();
    expect(lastCoordinateBody).toEqual({
      botIds: ["bot-helper"], message: "Is the export idempotent?", reason: "need to know before shipping",
      thread: "new", reply: "resume", consult: true, done_when: "a yes or no with the line that proves it",
    });
    await callTool("coordinate_bots", { bot_ids: ["bot-helper"], message: "notice", reply: "none", doneWhen: "  ", reason: " " });
    expect(lastCoordinateBody).toEqual({ botIds: ["bot-helper"], message: "notice", reply: "none" });
  });

  it("refuses a thread, reply or consult value outside the contract before contacting the server", async () => {
    for (const args of [
      { bot_ids: ["bot-helper"], message: "m", thread: "fresh" },
      { bot_ids: ["bot-helper"], message: "m", reply: "poll" },
      { bot_ids: ["bot-helper"], message: "m", consult: "yes" },
      { bot_ids: ["bot-helper"], message: "m", done_when: ["x"] },
    ]) {
      lastCoordinateBody = null;
      const res = await callTool("coordinate_bots", args);
      expect(res.result.isError, JSON.stringify(args)).toBe(true);
      expect(res.result.content[0].text).toContain('thread ("standing" or "new"), reply ("resume" or "none"), consult (true or false), in_my_folder (true or false) and done_when are optional');
      expect(lastCoordinateBody).toBeNull();
    }
  });

  it("keeps the documented snake_case key when both spellings arrive", async () => {
    const res = await callTool("coordinate_bots", {
      bot_ids: ["bot-helper"], botIds: ["bot-other"], group_id: "room-right", groupId: "room-wrong",
      message: "m", request_key: "from an older tool list", label: "from an older tool list",
    });
    expect(res.result.isError).toBeFalsy();
    expect(lastCoordinateBody).toMatchObject({
      botIds: ["bot-helper"], groupId: "room-right",
    });
    expect(lastCoordinateBody.botIds).not.toContain("bot-other");
    expect(lastCoordinateBody).not.toHaveProperty("requestKey");
    expect(lastCoordinateBody).not.toHaveProperty("label");
  });

  it("names the expected snake_case fields when arguments are unusable", async () => {
    lastCoordinateBody = null;
    const res = await callTool("coordinate_bots", {
      botIds: "bot-helper", message: "ids is not an array",
    });
    expect(res.result.isError).toBe(true);
    const text = res.result.content[0].text;
    for (const field of ["bot_ids", "message", "group_id", "reason", "rework", "thread", "reply", "consult", "in_my_folder", "done_when"]) {
      expect(text).toContain(field);
    }
    expect(text).toContain("botIds");
    expect(text).toContain("message");
    expect(lastCoordinateBody).toBeNull();
  });
});

// The tool bridge (agents-bridge.ts): a short hot list plus find_tool and
// use_tool in place of the whole catalog. The tool list is fixed when the
// proxy starts, so each profile under test is its own child, as above; all
// of them talk to the same scripted harness, and the main child (a Chief
// with the same switches and no bridge) is what a bridged call is compared
// against.
describe("tool bridge", () => {
  type Rpc = (method: string, params?: unknown) => Promise<any>;
  const started: ChildProcess[] = [];
  function startProxy(env: Record<string, string>): Rpc {
    const proxy = spawn(process.execPath, [PROXY], {
      env: {
        ...childEnv(), TZ: "Asia/Kolkata", OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`, OMB_BOT_ID: "bot-asker",
        OMB_THREAD_ID: "thread-asker-routine", OMB_COMMS_TOKEN: TOKEN, OMB_TURN_DEPTH: "0", ...env,
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    started.push(proxy);
    const waiting = new Map<number, (message: any) => void>();
    let nextRequest = 1;
    let buffer = "";
    proxy.stdout!.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    });
    return (method, params) => new Promise((resolve, reject) => {
      const id = nextRequest++;
      waiting.set(id, resolve);
      proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${method} timed out`)); }, 10_000).unref?.();
    });
  }

  /** The main child's switches: a Chief with skills and shared computers. */
  const CHIEF = { OMB_SKILL_AUTHORING_ENABLED: "1", OMB_SHARED_COMPUTERS_ENABLED: "1", OMB_CHIEF_OF_STAFF: "1" };
  const CHIEF_ONLY = ["create_bot", "list_team_setup", "propose_team_setup", "propose_bot_deletion", "create_room", "manage_room", "retry_thread"];
  const HOT = ["tool_result_read", "list_room_targets", "coordinate_bots", "list_bots", "list_rooms", "select_computer", "attach_file", "publish_page", "post_to_room", "request_credential", "request_sign_in", "fill_login", "memory_update"];
  let chief: Rpc;
  let plain: Rpc;
  let off: Rpc;
  const find = (proxy: Rpc, query: unknown) => proxy("tools/call", { name: "find_tool", arguments: { query } });
  const use = (proxy: Rpc, name: string, args?: unknown) =>
    proxy("tools/call", { name: "use_tool", arguments: { name, ...(args === undefined ? {} : { arguments: args }) } });
  const matchesOf = (response: any): Array<{ name: string; description: string; inputSchema: unknown }> => JSON.parse(response.result.content[0].text).matches;
  const listed = async (proxy: Rpc): Promise<any[]> => (await proxy("tools/list")).result.tools;
  /** A bridged call that was refused: a failed tool call the model reads,
   * never a protocol error, and its words. */
  const refusalOf = (response: any): string => {
    expect(response.error).toBeUndefined();
    expect(response.result.isError).toBe(true);
    return response.result.content[0].text;
  };

  beforeAll(async () => {
    chief = startProxy({ ...CHIEF, OMB_AGENTS_TOOL_BRIDGE: "1" });
    // not a Chief, nothing optional: the defaults, bridged
    plain = startProxy({ OMB_AGENTS_TOOL_BRIDGE: "1" });
    off = startProxy({ ...CHIEF, OMB_AGENTS_TOOL_BRIDGE: "0" });
    for (const proxy of [chief, plain, off]) {
      expect((await proxy("initialize", { protocolVersion: "2024-11-05" })).result.serverInfo.name).toBe("openmausbot-agents");
    }
  });
  afterAll(async () => { for (const proxy of started) await waitForExit(proxy, { signal: "SIGTERM" }); });

  it("changes nothing while the switch is off or absent: the same list to the byte, and no bridge tools", async () => {
    const unbridged = await rpc("tools/list");
    expect(JSON.stringify((await off("tools/list")).result)).toBe(JSON.stringify(unbridged.result));
    expect(unbridged.result.tools.map((tool: any) => tool.name)).not.toEqual(expect.arrayContaining(["find_tool"]));
    for (const proxy of [off, rpc]) {
      for (const name of ["find_tool", "use_tool"]) {
        const refused = await proxy("tools/call", { name, arguments: { query: "triggers", name: "list_triggers" } });
        expect(refused.error).toEqual({ code: -32602, message: `Unknown tool: ${name}` });
      }
    }
  });

  it("lists the hot tools as they were, then find_tool and use_tool", async () => {
    const unbridged = new Map((await listed(rpc)).map((tool) => [tool.name, tool]));
    for (const proxy of [chief, plain]) {
      const tools = await listed(proxy);
      expect(tools.map((tool) => tool.name)).toEqual([...HOT, "find_tool", "use_tool"]);
      // unchanged schemas: each hot tool is what the unbridged turn lists
      for (const tool of tools.slice(0, HOT.length)) expect(JSON.stringify(tool), tool.name).toBe(JSON.stringify(unbridged.get(tool.name)));
    }
    // A role changes only what sits behind use_tool, and what find_tool says exists.
    const describes = async (proxy: Rpc) => (await listed(proxy)).find((tool) => tool.name === "find_tool").description as string;
    for (const name of CHIEF_ONLY) {
      expect(await describes(chief), name).toContain(name);
      expect(await describes(plain), name).not.toContain(name);
    }
    expect(await describes(chief)).toContain("create_trigger");
    expect(await describes(plain)).toContain("create_trigger");
    // find_tool is a read and carries the marks the catalog's reads do; use_tool claims nothing
    const [findTool, useTool] = (await listed(chief)).slice(-2);
    expect(findTool.annotations).toEqual(unbridged.get("list_triggers").annotations);
    expect(findTool.annotations).toMatchObject({ readOnlyHint: true });
    expect(useTool.annotations).toBeUndefined();
  });

  it("publishes flat schemas for the two bridge tools", async () => {
    const tools = new Map((await listed(chief)).map((tool) => [tool.name, tool]));
    for (const name of ["find_tool", "use_tool"]) {
      const schema = tools.get(name).inputSchema;
      expect(JSON.stringify(schema)).not.toMatch(/"(oneOf|anyOf|allOf|const|format)":/);
      expect(schema.type).toBe("object");
      expect(schema).not.toHaveProperty("anyOf");
      expect(schema).not.toHaveProperty("oneOf");
    }
    expect(tools.get("find_tool").inputSchema.required).toEqual(["query"]);
    expect(tools.get("use_tool").inputSchema.required).toEqual(["name"]);
    // a plain object: the hidden tool's own schema is what checks it
    expect(tools.get("use_tool").inputSchema.properties.arguments).toEqual({ type: "object", additionalProperties: true, description: expect.any(String) });
  });

  it("find_tool finds a hidden tool from a natural request, with the description and schema the unbridged turn lists", async () => {
    const unbridged = new Map((await listed(rpc)).map((tool) => [tool.name, tool]));
    const matches = matchesOf(await find(chief, "schedule a recurring task every morning"));
    expect(matches.length).toBeLessThanOrEqual(3);
    const { name, description, inputSchema } = unbridged.get("create_trigger");
    expect(matches[0]).toEqual({ name, description, inputSchema });
    expect(matchesOf(await find(chief, "create a new specialist bot"))[0]!.name).toBe("create_bot");
    // a search that could not be made is a failed call, told how to search
    expect(refusalOf(await find(chief, "   "))).toContain('find_tool needs { "query": ');
  });

  it("find_tool never returns a tool outside this turn's profile", async () => {
    const profile = new Set((await listed(off)).map((tool) => tool.name).filter((name) => !CHIEF_ONLY.includes(name) && !["skills_list", "skill_manage", "list_shared_computers", "shared_computer"].includes(name)));
    for (const query of ["create a new specialist bot", "delete a teammate", "set up the team", "save a reusable skill", "use the desktop the user shared", ...CHIEF_ONLY, "skill_manage", "shared_computer"]) {
      const matches = matchesOf(await find(plain, query));
      for (const match of matches) {
        expect(profile.has(match.name), `${query} → ${match.name}`).toBe(true);
        expect(HOT.includes(match.name), `${query} → ${match.name}`).toBe(false);
      }
    }
  });

  it("use_tool runs a hidden tool end to end, with the request and the result a direct call gives", async () => {
    const routine = { when: "schedule", name: "Morning brief", instructions: "Summarize today's priorities.", schedule: { type: "weekly", time: "09:00", weekdays: ["monday", "friday"] }, timeout_minutes: 15 };
    // found first, as a bot would, from how a person would ask
    expect(matchesOf(await find(chief, "schedule a recurring task every morning"))[0]!.name).toBe("create_trigger");
    lastRoutineRequestBody = null;
    const direct = await callTool("create_trigger", routine);
    const directBody = lastRoutineRequestBody;
    lastRoutineRequestBody = null;
    lastAuth = undefined;
    const bridged = await use(chief, "create_trigger", routine);
    // the same capability, the same request, the same answer
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(lastRoutineRequestBody).toEqual(directBody);
    expect(lastRoutineRequestBody).toMatchObject({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", action: "create", routine: { name: "Morning brief", timeoutMinutes: 15 } });
    expect(bridged.result).toEqual(direct.result);
    expect(bridged.result.content[0].text).toContain("applied at once");
    // a tool that takes nothing, called with no arguments at all
    lastRoutineQuery = "";
    const routines = await use(chief, "list_triggers");
    expect(routines.result).toEqual((await callTool("list_triggers", {})).result);
    expect(new URL(lastRoutineQuery, "http://localhost").searchParams.get("fromBotId")).toBe("bot-asker");
  });

  it("use_tool refuses a name outside the profile in the words a direct call to it is refused with, as a failed call the model can read", async () => {
    for (const name of ["made_up", "skill_manage", "shared_computer", "send_voice_note", "find_tool", "use_tool"]) {
      // find_tool and use_tool are this proxy's own, so only the bridged form is unknown
      if (name !== "find_tool" && name !== "use_tool") {
        const direct = await plain("tools/call", { name, arguments: {} });
        expect(direct.error, name).toEqual({ code: -32602, message: `Unknown tool: ${name}` });
        expect(refusalOf(await use(plain, name, {})), name).toBe(direct.error.message);
      }
      expect(refusalOf(await use(plain, name, {})), name).toBe(`Unknown tool: ${name}`);
    }
  });

  it("refuses a Chief-only tool to a bot that is not a Chief without reaching the harness, and hands a Chief-only parameter to the harness to refuse", async () => {
    lastCreateBody = null;
    lastCreateRoomBody = null;
    expect(refusalOf(await use(plain, "create_bot", { name: "Scout", role: "Ops", instructions: "Work." }))).toBe("Unknown tool: create_bot");
    expect(refusalOf(await use(plain, "create_room", { name: "Ops", member_bot_ids: ["bot-helper"] }))).toBe("Unknown tool: create_room");
    expect(lastCreateBody).toBeNull();
    expect(lastCreateRoomBody).toBeNull();
    // A parameter only a Chief has is the harness's to refuse (index.ts
    // chiefPeerTargetRule), on a bridged call exactly as on a direct one: the
    // proxy hands both on with the same request.
    const other = { title: "Lead", reason: "asked", for_bot_id: "bot-helper" };
    lastProfileRequestBody = null;
    const direct = await plain("tools/call", { name: "propose_profile", arguments: other });
    const directBody = lastProfileRequestBody;
    lastProfileRequestBody = null;
    const bridged = await use(plain, "propose_profile", other);
    expect(lastProfileRequestBody).toEqual(directBody);
    expect(lastProfileRequestBody).toMatchObject({ fromBotId: "bot-asker", forBotId: "bot-helper" });
    expect(bridged.result).toEqual(direct.result);
    // A Chief's own turn reaches them through the bridge.
    const mine = await use(chief, "create_bot", { name: "Scout", role: "Ops", instructions: "Work." });
    expect(mine.result.isError).toBeFalsy();
    expect(lastCreateBody).toMatchObject({ name: "Scout", role: "Ops" });
  });

  it("use_tool is neither stricter nor looser than a direct call: the tool reads its own arguments", async () => {
    // What a schema would refuse and the tool takes on purpose
    // (normalizeScheduleInput): a schedule sent as text, "Daily", short
    // weekday names. Bridged, it makes the request a direct call makes.
    const lenient = { when: "schedule", name: "Brief", instructions: "Summarize the queue.", schedule: JSON.stringify({ type: "Weekly", time: "09:00", weekdays: ["mon", "fri"] }) };
    lastRoutineRequestBody = null;
    const direct = await callTool("create_trigger", lenient);
    const directBody = lastRoutineRequestBody;
    expect(direct.result.isError).toBeFalsy();
    lastRoutineRequestBody = null;
    const bridged = await use(chief, "create_trigger", lenient);
    expect(lastRoutineRequestBody).toEqual(directBody);
    expect(lastRoutineRequestBody).toMatchObject({ action: "create", routine: { name: "Brief" } });
    expect(bridged.result).toEqual(direct.result);
    // And what the tool itself refuses, it refuses in its own words either way.
    for (const [name, args] of [
      ["create_trigger", { when: "schedule", name: "Brief", instructions: "Summarize.", schedule: { type: "hourly" } }],
      ["start_thread", { title: "", message: "x" }],
      ["post_to_room", {}],
    ] as const) {
      const refused = await callTool(name, args);
      expect(refused.result.isError, name).toBe(true);
      if (name !== "post_to_room") expect((await use(chief, name, args)).result, name).toEqual(refused.result);
    }
    // Only the call's own shape is the bridge's to refuse: a name, and arguments that are an object.
    for (const shapeless of [{ arguments: {} }, { name: "list_triggers", arguments: "{}" }, { name: "list_triggers", arguments: [1] }]) {
      expect(refusalOf(await chief("tools/call", { name: "use_tool", arguments: shapeless })), JSON.stringify(shapeless)).toContain('use_tool needs { "name": ');
    }
  });

  it("use_tool runs a listed tool too, through the same path", async () => {
    lastMemoryBody = null;
    const remembered = await use(chief, "memory_update", { action: "append", text: "The deploy script lives in scripts/." });
    expect(remembered.result.isError).toBeFalsy();
    expect(lastMemoryBody).toEqual({ fromBotId: "bot-asker", fromThreadId: "thread-asker-routine", action: "append", text: "The deploy script lives in scripts/." });
    lastCoordinateBody = null;
    const handed = await use(chief, "coordinate_bots", { bot_ids: ["bot-helper"], message: "please review the patch" });
    expect(handed.result.isError).toBeFalsy();
    expect(lastCoordinateBody).toMatchObject({ botIds: ["bot-helper"], message: "please review the patch" });
  });

  it("will not run an outward action under another name: post_to_room is called directly", async () => {
    // The restart policy reads a turn's tool names to know it already posted.
    const posts = postCalls;
    const text = refusalOf(await use(chief, "post_to_room", { group_id: "room-launch", message: "Shipped." }));
    expect(text).toContain("post_to_room is in your tool list: call it directly");
    expect(text).toContain("Nothing was run");
    expect(postCalls).toBe(posts);
    const direct = await chief("tools/call", { name: "post_to_room", arguments: { group_id: "room-launch", message: "Shipped." } });
    expect(direct.result.isError).toBeFalsy();
    expect(postCalls).toBe(posts + 1);
  });

  it("leaves every limit with the harness: its refusal of a bridged call is the refusal a direct call gets", async () => {
    // The proxy counts nothing (a warm engine keeps it across turns), so the
    // per-turn limit on opened threads is the harness's to enforce and to
    // word, whichever way the call came.
    const original = threadResponse;
    threadResponse = { error: "You have already opened 5 threads this turn, which is the limit. Do not retry." };
    try {
      const calls = threadCalls;
      const job = { title: "QA: PR #9", message: "Review pull request 9." };
      const direct = await callTool("start_thread", job);
      const directBody = lastThreadBody;
      const bridged = await use(chief, "start_thread", job);
      expect(threadCalls).toBe(calls + 2);
      expect(lastThreadBody).toEqual(directBody);
      expect(refusalOf(bridged)).toContain("You have already opened 5 threads this turn");
      expect(bridged.result).toEqual(direct.result);
    } finally { threadResponse = original; }
  });

  it("bounds a large result from use_tool as a direct call's is, and keeps a refusal an error", async () => {
    const original = agentsResponse;
    agentsResponse = { bots: Array.from({ length: 80 }, (_, i) => ({ id: `bot-${i}`, name: `Fixture-${i}`, title: "x".repeat(400) })) };
    try {
      const result = await use(chief, "list_bots", {});
      const preview = result.result.content[0].text;
      expect(result.result.isError).toBeFalsy();
      expect(preview.length).toBeLessThan(17_000);
      const id = /id "(r-[0-9a-f-]{36})"/.exec(preview)![1];
      // the notice names tool_result_read, which stays in the list
      const page = await chief("tools/call", { name: "tool_result_read", arguments: { id, offset: 16_000 } });
      expect(page.result.isError).toBeFalsy();
      expect(page.result.content[0].text).toContain("Fixture-");
    } finally { agentsResponse = original; }
    computerStatus = 409;
    computerResponse = { error: `Unavailable: ${"x".repeat(30_000)}` };
    const refused = await use(chief, "select_computer", {});
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text.length).toBeLessThan(17_000);
    expect(refused.result.content[0].text).toContain("Unavailable:");
  });

  it("still answers a hidden tool called by its own name: the profile, not the list, is what a turn may call", async () => {
    lastRoutineQuery = "";
    const direct = await chief("tools/call", { name: "list_triggers", arguments: {} });
    expect(direct.result.isError).toBeFalsy();
    expect(lastRoutineQuery).toContain("fromBotId=bot-asker");
    // and a name outside the profile called directly is the protocol error it always was
    expect((await plain("tools/call", { name: "create_bot", arguments: {} })).error).toEqual({ code: -32602, message: "Unknown tool: create_bot" });
  });
});
