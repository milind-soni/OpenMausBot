import { describe, expect, it } from "vitest";

import { appCallOutcome } from "./connection-outcome.ts";

const answer = (texts: string[], isError: boolean) => new TextEncoder().encode(JSON.stringify({
  jsonrpc: "2.0", id: 1,
  result: { isError, content: texts.map((text) => ({ type: "text", text })) },
}));

describe("JSON text in a failed MCP tool result", () => {
  it.each([
    ['"Unauthorized: token expired"', "sign-in"],
    [JSON.stringify({ error: "invalid_token" }), "sign-in"],
    [JSON.stringify({ message: "403 Forbidden: insufficient_scope" }), "refused"],
  ])("classifies %s from the explicit error result", (text, error) => {
    expect(appCallOutcome(200, answer([text], true), "application/json"))
      .toEqual({ ok: false, error });
  });

  it("still reads a plain error when another content part is valid JSON", () => {
    expect(appCallOutcome(200, answer([JSON.stringify({ requestId: "test" }), "Token expired; reconnect"], true), "application/json"))
      .toEqual({ ok: false, error: "sign-in" });
  });

  it.each([
    JSON.stringify({ message: "Unauthorized access happened in 2024" }),
    '"403 Forbidden is an HTTP status"',
  ])("does not classify successful returned data: %s", (text) => {
    expect(appCallOutcome(200, answer([text], false), "application/json")).toEqual({ ok: true });
  });

  it("keeps an unrelated tool error as evidence the account works", () => {
    expect(appCallOutcome(200, answer([JSON.stringify({ error: "Message not found" })], true), "application/json"))
      .toEqual({ ok: true });
  });

  it.each([
    { error: "Message not found", resource: "/messages/401" },
    { message: "Message not found", resource: "/messages/403" },
    { error: { message: "Message not found", resource: "/messages/401" } },
    { data: { message: "Token expired; reconnect" }, requestId: "401" },
  ])("ignores unrelated JSON fields in a failed result: %j", (value) => {
    expect(appCallOutcome(200, answer([JSON.stringify(value)], true), "application/json"))
      .toEqual({ ok: true });
  });

  it.each([
    [{ error: { message: "invalid_token" } }, "sign-in"],
    [{ error: { message: "403 Forbidden" }, resource: "/messages/401" }, "refused"],
  ])("reads nested error messages without classifying metadata: %j", (value, error) => {
    expect(appCallOutcome(200, answer([JSON.stringify(value)], true), "application/json"))
      .toEqual({ ok: false, error });
  });
});
