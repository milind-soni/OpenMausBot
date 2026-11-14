import { describe, expect, it } from "vitest";
import en from "../src/locales/en.json";
import { CLOUD_COMPUTER_PERSON_LINES } from "./cloud-computer-recovery.ts";

describe("the person's line about a cloud computer that stopped answering", () => {
  it("has words in the language packs, naming the bot", () => {
    for (const key of Object.values(CLOUD_COMPUTER_PERSON_LINES)) {
      expect((en as Record<string, string>)[key], key).toContain("{name}");
    }
  });
});
