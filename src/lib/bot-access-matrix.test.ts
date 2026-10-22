import { describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";
import {
  accessBots,
  appAccess,
  appAccessPatch,
  outboundPatch,
  planAppForAll,
  planCopyAccess,
  planOutboundForAll,
} from "./bot-access-matrix";
import { HIGHLEVEL_SLUG } from "./highlevel-sign-in";

vi.mock("@/components/DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

const engine = (instanceId: string, driverKind: string, capabilities: Record<string, unknown>) => ({
  instanceId, driverKind, displayName: instanceId, enabled: true, snapshot: { state: "available" },
  models: { default: "m", options: [{ id: "m", label: "m" }] }, capabilities,
}) as unknown as InstanceInfo;

const instances = [
  engine("claude", "claudeAgent", { composioMcp: true, highlevelMcp: true }),
  engine("plain", "openaiCompat", {}),
];

const bot = (id: string, fields: Partial<Bot> = {}) => ({
  id, threadId: `${id}-t`, name: id, title: "", description: "", notifications: true, color: "blue", unread: false,
  modelSelection: { instanceId: "claude", model: "m" }, ...fields,
}) as Bot;

const connected = ["github", "supabase"];

/** What the matrix shows for a bot after a patch is applied the way the server stores it. */
const after = (b: Bot, patch: ReturnType<typeof appAccessPatch>): Bot => {
  const next = { ...b, ...patch } as Bot & Record<string, unknown>;
  for (const key of ["connectorTools", "connectorScopes"] as const) if (next[key] === null) delete next[key];
  return next;
};
const row = (b: Bot) => Object.fromEntries([...connected, HIGHLEVEL_SLUG].map((slug) => [slug, appAccess(b, instances, slug)]));

describe("bot access matrix", () => {
  it("lists visible bots only", () => {
    expect(accessBots([bot("a"), bot("b", { hidden: true })]).map((b) => b.id)).toEqual(["a"]);
  });

  it("reads each layer: model support, connected apps switch, read/write scopes and per-tool grants", () => {
    expect(appAccess(bot("a"), instances, "github")).toBe("all");
    expect(appAccess(bot("a", { modelSelection: { instanceId: "plain", model: "m" } }), instances, "github")).toBe("unsupported");
    expect(appAccess(bot("a", { composio: false }), instances, "github")).toBe("none");
    expect(appAccess(bot("a", { connectorScopes: { apps: { github: "read" } } }), instances, "github")).toBe("read");
    expect(appAccess(bot("a", { connectorScopes: { apps: { github: "read" } } }), instances, "supabase")).toBe("none");
    expect(appAccess(bot("a", { connectorTools: {} }), instances, "github")).toBe("none");
    expect(appAccess(bot("a", { connectorTools: { github: { tools: ["GITHUB_LIST_ISSUES"] } } }), instances, "github")).toBe("some");
    expect(appAccess(bot("a", { connectorTools: { github: { tools: "*" } } }), instances, "github")).toBe("all");
    expect(appAccess(bot("a", { connectorTools: { github: { tools: 7 } } } as unknown as Partial<Bot>), instances, "github")).toBe("custom");
    expect(appAccess(bot("a", { connectorTools: {} }), instances, HIGHLEVEL_SLUG)).toBe("all");
  });

  it("turns one app on for a bot the Chief created without opening every other app", () => {
    const chiefMade = bot("a", { composio: false, connectorTools: {} });
    const patch = appAccessPatch(chiefMade, instances, "github", "all", connected);
    expect(patch).toEqual({ composio: true, connectorScopes: { apps: { github: "write" } }, connectorTools: { github: { tools: "*" } } });
    expect(row(after(chiefMade, patch))).toEqual({ github: "all", supabase: "none", [HIGHLEVEL_SLUG]: "none" });
  });

  it("widens a bot limited to some tools to all of them, leaving its other apps as they were", () => {
    const limited = bot("a", { connectorTools: { github: { tools: ["GITHUB_LIST_ISSUES"] } } });
    const patch = appAccessPatch(limited, instances, "github", "all", connected);
    expect(patch).toEqual({ connectorTools: { github: { tools: "*" } } });
    expect(row(after(limited, patch))).toMatchObject({ github: "all", supabase: "none" });
  });

  it("removes one app from a bot that has every app without cutting off the rest", () => {
    const everything = bot("a");
    const patch = appAccessPatch(everything, instances, "github", "none", [...connected, HIGHLEVEL_SLUG]);
    expect(patch).toEqual({ connectorScopes: { apps: { supabase: "write", [HIGHLEVEL_SLUG]: "write" } } });
    expect(row(after(everything, patch))).toEqual({ github: "none", supabase: "all", [HIGHLEVEL_SLUG]: "all" });
  });

  it("drops the app from both the grants record and the scopes when a bot has both", () => {
    const both = bot("a", { connectorTools: { github: { tools: "*" }, supabase: { tools: "*" } }, connectorScopes: { apps: { github: "write", supabase: "read" } } });
    expect(appAccessPatch(both, instances, "github", "none", connected)).toEqual({
      connectorScopes: { apps: { supabase: "read" } },
      connectorTools: { supabase: { tools: "*" } },
    });
  });

  it("makes an app read only, keeping the other connected apps writable", () => {
    const everything = bot("a");
    const patch = appAccessPatch(everything, instances, "supabase", "read", connected);
    expect(patch).toEqual({ connectorScopes: { apps: { github: "write", supabase: "read" } } });
    expect(row(after(everything, patch))).toMatchObject({ github: "all", supabase: "read" });
  });

  it("changes nothing that is already set, unsupported, or saved in a shape this build cannot edit", () => {
    expect(appAccessPatch(bot("a"), instances, "github", "all", connected)).toBeNull();
    expect(appAccessPatch(bot("a", { composio: false }), instances, "github", "none", connected)).toBeNull();
    expect(appAccessPatch(bot("a", { modelSelection: { instanceId: "plain", model: "m" } }), instances, "github", "all", connected)).toBeNull();
    expect(appAccessPatch(bot("a", { connectorTools: { github: { tools: 7 } } } as unknown as Partial<Bot>), instances, "github", "none", connected)).toBeNull();
  });

  it("plans an app for every bot and says why a bot is skipped", () => {
    const plan = planAppForAll([
      bot("off", { composio: false }),
      bot("on"),
      bot("plain", { modelSelection: { instanceId: "plain", model: "m" } }),
    ], instances, "github", "all", connected);
    expect(plan.map((entry) => entry.status)).toEqual(["apply", "unchanged", "skip"]);
    expect(plan[2]).toMatchObject({ reason: "its model cannot use connected apps" });
  });

  it("sets the sending rule, keeping each bot's daily limit", () => {
    expect(outboundPatch(bot("a", { outbound: { policy: "ask", dailyCap: 12 } }), "allow")).toEqual({ outbound: { policy: "allow", dailyCap: 12 } });
    expect(planOutboundForAll([bot("a"), bot("b", { outbound: { policy: "allow", dailyCap: 5 } })], "ask").map((entry) => entry.status))
      .toEqual(["unchanged", "apply"]);
  });

  it("copies one bot's apps, sending rule and approval level to the others", () => {
    const source = bot("src", { composio: true, connectorTools: { github: { tools: "*" } }, outbound: { policy: "allow", dailyCap: 20 }, approvalMode: "ask" });
    const plan = planCopyAccess(source, [
      source,
      bot("legacy", { approvalMode: "full" }),
      bot("same", { connectorTools: { github: { tools: "*" } }, outbound: { policy: "allow", dailyCap: 20 }, approvalMode: "ask" }),
      bot("busy", { composio: false, approvalMode: "full", busy: true }),
    ], instances);
    expect(plan.map((entry) => [entry.bot.id, entry.status])).toEqual([["legacy", "apply"], ["same", "unchanged"], ["busy", "apply"]]);
    expect(plan[0]).toMatchObject({ patch: { connectorTools: { github: { tools: "*" } }, outbound: { policy: "allow", dailyCap: 20 }, approvalMode: "ask", applyToAllThreads: true } });
    expect(plan[2]).toMatchObject({ patch: { composio: true, connectorTools: { github: { tools: "*" } } } });
    expect(plan[2]).not.toMatchObject({ patch: { approvalMode: "ask" } });
  });

  it("leaves a target's Custom approval alone and still copies its apps", () => {
    const source = bot("src", { connectorTools: { github: { tools: "*" } }, approvalMode: "ask" });
    const [entry] = planCopyAccess(source, [source, bot("custom", { approvalMode: "custom" })], instances);
    expect(entry).toMatchObject({ status: "apply", patch: { connectorTools: { github: { tools: "*" } } } });
    expect(entry).not.toMatchObject({ patch: { approvalMode: expect.anything() } });
    const [same] = planCopyAccess(bot("s", { approvalMode: "ask" }), [bot("s"), bot("c", { approvalMode: "custom" })], instances);
    expect(same).toMatchObject({ status: "skip", reason: "Custom approval is set on each bot separately" });
  });

  it("clears a target's own limits when the source has none", () => {
    const [entry] = planCopyAccess(bot("src"), [bot("src"), bot("t", { connectorTools: {}, connectorScopes: { apps: {} } })], instances);
    expect(entry).toMatchObject({ status: "apply", patch: { connectorTools: null, connectorScopes: null } });
  });
});
