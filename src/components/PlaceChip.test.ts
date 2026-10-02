import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

vi.stubGlobal("window", {});
const fixture = vi.hoisted(() => ({ config: null as unknown, menuOpen: false }));
// Static markup never runs the click that opens the menu; this renders it open.
vi.mock("./MenuMotion", async (importOriginal) => ({
  ...await importOriginal<typeof import("./MenuMotion")>(),
  useMenuMotion: () => ({ shown: fixture.menuOpen, closing: false, className: "", exitProps: {} }),
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        config: fixture.config ?? original.initialState.config,
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

const { PlaceChip, usePlaceAvailability } = await import("./PlaceChip");
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

describe("the menu's first row", () => {
  afterEach(() => { fixture.menuOpen = false; });
  /** The open menu's radio rows: whether each is checked, and its words. */
  const rows = (props: Partial<ComponentProps<typeof PlaceChip>>) => {
    fixture.menuOpen = true;
    const html = renderToStaticMarkup(createElement(PlaceChip, { bot, live: false, onPin: () => {}, ...props }));
    return {
      html,
      rows: html.split('role="menuitemradio"').slice(1).map((row) => ({
        checked: row.startsWith(' aria-checked="true"'),
        text: row.slice(row.indexOf(">") + 1, row.indexOf("</button>"))
          .replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim(),
      })),
    };
  };

  it("is Auto itself for a bot on Auto, selected while the conversation has no pin", () => {
    const { html, rows: menu } = rows({ bot: { ...bot, computer: undefined } });
    expect(menu[0]).toEqual({ checked: true, text: "Auto Picks the right place for each task" });
    expect(html).not.toContain("Follow this bot");
    expect(html).toContain('aria-label="Where this conversation works: Auto"');
    // Auto once, then the four places as before: no second Auto row.
    expect(menu).toHaveLength(5);
    expect(menu.filter((row) => row.text.startsWith("Auto"))).toHaveLength(1);
  });

  it("stays Auto, unchecked, when the conversation is pinned elsewhere", () => {
    const { html, rows: menu } = rows({ bot: { ...bot, computer: undefined }, task: { surface: "vm" } });
    expect(menu[0]).toEqual({ checked: false, text: "Auto Picks the right place for each task" });
    expect(menu.find((row) => row.checked)?.text).toBe("Local VM Isolated local desktop");
    expect(html).toContain('aria-label="Where this conversation works: Local VM"');
  });

  it("keeps following the bot's setting when the bot works on a specific place", () => {
    const { html, rows: menu } = rows({ bot: { ...bot, computer: "local" } });
    expect(menu[0]).toEqual({ checked: true, text: "Follow this bot's setting Currently This computer" });
    expect(html).not.toContain("Picks the right place for each task");
  });
});

describe("the places a conversation can be pinned to", () => {
  const availability = () => {
    let seen: ReturnType<typeof usePlaceAvailability> | undefined;
    function Probe() { seen = usePlaceAvailability(bot); return null; }
    renderToStaticMarkup(createElement(Probe));
    return seen!;
  };
  afterEach(() => { fixture.config = null; });

  it("reaches this computer and a Local VM on a desktop or self-hosted server", () => {
    expect(availability()).toMatchObject({ cloud: true, vm: true, local: true });
  });

  it("never reaches them on an OMB Cloud home", () => {
    fixture.config = { cloudHome: true };
    expect(availability()).toMatchObject({ cloud: true, vm: false, local: false });
  });
});
