import { createConnection } from "node:net";

// Invoked by Codex. stdout must contain only the token; failures disclose no credentials.
const path = process.env.OMB_CODEX_AUTH_SOCKET;
const secret = process.env.OMB_CODEX_AUTH_SECRET;
if (!path || !secret) process.exit(1);
const socket = createConnection(path);
socket.setTimeout(55_000, () => socket.destroy());
socket.on("connect", () => socket.write(`${secret}\n`));
socket.on("error", () => { process.exitCode = 1; });
let response = "";
socket.on("data", (data) => { response += data.toString(); if (response.length > 16384) socket.destroy(); });
socket.on("close", () => {
  if (!response || response.length > 16384) { process.exitCode = 1; return; }
  process.stdout.write(response);
});
