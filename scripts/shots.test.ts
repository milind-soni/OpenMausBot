import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nameFor, parseShotsArgs, shotPlan } from "./shots.ts";

describe("pnpm shots", () => {
  it("photographs the app's own page into shots/ by default", () => {
    expect(parseShotsArgs([])).toEqual({ path: "/", name: "app", url: "http://127.0.0.1:5199", out: "shots", wait: "#root > *" });
  });

  it("names a preview's pictures after its page and state, unless --name says", () => {
    expect(nameFor("/room-card-preview.html?state=memory&layout=phone")).toBe("room-card-preview-state-memory-layout-phone");
    expect(parseShotsArgs(["/room-card-preview.html", "--name", "after"]).name).toBe("after");
  });

  it("refuses a path that is not the app's, a second path and a name that is not a file name", () => {
    expect(() => parseShotsArgs(["room-card-preview.html"])).toThrow(/starts with "\/"/);
    expect(() => parseShotsArgs(["/", "/rail"])).toThrow(/usage/);
    expect(() => parseShotsArgs(["--name", "../before"])).toThrow(/--name/);
    for (const elsewhere of ["//other.test/room-card-preview.html", "/\\other.test/room-card-preview.html"]) expect(() => parseShotsArgs([elsewhere])).toThrow(/not another site/);
    expect(parseShotsArgs(["/rail.html", "--url", "http://localhost:6000"]).path).toBe("/rail.html");
  });

  it("covers phone, tablet and desktop in Midnight and Daylight, each with its own file and skin in the address", () => {
    const plan = shotPlan(parseShotsArgs(["/one-home-preview.html?state=menu", "--name", "before", "--out", "pr"]));
    expect(plan.map(({ width, height, skin, scheme }) => `${width}x${height} ${skin} ${scheme}`)).toEqual([
      "390x844 midnight dark", "768x1024 midnight dark", "1440x900 midnight dark",
      "390x844 daylight light", "768x1024 daylight light", "1440x900 daylight light",
    ]);
    expect(plan[0]).toMatchObject({ url: "http://127.0.0.1:5199/one-home-preview.html?state=menu&skin=midnight", file: join("pr", "before-390-midnight.png"), mobile: true });
    expect(plan[5]).toMatchObject({ url: "http://127.0.0.1:5199/one-home-preview.html?state=menu&skin=daylight", file: join("pr", "before-1440-daylight.png"), mobile: false });
    expect(new Set(plan.map(({ file }) => file)).size).toBe(6);
  });

  it("replaces a skin the path already names rather than sending two", () => {
    const [shot] = shotPlan(parseShotsArgs(["/?skin=pop"]));
    expect(new URL(shot!.url).searchParams.getAll("skin")).toEqual(["midnight"]);
  });
});
