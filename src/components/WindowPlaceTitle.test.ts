// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { windowPlaceName } from "./WindowPlaceTitle";

beforeEach(() => setLocale("en"));
afterEach(() => { delete window.ogb; });

it("the top bar names the place as the rail does: This computer, in a profile too, on any platform; My Cloud while home keeps that name", () => {
  expect(windowPlaceName({ local: true, name: "This computer" }, undefined)).toBe("This computer");
  window.ogb = { platform: "darwin" } as unknown as typeof window.ogb;
  expect(windowPlaceName({ local: true, name: "This computer", profile: "default" }, undefined)).toBe("This computer");
  window.ogb = { platform: "win32" } as unknown as typeof window.ogb;
  expect(windowPlaceName({ local: true, name: "This computer", profile: "default" }, undefined)).toBe("This computer");
  expect(windowPlaceName({ local: false, name: "My Cloud", home: true }, undefined)).toBe("My Cloud");
});

it("home renamed by its owner (Settings → Name and colour) is called by that name in the top bar, as on the rail", () => {
  expect(windowPlaceName({ local: false, name: "Freedom Fox", home: true }, undefined)).toBe("Freedom Fox");
  expect(windowPlaceName({ local: false, name: "Freedom Fox", home: true }, "Acme"), "a team's Cloud keeps the team's name").toBe("Acme");
  expect(windowPlaceName({ local: false, name: "", home: true }, undefined)).toBe("My Cloud");
});

it("a workspace added from ＋ is called by its own name in the top bar", () => {
  window.ogb = { platform: "darwin" } as unknown as typeof window.ogb;
  expect(windowPlaceName({ local: true, name: "This computer", profile: "work", profileName: "Work" }, undefined)).toBe("Work");
});
