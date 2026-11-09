import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the Chief Operator bearer out of argv while preserving the GET request", () => {
  const docs = readFileSync(new URL("../../docs/chief-operator.md", import.meta.url), "utf8");
  const example = docs.match(/```sh\n([\s\S]*?)\n```/)![1]!;
  const [header, curl, extra] = example.split("|").map(command => command.trim());
  expect(extra).toBeUndefined();
  expect(header).toBe(`printf 'Authorization: Bearer %s\\n' "$OPENMAUSBOT_TOKEN"`);
  expect(curl).not.toContain("OPENMAUSBOT_TOKEN");
  expect(curl).toMatch(/^curl\s+--header\s+@-\s+"\$OPENMAUSBOT_URL\/api\/chief-operator"$/);
});
