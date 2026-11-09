// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
import { useSlashSkills } from "./use-slash-skills";
let root: Root;
let host: HTMLDivElement;
let current: ReturnType<typeof useSlashSkills>;
function Probe({ bot = "b1", thread = "t1", active = true }: { bot?: string; thread?: string; active?: boolean }) {
  current = useSlashSkills(bot, thread, active);
  return null;
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const render = (thread = "t1", active = true) => flushSync(() => root.render(createElement(Probe, { thread, active })));
beforeEach(() => { fixture.api.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });
describe("loading slash skills", () => {
  it("uses the paired-safe catalog and distinguishes loading, errors and successful retry", async () => {
    fixture.api.mockRejectedValueOnce(new Error("404 no route")).mockResolvedValueOnce({ skills: [{ name: "report", description: "Weekly report", enabled: true }] });
    render();
    expect(current.status).toBe("loading");
    await settle();
    expect(current.status).toBe("error");
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/slash-skills?threadId=t1");
    flushSync(() => current.retry());
    await settle();
    expect(current.status).toBe("ready");
    expect(current.skills).toEqual([{ name: "report", description: "Weekly report" }]);
  });
  it("ignores stale results after changing threads and treats an empty catalog as success", async () => {
    let resolveOld!: (body: unknown) => void;
    fixture.api.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce({ skills: [] });
    render(); render("t2"); await settle();
    resolveOld({ skills: [{ name: "old-thread", enabled: true }] }); await settle();
    expect(current.skills).toEqual([]);
    expect(current.status).toBe("ready");
    render("t2", false);
    expect(current.status).toBe("idle");
  });
});
