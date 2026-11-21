import { spawn } from "node:child_process";

const server = spawn("node", ["dist-server/server-launcher.js"], {
  stdio: "inherit",
});

const caddy = spawn("caddy", [
  "run",
  "--config",
  "/etc/caddy/Caddyfile",
], {
  stdio: "inherit",
});

let stopping = false;

function shutdown(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
  caddy.kill(signal);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

for (const [child, other] of [[server, caddy], [caddy, server]]) {
  child.on("exit", (code) => {
    if (!stopping) {
      stopping = true;
      other.kill("SIGTERM");
      process.exitCode = code ?? 1;
    }
  });
}
