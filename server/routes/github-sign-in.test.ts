import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { GithubSignInError, type GithubSignIn } from "../github/sign-in.ts";
import { personKey } from "../person-key.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createGithubSignInRoutes, githubAudience } from "./github-sign-in.ts";
import { PASS } from "./table.ts";

const PASTED = ["github", "pat", "11FIXTURE0", "y".repeat(40)].join("_");
const session = (fields: Partial<SessionRecord>, scopes: Array<"admin" | "client">): RequestAuth => ({
  kind: "session", via: "cookie", scopes, session: { id: "s-1", tokenHash: "0".repeat(64), label: "Desktop", scopes, createdAt: 1, lastSeenAt: 1, expiresAt: 9_000, ...fields } as SessionRecord,
});
const OWNER_WINDOW: RequestAuth = { kind: "loopback", scopes: ["admin"] };
const BOT_SHELL: RequestAuth = { kind: "loopback", scopes: ["admin"], trust: "service" };
const ADMIN_DEVICE = session({}, ["admin"]);
const PHONE = session({}, ["client"]);
const ADA = session({ email: "ada@example.com", teamRole: "member", membershipAuthority: "team" }, ["client"]);
const TEAM_ADMIN = session({ email: "bo@example.com", teamRole: "admin", membershipAuthority: "team" }, ["admin", "client"]);

function fakeSignIn() {
  const seen: Array<{ action: string; audience: string; token?: string }> = [];
  const signIn: Pick<GithubSignIn, "status" | "start" | "cancel" | "saveToken" | "signOut"> = {
    status: vi.fn(async (audience: string) => { seen.push({ action: "status", audience }); return { state: "signed-out" as const, download: false }; }),
    start: vi.fn(async (audience: string) => { seen.push({ action: "start", audience }); return { state: "signing-in" as const, code: "ABCD-1234", verificationUrl: "https://github.com/login/device", expiresAt: 5 }; }),
    cancel: vi.fn(async (audience: string) => { seen.push({ action: "cancel", audience }); return { state: "signed-out" as const, download: false }; }),
    saveToken: vi.fn(async (audience: string, token: string) => {
      seen.push({ action: "token", audience, token });
      if (token !== PASTED) throw new GithubSignInError(400, "GitHub did not accept this token. Check it and paste it again.");
      return { state: "signed-in" as const, login: "octo-fixture", source: "token" as const, scopes: [], checkedAt: 1 };
    }),
    signOut: vi.fn(async (audience: string) => { seen.push({ action: "sign-out", audience }); throw new Error(`gh said something about ${PASTED}`); }),
  };
  return { signIn, seen };
}

async function call(team: boolean, auth: RequestAuth, method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const { signIn, seen } = fakeSignIn();
  const route = createGithubSignInRoutes({ signIn, team });
  const answers: Array<{ status: number; body: unknown }> = [];
  const headers: Record<string, string> = { host: "127.0.0.1:8799", ...options.headers };
  const out = await route({
    req: { headers, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage, res: { setHeader: () => {} } as unknown as ServerResponse,
    url: new URL(`http://127.0.0.1:8799${path}`), path: path.split("?")[0]!, method, auth,
    json: (_res, status, body) => { answers.push({ status, body }); }, readBody: async () => options.body,
  });
  return { out, answer: answers[0], seen };
}

describe("GitHub sign-in routes", () => {
  it("off a Team Cloud: the owner's window and an admin reach the server's one sign-in, nobody else", async () => {
    for (const auth of [OWNER_WINDOW, ADMIN_DEVICE]) {
      const { answer, seen } = await call(false, auth, "POST", "/api/github/sign-in/start");
      expect(answer?.status).toBe(200);
      expect(seen).toEqual([{ action: "start", audience: "owner" }]);
    }
    for (const auth of [BOT_SHELL, PHONE, ADA]) {
      const { answer, seen } = await call(false, auth, "GET", "/api/github/sign-in");
      expect(answer?.status).toBe(403);
      expect(seen).toEqual([]);
    }
  });

  it("on a Team Cloud: each member reaches only their own, and the loopback or a session without membership none", async () => {
    const ada = await call(true, ADA, "GET", "/api/github/sign-in?check=1");
    expect(ada.answer?.status).toBe(200);
    expect(ada.seen).toEqual([{ action: "status", audience: personKey({ id: "", email: "ada@example.com" }) }]);
    const bo = await call(true, TEAM_ADMIN, "POST", "/api/github/sign-in/cancel");
    expect(bo.seen).toEqual([{ action: "cancel", audience: personKey({ id: "", email: "bo@example.com" }) }]);
    for (const auth of [OWNER_WINDOW, BOT_SHELL, ADMIN_DEVICE, PHONE]) {
      const { answer, seen } = await call(true, auth, "POST", "/api/github/sign-in/start");
      expect(answer?.status).toBe(403);
      expect(seen).toEqual([]);
    }
    expect(githubAudience(ADA, true)).not.toBe(githubAudience(TEAM_ADMIN, true));
  });

  it("is reachable by a client session only so a Team Cloud member can use it, and only these paths", () => {
    expect(requiredScope("GET", "/api/github/sign-in")).toBe("client");
    for (const action of ["start", "cancel", "token", "sign-out"]) expect(requiredScope("POST", `/api/github/sign-in/${action}`)).toBe("client");
    expect(requiredScope("GET", "/api/github/sign-in/token")).toBe("admin");
    expect(requiredScope("POST", "/api/github/sign-in/other")).toBe("admin");
  });

  it("takes changes only from this server's own page", async () => {
    const cross = await call(false, ADMIN_DEVICE, "POST", "/api/github/sign-in/start", { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(cross.answer?.status).toBe(403);
    expect(cross.seen).toEqual([]);
    const own = await call(false, ADMIN_DEVICE, "POST", "/api/github/sign-in/start", { headers: { origin: "http://127.0.0.1:8799", "sec-fetch-site": "same-origin" } });
    expect(own.answer?.status).toBe(200);
  });

  it("never answers with a token, even from an error", async () => {
    const saved = await call(false, OWNER_WINDOW, "POST", "/api/github/sign-in/token", { body: { token: PASTED } });
    expect(saved.answer?.status).toBe(200);
    expect(JSON.stringify(saved.answer)).not.toContain(PASTED);
    const refused = await call(false, OWNER_WINDOW, "POST", "/api/github/sign-in/token", { body: { token: "wrong" } });
    expect(refused.answer).toEqual({ status: 400, body: { error: "GitHub did not accept this token. Check it and paste it again." } });
    const failed = await call(false, OWNER_WINDOW, "POST", "/api/github/sign-in/sign-out");
    expect(failed.answer?.status).toBe(500);
    expect(JSON.stringify(failed.answer)).not.toContain(PASTED);
    expect((await call(false, OWNER_WINDOW, "POST", "/api/github/sign-in/token", { body: {} })).answer?.status).toBe(400);
  });

  it("passes other paths on and refuses wrong methods", async () => {
    expect((await call(false, OWNER_WINDOW, "GET", "/api/github/other-thing")).out).toBe(PASS);
    expect((await call(false, OWNER_WINDOW, "POST", "/api/github/sign-in")).answer?.status).toBe(405);
    expect((await call(false, OWNER_WINDOW, "GET", "/api/github/sign-in/start")).answer?.status).toBe(405);
    expect((await call(false, OWNER_WINDOW, "POST", "/api/github/sign-in/nope")).answer?.status).toBe(404);
  });
});
