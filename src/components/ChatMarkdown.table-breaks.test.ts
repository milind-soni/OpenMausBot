// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { ChatMarkdown } from "./ChatMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.restoreAllMocks());

const table = (value: string) => `| Result |\n| --- |\n| ${value} |`;
const render = (text: string) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(createElement(ChatMarkdown, { text }));
  return host;
};

it.each(["<br>", "<br/>", "<br />", "<BR>"])("renders %s as a line break inside a table cell", (tag) => {
  const cell = render(table(`Score: 8.8 / 10${tag}Details`)).querySelector("td")!;
  expect(cell.querySelectorAll("br")).toHaveLength(1);
  expect(cell.querySelector("br")?.nextSibling?.textContent).toBe("Details");
  expect(cell.textContent).not.toContain(tag);
  expect(cell.textContent).toContain("Score: 8.8 / 10");
  expect(cell.textContent).toContain("Details");
});

it("also breaks a table heading without losing its emphasis", () => {
  const cell = render("| **Score**<br>out of ten |\n| --- |\n| 8.8 |").querySelector("th")!;
  expect(cell.querySelectorAll("br")).toHaveLength(1);
  expect(cell.querySelector("br")?.nextSibling?.textContent).toBe("out of ten");
  expect(cell.querySelector("strong")?.textContent).toBe("Score");
  expect(cell.textContent).toContain("out of ten");
});

it("breaks inside emphasis while keeping that emphasis in the cell", () => {
  const strong = render(table("**First<br>Second**")).querySelector("td strong")!;
  expect(strong.querySelectorAll("br")).toHaveLength(1);
  expect(strong.querySelector("br")?.nextSibling?.textContent).toBe("Second");
  expect(strong.textContent).toContain("Second");
});

it("keeps code, escaped tags, attributes, and other HTML inert", () => {
  const value = '`<br>` &lt;br&gt; \\<br> <br onclick="bad()"> <img src=x onerror="bad()"> <script>bad()</script>';
  const cell = render(table(value)).querySelector("td")!;
  expect(cell.querySelector("br, img, script, [onclick], [onerror]")).toBeNull();
  expect(cell.querySelector("code")?.textContent).toBe("<br>");
  expect(cell.textContent).toContain('<br onclick="bad()">');
  expect(render('```html\n<br>\n```').querySelector("pre")?.textContent).toContain("<br>");
});

it("keeps HTML outside table cells as source text", () => {
  const host = render("Before<br>After");
  expect(host.querySelector("br")).toBeNull();
  expect(host.textContent).toBe("Before<br>After");
});

it("keeps the existing rendering of Markdown line breaks outside tables", () => {
  const host = render("Before  \nAfter");
  expect(host.querySelectorAll("br")).toHaveLength(1);
  expect(host.querySelector("br")?.nextSibling?.textContent).toBe("\nAfter");
});

it.each([
  ["First<br>Second", "First\nSecond"],
  ["First<br/><br/>Second", "First\n\nSecond"],
  ["**First**<br />[Second](https://example.test)", "First\nSecond"],
  ["**First<br />Second**", "First\nSecond"],
])("copies the visible line breaks from %s without extra blank lines", async (source, copied) => {
  setLocale("en");
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ChatMarkdown, { text: table(source) })));
    const content = host.querySelector("td .whitespace-pre-wrap")!.cloneNode(true) as HTMLElement;
    for (const br of content.querySelectorAll("br")) br.replaceWith(document.createTextNode("\n"));
    expect(content.textContent).toBe(copied);
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Copy table"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(writeText).toHaveBeenCalledWith(`Result\r\n"${copied}"`);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
