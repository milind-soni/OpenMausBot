// @vitest-environment happy-dom
import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "@/lib/i18n";
import { memoInLocale } from "./locale-memo";

afterEach(() => { setLocale("en"); });

describe("memoInLocale", () => {
  it("holds for the same props and draws again for new props or a new language", () => {
    let drawn = 0;
    const Label = memoInLocale(function Label({ id }: { id: string }) {
      drawn += 1;
      return createElement("span", null, `${t("trace.view")} ${id}`);
    });
    let redraw!: (id: string) => void;
    function Parent() {
      const [id, setId] = useState("a");
      const [, setTick] = useState(0);
      redraw = (next) => { setId(next); setTick((tick) => tick + 1); };
      return createElement(Label, { id });
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    flushSync(() => root.render(createElement(Parent)));
    expect([drawn, host.textContent]).toEqual([1, "View trace a"]);
    flushSync(() => redraw("a"));
    expect(drawn, "same props, same language").toBe(1);
    flushSync(() => redraw("b"));
    expect([drawn, host.textContent]).toEqual([2, "View trace b"]);
    setLocale("de");
    flushSync(() => redraw("b"));
    expect(drawn).toBe(3);
    expect(host.textContent).toBe(`${t("trace.view")} b`);
    expect(host.textContent).not.toBe("View trace b");
    flushSync(() => root.unmount());
  });
});
