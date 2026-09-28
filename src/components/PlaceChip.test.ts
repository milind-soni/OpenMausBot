import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

vi.stubGlobal("window", {});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        instances: [{
          instanceId: "test",
          driverKind: "grokAgent",
          displayName: "Grok",
          snapshot: { state: "available" },
          capabilities: { computerMcp: true, browserMcp: true },
        } as InstanceInfo],
      },
      dispatch: vi.fn(),
    }),
  };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({
    capabilities: {
      dictation: { available: false },
      host: { packaged: true, platform: "darwin" },
      localComputer: { available: true, support: "supported", enabled: true, status: "enabled" },
    },
    ready: true,
  }),
}));

const { PlaceChip } = await import("./PlaceChip");
afterAll(() => vi.unstubAllGlobals());

const bot = {
  id: "bot",
  threadId: "thread",
  name: "Rio",
  title: "",
  description: "",
  color: "green",
  notifications: true,
  unread: false,
  busy: false,
  messages: [],
  computer: "local",
  modelSelection: { instanceId: "test", model: "grok-4.6" },
} as Bot;

describe("PlaceChip composer trigger", () => {
  it("is icon-only, with the place name in the accessible name and tooltip", () => {
    const html = renderToStaticMarkup(createElement(PlaceChip, {
      bot,
      live: false,
      onPin: () => {},
    } satisfies ComponentProps<typeof PlaceChip>));
    expect(html).toContain('data-testid="place-chip"');
    expect(html).toContain('aria-label="Where this conversation works: This computer"');
    expect(html).toContain("This computer — From this bot&#x27;s Works on setting");
    expect(html).not.toMatch(/<span class="truncate">This computer<\/span>/);
  });
});
