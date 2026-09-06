// The allowlist.
//
// The proxy tests prove the app's own calls reach a real harness. These prove
// the other half, which no end-to-end test can: that everything else does
// not. The case worth caring about is the last one — a route nobody here has
// heard of is denied, because that is the property the whole file exists for
// and the one that quietly stopped being true once before.
import { describe, expect, it } from "vitest";

import { denyReason } from "../src/routes.ts";

const ask = (method: string, path: string, authenticated = true) =>
  denyReason({ method, path, authenticated });

const allowed = (method: string, path: string) => ask(method, path) === null;

describe("credentials", () => {
  it("lets an unpaired device pair, and do nothing else", () => {
    expect(ask("POST", "/api/pair", false)).toBeNull();
    expect(ask("GET", "/api/bots", false)).toEqual({
      status: 401,
      error: "pair this device from Remote access settings on the host computer",
    });
    expect(ask("POST", "/api/files", false)?.status).toBe(401);
  });

  it("lets anyone curl liveness — it is the unauthenticated smoke test", () => {
    expect(ask("GET", "/api/health", false)).toBeNull();
    // the bypass is one method on one path, not a family
    expect(ask("POST", "/api/health", false)?.status).toBe(401);
    expect(ask("GET", "/api/healthz", false)?.status).toBe(401);
  });
});

describe("what the app may do", () => {
  // Every request in ios/Sources/CompanionCore/Client.swift. If one of these
  // fails, a screen on the phone is broken.
  const calls: Array<[string, string]> = [
    ["GET", "/api/health"],
    ["GET", "/api/config"],
    ["GET", "/api/events"],
    ["GET", "/api/instances"],
    ["GET", "/api/team-map"],
    ["GET", "/api/companion/endpoints"],
    ["GET", "/api/bots"],
    ["POST", "/api/bots"],
    ["POST", "/api/sidebar-sections"],
    ["POST", "/api/bots/bot_123/messages"],
    ["PATCH", "/api/bots/bot_123/cards/msg_2"],
    ["POST", "/api/bots/bot_123/respond"],
    ["POST", "/api/bots/bot_123/interrupt"],
    ["DELETE", "/api/bots/bot_123/queue/queue_1"],
    ["POST", "/api/bots/bot_123/read"],
    ["POST", "/api/bots/bot_123/always-allow"],
    ["POST", "/api/bots/bot_123/messages/msg_2/edit"],
    ["GET", "/api/bots/bot_123/overview"],
    ["POST", "/api/bots/bot_123/active-branch"],
    ["POST", "/api/bots/bot_123/tasks"],
    ["POST", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/tasks/th_1"],
    ["DELETE", "/api/bots/bot_123/tasks/th_1"],
    ["PATCH", "/api/bots/bot_123/profile"],
    ["PATCH", "/api/bots/bot_123/model"],
    ["POST", "/api/bots/bot_123/avatar/generate"],
    ["POST", "/api/bots/bot_123/computer/join"],
    ["POST", "/api/bots/bot_123/secret-cards/message_1/provide"],
    ["POST", "/api/bots/bot_123/computer/control"],
    ["POST", "/api/bots/bot_123/computer/screenshot"],
    ["POST", "/api/bots/bot_123/computer/viewer-close"],
    ["POST", "/api/groups/room-1/messages"],
    ["POST", "/api/groups/room-1/interrupt"],
    ["DELETE", "/api/groups/room-1/queue/queue_1"],
    ["POST", "/api/groups/room-1/read"],
    ["POST", "/api/groups/room-1/tasks"],
    ["POST", "/api/groups/room-1/tasks/th_1"],
    ["PATCH", "/api/groups/room-1/tasks/th_1"],
    ["DELETE", "/api/groups/room-1/tasks/th_1"],
    ["GET", "/api/threads/th_1/messages"],
    ["GET", "/api/threads/th_1/messages/msg_2/image"],
    ["POST", "/api/threads/th_1/messages/msg_2/file"],
    ["POST", "/api/threads/th_1/messages/msg_2/reactions"],
    ["GET", "/api/threads/th_1/export"],
    ["POST", "/api/threads/th_1/respond"],
    ["GET", "/api/search"],
    ["POST", "/api/attachments"],
    ["GET", "/api/attachments/avatar-123.webp"],
    ["POST", "/api/files"],
    ["GET", "/api/tts/voices"],
    ["POST", "/api/tts/prepare"],
    ["POST", "/api/tts/speak"],
    ["GET", "/api/routines"],
    ["POST", "/api/routines"],
    ["PATCH", "/api/routines/routine_1"],
    ["DELETE", "/api/routines/routine_1"],
    ["POST", "/api/routines/routine_1/run"],
    ["POST", "/api/routine-runs/run_1/cancel"],
    ["POST", "/api/routine-runs/run_1/seen"],
    ["GET", "/api/connectors/catalog"],
    ["GET", "/api/connectors/connected"],
    ["GET", "/api/connectors"],
    ["POST", "/api/connectors/slack/authorize"],
    ["GET", "/api/bots/bot_123/connector-cards/msg_2/status"],
    ["POST", "/api/bots/bot_123/connector-cards/msg_2/authorize"],
    ["POST", "/api/bots/bot_123/connector-cards/msg_2/resume"],
    ["POST", "/api/bots/bot_123/connector-cards/msg_2/dismiss"],
    ["POST", "/api/bots/bot_123/secret-cards/msg_2/resume"],
    ["POST", "/api/bots/bot_123/secret-cards/msg_2/dismiss"],
  ];

  for (const [method, path] of calls) {
    it(`allows ${method} ${path}`, () => expect(ask(method, path)).toBeNull());
  }
});

describe("what it may not", () => {
  it("refuses host configuration, and says where it happens", () => {
    for (const [method, path] of [
      ["PUT", "/api/config"],
      ["PATCH", "/api/config"],
      ["GET", "/api/devices"],
      ["GET", "/api/companion"],
      ["POST", "/api/local-computer/start"],
      ["POST", "/api/webhooks"],
      ["POST", "/api/webhooks/wh_1/rotate"],
      ["DELETE", "/api/connectors/gmail"],
      ["POST", "/api/teams/import"],
    ] as Array<[string, string]>) {
      const denial = ask(method, path);
      expect(denial?.status, `${method} ${path}`).toBe(403);
      expect(denial?.error, `${method} ${path}`).toMatch(/on (?:your|the host) computer/);
    }
    expect(ask("GET", "/api/devices")).toEqual({
      status: 403,
      error: "Remote access settings are managed on the host computer",
    });
    expect(ask("GET", "/api/companion")).toEqual({
      status: 403,
      error: "Remote access settings are managed on the host computer",
    });
  });

  it("keeps endpoint refresh authenticated and exact-method only", () => {
    expect(ask("GET", "/api/companion/endpoints", false)?.status).toBe(401);
    expect(ask("GET", "/api/companion/endpoints")).toBeNull();
    expect(ask("POST", "/api/companion/endpoints")?.status).toBe(403);
    expect(ask("GET", "/api/companion/endpoints/extra")?.status).toBe(403);
  });

  it("describes only refused routine operations as computer-only", () => {
    for (const [method, path] of [
      ["GET", "/api/routines/routine_1"],
      ["PUT", "/api/routines/routine_1"],
      ["POST", "/api/routines/routine_1/cancel"],
    ] as Array<[string, string]>) {
      const denial = ask(method, path);
      expect(denial, `${method} ${path}`).toEqual({
        status: 403,
        error: "this routine operation is only available on your computer",
      });
    }
    expect(ask("GET", "/api/routines")).toBeNull();
    expect(ask("POST", "/api/routines/routine_1/run")).toBeNull();
  });

  it("denies the peer-agent endpoints exist at all", () => {
    expect(ask("GET", "/api/internal/peers")?.status).toBe(404);
    expect(ask("POST", "/api/internal/ask-bot")?.status).toBe(404);
  });

  it("does not serve the desktop UI", () => {
    expect(ask("GET", "/")?.status).toBe(404);
    expect(ask("GET", "/index.html")?.status).toBe(404);
  });

  it("opens and previews only an explicitly granted cloud viewer", () => {
    expect(allowed("POST", "/api/bots/bot_123/computer/join")).toBe(true);
    expect(allowed("POST", "/api/bots/bot_123/computer/control")).toBe(true);
    expect(allowed("POST", "/api/bots/bot_123/computer/screenshot")).toBe(true);
    expect(allowed("POST", "/api/bots/bot_123/computer/viewer-close")).toBe(true);
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("GET", "/api/bots/bot_123/computer/control")).toBe(false);
    expect(allowed("GET", "/api/bots/bot_123/computer/viewer-close")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/provision")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/sleep")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/computer/exec")).toBe(false);
  });

  it("allows only the exact encrypted credential submission verb", () => {
    expect(allowed("POST", "/api/bots/bot_123/secret-cards/message_1/provide")).toBe(true);
    expect(allowed("GET", "/api/bots/bot_123/secret-cards/message_1/provide")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/secret-cards/message_1/provided")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/secret-cards/message_1/provide/extra")).toBe(false);
  });

  // The method is part of the allowance, not decoration: reading the fleet
  // and deleting a bot are the same path.
  it("allows a path only for the methods it was allowed for", () => {
    expect(allowed("GET", "/api/bots")).toBe(true);
    expect(allowed("DELETE", "/api/bots/bot_123")).toBe(false);
    expect(allowed("POST", "/api/threads/th_1/messages")).toBe(false);
    expect(allowed("GET", "/api/threads/th_1/messages/msg_2/file")).toBe(false);
    expect(allowed("POST", "/api/threads/th_1/messages/msg_2/file/extra")).toBe(false);
    expect(allowed("GET", "/api/groups/room-1")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123")).toBe(false);
    expect(allowed("GET", "/api/bots/bot_123/model")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/model")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123/model/extra")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/overview")).toBe(false);
    expect(allowed("GET", "/api/bots/bot_123/overview/extra")).toBe(false);
    expect(allowed("PATCH", "/api/bots/bot_123/profile/execution-policy")).toBe(false);
    expect(allowed("GET", "/api/sidebar-sections")).toBe(false);
    expect(allowed("PATCH", "/api/sidebar-sections")).toBe(false);
    expect(allowed("POST", "/api/sidebar-sections/extra")).toBe(false);
    expect(allowed("PUT", "/api/config")).toBe(false);
    expect(allowed("GET", "/api/attachments/../config.json")).toBe(false);
    expect(allowed("GET", "/api/files")).toBe(false);
    expect(allowed("POST", "/api/files/anything")).toBe(false);
    expect(allowed("GET", "/api/routine-runs/run_1/cancel")).toBe(false);
    expect(allowed("POST", "/api/routine-runs/run_1/retry")).toBe(false);
    expect(allowed("DELETE", "/api/connectors/slack")).toBe(false);
    expect(allowed("GET", "/api/connectors/connected/all")).toBe(false);
    // revocation is a host-only affordance: a paired client can list and add
    // accounts but the account DELETE route is deliberately not allowed
    expect(allowed("DELETE", "/api/connectors/slack/accounts/ca_123")).toBe(false);
    expect(allowed("POST", "/api/bots/bot_123/secret-cards/msg_2/provided")).toBe(false);
    expect(allowed("PATCH", "/api/groups/room-1")).toBe(false);
  });

  // Patterns are anchored, so a path that merely starts right is still a
  // path nobody allowed.
  it("is not fooled by a prefix", () => {
    expect(allowed("GET", "/api/bots/bot_123/computer")).toBe(false);
    expect(allowed("GET", "/api/botsandthensome")).toBe(false);
    expect(allowed("GET", "/api/events/all")).toBe(false);
    expect(allowed("GET", "/api/threads/th_1/messages/msg_2/image/../../../config")).toBe(false);
    expect(allowed("GET", "/api/bots%2f..%2fwebhooks")).toBe(false);
  });

  // The one that matters. Upstream adds routes on its own schedule, and the
  // sidecar must not carry them to a phone because nobody wrote a rule
  // against a thing that did not exist yet.
  it("denies a route it has never heard of", () => {
    for (const path of [
      "/api/whatever-ships-next",
      "/api/bots/bot_123/some-new-verb",
      "/api/secrets",
    ]) {
      expect(allowed("GET", path), path).toBe(false);
      expect(allowed("POST", path), path).toBe(false);
      expect(allowed("DELETE", path), path).toBe(false);
    }
  });
});
