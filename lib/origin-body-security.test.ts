// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { POST as message, PATCH as edit } from "../app/api/local-chat/messages/route";
import { POST as conversation, PATCH as readConversation } from "../app/api/local-chat/conversations/route";
import { POST as invite } from "../app/api/workspace/invites/route";
import { POST as consent } from "../app/api/oauth/consent/route";
import { POST as signal, DELETE as ack } from "../app/api/local-voice/signals/route";
import { POST as participant } from "../app/api/local-voice/participants/route";
import { POST as issue } from "../app/api/github/issues/route";
import { POST as connection } from "../app/api/github/connection/route";
import { POST as feedback } from "../app/api/feedback/route";
import { POST as tick } from "../app/api/integrations/tick/route";
import { POST as upload } from "../app/api/local-chat/files/route";
import { readIntegrationRequest, signIntegration } from "./integration-bridge";

const work = vi.hoisted(() => vi.fn());
vi.mock("./localRealtime", () => ({
  requireLocalWorkspace: async () => ({ teamId: "fixture", _id: "fixture", workspaceRole: "owner" }),
  requireLocalChat: async () => ({ teamId: "fixture", _id: "fixture", workspaceRole: "owner" }),
  getConvexClient: work, limitLocalAction: vi.fn(), sessionTokenFromRequest: vi.fn(), TooManyRequests: class extends Error {},
  sendLocalMessage: work, editLocalMessage: work, openDirectConversation: work, markConversationRead: work,
  sendLocalVoiceSignal: work, ackLocalVoiceSignals: work, joinLocalVoice: work, updateLocalVoicePresence: work,
}));
vi.mock("./githubLocal", () => ({ githubProject: async () => ({ project: { _id: "fixture", memberRole: "admin", repoUrl: "https://github.com/example/repo" }, user: { _id: "fixture" } }), parseGitHubRepo: () => ({ owner: "example", repo: "repo" }), githubHeaders: work }));
vi.mock("./github-workspace", () => ({ lockGitHubJob: work, saveGitHubJob: work }));
vi.mock("./githubConnection", () => ({ saveGitHubConnection: work }));
vi.mock("./github-sync", () => ({ createGitHubTask: work, createProjectRepository: work, syncGitHubPage: work }));
vi.mock("./github-prs", () => ({ createTaskPR: work, syncPRPage: work }));
vi.mock("./mcp-oauth", () => ({ validateMcpAuthorization: work, validateMcpClient: work, issueMcpCode: work, authorizationError: work, maintainMcpOAuth: work, OAuthError: Error }));
vi.mock("./invite-mail", () => ({ sendInviteMail: work }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

test.each([
  ["message", message, "POST", 128000], ["edit", edit, "PATCH", 128000],
  ["conversation", conversation, "POST", 128000], ["read", readConversation, "PATCH", 128000],
  ["invite", invite, "POST", 128000], ["consent", consent, "POST", 128000],
  ["signal", signal, "POST", 128000], ["ack", ack, "DELETE", 128000],
  ["participant", participant, "POST", 128000], ["issue", issue, "POST", 128000],
  ["connection", connection, "POST", 128000], ["feedback", feedback, "POST", 12000],
  ["tick", tick, "POST", 100000], ["upload", upload, "POST", 16 * 1024 * 1024],
] as const)("%s cancels an oversized chunked request before business effects", async (name, handler, method, max) => {
  vi.stubEnv("ORIGIN_PUBLIC_URL", "http://origin.test");
  let cancelled = false, reads = 0;
  const body = new ReadableStream({
    pull(controller) { if (++reads <= 8) controller.enqueue(new Uint8Array(Math.ceil(max / 2))); else controller.close(); },
    cancel() { cancelled = true; },
  });
  const response = await handler(new Request(`http://origin.test/${name}`, { method, body, headers: { origin: "http://origin.test", "content-type": "application/json" }, duplex: "half" } as RequestInit));
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true); expect(reads).toBeLessThan(8); expect(work).not.toHaveBeenCalled();
});

test("bounded integration reading retains exact HMAC and freshness checks", async () => {
  vi.stubEnv("ORIGIN_INTEGRATION_SECRET", "fixture-secret-".repeat(4));
  const body = JSON.stringify({ at: Date.now(), operation: "fixture" });
  const request = (text: string, signature = signIntegration(body)) => new Request("http://origin.test/tick", { method: "POST", body: text, headers: { "x-origin-signature": signature } });
  expect(await readIntegrationRequest(request(body))).toMatchObject({ operation: "fixture" });
  await expect(readIntegrationRequest(request(body + " "))).rejects.toThrow("Unauthorized");
  const stale = JSON.stringify({ at: Date.now() - 120000 });
  await expect(readIntegrationRequest(request(stale, signIntegration(stale)))).rejects.toThrow("expired");
});
