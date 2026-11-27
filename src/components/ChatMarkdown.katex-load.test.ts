import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("document", { compatMode: "CSS1Compat" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("rehype-katex");
  vi.doUnmock("katex/dist/katex.min.css");
});

it("keeps concurrent callers waiting until the stylesheet is ready", async () => {
  let release!: () => void;
  let loading = false;
  const css = new Promise<void>(resolve => { release = resolve; });
  vi.doMock("katex/dist/katex.min.css", async () => {
    loading = true;
    await css;
    return {};
  });
  const { ensureChatKatex } = await import("./ChatMarkdown");
  const first = ensureChatKatex();
  await vi.waitFor(() => expect(loading).toBe(true));
  const second = ensureChatKatex();
  release();
  await Promise.all([first, second]);
  expect(second).toBe(first);
});

it.each(["rehype-katex", "katex/dist/katex.min.css"])("can retry a failed %s download", async moduleName => {
  vi.doMock(moduleName, () => { throw new Error("Download failed"); });
  const { ensureChatKatex } = await import("./ChatMarkdown");
  await expect(ensureChatKatex()).rejects.toThrow();
  vi.doMock(moduleName, async () => moduleName === "rehype-katex"
    ? await vi.importActual(moduleName)
    : {});
  await expect(ensureChatKatex()).resolves.toBeUndefined();
});
