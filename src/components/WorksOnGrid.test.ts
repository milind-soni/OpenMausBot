import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n";
import { worksOnChoices, worksOnHintKey } from "./WorksOnGrid";

const remote = { host: { platform: "linux" }, localComputer: { available: false, reasonCode: "remote-server" } } as DesktopCapabilities;
const desktop = { host: { platform: "darwin" }, localComputer: { available: true } } as DesktopCapabilities;

describe("worksOnHintKey", () => {
  it("says how a shared computer is used when the list has no This computer", () => {
    expect(worksOnChoices(null, remote).some(([mode]) => mode === "local")).toBe(false);
    expect(t(worksOnHintKey(null, remote))).toMatch(/desktop app isn't picked here: just ask the bot to use it\.$/);
  });

  it("keeps the plain line where This computer is offered", () => {
    expect(worksOnChoices(null, desktop).some(([mode]) => mode === "local")).toBe(true);
    expect(t(worksOnHintKey(null, desktop))).toBe("Choose where this bot works.");
  });

  it("keeps the Cloud line on a Cloud", () => {
    expect(t(worksOnHintKey({ cloudHome: true }, remote))).toMatch(/It can also use your computer whenever .+ is open on it\.$/);
  });
});
