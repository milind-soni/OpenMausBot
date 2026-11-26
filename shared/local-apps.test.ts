import { describe, expect, it } from "vitest";

import { localAppIdFromLink, localAppLink } from "./local-apps.ts";

describe("app links", () => {
  it("reads only openmausbot://app/<id> with a well-formed id", () => {
    expect(localAppIdFromLink(localAppLink("la_AbCdEfGhIjKlMnOp"))).toBe("la_AbCdEfGhIjKlMnOp");
    expect(localAppIdFromLink(" OPENMAUSBOT://APP/la_AbCdEfGhIjKlMnOp/ ")).toBe("la_AbCdEfGhIjKlMnOp");
    for (const link of ["openmausbot://app/la_short", "openmausbot://app/la_AbCdEfGhIjKlMnOp/more", "openmausbot://thread/la_AbCdEfGhIjKlMnOp",
      "https://example.com/app/la_AbCdEfGhIjKlMnOp", "openmausbot://app/la_AbCdEfGhIjKlMnOp?x=1"]) expect(localAppIdFromLink(link), link).toBeNull();
  });
});
