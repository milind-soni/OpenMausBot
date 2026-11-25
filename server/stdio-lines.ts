// Reads newline-delimited JSON-RPC, the MCP stdio framing, splitting only on "\n". node:readline also ends a line at
// U+2028 and U+2029, which JSON.stringify leaves unescaped inside strings, so it cuts such a frame into two halves
// that both fail JSON.parse.
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export function readStdioLines(input: Readable, onLine: (line: string) => void, onClose?: () => void): { close(): void } {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  let open = true;
  const deliver = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  const take = (text: string) => {
    const from = rest.length;
    rest += text;
    for (let newline = rest.indexOf("\n", from); open && newline !== -1; newline = rest.indexOf("\n")) {
      const line = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      deliver(line);
    }
  };
  const onData = (chunk: Buffer | string) => take(typeof chunk === "string" ? chunk : decoder.write(chunk));
  const onEnd = () => {
    take(decoder.end());
    if (open && rest) deliver(rest);
    close();
  };
  function close() {
    if (!open) return;
    open = false;
    rest = "";
    input.off("data", onData);
    input.off("end", onEnd);
    input.pause();
    onClose?.();
  }
  input.on("data", onData);
  input.on("end", onEnd);
  return { close };
}
