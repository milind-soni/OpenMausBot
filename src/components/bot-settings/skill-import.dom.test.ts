// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useSkillImport } from "./SkillsSection";

const request = vi.hoisted(() => vi.fn());
vi.mock("./BotEditorContext", () => ({ useBotEditor: () => ({ request }) }));

it("discards a pending import when the selected bot changes", async () => {
  const refresh = vi.fn(), setError = vi.fn();
  const root = createRoot(document.createElement("div"));
  let hook!: ReturnType<typeof useSkillImport>;
  function Probe({ id }: { id: string }) {
    hook = useSkillImport(id, { refresh, setError }, "Import failed");
    return null;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(createElement(Probe, { id: "first" })));
    await act(async () => hook.setSource("owner/repo"));
    let finish!: () => void;
    request.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ imported: [] }); }));
    let pending!: Promise<void>;
    await act(async () => { pending = hook.submit("url"); });
    await act(async () => root.render(createElement(Probe, { id: "second" })));
    await act(async () => { finish(); await pending; });
    expect(refresh).not.toHaveBeenCalled();
    expect(hook.imported).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
