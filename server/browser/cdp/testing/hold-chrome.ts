// Launches Chrome, prints its pid, and holds the pipe until this process is
// killed: the suite checks that Chrome then exits by itself.
import { launchChrome } from "../../chrome/launch.ts";

const [executablePath, userDataDir, host, sandbox] = process.argv.slice(2);
if (!executablePath || !userDataDir) throw new Error("usage: hold-chrome.ts <chrome> <user data dir> [host] [sandbox 0|1]");
const chrome = await launchChrome({
  executablePath,
  userDataDir,
  mode: "headless",
  host: host === "container" || host === "server" ? host : "desktop",
  sandbox: sandbox !== "0",
  handshakeTimeoutMs: 120_000,
});
process.stdout.write(`${JSON.stringify({ pid: chrome.pid })}\n`);
setInterval(() => {}, 60_000);
