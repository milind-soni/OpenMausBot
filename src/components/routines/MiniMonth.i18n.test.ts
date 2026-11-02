import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { MiniMonth } from "./MiniMonth";

afterEach(() => setLocale("en"));

it.each(["en", "zh", "zh-tw"])("uses the selected %s language for miniature calendar labels", (locale) => {
  setLocale(locale);
  const html = renderToStaticMarkup(createElement(MiniMonth, { anchor: Date.UTC(2026, 10, 1, 12), onSelect: vi.fn() }));
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).toContain(locale === "en" ? "MTWTFSS" : "一二三四五六日");
  expect(html).toContain(locale === "en" ? "November 2026" : "2026年11月");
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
});
