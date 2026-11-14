// @vitest-environment happy-dom
// The settings search keeps looking until every app-name source (connector inventory, app catalog, Email) has answered.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  holdCatalog: false,
  answerCatalog: null as null | ((ok: boolean) => void),
  answerEmail: null as null | ((ok: boolean) => void),
}));
vi.mock("@/lib/connected-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connected-apps")>()),
  preloadConnectedApps: () => Promise.resolve({ authoritative: true, services: { github: { connected: true } } }),
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  const api = (path: string) => {
    if (path === "/api/connectors/catalog") {
      if (!fixture.holdCatalog) return Promise.resolve({ cards: [] });
      return new Promise((resolve, reject) => {
        fixture.answerCatalog = (ok) => (ok ? resolve({ cards: [] }) : reject(new Error("down")));
      });
    }
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

function Probe({ bot, load }: { bot: Bot; load: boolean }) {
  const apps = useBotApps(bot, load);
  return createElement("p", null, `${appSearchPhase(apps)}:${apps.apps.map((app) => app.slug).join(",")}`);
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const bot = { id: "scout" } as Bot;
const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
function render(load = true) {
  if (!host) {
    setLocale("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  flushSync(() => root!.render(createElement(Probe, { bot, load })));
  return host;
}

afterEach(() => {
  root?.unmount();
  host?.remove();
  host = null;
  root = null;
  fixture.holdCatalog = false;
  fixture.answerCatalog = null;
  fixture.answerEmail = null;
});

describe("app names for the settings search", () => {
  // Runs first: the app catalog is cached once it loads, and only a failed load is asked again.
  it("stays loading while the app catalog has not answered, and stops when it fails", async () => {
    fixture.holdCatalog = true;
    const view = render();
    await settle();
    fixture.answerEmail?.(true);
    await settle();
    expect(view.textContent).toBe("loading:email,github");
    fixture.answerCatalog?.(false);
    await settle();
    expect(view.textContent).toBe("ready:email,github");
  });

  it("stays loading while Email has not answered, even once the other apps are in", async () => {
    const view = render();
    await settle();
    expect(view.textContent).toBe("loading:github");
    fixture.answerEmail?.(true);
    await settle();
    expect(view.textContent).toBe("ready:email,github");
  });

  it("stops loading when the Email lookup fails", async () => {
    const view = render();
    await settle();
    fixture.answerEmail?.(false);
    await settle();
    expect(view.textContent).toBe("ready:github");
  });

  it("is loading again while a new lookup runs after an earlier one failed", async () => {
    const view = render();
    await settle();
    fixture.answerEmail?.(false);
    await settle();
    expect(view.textContent).toBe("ready:github");
    render(false);
    render(true);
    await settle();
    expect(view.textContent).toBe("loading:github");
    fixture.answerEmail?.(true);
    await settle();
    expect(view.textContent).toBe("ready:email,github");
  });
});
