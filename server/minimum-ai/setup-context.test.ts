import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createSetupContext } from "./setup-context.ts";
import { createWorkflowStore } from "./store.ts";
import { workflowSchemaDigest } from "./binding.ts";
import type { RequestAuth } from "../request-auth.ts";

it("resolves an owner's account and searches only when preparing a workflow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-workflow-context-"));
  try {
    const store = createWorkflowStore(join(dir, "plans.json"));
    const model = vi.fn(async () => ({}));
    const tools = [{ tool_slug: "MAIL_LIST", input_schema: { type: "object" } }];
    const relay = vi.fn(async (frame: Record<string, unknown>) => {
      const data = { successful: true, data: { tools } };
      return { status: 200, transportSessionId: "fixture", bytes: new TextEncoder().encode(JSON.stringify(frame.method === "tools/call" ? { id: frame.id, result: { content: [{ type: "text", text: JSON.stringify(data) }] } } : { result: {} })) };
    });
    const context = createSetupContext({ owner: (auth) => auth.kind === "session" ? "owner" : null,
      routine: () => ({ botId: "bot", prompt: "Check mail", target: "bot", runOn: "maus", executionMode: "minimum-ai" }),
      services: async () => ({ mail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "account", status: "ACTIVE" }] } }),
      permitted: (_bot, tool) => tool === "MAIL_LIST", serviceFor: () => "mail", withRelay: async (_bot, _id, _thread, run) => run(relay), planner: () => model, store });
    const auth = { kind: "session" } as RequestAuth;
    const available = await context(auth, "routine", "prepare");
    const prepared = available?.select?.(["MAIL_LIST"]);
    expect(prepared?.binding.connectionIds).toEqual(["mail:account"]);
    const binding = { ...prepared!.binding, schemaDigest: workflowSchemaDigest(prepared!.catalog) };
    store.saveDraft("routine", "owner", binding, { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }, new Set(["MAIL_LIST"]), new Set(), prepared!.catalog);
    relay.mockClear();
    const existing = await context(auth, "routine", "existing");
    expect(existing?.catalog.map((tool) => tool.name)).toEqual(["MAIL_LIST"]);
    expect(relay.mock.calls.map(([frame]) => (frame.params as { name?: string } | undefined)?.name).filter(Boolean)).toEqual(["COMPOSIO_GET_TOOL_SCHEMAS"]);
    expect(await context({ kind: "api" } as unknown as RequestAuth, "routine", "prepare")).toBeNull();
    expect(model).not.toHaveBeenCalled();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
