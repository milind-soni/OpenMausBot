// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_LIMITS } from "../../shared/app";

const folder = join(process.cwd(), "skills", "social-posts");
const template = readFileSync(join(folder, "posts.html"), "utf8");
const pageScript = [...template.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
const DATA_BLOCK = /<script id="posts-data" type="application\/json">\s*([\s\S]*?)\s*<\/script>/;

function mount(data: unknown): void {
  const json = typeof data === "string" ? data : JSON.stringify(data);
  const script = document.createElement("script");
  script.id = "posts-data";
  script.type = "application/json";
  script.textContent = json;
  document.head.replaceChildren(script);
  document.body.innerHTML = '<main id="root"></main>';
  new Function(pageScript)();
}
const post = (platforms: Record<string, unknown>, rest: Record<string, unknown> = {}) => ({ account: { name: "Ada Stone", handle: "ada" }, posts: [{ title: "T", platforms, ...rest }] });
const panel = (id: string) => document.querySelector(`[data-panel="${id}"]`)!;
const checks = (id: string) => [...panel(id).querySelectorAll(".checks li")].map((item) => item.textContent ?? "");
const warnings = (id: string) => [...panel(id).querySelectorAll(".checks li.warn")].map((item) => item.textContent ?? "");
const images = (count: number) => Array.from({ length: count }, (_, index) => ({ src: `${index}.png` }));

describe("social-posts template", () => {
  it("is self-contained, carries its licence notices and leaves room for a bot's data", () => {
    const code = template.replace(/<!--[\s\S]*?-->/, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/(?:src|href)="https?:/);
    expect(code).not.toMatch(/<script[^>]+src=|<link\b|@import/);
    expect(template).toContain("Copyright (c) 2026 Tushar Bhardwaj");
    expect(template).toContain("Lucide Contributors");
    expect(readFileSync(join(process.cwd(), "NOTICE"), "utf8")).toContain("third_party/minimock/LICENSE");
    expect(Buffer.byteLength(template)).toBeLessThan(APP_LIMITS.htmlBytes / 4);
    expect(() => JSON.parse(DATA_BLOCK.exec(template)![1]!)).not.toThrow();
  });

  it("shows the sample with one tab per platform, one card at a time, and says it is a preview", () => {
    mount(DATA_BLOCK.exec(template)![1]!);
    const tabs = [...document.querySelectorAll<HTMLElement>("[data-tab]")];
    expect(tabs.map((tab) => tab.dataset.tab)).toEqual(["instagram", "linkedin", "x", "threads", "facebook", "reels"]);
    expect(document.querySelectorAll(".card-wrap:not(.off)")).toHaveLength(1);
    tabs[1]!.click();
    expect(panel("linkedin").classList.contains("off")).toBe(false);
    expect(panel("instagram").classList.contains("off")).toBe(true);
    expect(template).toMatch(/Preview: a close likeness/);
  });

  it("counts X as X does: weighted characters, a whole emoji as 2, any link as 23", () => {
    mount(post({ x: { text: "a".repeat(280) } }));
    expect(warnings("x")).toEqual([]);
    mount(post({ x: { text: "a".repeat(281) } }));
    expect(warnings("x")[0]).toContain("281 of 280 characters: 1 over");
    mount(post({ x: { text: `${"a".repeat(278)}👨‍👩‍👧‍👦` } }));
    expect(checks("x")[0]).toContain("280 of 280");
    mount(post({ x: { text: `${"中".repeat(140)}a` } }));
    expect(warnings("x")[0]).toContain("281 of 280");
    mount(post({ x: { text: `https://example.com/${"p".repeat(400)}` } }));
    expect(checks("x")[0]).toContain("23 of 280");
  });

  it("warns past each platform's sourced limit, and never on a platform that publishes none", () => {
    mount(post({
      threads: { text: `${"a".repeat(497)}👍` },
      linkedin: { text: "a".repeat(3001), media: images(301) },
      instagram: { text: `${"#tag ".repeat(31)}${"@me ".repeat(21)}`, media: images(21) },
      x: { text: "hi", media: images(5) },
      facebook: { text: "a".repeat(70000), media: images(30) },
      tiktok: { text: "a".repeat(2201), media: [{ video: "", poster: "" }] },
      reels: { text: "a".repeat(2201), media: [{ video: "", width: 1920, height: 1080, duration: 901 }] },
      shorts: { media: [{ video: "", width: 1920, height: 1080, duration: 181 }] },
    }));
    expect(warnings("threads")[0]).toContain("501 of 500");
    expect(warnings("linkedin")).toEqual(expect.arrayContaining([expect.stringContaining("3001 of 3000"), expect.stringContaining("301 pages")]));
    expect(warnings("instagram")).toEqual(expect.arrayContaining([expect.stringContaining("31 hashtags"), expect.stringContaining("21 @ tags"), expect.stringContaining("21 items")]));
    expect(warnings("x")).toEqual([expect.stringContaining("5 items: X takes up to 4")]);
    expect(checks("facebook")).toEqual([]);
    expect(warnings("tiktok")[0]).toContain("2201 of 2200");
    expect(warnings("reels")).toEqual(expect.arrayContaining([expect.stringContaining("2201 of 2200"), expect.stringContaining("recommends 9:16"), expect.stringContaining("901 s")]));
    expect(warnings("shorts")).toEqual(expect.arrayContaining([expect.stringContaining("must be square or vertical"), expect.stringContaining("181 s")]));
  });

  it("uses TikTok's larger description limit for a photo post", () => {
    mount(post({ tiktok: { text: "a".repeat(3000), media: images(2) } }));
    expect(warnings("tiktok")).toEqual([]);
    expect(checks("tiktok")[0]).toContain("3000 of 4000");
  });

  it("says where LinkedIn can cut the text, as a note and not a warning", () => {
    mount(post({ linkedin: { text: `${"a".repeat(140)} end of hook, and more words after it` } }));
    expect(warnings("linkedin")).toEqual([]);
    expect(checks("linkedin").join()).toContain("...see more");
    expect(checks("linkedin").join()).toContain("end of h");
    mount(post({ linkedin: { text: "a".repeat(150) } }));
    expect(checks("linkedin").join()).not.toContain("see more");
  });

  it("flags an image of the wrong shape, and a carousel whose slides differ, from the sizes it is given", () => {
    mount(post({ instagram: { media: [{ src: "a.png", width: 2400, height: 800 }] } }));
    expect(warnings("instagram")[0]).toContain("3:1");
    expect(warnings("instagram")[0]).toContain("4:5 to 1.91:1");
    mount(post({ instagram: { media: [{ src: "a.png", width: 1080, height: 1350 }] } }));
    expect(warnings("instagram")).toEqual([]);
    mount(post({ instagram: { media: [{ src: "a.png", width: 1080, height: 1350 }, { src: "b.png", width: 1080, height: 1080 }] } }));
    expect(checks("instagram").join()).toContain("first one's shape");
  });

  it("draws a swipeable carousel with dots on Instagram and a paged document on LinkedIn", () => {
    const slides = [{ layout: "cover", title: "One" }, { layout: "points", title: "Two", points: ["a", "b"] }, { layout: "quote", quote: "Three" }, { html: '<b id="own">Four</b>' }];
    mount(post({ instagram: {}, linkedin: { documentTitle: "My doc" } }, { media: slides }));
    expect(panel("instagram").querySelectorAll(".swipe-item")).toHaveLength(4);
    expect(panel("instagram").querySelectorAll(".dots i")).toHaveLength(4);
    expect(panel("instagram").querySelector("[data-count]")!.textContent).toBe("1/4");
    expect(panel("linkedin").querySelector(".doc-head")!.textContent).toContain("My doc");
    expect(panel("linkedin").querySelector("[data-count]")!.textContent).toBe("1 of 4 pages");
    expect(panel("linkedin").querySelector("#own")!.textContent).toBe("Four");
    expect(panel("linkedin").querySelectorAll(".slide-points li")).toHaveLength(2);
  });

  it("plays a video it can, shows a poster with a play mark when it can't, and notes the swap", () => {
    mount(post({ reels: { media: [{ video: "clip.mp4", poster: "p.jpg" }] }, shorts: { media: [{ poster: "p.jpg" }] }, tiktok: {} }));
    expect(panel("reels").querySelector("video")!.getAttribute("src")).toBe("clip.mp4");
    expect(panel("shorts").querySelector(".poster-frame .play-mark")).not.toBeNull();
    expect(panel("tiktok").querySelector(".no-video")).not.toBeNull();
    panel("reels").querySelector("video")!.dispatchEvent(new Event("error"));
    expect(panel("reels").querySelector("video")).toBeNull();
    expect(panel("reels").querySelector(".poster-frame .play-mark")).not.toBeNull();
    expect(checks("reels").join()).toContain("poster stands in");
  });

  it("survives empty and odd data: initials, a failed image, right-to-left text and hostile words", () => {
    mount(post({ linkedin: { text: "<img src=x onerror=alert(1)> مرحبا", media: [{ src: "gone.png", alt: "Gone" }] }, facebook: { text: "" } }));
    expect(panel("linkedin").querySelector(".post-avatar")!.textContent).toBe("AS");
    expect(panel("linkedin").querySelector(".clip img")).toBeNull();
    expect(panel("linkedin").querySelector(".clip")!.getAttribute("dir")).toBe("auto");
    expect(panel("facebook").querySelector(".empty-text")).not.toBeNull();
    panel("linkedin").querySelector(".frame img")!.dispatchEvent(new Event("error"));
    expect(panel("linkedin").querySelector(".missing-image")!.textContent).toBe("Gone");
    expect(warnings("linkedin").join()).toContain("can't load here");

    mount({ account: { avatar: "gone.png", name: "نور الهدى" }, posts: [{ platforms: { x: { text: "hi" } } }] });
    panel("x").querySelector(".post-avatar img")!.dispatchEvent(new Event("error"));
    expect(panel("x").querySelector(".post-avatar")!.textContent).toBe("نا");

    mount({ posts: [{ platforms: { nosuch: {} } }] });
    expect(document.querySelector(".problem")!.textContent).toContain("No platforms");
    mount({});
    expect(document.querySelector(".problem")!.textContent).toBe("No posts yet.");
    mount("{ not json");
    expect(document.querySelector(".problem")!.textContent).toContain("isn't valid JSON");
  });
});
