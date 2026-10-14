import { describe, expect, it, vi } from "vitest";

import { WIDGET_SAMPLES } from "../../shared/widget-samples.ts";
import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools, type CatalogProfile } from "./agents-catalog.ts";
import type { HarnessClient } from "./agents-client.ts";

const PROFILE: CatalogProfile = { skillAuthoring: false, sharedComputers: false, voiceNotes: false, cloudHome: false, chief: false, botId: "bot-scout" };

function harness(answer: { ok: boolean; status: number; body: Record<string, unknown> } = { ok: true, status: 201, body: { messageId: "m42" } }) {
  const api = vi.fn<HarnessClient["api"]>(async () => ({}));
  const apiResponse = vi.fn<HarnessClient["apiResponse"]>(async () => answer);
  const context: ToolCallContext = { botId: "bot-scout", threadId: "thread-scout", depth: 0, externalRuntime: false, sharedComputers: false, client: { api, apiResponse } };
  return { api, apiResponse, context };
}

describe("the widget tools in the catalog", () => {
  it("are offered to every bot that gets the agents catalog, whatever the turn mounts", () => {
    const profiles: CatalogProfile[] = [
      PROFILE,
      { ...PROFILE, chief: true, skillAuthoring: true, sharedComputers: true, voiceNotes: true },
      { ...PROFILE, cloudHome: true },
      { ...PROFILE, memoryEnabled: false },
    ];
    for (const profile of profiles) {
      const names = availableTools(profile).map((tool) => tool.name);
      expect(names.slice(names.indexOf("attach_file"), names.indexOf("attach_file") + 3)).toEqual(["attach_file", "show_widget", "update_widget"]);
    }
  });

  it("carry schemas a model can fill, and no read-only annotation: they post into the chat", () => {
    const tools = new Map(availableTools(PROFILE).map((tool) => [tool.name, tool as { name: string; description: string; inputSchema: unknown; annotations?: unknown }]));
    const show = tools.get("show_widget")!;
    expect(show.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        widget: { type: "object", additionalProperties: true, description: "The widget tree." },
        fallback_text: { type: "string", description: "Optional plain-text version for clients that cannot draw widgets. Written for you when omitted." },
      },
      required: ["widget"],
    });
    expect(show.description).toMatch(/^Show an interactive widget in this chat\. Reach for it yourself/);
    expect(show.description).toMatch(/Never ask for passwords here\. Not available in rooms\.$/);
    const update = tools.get("update_widget")!;
    expect(update.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { widget_id: { type: "string" }, widget: { type: "object", additionalProperties: true } },
      required: ["widget_id", "widget"],
    });
    expect(update.description).toBe("Replace a widget you showed earlier in this chat, in place: a progress bar moving, a status changing. `widget_id` is the id show_widget returned. A widget the person already answered cannot be updated; show a new one.");
    for (const name of ["attach_file", "show_widget", "update_widget"]) expect(tools.get(name), name).not.toHaveProperty("annotations");
  });
});

describe("show_widget", () => {
  it("posts the tree as the model wrote it and tells the model to end its turn", async () => {
    const { api, apiResponse, context } = harness();
    const result = await callTool("show_widget", { widget: WIDGET_SAMPLES.pullRequests }, context);
    expect(apiResponse).toHaveBeenCalledTimes(1);
    expect(apiResponse).toHaveBeenCalledWith("/api/internal/options-card", {
      method: "POST",
      body: JSON.stringify({ tool: "show_widget", widget: WIDGET_SAMPLES.pullRequests }),
    });
    expect(api).not.toHaveBeenCalled();
    expect(result).toEqual({
      text: 'Shown as widget m42. If it asks the person something, end your turn now: their press arrives as their next message. To change it later, call update_widget with widget_id "m42".',
    });
  });

  it("says so when the harness masked something that read as a secret", async () => {
    const { apiResponse, context } = harness();
    apiResponse.mockResolvedValueOnce({ ok: true, status: 201, body: { messageId: "m42", masked: true } });
    const result = await callTool("show_widget", { widget: WIDGET_SAMPLES.pullRequests }, context);
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/^Shown as widget m42\. .* Something in it read as a secret and was masked before it was stored\. Never put secrets in a widget, and name a payload field key, token or password only when it holds one\.$/);
  });

  it("warns when a list has a confirm button and no row that can be chosen, and says nothing when one can", async () => {
    const { context } = harness();
    const rows = ["Butter chicken", "Veggie bowl", "Pizza"].map((value) => ({ type: "ListViewItem", children: [{ type: "Text", value }] }));
    const confirm = { label: "Pick this", action: { type: "dinner.pick" } };
    const stuck = await callTool("show_widget", { widget: { type: "ListView", title: "Dinner", children: rows, confirm } }, context);
    expect(stuck.isError).toBeUndefined();
    expect(stuck.text).toMatch(/ No row of this list can be chosen: the person can only confirm or cancel it as a whole\. If they are meant to pick one row, call update_widget and give the ListView a name \(and each row a value\), so the rows become selectable and confirm sends the pick\.$/);
    const choice = await callTool("show_widget", { widget: { type: "ListView", name: "dish", title: "Dinner", children: rows, confirm } }, context);
    expect(choice.text).not.toContain("No row of this list can be chosen");
    const pressable = await callTool("show_widget", { widget: WIDGET_SAMPLES.pullRequests }, context);
    expect(pressable.text).not.toContain("No row of this list can be chosen");
  });

  it("sends fallback_text only when it is a string", async () => {
    const { apiResponse, context } = harness();
    await callTool("show_widget", { widget: WIDGET_SAMPLES.spendTable, fallback_text: "Spend by bot, last 7 days." }, context);
    await callTool("show_widget", { widget: WIDGET_SAMPLES.spendTable, fallback_text: 7 }, context);
    expect(apiResponse.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { tool: "show_widget", widget: WIDGET_SAMPLES.spendTable, fallback_text: "Spend by bot, last 7 days." },
      { tool: "show_widget", widget: WIDGET_SAMPLES.spendTable },
    ]);
  });

  it("returns the parser's sentence for a malformed widget without calling the harness", async () => {
    const { api, apiResponse, context } = harness();
    expect(await callTool("show_widget", { widget: { type: "Card", children: [{ type: "Select", name: "a", options: [] }] } }, context))
      .toEqual({ text: "widget.children[0].options: needs 1 to 40 items.", isError: true });
    expect(await callTool("show_widget", {}, context)).toEqual({ text: "widget: must be an object with a type.", isError: true });
    expect(await callTool("show_widget", { widget: { type: "Card", children: [{ type: "Input", name: "pw", inputType: "password" }] } }, context))
      .toEqual({ text: "widget.children[0].inputType: password fields are not allowed in a widget; use request_credential for secrets.", isError: true });
    expect(apiResponse).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
  });

  it("hands the harness's refusal to the model as an error", async () => {
    const room = harness({ ok: false, status: 409, body: { error: "Widgets are not available in rooms yet. Answer in text." } });
    expect(await callTool("show_widget", { widget: WIDGET_SAMPLES.pullRequests }, room.context))
      .toEqual({ text: "Widgets are not available in rooms yet. Answer in text.", isError: true });
    const silent = harness({ ok: false, status: 500, body: {} });
    expect(await callTool("show_widget", { widget: WIDGET_SAMPLES.pullRequests }, silent.context)).toEqual({ text: "Could not show that widget.", isError: true });
  });
});

describe("update_widget", () => {
  it("names the widget it replaces", async () => {
    const { apiResponse, context } = harness({ ok: true, status: 201, body: { messageId: "m7" } });
    const result = await callTool("update_widget", { widget_id: "m7", widget: WIDGET_SAMPLES.buildStatus, fallback_text: "ignored" }, context);
    expect(apiResponse).toHaveBeenCalledWith("/api/internal/options-card", {
      method: "POST",
      body: JSON.stringify({ tool: "update_widget", widget_id: "m7", widget: WIDGET_SAMPLES.buildStatus }),
    });
    expect(result).toEqual({ text: "Updated widget m7." });
  });

  it("checks the widget, then the id, before any round trip", async () => {
    const { apiResponse, context } = harness();
    expect(await callTool("update_widget", { widget_id: "m7", widget: "not json" }, context)).toEqual({ text: "widget: must be a JSON object, not text.", isError: true });
    expect(await callTool("update_widget", { widget: WIDGET_SAMPLES.buildStatus }, context)).toEqual({ text: "widget_id: is required, the id show_widget returned.", isError: true });
    expect(await callTool("update_widget", { widget_id: "  ", widget: WIDGET_SAMPLES.buildStatus }, context)).toMatchObject({ isError: true });
    expect(apiResponse).not.toHaveBeenCalled();
  });

  it("hands a settled or unknown widget's refusal to the model", async () => {
    const settled = harness({ ok: false, status: 409, body: { error: "The person already answered that widget. Show a new one." } });
    expect(await callTool("update_widget", { widget_id: "m7", widget: WIDGET_SAMPLES.buildStatus }, settled.context))
      .toEqual({ text: "The person already answered that widget. Show a new one.", isError: true });
    const silent = harness({ ok: false, status: 500, body: {} });
    expect(await callTool("update_widget", { widget_id: "m7", widget: WIDGET_SAMPLES.buildStatus }, silent.context)).toEqual({ text: "Could not update that widget.", isError: true });
  });
});

describe("draft_bug_report", () => {
  it("is offered to every bot except on a guest's turn", () => {
    for (const profile of [PROFILE, { ...PROFILE, chief: true }, { ...PROFILE, cloudHome: true }]) {
      expect(availableTools(profile).map((tool) => tool.name)).toContain("draft_bug_report");
    }
    expect(availableTools({ ...PROFILE, cloudHome: true, guestTurn: true }).map((tool) => tool.name)).not.toContain("draft_bug_report");
    const tool = availableTools(PROFILE).find((entry) => entry.name === "draft_bug_report")!;
    expect(tool.description).toMatch(/only when OpenMausBot itself fails/);
    expect(tool.description).toMatch(/Never for errors in the person's own task/);
    expect(tool.description).toMatch(/nothing is sent unless they press Send\. After calling it, end your turn/);
    expect(tool).not.toHaveProperty("annotations");
  });

  it("posts the draft as the model wrote it and tells the model to end its turn", async () => {
    const { api, apiResponse, context } = harness();
    const result = await callTool("draft_bug_report", { summary: " Team tools did not connect ", details: " ECONNREFUSED " }, context);
    expect(apiResponse).toHaveBeenCalledExactlyOnceWith("/api/internal/options-card", {
      method: "POST",
      body: JSON.stringify({ tool: "draft_bug_report", summary: "Team tools did not connect", details: "ECONNREFUSED" }),
    });
    expect(api).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.text).toMatch(/nothing is sent unless they press Send\. Your turn ends now/);
  });

  it("refuses a missing or overlong summary without calling the harness, and passes a refusal through", async () => {
    const { apiResponse, context } = harness({ ok: false, status: 403, body: { error: "draft_bug_report is not available in a conversation a guest is driving." } });
    expect(await callTool("draft_bug_report", { details: "x" }, context)).toEqual({ text: "draft_bug_report needs summary: one line on what failed in OpenMausBot.", isError: true });
    expect((await callTool("draft_bug_report", { summary: "x".repeat(201), details: "" }, context)).text).toMatch(/^summary is limited to 200 characters; this one is 201/);
    expect(apiResponse).not.toHaveBeenCalled();
    expect(await callTool("draft_bug_report", { summary: "Broken", details: "" }, context))
      .toEqual({ text: "draft_bug_report is not available in a conversation a guest is driving.", isError: true });
  });
});
