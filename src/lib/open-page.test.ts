import { describe, expect, it, vi } from "vitest";

import { closePage, onPageOpened, openPage, openPageFor } from "./open-page";

describe("open page", () => {
  it("keeps one open page per chat, and only that page's close clears it", () => {
    openPage("t1", { appId: "a", rev: 0 });
    openPage("t2", { appId: "c", rev: 1 });
    openPage("t1", { appId: "b", rev: 2 });
    closePage("t1", "a");
    expect(openPageFor("t1")).toEqual({ appId: "b", rev: 2 });
    expect(openPageFor("t2")).toEqual({ appId: "c", rev: 1 });
    closePage("t1", "b");
    closePage("t2", "c");
    expect(openPageFor("t1")).toBeUndefined();
    expect(openPageFor("t2")).toBeUndefined();
  });

  it("tells open panes when another page opens, until they stop listening", () => {
    const heard = vi.fn();
    const off = onPageOpened(heard);
    openPage("t1", { appId: "a", rev: 0 });
    off();
    openPage("t1", { appId: "b", rev: 0 });
    expect(heard).toHaveBeenCalledTimes(1);
    closePage("t1", "b");
  });
});
