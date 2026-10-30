import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import { addHeldSecretScrubber } from "../redact.ts";
import { VOICE_FIRST_BLOCK_MAX_CHARS } from "../tts/speech-text.ts";
import { PASS } from "./table.ts";
import { createTtsRoutes } from "./tts.ts";

async function call(method: string, path: string, body: unknown = {}, cfg = {} as AppConfig) {
  const answers: Array<[number, unknown]> = [];
  const out = await createTtsRoutes({ config: () => cfg })({
    req: {} as never, res: {} as never, url: new URL(`http://x${path}`), path: new URL(`http://x${path}`).pathname, method,
    auth: { kind: "loopback", scopes: ["admin", "client"] },
    json: ((_res: unknown, status: number, value: unknown) => { answers.push([status, value]); }) as never, readBody: (async () => body) as never,
  });
  return { out, answers };
}

describe("voice routes", () => {
  it("leave every other path to the next route", async () => {
    expect((await call("GET", "/api/connectors/catalog")).out).toBe(PASS);
    expect((await call("DELETE", "/api/tts/voices")).out).toBe(PASS);
  });

  it("add a Voice Library voice only with an owner, a voice id and a name made of plain ids", async () => {
    for (const body of [{}, { publicOwnerId: "owner1", voiceId: "../voices", name: "x" }, { publicOwnerId: "owner1", voiceId: "v1", name: " " }]) {
      expect((await call("POST", "/api/tts/voices/add", body)).answers).toEqual([[400, { error: "publicOwnerId, voiceId and name required" }]]);
    }
  });

  it("prepare a reply with a short first block, and never a held secret", async () => {
    const remove = addHeldSecretScrubber((text) => text.replaceAll("correct-horse-battery", "••••••"));
    try {
      const text = `I logged in with correct-horse-battery and then ${Array.from({ length: 30 }, (_, i) => `checked item ${i}`).join(", ")}. Done.`;
      const { answers } = await call("POST", "/api/tts/prepare", { text });
      const { utterances } = answers[0]![1] as { utterances: string[] };
      expect(utterances[0]!.length).toBeLessThanOrEqual(VOICE_FIRST_BLOCK_MAX_CHARS);
      expect(utterances.length).toBeGreaterThan(2);
      expect(utterances.join(" ")).not.toContain("correct-horse-battery");
    } finally {
      remove();
    }
  });

  it("list no voices, and say why, when no voice provider is set up", async () => {
    const { answers } = await call("GET", "/api/tts/voices?q=calm");
    expect(answers).toHaveLength(1);
    expect(answers[0]![0]).toBe(200);
    expect((answers[0]![1] as { voices: unknown[] }).voices).toEqual([]);
  });
});
