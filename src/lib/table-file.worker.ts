import { parseTableFile } from "./table-data";

self.onmessage = (event: MessageEvent<{ text: string; delimiter: "," | "\t" }>) => {
  try { self.postMessage({ table: parseTableFile(event.data.text, event.data.delimiter) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "format" }); }
};
