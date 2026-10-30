import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestKey } from "./key.ts";
import type { Recipe } from "./rules.ts";
import { MAX_RECIPES, RecipeStore, UNUSED_MS } from "./store.ts";

const recipe = (id: string, key: string, lastUsedAt = 1_000): Recipe => ({
  id,
  key,
  request: key,
  steps: [{ tool: "launch_app", args: { name: "Notes" }, app: { name: "Notes" } }],
  createdAt: 1_000,
  lastUsedAt,
});

describe("RecipeStore", () => {
  let dir: string;
  let clock: number;
  let store: RecipeStore;
  const file = () => join(dir, "b1", "saved-steps.json");
  const onDisk = () => JSON.parse(readFileSync(file(), "utf8")) as { version: number; recipes: Recipe[] };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "saved-steps-store-"));
    clock = 5_000;
    store = new RecipeStore({ folder: (botId) => join(dir, botId), now: () => clock });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("saves and finds by key, in a 0600 file", () => {
    store.save("b1", recipe("r1", "open notes"));
    expect(store.find("b1", "open notes")!.id).toBe("r1");
    expect(store.find("b1", "other")).toBeUndefined();
    expect(store.find("b2", "open notes")).toBeUndefined();
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("replaces the recipe for the same key", () => {
    store.save("b1", recipe("r1", "open notes"));
    store.save("b1", recipe("r2", "open notes"));
    expect(store.find("b1", "open notes")!.id).toBe("r2");
    expect(onDisk().recipes.map((r) => r.id)).toEqual(["r2"]);
  });

  it("keeps the 200 most recently used", () => {
    for (let i = 0; i <= MAX_RECIPES; i++) store.save("b1", recipe(`r${i}`, `key ${i}`, 1_000 + i));
    expect(onDisk().recipes).toHaveLength(MAX_RECIPES);
    expect(store.find("b1", "key 0")).toBeUndefined();
    expect(store.find("b1", "key 1")!.id).toBe("r1");
    expect(store.find("b1", `key ${MAX_RECIPES}`)!.id).toBe(`r${MAX_RECIPES}`);
  });

  it("drops a recipe unused for 60 days", () => {
    store.save("b1", recipe("r1", "open notes", 1_000));
    clock = 1_000 + UNUSED_MS;
    expect(store.find("b1", "open notes")!.id).toBe("r1");
    clock = 1_000 + UNUSED_MS + 1;
    expect(store.find("b1", "open notes")).toBeUndefined();
    store.save("b1", recipe("r2", "open mail", clock));
    expect(onDisk().recipes.map((r) => r.id)).toEqual(["r2"]);
  });

  it("touch moves lastUsedAt to now", () => {
    store.save("b1", recipe("r1", "open notes", 1_000));
    clock = 9_000;
    store.touch("b1", "r1");
    expect(store.find("b1", "open notes")!.lastUsedAt).toBe(9_000);
    expect(onDisk().recipes[0]!.lastUsedAt).toBe(9_000);
  });

  it("forget answers whether it removed something", () => {
    store.save("b1", recipe("r1", "open notes"));
    expect(store.forget("b1", "r1")).toBe(true);
    expect(store.forget("b1", "r1")).toBe(false);
    expect(store.find("b1", "open notes")).toBeUndefined();
    expect(onDisk().recipes).toEqual([]);
  });

  it("reads a corrupt or other-version file as empty and rewrites it on save", () => {
    mkdirSync(join(dir, "b1"));
    writeFileSync(file(), "{nope");
    expect(store.find("b1", "open notes")).toBeUndefined();
    expect(store.forget("b1", "r1")).toBe(false);
    store.save("b1", recipe("r1", "open notes"));
    expect(onDisk().version).toBe(1);
    expect(store.find("b1", "open notes")!.id).toBe("r1");
    writeFileSync(file(), JSON.stringify({ version: 2, recipes: [recipe("r1", "open notes")] }));
    expect(store.find("b1", "open notes")).toBeUndefined();
  });

  it("drops malformed recipes and keeps the rest", () => {
    mkdirSync(join(dir, "b1"));
    const bad = { ...recipe("r1", "open notes"), steps: "x" };
    writeFileSync(file(), JSON.stringify({ version: 1, recipes: [bad, recipe("r2", "open mail")] }));
    expect(store.find("b1", "open notes")).toBeUndefined();
    expect(store.find("b1", "open mail")!.id).toBe("r2");
  });

  it("drops recipes whose step args carry addressing, pixels or keys outside the tool's list", () => {
    mkdirSync(join(dir, "b1"));
    const withArgs = (id: string, key: string, args: Record<string, unknown>): Recipe => {
      const base = recipe(id, key);
      return { ...base, steps: [{ tool: "click", args, app: { name: "Notes" }, element: { role: "AXButton", label: "New", path: [] } }] };
    };
    writeFileSync(file(), JSON.stringify({
      version: 1,
      recipes: [
        withArgs("r1", "with x", { x: 4, y: 5 }),
        withArgs("r2", "with token", { element_token: "t" }),
        withArgs("r3", "with stray", { text: "hi" }),
        withArgs("r4", "fine", { button: "left" }),
      ],
    }));
    expect(store.find("b1", "with x")).toBeUndefined();
    expect(store.find("b1", "with token")).toBeUndefined();
    expect(store.find("b1", "with stray")).toBeUndefined();
    expect(store.find("b1", "fine")!.id).toBe("r4");
  });

  it("drops element steps saved without their element or app and keeps the rest of the file", () => {
    mkdirSync(join(dir, "b1"));
    const app = { name: "Notes" };
    const element = { role: "AXButton", label: "New", path: [] };
    const withStep = (id: string, step: Recipe["steps"][number]): Recipe => ({ ...recipe(id, id), steps: [step] });
    writeFileSync(file(), JSON.stringify({
      version: 1,
      recipes: [
        withStep("no element", { tool: "click", args: {}, app }),
        withStep("no app", { tool: "click", args: {}, element }),
        withStep("neither", { tool: "set_value", args: { value: "hi" } }),
        withStep("both", { tool: "click", args: {}, app, element }),
        withStep("key alone", { tool: "press_key", args: { key: "return" } }),
        withStep("key to an app", { tool: "hotkey", args: { keys: ["cmd", "w"] }, app }),
        withStep("key to a window", { tool: "hotkey", args: { keys: ["cmd", "w"] }, app, window: { title: "Invoice" } }),
      ],
    }));
    expect(store.find("b1", "no element")).toBeUndefined();
    expect(store.find("b1", "no app")).toBeUndefined();
    expect(store.find("b1", "neither")).toBeUndefined();
    expect(store.find("b1", "both")!.id).toBe("both");
    expect(store.find("b1", "key alone")).toBeUndefined();
    expect(store.find("b1", "key to an app")).toBeUndefined();
    expect(store.find("b1", "key to a window")!.id).toBe("key to a window");
  });

  it("drops key and element steps scoped wider than their window and keeps the rest of the file", () => {
    mkdirSync(join(dir, "b1"));
    const app = { name: "Notes" };
    const element = { role: "AXButton", label: "New", path: [] };
    const withStep = (id: string, step: Recipe["steps"][number]): Recipe => ({ ...recipe(id, id), steps: [step] });
    writeFileSync(file(), JSON.stringify({
      version: 1,
      recipes: [
        withStep("desktop click", { tool: "click", args: { scope: "desktop" }, app, element }),
        withStep("screen scroll", { tool: "scroll", args: { direction: "down", scope: "screen" }, app, element }),
        withStep("null scope", { tool: "click", args: { scope: null }, app, element }),
        withStep("desktop hotkey", { tool: "hotkey", args: { keys: ["cmd", "s"], scope: "desktop" }, app }),
        withStep("desktop key", { tool: "press_key", args: { key: "return", scope: "desktop" }, app }),
        withStep("window click", { tool: "click", args: { scope: "window" }, app, element }),
        withStep("window hotkey", { tool: "hotkey", args: { keys: ["cmd", "s"], scope: "window" }, app, window: { title: "Notes" } }),
        withStep("unscoped key", { tool: "press_key", args: { key: "return" }, app, window: { title: "Notes" } }),
      ],
    }));
    for (const dropped of ["desktop click", "screen scroll", "null scope", "desktop hotkey", "desktop key"]) expect(store.find("b1", dropped)).toBeUndefined();
    for (const kept of ["window click", "window hotkey", "unscoped key"]) expect(store.find("b1", kept)!.id).toBe(kept);
  });

  it("drops a recipe that types words its stored request does not hold word for word", () => {
    mkdirSync(join(dir, "b1"));
    const app = { name: "Notes" };
    const element = { role: "AXTextArea", label: "Body", path: [] };
    const keyed = (id: string, request: string): Recipe => ({ ...recipe(id, requestKey(request) || id), request });
    const typing = (id: string, request: string, value: string): Recipe => ({ ...keyed(id, request), steps: [{ tool: "set_value", args: { value }, app, element }] });
    const opening = (id: string, request: string): Recipe => ({ ...keyed(id, request), steps: [{ tool: "launch_app", args: { name: "Safari", urls: ["https://example.com"] } }] });
    const written = [
      typing("no request", "", "hi"), typing("loose spacing", "type  hey", "hey"), typing("other words", "type hello", "hi"),
      typing("fits", "type hi", "hi"), opening("link elsewhere", "open safari"), opening("link", "open https://example.com"),
    ];
    writeFileSync(file(), JSON.stringify({ version: 1, recipes: written }));
    const found = (id: string) => store.find("b1", written.find((entry) => entry.id === id)!.key)?.id;
    for (const dropped of ["no request", "loose spacing", "other words", "link elsewhere"]) expect(found(dropped)).toBeUndefined();
    for (const kept of ["fits", "link"]) expect(found(kept)).toBe(kept);
  });

  it("drops a recipe whose key is not its request's key under today's normalising", () => {
    mkdirSync(join(dir, "b1"));
    const keyedBeforeSymbolsCounted = { ...recipe("old", "open the c tab"), request: "open the C++ tab" };
    const keyedNow = { ...recipe("new", "open the c++ tab"), request: "open the C++ tab" };
    writeFileSync(file(), JSON.stringify({ version: 1, recipes: [keyedBeforeSymbolsCounted, recipe("plain", "open notes")] }));
    expect(store.find("b1", "open the c tab")).toBeUndefined();
    expect(store.find("b1", "open notes")!.id).toBe("plain");
    writeFileSync(file(), JSON.stringify({ version: 1, recipes: [keyedNow] }));
    expect(store.find("b1", requestKey("open the C++ tab"))!.id).toBe("new");
  });

  it("drops typing and steps that flip a toggle", () => {
    mkdirSync(join(dir, "b1"));
    const app = { name: "TextEdit" };
    const withStep = (id: string, step: unknown): Recipe => ({ ...recipe(id, id), request: id, steps: [step as Recipe["steps"][number]] });
    writeFileSync(file(), JSON.stringify({
      version: 1,
      recipes: [
        withStep("type hi", { tool: "type_text", args: { text: "hi" }, app, element: { role: "AXTextArea", label: "Body", path: [] } }),
        withStep("tick", { tool: "click", args: {}, app, element: { role: "AXCheckBox", label: "Bold", path: [] } }),
        withStep("menu", { tool: "right_click", args: {}, app, element: { role: "AXCheckBox", label: "Bold", path: [] } }),
      ],
    }));
    expect(store.find("b1", "type hi")).toBeUndefined();
    expect(store.find("b1", "tick")).toBeUndefined();
    expect(store.find("b1", "menu")!.id).toBe("menu");
  });

  it("drops steps that press a final action, touch a secret field or open a second copy of an app, and keeps the rest", () => {
    mkdirSync(join(dir, "b1"));
    const app = { name: "Mail" };
    const withStep = (id: string, step: unknown): Recipe => ({ ...recipe(id, id), request: id, steps: [step as Recipe["steps"][number]] });
    writeFileSync(file(), JSON.stringify({
      version: 1,
      recipes: [
        withStep("send", { tool: "click", args: {}, app, window: { title: "New Message" }, element: { role: "AXButton", label: "Senden", path: [] } }),
        withStep("in checkout", { tool: "click", args: {}, app, window: { title: "Checkout" }, element: { role: "AXButton", label: "Next", path: [] } }),
        withStep("password", { tool: "click", args: {}, app, window: { title: "Sign in" }, element: { role: "AXSecureTextField", label: "Password", path: [] } }),
        withStep("delete key", { tool: "press_key", args: { key: "delete" }, app, window: { title: "Inbox" } }),
        withStep("second copy", { tool: "launch_app", args: { name: "Mail", creates_new_application_instance: true } }),
        withStep("open mail", { tool: "launch_app", args: { name: "Mail" } }),
      ],
    }));
    for (const dropped of ["send", "in checkout", "password", "delete key", "second copy"]) expect(store.find("b1", dropped), dropped).toBeUndefined();
    expect(store.find("b1", "open mail")!.id).toBe("open mail");
  });

  it("refuses a bot id that is not a single folder name", () => {
    for (const botId of ["../x", "a/b", "a\\b", "..", ""]) {
      store.save(botId, recipe("r1", "open notes"));
      expect(store.find(botId, "open notes")).toBeUndefined();
      expect(store.forget(botId, "r1")).toBe(false);
    }
    expect(existsSync(join(dir, "x"))).toBe(false);
    expect(existsSync(join(dirname(dir), "x"))).toBe(false);
  });
});
