// @vitest-environment happy-dom
import { Buffer } from "node:buffer";
import { Window, DOMRect, type Element } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Tab } from "../tabs.ts";
import { inspectBrowserElement } from "./inspect-element.ts";

afterEach(() => vi.unstubAllGlobals());

async function inspect(html: string, setup?: (root: Element) => void) {
  const doc = new Window().document;
  const root = doc.createElement("section");
  doc.body.append(root);
  root.innerHTML = html;
  setup?.(root);
  const selected = root.firstElementChild!;
  vi.spyOn(selected, "getBoundingClientRect").mockReturnValue(
    new DOMRect(5, 6, 20, 30),
  );
  Object.defineProperty(doc, "elementFromPoint", { value: () => selected });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("innerWidth", 100);
  vi.stubGlobal("innerHeight", 100);
  vi.stubGlobal("scrollX", 0);
  vi.stubGlobal("scrollY", 0);
  vi.stubGlobal("location", {
    href: "https://example.test/page?token=fixture-only#private",
  });
  const evaluate = vi.fn(async (expression: string) =>
    Function("return " + expression)(),
  );
  const screenshot = vi.fn(async () => ({ data: Buffer.from("fixture") }));
  const push = vi.fn();
  await inspectBrowserElement(
    { push },
    { page: { evaluate, screenshot } } as unknown as Tab,
    { requestId: "privacy-1", x: 10, y: 12, capture: true },
  );
  return { push, screenshot };
}

it.each([
  '<input value="fixture-secret">',
  "<textarea>fixture-secret</textarea>",
  "<select><option>fixture-secret</option></select>",
  "<iframe></iframe>",
  "<article data-private>fixture-secret</article>",
  "<article data-sensitive>fixture-secret</article>",
  '<article contenteditable="true">fixture-secret</article>',
  "<article contenteditable>fixture-secret</article>",
  '<article contenteditable="plaintext-only">fixture-secret</article>',
  "<article><section contenteditable>fixture-secret</section></article>",
  '<article><input value="fixture-secret"></article>',
])("refuses editable or sensitive DOM selections: %s", async (html) => {
  const f = await inspect(html);
  expect(f.screenshot).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledWith(
    expect.objectContaining({
      error: "Select a smaller element without private or editable content.",
    }),
  );
  expect(JSON.stringify(f.push.mock.calls)).not.toContain("fixture-secret");
});

it("removes query, fragment and URL credentials from public element metadata", async () => {
  const f = await inspect("<h1>Public heading</h1>");
  expect(f.screenshot).toHaveBeenCalledOnce();
  const reply = f.push.mock.calls[0][0];
  expect(reply.element.url).toBe("https://example.test/page");
  expect(reply.element.label).toBe("Public heading");
});

const privacyError =
  "Select a smaller element without private or editable content.";

it.each(["data-private", "data-sensitive", "contenteditable"])(
  "refuses a %s sibling overlapping the selected clip away from the pointer",
  async (attribute) => {
    const f = await inspect(
      `<article>Public</article><aside ${attribute}>fixture-secret</aside>`,
      (root) => {
        vi.spyOn(root.children[1], "getBoundingClientRect").mockReturnValue(
          new DOMRect(20, 20, 10, 10),
        );
      },
    );
    expect(f.screenshot).not.toHaveBeenCalled();
    expect(f.push).toHaveBeenCalledWith(
      expect.objectContaining({ error: privacyError }),
    );
    expect(JSON.stringify(f.push.mock.calls)).not.toContain("fixture-secret");
  },
);

it("refuses a selection inside a private shadow host", async () => {
  const f = await inspect("<article data-private></article>", (root) => {
    const host = root.firstElementChild!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<h1>fixture-secret</h1>";
    const child = shadow.firstElementChild!;
    vi.spyOn(child, "getBoundingClientRect").mockReturnValue(
      new DOMRect(5, 6, 20, 30),
    );
    Object.defineProperty(shadow, "elementFromPoint", { value: () => child });
  });
  expect(f.screenshot).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledWith(
    expect.objectContaining({ error: privacyError }),
  );
});

it("refuses private descendants inside an open shadow root", async () => {
  const f = await inspect("<article>Public</article>", (root) => {
    const shadow = root.firstElementChild!.attachShadow({ mode: "open" });
    shadow.innerHTML = "<section data-sensitive>fixture-secret</section>";
  });
  expect(f.screenshot).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledWith(
    expect.objectContaining({ error: privacyError }),
  );
});

it("refuses an overlapping child of a private sibling with an empty wrapper rectangle", async () => {
  const f = await inspect(
    "<article>Public</article><aside data-private><p>fixture-secret</p></aside>",
    (root) => {
      vi.spyOn(
        root.children[1].firstElementChild!,
        "getBoundingClientRect",
      ).mockReturnValue(new DOMRect(20, 20, 10, 10));
    },
  );
  expect(f.screenshot).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledWith(
    expect.objectContaining({ error: privacyError }),
  );
});

it("allows a sensitive sibling outside the clip", async () => {
  const f = await inspect(
    "<article>Public</article><aside data-private>fixture-secret</aside>",
    (root) => {
      vi.spyOn(root.children[1], "getBoundingClientRect").mockReturnValue(
        new DOMRect(60, 60, 10, 10),
      );
    },
  );
  expect(f.screenshot).toHaveBeenCalledOnce();
});

it("refuses pages that exceed the privacy scan budget", async () => {
  const f = await inspect("<article>Public</article>" + "<p></p>".repeat(5000));
  expect(f.screenshot).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledWith(
    expect.objectContaining({ error: privacyError }),
  );
});
