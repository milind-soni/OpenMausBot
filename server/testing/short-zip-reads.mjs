import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";

const open = fs.open;
fs.open = async (path, ...args) => {
  const handle = await open(path, ...args);
  if (basename(String(path)) === "map.xmind") {
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      const result = await read(buffer, offset, Math.min(length, 7), position);
      if (result.bytesRead < length) {
        appendFileSync(join(process.env.OMB_DATA_DIR, "zip-short-reads.jsonl"),
          JSON.stringify({ requested: length, returned: result.bytesRead }) + "\n");
      }
      return result;
    };
  }
  return handle;
};
syncBuiltinESMExports();
