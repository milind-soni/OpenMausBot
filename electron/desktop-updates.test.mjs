import { expect, it } from "vitest";
import { DESKTOP_AUTO_UPDATE } from "./desktop-updates.mjs";

it("keeps desktop auto-update off until Edu Bot ships its own release feed", () => {
  expect(DESKTOP_AUTO_UPDATE).toBe(false);
});
