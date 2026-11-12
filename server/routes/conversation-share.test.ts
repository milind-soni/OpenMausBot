// The routes refuse anything but a team member's own signed-in session: the server itself (a bot's loopback call, a
// service), a session the team's Admin never signed and any server that is not a team's reach nothing here.
import { describe, expect, it, vi } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createConversationSharing, type ConversationShareDeps } from "./conversation-share.ts";
import { PASS, type RouteContext } from "./table.ts";

const share = vi.fn(), add = vi.fn();
const deps = (team: boolean): ConversationShareDeps => ({
  team: team ? { id: "acme", name: "Acme" } : null,
  store: () => ({ bot: () => ({ id: "scout", name: "Scout" }), taskByThread: () => ({ threadId: "t1", title: "Plan" }), messagesFor: () => [{ id: "m1" }], onChange: () => () => {} }) as never,
  shares: { get: () => undefined, share, readers: () => null, personLeft: () => [] } as never,
  saves: { add, list: () => [], remove: () => "gone", personLeft: () => {} } as never,
  starter: () => undefined, audienceOf: () => "team", sees: () => true, levelOf: () => "edit", levelFor: () => "edit",
  people: () => [], nameOf: (email) => email, language: () => undefined, busy: () => false, routinesIn: () => 0, outside: () => false,
  audienceChanged: vi.fn(), changed: vi.fn(), inbox: () => ({ keepOne: () => null }), looking: () => false, notify: vi.fn(),
  botOf: () => "scout", handTo: vi.fn(),
});

async function call(team: boolean, auth: RequestAuth, method: string, path: string, body: unknown = {}) {
  let status = 0;
  const answered = await createConversationSharing(deps(team)).routes({
    req: {} as never, res: {} as never, url: new URL(`http://x${path}`), path, method, auth,
    json: ((_res: unknown, code: number) => { status = code; }) as never, readBody: (async () => body) as never,
  } as RouteContext);
  return answered === PASS ? "pass" : status;
}

const member = (extra: Partial<SessionRecord> = {}): RequestAuth => ({ kind: "session", via: "bearer", scopes: ["client"],
  session: { id: "s1", email: "rui@acme.test", membershipAuthority: "team", ...extra } as SessionRecord });

describe("who reaches sharing and team memory", () => {
  const routes: Array<[string, string, unknown]> = [
    ["POST", "/api/bots/scout/tasks/t1/share", { with: "team" }],
    ["GET", "/api/bots/scout/tasks/t1/share", undefined],
    ["POST", "/api/bots/scout/memory/team", { threadId: "t1", messageId: "m1", text: "x" }],
    ["DELETE", "/api/bots/scout/memory/team/e1", undefined],
  ];

  it("refuses the server itself, as a bot's own call would come, with every scope", async () => {
    for (const [method, path, body] of routes) expect(await call(true, { kind: "loopback", scopes: ["admin", "client"] }, method, path, body), `${method} ${path}`).toBe(404);
    expect(share).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses a session no team membership vouches for, and everything off a team", async () => {
    for (const [method, path, body] of routes) {
      expect(await call(true, member({ membershipAuthority: undefined }), method, path, body)).toBe(404);
      expect(await call(false, member(), method, path, body)).toBe(404);
    }
    expect(share).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("leaves every other path to the routes after it", async () => {
    expect(await call(true, member(), "GET", "/api/bots/scout/memory/mine", undefined)).toBe("pass");
  });
});
