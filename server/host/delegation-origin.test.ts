import { describe, expect, it } from "vitest";
import { delegationOriginKind } from "./delegation-origin.ts";

describe("runtime lineage projection for delegation", () => {
  it("keeps routine authority separate from outside user-evidence projection", () => {
    expect(delegationOriginKind({ originKind: "routine", origin: { kind: "outside" } })).toBe("routine");
  });
  it("lets authoritative outside lineage override a legacy user quote", () => {
    expect(delegationOriginKind({ originKind: "outside", origin: { kind: "user", request: "Quoted context" } })).toBe("outside");
  });
  it("keeps older user roots compatible and missing roots outside", () => {
    expect(delegationOriginKind({ origin: { kind: "user", request: "Do scoped work" } })).toBe("person");
    expect(delegationOriginKind(undefined)).toBe("outside");
  });
});
