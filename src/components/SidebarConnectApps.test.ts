import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { initialState } from "@/state/store";

vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(), useStore: () => ({ state: initialState, dispatch: vi.fn() }) }));

import { APP_FACES, POPULAR_APPS, SidebarConnectApps, appFaces } from "./SidebarConnectApps";

const card = (slug: string) => ({ slug, label: slug, logo: `https://logos.example/${slug}.png`, domain: null });

describe("the Connect apps faces", () => {
  it("shows popular apps until something is connected", () => {
    expect(appFaces([], new Map()).map((face) => face.slug)).toEqual(POPULAR_APPS.map((app) => app.slug));
  });

  it("puts connected apps first, fills with popular ones, and never shows more than three", () => {
    const cards = new Map([["github", card("github")], ["gmail", card("gmail")]]);
    expect(appFaces(["github", "gmail"], cards).map((face) => face.slug)).toEqual(["github", "gmail", "slack"]);
    const many = new Map(["a", "b", "c", "d"].map((slug) => [slug, card(slug)]));
    expect(appFaces(["a", "b", "c", "d"], many)).toHaveLength(APP_FACES);
  });

  it("draws a 36px pill with a 14px medium label and three overlapping 16px logos whose outer two fan out on hover", () => {
    const html = renderToStaticMarkup(createElement(SidebarConnectApps));
    expect(html).toMatch(/class="group\/apps flex h-9 min-w-0 flex-1 items-center justify-center gap-1\.5 rounded-full pl-4 pr-3 text-\[14px\] font-medium leading-5 text-ink /);
    const faces = [...html.matchAll(/data-app-face="[^"]+" class="([^"]*)"/g)].map(([, classes]) => classes!);
    expect(faces).toHaveLength(3);
    for (const face of faces) expect(face).toContain("size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-white p-px");
    expect(faces[0]).toContain("motion-safe:group-hover/apps:-rotate-[8deg]");
    expect(faces[1]).toContain("-ms-1.5");
    expect(faces[1]).not.toContain("rotate");
    expect(faces[2]).toContain("motion-safe:group-hover/apps:translate-x-[3px] motion-safe:group-hover/apps:rotate-[8deg]");
  });

  it("is a round 36px puzzle button on the collapsed rail, named for screen readers", () => {
    const html = renderToStaticMarkup(createElement(SidebarConnectApps, { circle: true }));
    expect(html).toMatch(/data-tour="nav-apps"[^>]*aria-label="Connect apps" title="Connect apps" class="[^"]*\bsize-9\b[^"]*\brounded-full\b/);
    expect(html).toContain("lucide-puzzle");
    expect(html).not.toContain("data-app-face");
  });

  it("keeps a connected app it cannot draw yet out, and the popular ones in", () => {
    expect(appFaces(["linear"], new Map()).map((face) => face.slug)).toEqual(["gmail", "slack", "notion"]);
  });
});
