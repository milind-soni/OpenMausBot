import { expect, it, vi } from "vitest";
import { boundedAgentResult } from "./agents-result.ts";
import { TOOL_RESULT_MAX_CHARS } from "../tool-results.ts";

const id = "r-37a58e8d-4411-4a9c-bc1a-00c4278201db";

it("leaves small results unchanged without cache I/O", async () => {
  const save = vi.fn();
  expect(await boundedAgentResult("original result", save)).toBe("original result");
  expect(save).not.toHaveBeenCalled();
});

it("returns a bounded preview and an exact next offset without breaking emoji", async () => {
  const save = vi.fn().mockResolvedValue({ id });
  const text = `${"x".repeat(15_999)}🌱${"y".repeat(15_000)}`;
  const reply = await boundedAgentResult(text, save);
  expect(reply.length).toBeLessThan(17_000);
  expect(Buffer.from(reply).toString()).toBe(reply);
  expect(reply).toContain(`id "${id}" and offset 15999`);
  expect(save).toHaveBeenCalledExactlyOnceWith(text, false);
});

it("redacts before both preview and retention, and admits when the tail is omitted", async () => {
  const save = vi.fn().mockResolvedValue({ id });
  const secret = `ghp_${"x".repeat(30)}`;
  const reply = await boundedAgentResult(`${secret}\n${"x".repeat(TOOL_RESULT_MAX_CHARS * 2)}`, save);
  expect(reply).not.toContain(secret);
  expect(reply).toContain("remaining tail was omitted");
  expect(save.mock.calls[0]![0]).not.toContain(secret);
  expect(save.mock.calls[0]![0].length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
  expect(save.mock.calls[0]![1]).toBe(true);
});

it.each([null, {}, { id: "bad" }])("does not advertise a missing cache handle: %j", async saved => {
  expect(await boundedAgentResult("x".repeat(30_000), async () => saved)).toContain("could not be saved");
});

it("does not repeat the operation or claim failure when storing its output fails", async () => {
  const save = vi.fn().mockRejectedValue(new Error("offline"));
  const reply = await boundedAgentResult("x".repeat(30_000), save);
  expect(save).toHaveBeenCalledTimes(1);
  expect(reply).toContain("The original operation was not retried");
  expect(reply).not.toContain(id);
});

it("replaces the preview with a checked summary and points at offset 0", async () => {
  const summary = "Status: 3 pods running; pod-7 is failing image pull.";
  const save = vi.fn().mockResolvedValue({ id, summary });
  const reply = await boundedAgentResult("x".repeat(30_000), save);
  expect(reply.startsWith(summary)).toBe(true);
  expect(reply).toContain(`OpenMausBot summarized this large tool result: 30,000 → ${summary.length.toLocaleString("en-US")} characters`);
  expect(reply).toContain(`read it with tool_result_read id "${id}" and offset 0`);
  expect(reply).toContain("A summarized result is cached for one hour; restart or cache pressure can drop it, and its durable copy extends retrieval up to 30 days");
  expect(reply).not.toContain("showing the first");
  expect(reply.length).toBeLessThan(1_000);
});

it("admits the storage limit on a summarized truncated result", async () => {
  const save = vi.fn().mockResolvedValue({ id, summary: "s", truncated: true });
  const reply = await boundedAgentResult("x".repeat(TOOL_RESULT_MAX_CHARS * 2), save);
  expect(reply).toContain("saved in full up to the storage limit");
  expect(reply).not.toContain("saved in full;");
});

it.each([["empty string", ""], ["blank", "   "], ["non-string", 42]])("ignores a missing summary (%s) and keeps today's preview", async (_name, summary) => {
  const save = vi.fn().mockResolvedValue({ id, summary, truncated: false });
  const reply = await boundedAgentResult("x".repeat(30_000), save);
  expect(reply).toContain("showing the first");
  expect(reply).toContain(`offset 16000`);
  expect(reply).not.toContain("summarized this large tool result");
});
