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
