import { parentPort } from "node:worker_threads";
import { compareTexts, formatTextChanges } from "../shared/text-changes.ts";

parentPort!.once("message", (request: { original: string; edited: string; start?: number }) => {
  try {
    const result = compareTexts(request.original, request.edited);
    parentPort!.postMessage(result.ok ? { text: formatTextChanges(result, { start: request.start }) } : { reason: result.reason });
  } catch {
    // An error message could quote the documents.
    parentPort!.postMessage({ reason: "failed" });
  }
});
