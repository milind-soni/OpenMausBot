import { expect, it, vi } from "vitest";
import { schemaCheckedInvoker } from "./schema-check.ts";

it("refuses invalid or unknown tool inputs before the connector is called", async () => {
  const invoke = vi.fn(async () => ({}));
  const checked = schemaCheckedInvoker([{ name: "MAIL_LIST", inputSchema: { type: "object", properties: { folder: { type: "string" } }, required: ["folder"], additionalProperties: false } }], invoke);
  const signal = new AbortController().signal;
  await expect(checked("MAIL_LIST", { folder: 12 }, signal)).rejects.toThrow(/schema/i);
  await expect(checked("MAIL_DELETE", {}, signal)).rejects.toThrow(/not available/i);
  expect(invoke).not.toHaveBeenCalled();
  await checked("MAIL_LIST", { folder: "inbox" }, signal);
  expect(invoke).toHaveBeenCalledOnce();
});

it("accepts harmless vendor schema annotations while still enforcing required input fields", async () => {
  const invoke = vi.fn(async () => ({}));
  const checked = schemaCheckedInvoker([{ name: "MAIL_LIST", inputSchema: { type: "object", "x-toolkit-note": "sample", properties: { folder: { type: "string", example: "inbox" } }, required: ["folder"], additionalProperties: false } }], invoke);
  const signal = new AbortController().signal;
  await checked("MAIL_LIST", { folder: "inbox" }, signal);
  await expect(checked("MAIL_LIST", {}, signal)).rejects.toThrow(/schema/i);
  expect(invoke).toHaveBeenCalledTimes(1);
});
