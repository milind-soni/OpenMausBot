// Shared provisioning and shell contract for the cloud computer's Cua Driver.
// The box command API is the transport boundary: the daemon stays loopback-only
// inside the VM and OpenMausBot never exposes another inbound port.

export const REMOTE_CUA_VERSION = "0.20.0";
export const REMOTE_CUA_EXECUTABLE = "/opt/ogb/cua-driver";
export const REMOTE_CUA_SOCKET = "/opt/ogb/run/cua.sock";
export const REMOTE_CUA_SESSION = "openmausbot";
export const REMOTE_CDP_HELPER = "/opt/ogb/openmausbot-cdp.mjs";

const REMOTE_CUA_WHEELS = {
  x86_64: {
    url: "https://files.pythonhosted.org/packages/fa/d7/a43008a328a40c85e7bc706fc20235b9abedc75e28b413817655153157ff/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl",
    sha256: "f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961",
  },
  aarch64: {
    url: "https://files.pythonhosted.org/packages/94/9d/1c1838b69067e83266c3d2aae02d74eef353a43dc8644884ccf03fe7f933/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl",
    sha256: "48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77",
  },
} as const;

const CDP_HELPER_SOURCE = String.raw`const [action, encoded = ""] = process.argv.slice(2);
const input = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8") || "{}");
const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
const page = pages.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!page) throw new Error("no debuggable browser page");
if (input.url && page.url !== input.url) throw new Error("page changed; take a new browser snapshot");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", () => reject(new Error("DevTools connection failed")), { once: true });
});
let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result ?? {});
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const refId = (value) => {
  const match = /^b(\d+)$/.exec(String(value ?? ""));
  if (!match) throw new Error("invalid or stale browser ref; take a new snapshot");
  return Number(match[1]);
};
if (action === "snapshot") {
  await send("Accessibility.enable");
  const { nodes = [] } = await send("Accessibility.getFullAXTree", { depth: 14 });
  const useful = new Set(["button", "checkbox", "combobox", "heading", "link", "menuitem", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
  const elements = [];
  for (const node of nodes) {
    const role = String(node.role?.value ?? "").toLowerCase();
    const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    const backend = Number(node.backendDOMNodeId ?? 0);
    if (!backend || !useful.has(role) || (!name && role !== "textbox" && role !== "searchbox")) continue;
    const disabled = node.properties?.some((property) => property.name === "disabled" && property.value?.value === true) ?? false;
    elements.push({ ref: "b" + backend, role, name: name || "unnamed", disabled });
    if (elements.length >= 250) break;
  }
  process.stdout.write(JSON.stringify({ title: String(page.title ?? "").slice(0, 200), url: page.url, elements }));
} else if (action === "click") {
  const backendNodeId = refId(input.ref);
  const { model } = await send("DOM.getBoxModel", { backendNodeId });
  const quad = model?.border ?? model?.content;
  if (!Array.isArray(quad) || quad.length < 8) throw new Error("element is not visible; take a new snapshot");
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else if (action === "fill") {
  const backendNodeId = refId(input.ref);
  await send("DOM.focus", { backendNodeId });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  await send("Input.insertText", { text: String(input.text ?? "") });
  process.stdout.write(JSON.stringify({ ok: true, ref: input.ref }));
} else {
  throw new Error("unknown browser action");
}
socket.close();`;

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export const MAX_REMOTE_COMMAND_LENGTH = 4_000;

/** Run a user- or model-supplied command without inheriting provider or
 * account credentials from an older box image. Keep this shared by the bot
 * tool and the owner's Computer-panel console so the two boundaries cannot
 * drift apart. */
export function isolatedRemoteCommand(command: string): string {
  return [
    "exec env -i",
    'HOME="$HOME"',
    'USER="${USER:-$(id -un)}"',
    'LOGNAME="${LOGNAME:-${USER:-$(id -un)}}"',
    'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    'DISPLAY="${DISPLAY:-:0}"',
    'XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"',
    'XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}"',
    "/bin/bash -c",
    shellQuote(command),
  ].join(" ");
}

/** Start the already-installed daemon after a box resume. This is cheap when
 * it is healthy and intentionally does not install anything on the hot path. */
export function ensureRemoteCuaCommand(): string {
  return [
    `if [ -x ${REMOTE_CUA_EXECUTABLE} ]; then`,
    `  mkdir -p ${REMOTE_CUA_SOCKET.slice(0, REMOTE_CUA_SOCKET.lastIndexOf("/"))}`,
    `  if ! ${REMOTE_CUA_EXECUTABLE} status --socket ${REMOTE_CUA_SOCKET} >/dev/null 2>&1; then`,
    `    rm -f ${REMOTE_CUA_SOCKET}`,
    '    display=${DISPLAY:-$(find /tmp/.X11-unix -maxdepth 1 -name "X*" -printf ":%f\\n" 2>/dev/null | sed "s/:X/:/" | head -1)}',
    '    display=${display:-:0}',
    `    nohup env HOME="$HOME" DISPLAY="$display" CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${REMOTE_CUA_EXECUTABLE} serve --socket ${REMOTE_CUA_SOCKET} --permission-mode standard > /tmp/ogb-cua-driver.log 2>&1 &`,
    `    for i in 1 2 3 4 5 6 7 8 9 10; do ${REMOTE_CUA_EXECUTABLE} status --socket ${REMOTE_CUA_SOCKET} >/dev/null 2>&1 && break; sleep 0.2; done`,
    "  fi",
    "fi",
  ].join("\n");
}

/** Idempotent setup. The exact wheel is verified before its bundled native
 * executable is installed; installation remains asynchronous so first-time
 * provisioning does not block the desktop for several minutes. */
export function remoteComputerBootstrapCommand(botName: string): string {
  const helper = Buffer.from(CDP_HELPER_SOURCE).toString("base64");
  const installer = [
    "set -eu",
    "trap 'rm -f /tmp/ogb-cua-installing' EXIT",
    "sudo mkdir -p /opt/ogb/run",
    'sudo chown -R "$(id -u):$(id -g)" /opt/ogb',
    'arch="$(uname -m)"',
    `case "$arch" in x86_64) url=${shellQuote(REMOTE_CUA_WHEELS.x86_64.url)}; sha=${REMOTE_CUA_WHEELS.x86_64.sha256} ;; aarch64|arm64) url=${shellQuote(REMOTE_CUA_WHEELS.aarch64.url)}; sha=${REMOTE_CUA_WHEELS.aarch64.sha256} ;; *) echo "unsupported architecture: $arch" >&2; exit 1 ;; esac`,
    'wheel="/tmp/cua-driver-${sha}.whl"',
    'curl -fsSL "$url" -o "$wheel"',
    'echo "$sha  $wheel" | sha256sum -c -',
    'python3 - "$wheel" <<\'PY\'\nimport os, sys, zipfile\nwheel = sys.argv[1]\nwith zipfile.ZipFile(wheel) as archive:\n    names = [name for name in archive.namelist() if name == "cua_driver/bin/cua-driver" or name.endswith("/cua_driver/bin/cua-driver")]\n    if len(names) != 1:\n        raise SystemExit("cua-driver executable missing from wheel")\n    with archive.open(names[0]) as source, open("/opt/ogb/cua-driver", "wb") as target:\n        target.write(source.read())\nos.chmod("/opt/ogb/cua-driver", 0o755)\nPY',
    `test "$(${REMOTE_CUA_EXECUTABLE} --version)" = "cua-driver ${REMOTE_CUA_VERSION}"`,
    `touch /opt/ogb/cua-${REMOTE_CUA_VERSION}-ready`,
    'rm -f "$wheel"',
  ].join("\n");
  // The display name is untrusted. Encode the banner before composing the
  // nested tmux shell so substitutions/backticks can never become syntax.
  const banner = Buffer.from(`  ▦ ${botName}'s computer — OpenMausBot`).toString("base64");
  const tmuxSessionCommand = [
    "echo",
    `printf %s ${shellQuote(banner)} | base64 -d`,
    "echo",
    "exec bash -i",
  ].join("; ");
  return [
    "if ! command -v xdotool >/dev/null || ! command -v convert >/dev/null || ! command -v curl >/dev/null || ! command -v python3 >/dev/null; then sudo apt-get update -qq || true; sudo apt-get install -y -qq ca-certificates curl python3 gnome-screenshot xclip wmctrl xdotool imagemagick scrot >/dev/null 2>&1 || true; fi",
    "sudo mkdir -p /opt/ogb/run",
    `printf %s ${shellQuote(helper)} | base64 -d | sudo tee ${REMOTE_CDP_HELPER} >/dev/null`,
    `sudo chmod 0755 ${REMOTE_CDP_HELPER}`,
    'pkill -f "^/opt/ogb/venv/bin/python -m computer_server( |$)" >/dev/null 2>&1 || true',
    `[ -f /opt/ogb/cua-${REMOTE_CUA_VERSION}-ready ] || [ -f /tmp/ogb-cua-installing ] || { touch /tmp/ogb-cua-installing; nohup bash -c ${shellQuote(installer)} > /tmp/ogb-cua-install.log 2>&1 & }`,
    ensureRemoteCuaCommand(),
    `tmux has-session -t work 2>/dev/null || tmux new-session -d -s work ${shellQuote(tmuxSessionCommand)}`,
    "echo bootstrapped",
  ].join("\n");
}

export function semanticBrowserCommand(action: "snapshot" | "click" | "fill", input: unknown): string {
  const encoded = Buffer.from(JSON.stringify(input ?? {})).toString("base64url");
  return `node ${REMOTE_CDP_HELPER} ${action} ${shellQuote(encoded)}`;
}
