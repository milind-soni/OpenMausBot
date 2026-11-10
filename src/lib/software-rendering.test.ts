// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { applySoftwareRendering } from "./software-rendering";

afterEach(() => {
  delete document.documentElement.dataset.softwareRendering;
  delete (window as { ogb?: unknown }).ogb;
});

describe("applySoftwareRendering", () => {
  it("marks the page when the desktop app renders without a GPU", () => {
    (window as { ogb?: unknown }).ogb = { platform: "linux", softwareRendering: true };
    applySoftwareRendering();
    expect(document.documentElement.dataset.softwareRendering).toBe("");
  });

  it("leaves the page alone with a GPU, on other platforms and in a browser", () => {
    (window as { ogb?: unknown }).ogb = { platform: "linux" };
    applySoftwareRendering();
    expect(document.documentElement.dataset.softwareRendering).toBeUndefined();
    (window as { ogb?: unknown }).ogb = { platform: "darwin", softwareRendering: false };
    applySoftwareRendering();
    expect(document.documentElement.dataset.softwareRendering).toBeUndefined();
    delete (window as { ogb?: unknown }).ogb;
    applySoftwareRendering();
    expect(document.documentElement.dataset.softwareRendering).toBeUndefined();
  });
});
