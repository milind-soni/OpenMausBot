import { describe, expect, it } from "vitest";

import { OUTSIDE_REFUSAL, outsideRouteRefused } from "./outside-fence.ts";

describe("what a confined turn reaches of OpenMausBot's own routes", () => {
  it("refuses what runs or starts something with no person deciding", () => {
    for (const path of ["vm-exec", "fill-login", "create-room", "computer/select", "phone/claim", "device/mcp", "pages/publish", "pages/unpublish", "request-credential", "request-sign-in", "threads/abc/close"]) {
      expect(outsideRouteRefused("POST", `/api/internal/${path}`), path).toBe(true);
    }
  });

  it("refuses a route nobody listed, and a listed path under another method", () => {
    expect(outsideRouteRefused("POST", "/api/internal/brand-new-route")).toBe(true);
    expect(outsideRouteRefused("GET", "/api/internal/coordinate-bots")).toBe(true);
    expect(outsideRouteRefused("DELETE", "/api/internal/memory")).toBe(true);
  });

  it("keeps what finishes the work here, asks a person or carries the lineage", () => {
    expect(outsideRouteRefused("POST", "/api/internal/hook")).toBe(false);
    expect(outsideRouteRefused("GET", "/api/internal/tool-result")).toBe(false);
    expect(outsideRouteRefused("POST", "/api/internal/options-card")).toBe(false);
    expect(outsideRouteRefused("POST", "/api/internal/coordinate-bots")).toBe(false);
    expect(outsideRouteRefused("post", "/api/internal/connectors/mcp")).toBe(false);
    expect(outsideRouteRefused("POST", "/api/internal/mcp-http/server-a")).toBe(false);
  });

  it("speaks plainly and tells the bot to finish where it is", () => {
    expect(OUTSIDE_REFUSAL).toContain("came in from outside");
    expect(OUTSIDE_REFUSAL).toContain("Finish what you can in this conversation");
  });
});
