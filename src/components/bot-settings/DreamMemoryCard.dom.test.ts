// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ApiError } from "@/state/api";
const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: calls.api, ApiError }));
import { DreamMemoryCard } from "./DreamMemoryCard";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("runs a dream and binds restore confirmation to the shown backup and file hash", async () => {
  const requests: { path: string; body?: Record<string, string> }[] = [];
  const report = { at: Date.now(), conversations: 2, learned: [1], outdated: [], ideas: [] };
  calls.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path, body });
    if (path.endsWith("/upkeep")) return { lastDream: report };
    if (path.endsWith("/backups")) return { backups: [{ id: "backup-one", at: Date.now() }] };
    if (path.endsWith("/restore") && !body.expectedHash) throw new ApiError("changed", 409, { code: "changed", currentHash: "hash-shown" });
    return { report };
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const changed = vi.fn(async () => {});
  const click = async (text: string) => {
    const button = [...host.querySelectorAll("button")].find((button) => button.textContent === text)!;
    expect(button).toBeTruthy();
    await act(async () => { button.click(); });
  };
  try {
    await act(async () => root.render(createElement(DreamMemoryCard, { botId: "chosen", enabled: true, onChange: changed })));
    await click("Dream now");
    expect(requests.some((r) => r.path === "/api/bots/chosen/memory/dream")).toBe(true);
    await click("Restore backup");
    expect(host.textContent).toContain("changed since this backup");
    await click("Replace with backup");
    expect(requests.filter((r) => r.path.endsWith("/restore")).at(-1)?.body).toEqual({ id: "backup-one", expectedHash: "hash-shown" });
    expect(changed).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
