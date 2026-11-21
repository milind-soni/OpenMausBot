// @vitest-environment happy-dom
// A search hit's label is the row's own name as this computer shows it: on a Mac, "Use this Mac …".
import { afterEach, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { hitLabel } from "./SettingsNav";
import { SETTINGS_INDEX } from "./settings-index";
import type { SettingsPlace } from "./settings-context";

const entry = SETTINGS_INDEX.find((row) => row.id === "always-on")!;
const label = () => hitLabel({ entry, elsewhere: false, score: 0 }, { name: "This computer" } as SettingsPlace, true);
afterEach(() => { delete (window as { ogb?: unknown }).ogb; });

it("says Mac on a Mac and computer elsewhere, as the row itself does", () => {
  setLocale("en");
  (window as { ogb?: unknown }).ogb = { platform: "darwin" };
  expect(label()).toBe("Use this Mac as an always-on home");
  (window as { ogb?: unknown }).ogb = { platform: "win32" };
  expect(label()).toBe("Use this computer as an always-on home");
});
