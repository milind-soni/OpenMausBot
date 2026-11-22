import { parentPort } from "node:worker_threads";
import { changeList, compareTexts } from "../shared/text-changes.ts";

parentPort!.once("message", (request: { original: string; edited: string }) => {
  try {
    const result = compareTexts(request.original, request.edited);
    parentPort!.postMessage(result.ok ? { list: changeList(result) } : { reason: result.reason });
  } catch {
    // An error message could quote the documents.
    parentPort!.postMessage({ reason: "failed" });
  }
});
