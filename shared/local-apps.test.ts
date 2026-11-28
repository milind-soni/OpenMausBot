import { describe, expect, it } from "vitest";

import { LOCAL_APP_ID as LINK_ID, parseAppLink } from "../electron/app-link.mjs";
import { LOCAL_APP_ID } from "./local-apps.ts";

describe("saved app ids", () => {
  it("are the same shape where the store makes them and where a link is read", () => {
    expect(LINK_ID.source).toBe(LOCAL_APP_ID.source);
    expect(parseAppLink("openmausbot://app/la_AbCdEfGhIjKlMnOp")).toEqual({ id: "la_AbCdEfGhIjKlMnOp", window: false });
  });
});
