import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SendTurnInput } from "../../contracts.ts";
import type { AcpSupport } from "./core.ts";
import { resolveAcpClientPath } from "./client-path.ts";

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

export async function handleAcpClientFileRequest(msg: any, turn: SendTurnInput, cwd: string, support: Pick<AcpSupport, "clientFileSystem" | "clientReadRoots">, send: (obj: unknown) => void): Promise<void> {
  const fail = (error: unknown) => send({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
  });
  try {
    if (!support.clientFileSystem) throw new Error("Client file access is disabled.");
    const params = msg.params ?? {};
    const path = await resolveAcpClientPath(params.path, cwd, msg.method === "fs/read_text_file" ? support.clientReadRoots?.(turn) : undefined);
    if (msg.method === "fs/read_text_file") {
      const info = await stat(path);
      if (!info.isFile() || info.size > CLIENT_FILE_MAX_BYTES) {
        throw new Error(`ACP can only read text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
      }
      const content = await readFile(path, "utf8");
      if (params.line == null && params.limit == null) {
        send({ jsonrpc: "2.0", id: msg.id, result: { content } });
        return;
      }
      const line = typeof params.line === "number" && Number.isInteger(params.line) && params.line > 0 ? params.line : 1;
      const limit = typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit >= 0 ? params.limit : undefined;
      const lines = content.split("\n");
      const start = line - 1;
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: lines.slice(start, limit === undefined ? undefined : start + limit).join("\n") },
      });
      return;
    }
    if (typeof params.content !== "string" || Buffer.byteLength(params.content) > CLIENT_FILE_MAX_BYTES) {
      throw new Error(`ACP can only write text files under ${CLIENT_FILE_MAX_BYTES} bytes.`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content, "utf8");
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } catch (error) {
    fail(error);
  }
}
