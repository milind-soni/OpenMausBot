// @vitest-environment happy-dom
// The settings search keeps looking until both app-name sources (connector inventory and Email) have answered.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ answerEmail: null as null | ((ok: boolean) => void) }));
vi.mock("@/lib/connected-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connected-apps")>()),
  preloadConnectedApps: () => Promise.resolve({ authoritative: true, services: { github: { connected: true } } }),
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  const api = (path: string) => {
    if (path === "/api/connectors/catalog") return Promise.resolve({ cards: [] });
    if (path === "/api/email") {
      return new Promise((resolve, reject) => {
        fixture.answerEmail = (ok) => (ok ? resolve({ state: "connected", accounts: [{ address: "ana@example.test" }] }) : reject(new Error("down")));
      });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  };
  return { ...original, api };
});

const { useBotApps } = await import("./useBotApps");
const { appSearchPhase } = await import("./sections");

function Probe({ bot }: { bot: Bot }) {
  const apps = useBotApps(bot, true);
  return createElement("p", null, `${appSearchPhase(apps)}:${apps.apps.map((app) => app.slug).join(",")}`);
}

let host: HTMLDivElement;
let root: Root;
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  setLocale("en");
  fixture.answerEmail = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(Probe, { bot: { id: "scout" } as Bot })));
});
afterEach(() => {
  root.unmount();
  host.remove();
});

describe("app names for the settings search", () => {
  it("stays loading while Email has not answered, even once the other apps are in", async () => {
    await settle();
    expect(host.textContent).toBe("loading:github");
    fixture.answerEmail?.(true);
    await settle();
    expect(host.textContent).toBe("ready:email,github");
  });

  it("stops loading when the Email lookup fails", async () => {
    await settle();
    fixture.answerEmail?.(false);
    await settle();
    expect(host.textContent).toBe("ready:github");
  });
});
