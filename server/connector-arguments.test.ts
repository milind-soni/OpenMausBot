import { describe, expect, it } from "vitest";

import { ARGUMENT_REFUSAL, argumentRefusalNote, exampleCall, fitArguments, fittedArgumentsNote } from "./connector-arguments.ts";

/** The shapes Composio's own tools list, a definition behind a local $ref included. */
const SEARCH = {
  type: "object",
  properties: { queries: { type: "array", items: { $ref: "#/$defs/Query" } }, session: { type: "object", properties: { id: { type: "string" } } } },
  required: ["queries"],
  $defs: { Query: { type: "object", properties: { use_case: { type: "string" }, known_fields: { type: "string" } }, required: ["use_case"] } },
};
const WORKBENCH = {
  type: "object",
  properties: { code_to_execute: { type: "string" }, thought: { type: "string" }, timeout: { type: "number" } },
  required: ["code_to_execute"],
};
const MULTI = {
  type: "object",
  properties: {
    tools: { type: "array", items: { type: "object", properties: { tool_slug: { type: "string" }, arguments: { type: "object" } }, required: ["tool_slug", "arguments"] } },
    sync_response_to_workbench: { type: "boolean" },
    session_id: { type: "string" },
  },
  required: ["tools"],
};

describe("fitting a call's arguments to the tool's schema", () => {
  it("fits each argument mistake bots made in a Team trial", () => {
    expect(fitArguments({ job: "generate an image from a text description" }, SEARCH)).toEqual({
      args: { queries: [{ use_case: "generate an image from a text description" }] },
      changed: ["job as queries", 'queries as [{"use_case": …}]'],
    });
    expect(fitArguments({ code: "print(1)" }, WORKBENCH)).toEqual({ args: { code_to_execute: "print(1)" }, changed: ["code as code_to_execute"] });
    expect(fitArguments({ code_to_execute: "print(1)", timeout: "120" }, WORKBENCH)).toEqual({ args: { code_to_execute: "print(1)", timeout: 120 }, changed: ["timeout as a number"] });
    const listed = JSON.stringify([{ tool_slug: "GOOGLE_ANALYTICS_BATCH_RUN_REPORTS", arguments: { property: "properties/1" } }]);
    expect(fitArguments({ session_id: "s", sync_response_to_workbench: false, tools: listed }, MULTI)).toEqual({
      args: { session_id: "s", sync_response_to_workbench: false, tools: [{ tool_slug: "GOOGLE_ANALYTICS_BATCH_RUN_REPORTS", arguments: { property: "properties/1" } }] },
      changed: ["tools from text to a list"],
    });
  });

  it("reads a bare string or a list of strings where a list of one-field objects goes, arguments sent as text, and nested text", () => {
    expect(fitArguments({ queries: "send an email" }, SEARCH).args).toEqual({ queries: [{ use_case: "send an email" }] });
    expect(fitArguments({ queries: ["send an email", "read my calendar"] }, SEARCH).args).toEqual({ queries: [{ use_case: "send an email" }, { use_case: "read my calendar" }] });
    expect(fitArguments(JSON.stringify({ queries: [{ use_case: "x" }] }), SEARCH)).toEqual({ args: { queries: [{ use_case: "x" }] }, changed: ["the arguments from text to an object"] });
    expect(fitArguments({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: '{"to":"a@b.c"}' }] }, MULTI)).toEqual({
      args: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "a@b.c" } }] },
      changed: ["tools[0].arguments from text to an object"],
    });
  });

  it("leaves a well-formed call as it is, and never guesses which of two sent fields was meant", () => {
    const fine = { queries: [{ use_case: "x" }], session: { id: "s" } };
    expect(fitArguments(fine, SEARCH)).toEqual({ args: fine, changed: [] });
    expect(fitArguments(fine, SEARCH).args).toBe(fine);
    expect(fitArguments({ script: "a", notes: "b" }, WORKBENCH)).toEqual({ args: { script: "a", notes: "b" }, changed: [] });
    // Of two text fields, the one sharing a word with the missing name is the one meant.
    expect(fitArguments({ code: "a", note: "b" }, WORKBENCH).args).toEqual({ code_to_execute: "a", note: "b" });
    expect(fitArguments({ timeout: "soon", code_to_execute: "x" }, WORKBENCH).changed).toEqual([]);
    expect(fitArguments("not json", SEARCH)).toEqual({ args: "not json", changed: [] });
    expect(fitArguments({ anything: 1 }, undefined)).toEqual({ args: { anything: 1 }, changed: [] });
  });
});

describe("what a bot is told", () => {
  it("shows a call each schema accepts", () => {
    expect(exampleCall(SEARCH)).toBe('{"queries":[{"use_case":"…"}]}');
    expect(exampleCall(WORKBENCH)).toBe('{"code_to_execute":"…"}');
    expect(exampleCall(MULTI)).toBe('{"tools":[{"tool_slug":"…","arguments":{}}]}');
    expect(exampleCall({ type: "object", properties: {} })).toBeNull();
  });

  it("says how to call again, and that a refusal over arguments says nothing about which tools exist", () => {
    const note = argumentRefusalNote("COMPOSIO_SEARCH_TOOLS", SEARCH, ["gemini", "gmail"]);
    expect(note).toContain('Call it again with the arguments its schema names, for example {"queries":[{"use_case":"…"}]} with your own values.');
    expect(note).toContain("it says nothing about which apps or tools exist, so do not tell the person a tool is missing. Connected apps you can use: gemini, gmail.");
    expect(argumentRefusalNote("GMAIL_SEND_EMAIL", undefined, [])).toContain("Read its arguments with COMPOSIO_GET_TOOL_SCHEMAS");
    expect(fittedArgumentsNote("COMPOSIO_SEARCH_TOOLS", ["job as queries"])).toBe("OpenMausBot note: COMPOSIO_SEARCH_TOOLS's arguments were read with job as queries. Send them in that shape next time.");
  });

  it("knows Composio's refusal of a call's arguments", () => {
    expect(ARGUMENT_REFUSAL.test('Invalid request for COMPOSIO_SEARCH_TOOLS: Validation error: Required at "queries"')).toBe(true);
    expect(ARGUMENT_REFUSAL.test('Invalid request for COMPOSIO_REMOTE_WORKBENCH: Validation error: Expected number, received string at "timeout"')).toBe(true);
    expect(ARGUMENT_REFUSAL.test("The calendar has no events that day.")).toBe(false);
  });
});
