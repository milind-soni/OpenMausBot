import { afterEach, describe, expect, it } from "vitest";

import { appBlockedText, type AppBlockedReason } from "../../../shared/app";
import { setLocale } from "@/lib/i18n";
import { formatAppBytes } from "./AppChrome";
import { appBlockedLine } from "./app-blocked";

const REASONS: AppBlockedReason[] = ["signed-out", "server-removed", "server-disabled", "apps-off", "too-large", "unavailable"];

afterEach(() => {
  setLocale("en");
});

describe("why an app cannot run", () => {
  it("says in English exactly what the server says", () => {
    for (const reason of REASONS) {
      expect(appBlockedLine(reason, "Asana"), reason).toBe(appBlockedText(reason, "Asana"));
      expect(appBlockedLine(reason), reason).toBe(appBlockedText(reason));
    }
  });

  it("says it in the app language", () => {
    setLocale("pt-br");
    expect(appBlockedLine("server-removed", "Excalidraw")).toBe("Excalidraw não está mais conectado");
    expect(appBlockedLine("too-large")).not.toBe(appBlockedText("too-large"));
  });

  it("keeps the server's words for a reason this client does not know", () => {
    expect(appBlockedLine("archived" as AppBlockedReason, "Asana", "Asana archived this app")).toBe("Asana archived this app");
    expect(appBlockedLine("toString" as AppBlockedReason, "Asana", "Asana archived this app")).toBe("Asana archived this app");
  });
});

describe("an app's size", () => {
  it("writes decimals the app language's way", () => {
    expect(formatAppBytes(1234)).toBe("1.2 KB");
    setLocale("pt-br");
    expect(formatAppBytes(1234)).toBe("1,2 KB");
    expect(formatAppBytes(432_000)).toBe("422 KB");
  });
});
