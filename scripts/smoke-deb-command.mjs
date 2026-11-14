// Proves the install line the app puts on the clipboard (it never installs the
// .deb itself) works as pasted, quoting included, as root on a clean Ubuntu,
// and that a bare `dpkg -i` does not.
//
//   node scripts/smoke-deb-command.mjs <path-to-deb>
//
// Needs a container runtime.
import { execFileSync } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import path from "node:path";

import { packageInstallCommand } from "../electron/package-install-command.mjs";

const IMAGE = process.env.OMB_DEB_SMOKE_IMAGE || "ubuntu:24.04";
const RUNTIME = process.env.OMB_DEB_SMOKE_RUNTIME || "docker";
if (!["docker", "podman"].includes(RUNTIME)) throw new Error("unsupported container runtime");

function fail(message) {
  console.error(`[smoke-deb-command] ${message}`);
  process.exit(1);
}

const deb = path.resolve(process.argv[2] ?? "");
if (!deb.endsWith(".deb") || !existsSync(deb)) fail("pass the path to a .deb");

// Inside the container the package sits at a path with a space and an
// apostrophe, so the quoting the app emits is exercised, not assumed.
const staged = "/root/pending dir/o'brien/OpenMausBot.deb";
const command = packageInstallCommand("deb", staged);
console.log(`[smoke-deb-command] command under test:\n    ${command}\n`);

function inContainer(script, { expectFailure = false } = {}) {
  try {
    const output = execFileSync(
      RUNTIME,
      [
        "run", "--rm",
        "-v", `${deb}:/tmp/package.deb:ro`,
        "-e", "DEBIAN_FRONTEND=noninteractive",
        IMAGE,
        "/bin/bash", "-c", script,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (expectFailure) fail("the command was expected to fail but succeeded");
    return output;
  } catch (error) {
    if (expectFailure) return String(error.stdout ?? "") + String(error.stderr ?? "");
    // Only the tails: apt's full output runs past 100 KB, and dumping it whole
    // (or throwing the error that carries it) buried dpkg's actual reason.
    // writeSync, because process.exit can drop a pending write to a pipe.
    writeSync(2, `${tail(error.stdout)}\n${tail(error.stderr)}\n`);
    fail(`the container exited with ${error.status ?? error.signal ?? error.code}`);
  }
}

function tail(text, lines = 200) {
  return String(text ?? "").trimEnd().split("\n").slice(-lines).join("\n");
}

// On any failure, print dpkg's own record and the maintainer scripts' output
// (apt keeps both in its logs) last, where the tail above will show them.
const diagnostics = [
  "trap 'status=$?; if [ \"$status\" -ne 0 ]; then",
  '  echo "--- /var/log/dpkg.log (tail) ---"; tail -n 40 /var/log/dpkg.log || true',
  '  echo "--- /var/log/apt/term.log (tail) ---"; tail -n 80 /var/log/apt/term.log || true',
  "fi; exit \"$status\"' EXIT",
].join("\n");

// Everything before the command under test is setup; `set -e` keeps a failed
// setup from being read as a failed install.
const prepare = [
  "set -e",
  diagnostics,
  "apt-get update -qq",
  "apt-get install -y -qq sudo >/dev/null",
  `mkdir -p "$(dirname "${staged}")"`,
  `cp /tmp/package.deb "${staged}"`,
].join("\n");

console.log("[smoke-deb-command] installing with the command the app hands over…");
const installed = inContainer(
  [
    prepare,
    command,
    'dpkg-query -W -f="INSTALLED=\\${Version} \\${db:Status-Abbrev}\\n" openmausbot',
    'test -x /opt/OpenMausBot/openmausbot && echo "EXECUTABLE=yes"',
  ].join("\n"),
);

const version = installed.match(/INSTALLED=(\S+) (\S+)/);
const checks = [
  ["the package installed and configured", version?.[2]?.startsWith("ii") === true],
  ["the app binary is in place", installed.includes("EXECUTABLE=yes")],
];

// Control: on a clean Ubuntu `dpkg -i` resolves none of the dependencies.
console.log("[smoke-deb-command] control: the `dpkg -i` the app used to run…");
const control = inContainer([prepare, `dpkg -i "${staged}" || echo "DPKG_FAILED"`].join("\n"), {
  expectFailure: false,
});
checks.push([
  "`dpkg -i` alone fails where the handed-over command works",
  control.includes("DPKG_FAILED") || /dependency problems|not installed/i.test(control),
]);

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "✔" : "✖"} ${label}`);
  if (!ok) failed += 1;
}
if (failed > 0) fail(`${failed} check(s) failed`);
console.log(`[smoke-deb-command] OK — ${version[1]} installed by the command the app copies`);
