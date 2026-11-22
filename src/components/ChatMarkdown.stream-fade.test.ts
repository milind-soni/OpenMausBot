// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";
import { StreamingReplyContext } from "@/state/live-reply";

vi.mock("@/lib/interface-mode", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
  readAdvancedMode: () => true,
}));

const { ChatMarkdown } = await import("./ChatMarkdown");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a streaming reply fades in what arrives", () => {
  let host: HTMLDivElement;
  let root: Root;
  let faded: string[];
  let reduced: boolean;
  const draw = (text: string, streaming = true) =>
    act(() => root.render(createElement(StreamingReplyContext, { value: streaming }, createElement(ChatMarkdown, { text }))));
  const take = () => faded.splice(0);

  beforeEach(() => {
    setLocale("en");
    faded = [];
    reduced = false;
    vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(function (this: HTMLElement) {
      faded.push(`${this.tagName.toLowerCase()}:${this.textContent}`);
      return {} as Animation;
    });
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: reduced && query.includes("reduce") }) as MediaQueryList);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("fades each new block in once, as it arrives", () => {
    draw("First paragraph ");
    expect(take(), "the reply's first draw fades in as one").toEqual(["div:First paragraph"]);
    draw("First paragraph grows ");
    expect(take(), "words added to a shown block do not play it again").toEqual([]);
    draw("First paragraph grows\n\nSecond ");
    expect(take(), "the first block, now finished and drawn anew, does not play again").toEqual(["p:Second"]);
  });

  it("fades a list in item by item and a table row by row", () => {
    draw("Steps:\n\n");
    expect(take()).toEqual(["div:Steps:"]);
    draw("Steps:\n\n- one\n");
    expect(take()).toEqual(["li:one"]);
    draw("Steps:\n\n- one\n- two\n");
    expect(take()).toEqual(["li:two"]);
    draw("Steps:\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
    expect(take().filter((each) => each.startsWith("tr:"))).toEqual(["tr:ab", "tr:12"]);
  });

  it("fades a new block in before the footnotes, not the footnotes again", () => {
    draw("A claim.[^1]\n\n[^1]: The source.\n");
    take();
    draw("A claim.[^1]\n\nMore detail.\n\n[^1]: The source.\n");
    expect(take()).toEqual(["p:More detail."]);
  });

  it("fades a reply opened mid-stream in once as a whole, not block by block", () => {
    draw("One.\n\nTwo.\n\n- three\n- four\n");
    expect(take().map((each) => each.split(":")[0]), "one fade for the reply, none for its blocks").toEqual(["div"]);
  });

  it("leaves a finished reply, and anyone who asks for less motion, without a fade", () => {
    draw("A saved reply.\n\nWith two blocks.", false);
    expect(take()).toEqual([]);
    reduced = true;
    act(() => root.unmount());
    root = createRoot(host);
    draw("Streaming for someone who asked for less motion ");
    expect(take()).toEqual([]);
  });

  it("leaves the reply still when the app is set to less motion, whatever the system asks", () => {
    document.documentElement.dataset.reducedMotion = "true";
    try {
      draw("Streaming with the app set to less motion ");
      expect(take()).toEqual([]);
    } finally {
      delete document.documentElement.dataset.reducedMotion;
    }
  });
});
