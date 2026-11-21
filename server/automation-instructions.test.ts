import { expect, it } from "vitest";
import { instructionsUpdateRefusal } from "./automation-instructions.ts";
import { addHeldSecretScrubber } from "./redact.ts";

it("allows replacing ordinary instructions, including long instructions", () => {
  expect(instructionsUpdateRefusal("Check the queue.\n".repeat(500), "Check the queue twice.")).toBeNull();
});

it("protects held secrets as well as recognizable credentials, while allowing other updates", () => {
  const remove = addHeldSecretScrubber(text => text.replaceAll("fixture-passphrase", "••••••"));
  try {
    for (const secret of ["fixture-passphrase", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"]) {
      const prompt = `Use ${secret}.`;
      expect(instructionsUpdateRefusal(prompt, "Replacement")).not.toBeNull();
      expect(instructionsUpdateRefusal(prompt, undefined)).toBeNull();
    }
  } finally { remove(); }
});
