import { beforeEach, describe, expect, it, vi } from "vitest";

// A tiny hook runtime: state slots that survive renders, and effects that run when their dependencies change.
const runtime = vi.hoisted(() => ({
  slots: [] as unknown[],
  deps: [] as Array<unknown[] | undefined>,
  index: 0,
  effect: 0,
}));

vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const i = runtime.index++;
    if (!(i in runtime.slots)) runtime.slots[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [runtime.slots[i], (next: unknown) => { runtime.slots[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(runtime.slots[i]) : next; }];
  },
  useEffect: (run: () => void, deps?: unknown[]) => {
    const i = runtime.effect++;
    const previous = runtime.deps[i];
    if (!previous || !deps || deps.some((dep, at) => dep !== previous[at])) {
      runtime.deps[i] = deps;
      run();
    }
  },
}));

const { forgetSearchDisclosuresForTests, searchMatchesThreads, setSidebarCollapsedAll, useSearchDisclosure } = await import("./search-disclosure");
const { SIDEBAR_COLLAPSED_ALL_KEY } = await import("./sidebar-preferences");

/** Renders twice so an effect's state change is visible, as React would show it. */
const row = (key: string, initial = false) => (query: string, matches: boolean) => {
  let result!: ReturnType<typeof useSearchDisclosure>;
  for (let pass = 0; pass < 2; pass++) {
    runtime.index = 0;
    runtime.effect = 0;
    result = useSearchDisclosure(key, query, matches, initial);
  }
  return result;
};

const store = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });

beforeEach(() => {
  store.clear();
  runtime.slots = [];
  runtime.deps = [];
  forgetSearchDisclosuresForTests();
});

describe("sidebar search disclosure (MOCA-293)", () => {
  it("opens only rows with a matching thread, and clearing puts every row back", () => {
    const writer = row("bot:writer");
    const [, open] = writer("", false);
    open(true);
    expect(writer("", false)[0]).toBe(true);
    expect(writer("post", true)[0]).toBe(true);
    expect(writer("", false)[0]).toBe(true);

    runtime.slots = [];
    runtime.deps = [];
    const chief = row("bot:chief");
    expect(chief("", false)[0]).toBe(false);
    expect(chief("post", false)[0]).toBe(false);
    expect(chief("", false)[0]).toBe(false);

    runtime.slots = [];
    runtime.deps = [];
    const brand = row("bot:brand");
    expect(brand("", false)[0]).toBe(false);
    expect(brand("post", true)[0]).toBe(true);
    expect(brand("", false)[0]).toBe(false);
  });

  it("keeps a row's own state across the remount a search causes", () => {
    const first = row("bot:cosmo");
    first("", false)[1](true);
    runtime.slots = [];
    runtime.deps = [];
    expect(row("bot:cosmo")("", false)[0]).toBe(true);
  });

  it("lets the person toggle a row during a search until the query changes", () => {
    const scout = row("bot:scout");
    scout("", false);
    scout("post", true)[1](false);
    expect(scout("post", true)[0]).toBe(false);
    expect(scout("posts", true)[0]).toBe(true);
    expect(scout("", false)[0]).toBe(false);
  });

  it("restores a selected room's explicit closed choice after search remounts it", () => {
    const room = row("group:engineering", true);
    expect(room("", false)[0]).toBe(true);
    room("", false)[1](false);
    runtime.slots = [];
    runtime.deps = [];
    expect(row("group:engineering", true)("", false)[0]).toBe(false);
  });

  it("matches thread titles and folders, not routine runs", () => {
    const tasks = [{ title: "LinkedIn post: launch story" }, { title: "post run", routineRunId: "r1" }];
    expect(searchMatchesThreads("POST", tasks)).toBe(true);
    expect(searchMatchesThreads("post run", tasks)).toBe(false);
    expect(searchMatchesThreads("launch", [], [{ name: "Launch week" }])).toBe(true);
    expect(searchMatchesThreads("  ", tasks)).toBe(false);
  });
});

describe("sidebar collapse all", () => {
  const mount = (key: string, initial = false) => {
    runtime.slots = [];
    runtime.deps = [];
    return row(key, initial);
  };

  it("closes and persists every row that is mounted or has a choice, then opens them again", () => {
    const first = row("bot:first", true);
    expect(first("", false)[0]).toBe(true);
    const chosen = mount("group:chosen");
    chosen("", false)[1](true);
    setSidebarCollapsedAll(true);
    expect(chosen("", false)[0]).toBe(false);
    expect(store.get(SIDEBAR_COLLAPSED_ALL_KEY)).toBe("true");
    setSidebarCollapsedAll(false);
    expect(chosen("", false)[0]).toBe(true);
    expect(store.get(SIDEBAR_COLLAPSED_ALL_KEY)).toBe("false");
  });

  it("is the default for a bot or group the person has not toggled, even one that appears later", () => {
    setSidebarCollapsedAll(true);
    expect(mount("bot:later", true)("", false)[0]).toBe(false);
    expect(mount("group:later", true)("", false)[0]).toBe(false);
  });

  it("starts from the saved value after a reload, and a person's own toggle still wins afterwards", () => {
    store.set(SIDEBAR_COLLAPSED_ALL_KEY, "true");
    forgetSearchDisclosuresForTests();
    const bot = mount("bot:reloaded", true);
    expect(bot("", false)[0]).toBe(false);
    bot("", false)[1](true);
    expect(bot("", false)[0]).toBe(true);
  });

  it("leaves a row's default alone until the person has chosen", () => {
    expect(mount("bot:plain", true)("", false)[0]).toBe(true);
    expect(mount("bot:closed")("", false)[0]).toBe(false);
  });

  it("keeps a bot that appears after Expand all open, and after a reload", () => {
    setSidebarCollapsedAll(false);
    expect(mount("bot:after-expand")("", false)[0]).toBe(true);
    expect(store.get(SIDEBAR_COLLAPSED_ALL_KEY)).toBe("false");
    forgetSearchDisclosuresForTests();
    expect(mount("bot:reloaded-open")("", false)[0]).toBe(true);
  });

  it("does not change what a search shows", () => {
    const bot = mount("bot:found");
    setSidebarCollapsedAll(true);
    expect(bot("pos", true)[0]).toBe(true);
  });
});
