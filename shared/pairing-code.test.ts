import { describe, expect, it } from "vitest";

import en from "../src/locales/en.json";
import { formatPairingCode, PAIRING_INPUT_PROBLEM_KEY, PAIRING_INPUT_PROBLEM_TEXT, readPairingInput } from "./pairing-code";

const credential = `omb_pair_${"Q".repeat(43)}`;

describe("readPairingInput", () => {
  it("takes a code however it is typed", () => {
    expect(readPairingInput("7kq2 m9xd-h4tp")).toEqual({ kind: "code", code: "7KQ2M9XDH4TP" });
    expect(formatPairingCode("7kq2m9xdh4tp")).toBe("7KQ2-M9XD-H4TP");
  });

  it("reads the code or credential out of every link that carries one", () => {
    expect(readPairingInput("https://maus.example.com/pair#code=7KQ2-M9XD-H4TP")).toEqual({ kind: "code", code: "7KQ2M9XDH4TP" });
    expect(readPairingInput("http://192.168.1.20:8799/pair?code=7KQ2-M9XD-H4TP")).toEqual({ kind: "code", code: "7KQ2M9XDH4TP" });
    expect(readPairingInput(`openmausbot://pair?address=192.168.1.20%3A8810&token=${credential}`)).toEqual({ kind: "credential", credential });
    expect(readPairingInput("openmausbot://pair?address=https%3A%2F%2Fmaus.example.com&code=7KQ2-M9XD-H4TP")).toEqual({ kind: "code", code: "7KQ2M9XDH4TP" });
    expect(readPairingInput(credential)).toEqual({ kind: "credential", credential });
  });

  it("names the wrong kind of code instead of calling it wrong", () => {
    expect(readPairingInput("1234 5678")).toEqual({ kind: "wrong", problem: "emailCode" });
    expect(readPairingInput("123456")).toEqual({ kind: "wrong", problem: "oldCode" });
    expect(readPairingInput(`omb_sess_${"a".repeat(43)}`)).toEqual({ kind: "wrong", problem: "scriptKey" });
    expect(readPairingInput("https://maus.example.com/")).toEqual({ kind: "wrong", problem: "notACode" });
    expect(readPairingInput("hello")).toEqual({ kind: "wrong", problem: "notACode" });
    expect(readPairingInput("  ")).toEqual({ kind: "empty" });
  });

  it("every problem has its sentence in the catalog, word for word", () => {
    for (const key of Object.values(PAIRING_INPUT_PROBLEM_KEY)) {
      expect(en[key as keyof typeof en]).toBe(PAIRING_INPUT_PROBLEM_TEXT[key as keyof typeof PAIRING_INPUT_PROBLEM_TEXT]);
    }
  });
});
