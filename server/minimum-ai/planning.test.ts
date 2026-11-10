import { expect, it, vi } from "vitest";
import { botWorkflowPlanner, prepareWorkflow, textWorkflowPlanner } from "./planning.ts";
import { approveWorkflow, executeApprovedWorkflow, verifyWorkflow } from "./approval.ts";

it("asks the planner once, then replays the approved plan without the planner", async () => {
  const plan = { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: { folder: "inbox" } }] };
  const planner = vi.fn(async () => plan);
  const draft = await prepareWorkflow("Check my inbox", new Set(["MAIL_LIST"]), planner);
  expect(draft.approved).toBe(false);
  const invoke = vi.fn(async () => ({ messages: [] }));
  const approved = approveWorkflow((await verifyWorkflow(draft, new Set(["MAIL_LIST"]), async () => ({ messages: [] }))).proposal);
  await executeApprovedWorkflow(approved, new Set(["MAIL_LIST"]), invoke);
  await executeApprovedWorkflow(approved, new Set(["MAIL_LIST"]), invoke);
  expect(planner).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("rejects invalid planner output instead of saving or executing it", async () => {
  const planner = vi.fn(async () => ({ version: 1, steps: [{ kind: "shell", command: "anything" }] }));
  await expect(prepareWorkflow("Do a task", new Set(["MAIL_LIST"]), planner)).rejects.toThrow();
});

it("does not mistake moving a Notion page to trash for permanent deletion", async () => {
  for (const tool of ["NOTION_DELETE_BLOCK", "NOTION_ARCHIVE_NOTION_PAGE"]) {
    const planner = vi.fn(async () => ({ version: 1, steps: [{ kind: "call", id: "remove", tool, input: {} }] }));
    await expect(prepareWorkflow('Check the Notion database for items where property "Group" is "Trash". If any items are present, permanently delete them using their block IDs. If the Trash column is empty, take no action.', new Set([tool]), planner)).rejects.toThrow(/permanent/i);
  }
  const planner = vi.fn(async () => ({ version: 1, steps: [{ kind: "call", id: "archive", tool: "NOTION_ARCHIVE_NOTION_PAGE", input: {} }] }));
  await expect(prepareWorkflow("Archive matching Notion pages", new Set(["NOTION_ARCHIVE_NOTION_PAGE"]), planner)).resolves.toBeTruthy();
});

it("does not send credentials from instructions to the planning model", async () => {
  const planner = vi.fn();
  await expect(prepareWorkflow(`Read mail with sk-${"a".repeat(24)}`, new Set(["MAIL_LIST"]), planner)).rejects.toThrow(/credentials/i);
  expect(planner).not.toHaveBeenCalled();
});

it("provides the planner with connected tool schemas without granting extra tools", async () => {
  const catalog = [{ name: "MAIL_LIST", description: "List inbox messages", inputSchema: { type: "object", properties: { folder: { type: "string" } } } }];
  const planner = vi.fn(async () => ({ version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: { folder: "inbox" } }] }));
  await prepareWorkflow("Check my inbox", new Set(["MAIL_LIST"]), planner, new Set(), catalog);
  expect(planner).toHaveBeenCalledWith("Check my inbox", catalog);
});

it("describes the unwrapped Composio data to the planner while retaining schema references", async () => {
  const catalog = [{ name: "NOTION_QUERY_DATABASE", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { successful: { type: "boolean" }, error: { type: "string" }, data: { $ref: "#/$defs/Rows" } }, $defs: { Rows: { type: "object", properties: { results: { type: "array" } } } } } }];
  const planner = vi.fn(async (_goal: string, _tools: readonly import("./planning.ts").WorkflowToolDescriptor[]) => ({ version: 1, steps: [{ kind: "call", id: "list", tool: "NOTION_QUERY_DATABASE", input: {} }] }));
  await prepareWorkflow("List rows", new Set(["NOTION_QUERY_DATABASE"]), planner, new Set(), catalog);
  expect(planner.mock.calls[0]?.[1][0]?.outputSchema).toEqual({ $ref: "#/$defs/Rows", $defs: catalog[0]!.outputSchema.$defs });
});

it("generates a proposal through a text-only model and rejects unsupported output", async () => {
  const generate = vi.fn(async (_prompt: string) => JSON.stringify({ version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }));
  const proposal = await prepareWorkflow("Check mail", new Set(["MAIL_LIST"]), textWorkflowPlanner(generate));
  expect(proposal.plan.steps[0]).toMatchObject({ tool: "MAIL_LIST" });
  expect(generate.mock.calls[0]?.[0]).toContain("You cannot run tools");
  expect(generate.mock.calls[0]?.[0]).toContain("it stops with an error before later steps if more pages remain at the limit");
  await expect(prepareWorkflow("Do something", new Set(["MAIL_LIST"]), textWorkflowPlanner(async () => '{"unsupported":"no tool"}'))).rejects.toThrow(/cannot be converted/i);
});

it("uses the bot's existing accounted text-only model for setup", async () => {
  const generateText = vi.fn(async () => JSON.stringify({ version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] }));
  const text = vi.fn(() => ({ via: "engine" as const, generateText }));
  await prepareWorkflow("Check mail", new Set(["MAIL_LIST"]), botWorkflowPlanner({ text }, "bot-1"));
  expect(text).toHaveBeenCalledWith("minimum-ai-plan", "bot-1");
  expect(generateText).toHaveBeenCalledOnce();
  await expect(prepareWorkflow("Check mail", new Set(["MAIL_LIST"]), botWorkflowPlanner({ text: () => null }, "bot-1"))).rejects.toThrow(/no text-only model/i);
});

it("accepts a fenced JSON proposal and gives a safe reason when a task is unsupported", async () => {
  const plan = { version: 1, steps: [{ kind: "call", id: "list", tool: "MAIL_LIST", input: {} }] };
  const proposal = await prepareWorkflow("Check mail", new Set(["MAIL_LIST"]), textWorkflowPlanner(async () => `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``));
  expect(proposal.plan.steps[0]).toMatchObject({ tool: "MAIL_LIST" });
  const secret = `sk-${"a".repeat(24)}`;
  const planner = textWorkflowPlanner(async () => JSON.stringify({ unsupported: `Needs a computer action. ${secret}` }));
  await expect(prepareWorkflow("Check mail", new Set(["MAIL_LIST"]), planner)).rejects.toThrow(/Needs a computer action/);
  try { await prepareWorkflow("Check mail", new Set(["MAIL_LIST"]), planner); } catch (error) { expect(String(error)).not.toContain(secret); }
});
