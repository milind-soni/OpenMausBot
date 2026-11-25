import { describe, expect, it } from "vitest";

import { crashArea } from "./crash-area";

describe("the area a page crash came from", () => {
  it("names the built file of the component that threw, never the minified component name", () => {
    const stack = "\n    at Xt (http://127.0.0.1:8799/assets/SettingsModal-Bq3x_9aZ.js:3:1204)\n    at div\n    at Ve (http://127.0.0.1:8799/assets/App-BM6OOWwA.js:12:345)";
    expect(crashArea(stack)).toBe("SettingsModal");
    expect(crashArea("\n    at div\n    at Suspense\n    at Ve (http://127.0.0.1:8799/assets/App-BM6OOWwA.js:12:345)")).toBe("App");
    expect(crashArea("\n    at Ve (https://tenant.mausbot.cloud/assets/index-AbCdEf12.js:1:2)")).toBe("index");
  });

  it("names a source module in development", () => {
    expect(crashArea("\n    at ChatPane (http://localhost:5173/src/components/SettingsModal.tsx?t=1732000000000:44:9)")).toBe("SettingsModal");
  });

  it("says other for anything not on its list: a library chunk, a page from elsewhere, no stack", () => {
    expect(crashArea("\n    at q (http://127.0.0.1:8799/assets/mermaid.core-AbCdEf12.js:1:2)")).toBe("other");
    expect(crashArea("\n    at q (https://example.test/assets/PrivateThing-AbCdEf12.js:1:2)")).toBe("other");
    expect(crashArea("\n    at Something (http://localhost:5173/src/components/Not-A-Known-File.tsx:1:2)")).toBe("other");
    expect(crashArea(undefined)).toBe("other");
    expect(crashArea("")).toBe("other");
  });
});
