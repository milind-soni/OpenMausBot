import { expect, it } from "vitest";
import { taskDisposition } from "./task-disposition.ts";
it("accepts only a complete unquoted BLOCKED report", () => {
 expect(taskDisposition("BLOCKED: GitHub tool unavailable")).toEqual({ state: "blocked", reason: "GitHub tool unavailable" });
});
it.each(["Example: BLOCKED: missing key", "> BLOCKED: missing key", "`BLOCKED: missing key`", "```\nBLOCKED: missing key\n```", "If missing, report:\n\nBLOCKED: missing key", "Earlier BLOCKED: missing key; now published", " BLOCKED: missing key", "BLOCKED:", "BLOCKED: missing key\nPublished successfully", "Hypothetical\nBLOCKED: missing key"])("rejects %s", text => {
 expect(taskDisposition(text)).toBeUndefined();
});

const completed = 'OPENMAUS_TASK_RESULT: {"state":"completed"}';
const blocked = 'OPENMAUS_TASK_RESULT: {"state":"blocked","reason":"GitHub tool unavailable"}';
it("accepts explicit terminal completion and blocked reports after useful prose", () => {
 expect(taskDisposition(completed)).toEqual({ state: "completed" });
 expect(taskDisposition(`Checked the files; publication requires a missing tool.\n\n${blocked}\n`)).toEqual({ state: "blocked", reason: "GitHub tool unavailable" });
 expect(taskDisposition(`Published the requested artifact.\r\n\r\n${completed}\r\n`)).toEqual({ state: "completed" });
});
it.each([
 `> ${blocked}`, ` ${blocked}`, `    ${blocked}`, `Example: ${blocked}`, `\`${blocked}\``,
 `\`\`\`json\n${blocked}\n\`\`\``, `\`\`\`\n\n${blocked}`, `~~~\n\n${blocked}`,
 `\`\`\`\n\`\`\`not-a-close\n\n${blocked}`, `~~~\n~~~not-a-close\n\n${blocked}`,
 `If the tool is absent, say:\n${blocked}`, `Hypothetical\n${blocked}`, `${blocked}\nStill working`,
 `${blocked}\n\n${completed}`, `${completed}\n\n`,
 'OPENMAUS_TASK_RESULT: {"state":"blocked","reason":""}',
 'OPENMAUS_TASK_RESULT: {"state":"blocked","reason":"missing","extra":true}',
 'OPENMAUS_TASK_RESULT: {"state":"completed","reason":"maybe"}',
 'OPENMAUS_TASK_RESULT: {"state":"failed"}',
 'OPENMAUS_TASK_RESULT: {"state":"blocked","state":"completed"}',
 'OPENMAUS_TASK_RESULT: {"state":"blocked","reason":"one","reason":"two"}',
 'OPENMAUS_TASK_RESULT: {"state":"blocked","reason":"first\\nsecond"}',
 `OPENMAUS_TASK_RESULT: ${JSON.stringify({ state: "blocked", reason: "x".repeat(1001) })}`,
])("rejects examples and malformed protocol: %s", text => expect(taskDisposition(text)).toBeUndefined());
it("does not infer task completion or blockers from prose", () => {
 expect(taskDisposition("Published successfully")).toBeUndefined();
 expect(taskDisposition("Missing GitHub permissions; could not publish")).toBeUndefined();
});
