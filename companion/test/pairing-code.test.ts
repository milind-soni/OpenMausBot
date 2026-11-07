import { describe, expect, it } from "vitest";

import * as shared from "../../shared/pairing-code.ts";
import { formatPairingCode, generatePairingCode, isOldPairingCode, normalizePairingCode, PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "../src/pairing-code.ts";

describe("the sidecar's pairing code", () => {
  it("follows the same rules as everywhere else", () => {
    expect(PAIRING_CODE_ALPHABET).toBe(shared.PAIRING_CODE_ALPHABET);
    expect(PAIRING_CODE_LENGTH).toBe(shared.PAIRING_CODE_LENGTH);
    for (const typed of ["7kq2 m9xd-h4tp", "0O1I-abcd-efgh", "  x "]) {
      expect(normalizePairingCode(typed)).toBe(shared.normalizePairingCode(typed));
      expect(formatPairingCode(typed)).toBe(shared.formatPairingCode(typed));
    }
    for (let i = 0; i < 50; i++) expect(shared.readPairingInput(generatePairingCode()).kind).toBe("code");
    expect(isOldPairingCode("004 209")).toBe(true);
    expect(shared.readPairingInput("004 209")).toEqual({ kind: "wrong", problem: "oldCode" });
  });
});
