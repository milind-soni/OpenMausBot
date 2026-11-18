// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as Array<{ event: string; props: unknown }>);
vi.mock("@/lib/analytics", () => ({ track: (event: string, props: unknown) => void sent.push({ event, props }) }));

const { useConnectAiSteps } = await import("./connect-ai-events");

it("sends opened once per screen, even when an AI connects after it, and other steps once per engine", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  function Screen({ engine }: { engine?: string }) {
    const step = useConnectAiSteps("meet");
    useEffect(() => {
      step("opened", { aiReady: Boolean(engine), ...(engine ? { driverKind: engine } : {}) });
      step("chosen", { driverKind: "claudeAgent" });
      if (engine) step("chosen", { driverKind: engine });
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Screen)));
  await act(async () => root.render(createElement(Screen, { engine: "codex" })));
  await act(async () => root.unmount());
  expect(sent.map(({ props }) => props)).toEqual([
    { step: "opened", place: "meet", ai_ready: false },
    { step: "chosen", place: "meet", engine: "claude" },
    { step: "chosen", place: "meet", engine: "codex" },
  ]);
});
