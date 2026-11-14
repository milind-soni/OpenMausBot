import { describe, expect, it } from "vitest";

import { createRepresentative, readAnswer, type Question } from "./representative.ts";

describe("an explicit representative wait", () => {
  it.each([
    '{"wait":true,"answer":"Ben is free on Friday."}',
    '{"answer":"Ben is free on Friday.","wait":true}',
  ])("takes precedence over a draft answer in %s", (raw) => {
    expect(readAnswer(raw, "Ben")).toBeNull();
  });

  it("does not return an answer the model has marked as waiting for the person", async () => {
    const input: Question = {
      person: { key: "p_ben", name: "Ben" }, bot: { id: "bens-chief" },
      team: "Acme", asker: "Cleo", question: "Is Ben free on Friday?", shared: { notes: [], work: [] },
    };
    const assistant = createRepresentative({
      busy: async () => [], generate: async () => '{"wait":true,"answer":"Ben is free on Friday."}',
      timeZone: () => "UTC", now: () => Date.UTC(2026, 9, 27),
    });
    expect(await assistant.answer(input)).toBeNull();
  });

  it("continues to accept an ordinary answer and an explicitly false wait", () => {
    expect(readAnswer('{"answer":"Ben is busy."}', "Ben")).toBe("Ben is busy.");
    expect(readAnswer('{"answer":"Ben is busy.","wait":false}', "Ben")).toBe("Ben is busy.");
    expect(readAnswer('{"wait":true}', "Ben")).toBeNull();
  });
});
