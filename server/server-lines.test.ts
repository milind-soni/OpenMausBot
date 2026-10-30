import { describe, expect, it } from "vitest";

import "./server-line-packs.ts";
import { serverLine } from "./server-lines.ts";

describe("serverLine", () => {
  it("writes the line in the language given, with its values filled in", () => {
    expect(serverLine("de", "server.reports.sent", { report: "r-1" })).toBe("An das MausBot-Team gesendet (Bericht r-1). Milind und Omkar bekommen ihn per E-Mail.");
    expect(serverLine(undefined, "server.reports.sent", { report: "r-1" })).toBe("Sent to the MausBot team (report r-1). Milind and Omkar get it by email.");
    expect(serverLine("en", "server.reports.when.minutes", { count: 5 })).toBe("in about 5 minutes");
  });

  it("reads a regional tag as its language, and a language it has no words for as English", () => {
    expect(serverLine("de-AT", "server.reports.when.soon")).toBe("so bald wie möglich");
    expect(serverLine("pt", "server.reports.when.soon")).toBe(serverLine("pt-br", "server.reports.when.soon"));
    expect(serverLine("zh-Hant", "server.reports.when.soon")).toBe(serverLine("zh-tw", "server.reports.when.soon"));
    expect(serverLine("nl", "server.reports.when.soon")).toBe("as soon as it can");
  });

  it("leaves a {name} it was given no value for as it is", () => {
    expect(serverLine("en", "server.reports.refused", {})).toBe("The MausBot team's server refused this bug report, so nothing was sent: {detail}.");
  });
});
