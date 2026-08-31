// Spawned by an adapter CLI as its `browser` MCP server. BetterWright gives a
// profile exactly one owning process, so the worker that drives the browser
// must be the server's — the same worker that serves the embedded live view.
// This forwarder is that arrangement's stdio face: it relays the adapter's
// MCP stdio stream to the server's browser bridge socket verbatim, after one
// preamble line naming the profile this bot browses in.
import { connect } from "node:net";

const [socketPath, profile] = process.argv.slice(2);
if (!socketPath || !profile) {
  console.error("usage: browser-forwarder <bridge-socket> <profile>");
  process.exit(2);
}

const socket = connect(socketPath);
socket.once("connect", () => {
  socket.write(`${JSON.stringify({ t: "browser-mcp", profile })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(0));
// The CLI signals shutdown by closing our stdin; pass the FIN along so the
// bridge drops this connection while the shared worker lives on.
process.stdin.on("end", () => socket.end());
