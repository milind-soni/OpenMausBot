import { describe, expect, it } from "vitest";

import { supportDiagnostics } from "../devs-report.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createSupportDiagnosticsRoutes, SUPPORT_DIAGNOSTICS_PATH } from "./support-diagnostics.ts";
import { PASS, type RouteContext } from "./table.ts";

const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const SECRET = "sk-ant-api03-supportdiagnosticssecret0123456789abcdefghijklmnop";

function ctx(path: string, method: string) {
  const sent: { status?: number; body?: unknown } = {};
  const context = { req: {} as RouteContext["req"], res: {} as RouteContext["res"], url: new URL(`http://x${path}`), path, method, auth,
    json: ((_res: unknown, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as unknown as RouteContext["json"],
    readBody: (async () => undefined) as unknown as RouteContext["readBody"] } as RouteContext;
  return { context, sent };
}

describe("Contact support's diagnostics", () => {
  it("are the app's facts and its recent warnings and errors, redacted, and never a conversation", () => {
    const text = supportDiagnostics({ installId: "install_0001", appVersion: "0.1.153", runsOn: "desktop app", os: "darwin 25.3.0 arm64", node: "v24.15.0",
      uptimeSeconds: 3_900, language: "de", now: Date.UTC(2026, 10, 12, 9, 0), log: [`2026-11-12T08:59:00.000Z warn engine failed with key ${SECRET}`, "2026-11-12T08:59:30.000Z error\nsplit line"] }, []);
    expect(text.split("\n")).toEqual(["MausBot support request diagnostics", "Sent: 2026-11-12T09:00:00.000Z", "App version: 0.1.153", "Runs on: desktop app",
      "OS: darwin 25.3.0 arm64", "Node: v24.15.0", "Server uptime: 1h 5m", "Language: de", "Install: install_0001", "", "## Server warnings and errors, newest last",
      expect.stringMatching(/^2026-11-12T08:59:00\.000Z warn engine failed with key /), "2026-11-12T08:59:30.000Z error split line"]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/Conversation|Message:/);
    const quiet = supportDiagnostics({ installId: "i", appVersion: "0.1.153", runsOn: "My Cloud", os: "linux", node: "v24", uptimeSeconds: 5, now: 0, log: [] }, []);
    expect(quiet).toContain("(none since the server started)");
    expect(quiet).not.toContain("Language:");
  });

  it("are served to an admin only, for GET", async () => {
    expect(requiredScope("GET", SUPPORT_DIAGNOSTICS_PATH)).toBe("admin");
    const route = createSupportDiagnosticsRoutes({ installId: "install_0001", appVersion: () => "0.1.153", runsOn: "desktop app", language: () => undefined,
      recentLog: () => ["2026-11-12T08:59:00.000Z warn something"], now: () => 0 });
    expect(await route(ctx("/api/other", "GET").context)).toBe(PASS);
    const post = ctx(SUPPORT_DIAGNOSTICS_PATH, "POST");
    await route(post.context);
    expect(post.sent.status).toBe(405);
    const get = ctx(SUPPORT_DIAGNOSTICS_PATH, "GET");
    await route(get.context);
    expect(get.sent.status).toBe(200);
    expect((get.sent.body as { text: string }).text).toContain("2026-11-12T08:59:00.000Z warn something");
  });
});
