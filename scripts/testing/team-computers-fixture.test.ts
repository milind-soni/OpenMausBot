import { expect, it } from "vitest";
import { launchVerificationServer } from "../control-omb.ts";

it.each([
  "https://127.0.0.1:12345", "http://localhost:12345", "http://192.0.2.1:12345",
  "http://127.0.0.1:12345/api", "http://127.0.0.1:12345?token=secret", "http://127.0.0.1:12345#fragment",
  "http://user:password@127.0.0.1:12345", "http://127.0.0.1:0", "http://127.0.0.1:65536",
])("rejects an unsafe Box fixture endpoint before launching: %s", async (endpoint) => {
  await expect(launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], endpoint))
    .rejects.toThrow(/Box verification requires/);
});
