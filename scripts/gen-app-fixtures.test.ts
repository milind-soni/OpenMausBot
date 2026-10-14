import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BOT_HTML_CSP } from "../shared/app-frame/csp.ts";
import { CSP_META_PREFIX } from "../shared/app-frame/document.ts";
import { APP_SAMPLES, MCP_APP_SAMPLES } from "../shared/app-samples.ts";
import { APP_HOST_HTML, appHostHashOf } from "./build-app-host.ts";
import { buildAppFixtures, writeAppFixtures } from "./gen-app-fixtures.ts";

describe("app fixtures", () => {
  it("are the same every run", () => {
    expect(JSON.stringify(buildAppFixtures())).toBe(JSON.stringify(buildAppFixtures()));
  });

  it("hold a row and a document for every sample, the edge rows, and a line an app sent", () => {
    const { messages, documents, expectations } = buildAppFixtures();
    const ids = messages.map((message) => message.id);
    for (const name of Object.keys(APP_SAMPLES)) expect(ids).toContain(`app-${name}`);
    for (const name of Object.keys(MCP_APP_SAMPLES)) expect(ids).toContain(`app-mcp-${name}`);
    expect(ids).toEqual(expect.arrayContaining(["app-too-large", "app-sent", "app-future", "app-broken"]));
    for (const id of Object.keys(APP_SAMPLES).map((name) => `app-${name}`)) {
      expect(documents[id]?.srcdoc.startsWith(`${CSP_META_PREFIX}${BOT_HTML_CSP}">`), id).toBe(true);
    }
    for (const id of Object.keys(MCP_APP_SAMPLES).map((name) => `app-mcp-${name}`)) {
      expect(documents[id]?.srcdoc.startsWith(CSP_META_PREFIX), id).toBe(true);
      expect(documents[id]?.tool, id).toBeDefined();
    }
    expect(documents["app-too-large"]).toBeUndefined();
    expect(messages.find((message) => message.id === "app-report")?.app?.rev).toBe(1);
    expect(messages.find((message) => message.id === "app-counter")?.app?.context?.text).toBe("The counter shows 3 cups.");
    expect(messages.find((message) => message.id === "app-sent")).toMatchObject({ role: "user", replyToId: "app-counter", fromApp: { messageId: "app-counter", title: "Coffee counter" } });
    // Excalidraw's undeclared and malformed origins were refused, and say so.
    expect(messages.find((message) => message.id === "app-mcp-excalidraw")?.app?.network).toEqual({
      connect: ["https://esm.sh"], resources: ["https://esm.sh"], refused: ["http://localhost:8080", "https://example.com/path"],
    });
    expect(expectations.appHostSha256).toBe(appHostHashOf(readFileSync(APP_HOST_HTML, "utf8")));
  });

  it("are written where the phone apps read them, with the host page copied byte for byte", () => {
    const root = mkdtempSync(join(tmpdir(), "omb-mobile-"));
    const files = writeAppFixtures(root);
    expect(files.map((file) => file.slice(root.length + 1))).toEqual([
      "ios/Tests/CompanionCoreTests/Fixtures/app-messages.json",
      "ios/Tests/CompanionCoreTests/Fixtures/app-documents.json",
      "ios/Tests/CompanionCoreTests/Fixtures/app-expectations.json",
      "ios/App/Resources/app-host.html",
      "android/app/src/main/assets/app/app-host.html",
    ]);
    const host = readFileSync(APP_HOST_HTML, "utf8");
    expect(readFileSync(join(root, "ios/App/Resources/app-host.html"), "utf8")).toBe(host);
    expect(readFileSync(join(root, "android/app/src/main/assets/app/app-host.html"), "utf8")).toBe(host);
    expect(JSON.parse(readFileSync(files[0]!, "utf8"))).toMatchObject({ hasMore: false, messages: expect.any(Array) });
  });
});
