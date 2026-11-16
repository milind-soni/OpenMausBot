// Runs the real Studio UI and Preview guest in a disposable Electron app.
// All server data, provider processes (fake CLI) and fixture files are isolated.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, realpathSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import electronPath from "electron";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temp = mkdtempSync(join(tmpdir(), "gbs-bot-preview-"));
const artifacts = process.env.GBS_QA_ARTIFACTS ?? join(root, ".omb-scratch", "bot-preview-testing"); mkdirSync(artifacts, { recursive: true });
const data = join(temp, "data"), project = join(temp, "project"); mkdirSync(data); mkdirSync(project);
const children = []; const submissions = []; let fixture; let errors = "";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, timeout = 20000) { const deadline = Date.now() + timeout; let last; do { try { last = await read(); if (predicate(last)) return last; } catch {} await delay(50); } while (Date.now() < deadline); throw new Error(`Observable state did not arrive: ${JSON.stringify(last)?.slice(0, 1000)}\n${errors.slice(-2000)}`); }
async function freePort() { const s = createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const port = await freePort(), controlPort = await freePort(), base = `http://127.0.0.1:${port}`, secret = randomUUID();
async function json(url, method = "GET", body, headers = {}) { const r = await fetch(url, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35000) }); const value = await r.json(); if (!r.ok) throw new Error(`${r.status}: ${value.error}`); return value; }
const api = (path, method, body) => json(base + path, method, body);
const desktop = (path, body) => json(`http://127.0.0.1:${controlPort}${path}`, body === undefined ? "GET" : "POST", body, { authorization: secret });
function child(command, args, env) { const p = spawn(command, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] }); p.stderr.on("data", c => { errors += c; }); children.push(p); return p; }
function mcp(entry) {
  const proc = child(entry.command, entry.args, { ...process.env, ...entry.env }); let id = 0, buffer = ""; const pending = new Map();
  proc.stdout.on("data", c => { buffer += c; let end; while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue; let msg; try { msg = JSON.parse(line); } catch { continue; } pending.get(msg.id)?.(msg); pending.delete(msg.id); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(new Error(`MCP ${method} timed out`)); }, 35000); pending.set(key, value => { clearTimeout(timer); resolve(value); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: key, method, params }) + "\n"); });
  return { rpc, async call(name, args = {}, allowError = false) { const reply = await rpc("tools/call", { name, arguments: args }); if (reply.result?.isError && !allowError) throw new Error(reply.result.content[0].text); return reply.result; } };
}
const text = result => JSON.parse(result.content[0].text);
try {
  const html = `<!doctype html><html><head><title>Preview testing fixture</title><style>body{font:18px system-ui;padding:32px;background:#f5f7fb;color:#172033;min-height:1500px}form{display:grid;gap:16px;max-width:420px}input,select,button{font:inherit;padding:10px}#narrow{display:none}@media(max-width:500px){#narrow{display:block}#wide{display:none}}</style></head><body><h1>Preview testing fixture</h1><p id="narrow">Narrow layout</p><p id="wide">Wide layout</p><form><label>Name<input name="name" required></label><label>Plan<select name="plan"><option value="basic">Basic</option><option value="pro">Pro</option></select></label><button>Save profile</button></form><p role="status" id="result">Waiting for input</p><button id="error">Report error</button><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#result').textContent='Saved '+document.querySelector('input').value+' '+document.querySelector('select').value;fetch('/record?name='+encodeURIComponent(document.querySelector('input').value))};document.querySelector('#error').onclick=()=>{console.error('Fixture diagnostic');fetch('/missing')};</script></body></html>`;
  writeFileSync(join(project, "index.html"), html);
  fixture = createServer((req, res) => { if (req.url.startsWith("/record?")) { submissions.push(new URL(req.url,"http://fixture").searchParams.get("name")); res.setHeader("content-type","application/json"); return res.end("{}"); } if (req.url === "/missing") { res.writeHead(404); return res.end("Missing fixture"); } if (req.url === "/redirect-app") { res.writeHead(302, { location: base + "/api/config" }); return res.end(); } res.setHeader("content-type", "text/html"); res.end(html); });
  await new Promise(r => fixture.listen(0, "127.0.0.1", r)); const fixtureURL = `http://127.0.0.1:${fixture.address().port}/`;
  const wrapper = join(temp, "fake-claude.mjs"), dump = join(temp, "claude.json");
  writeFileSync(wrapper, `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('fake-cli 2.1.312');process.exit(0)}\nprocess.env.FAKE_CLAUDE_MODE='happy';process.env.FAKE_CLAUDE_DUMP=${JSON.stringify(dump)};await import(${JSON.stringify(pathToFileURL(join(root, "server/testing/fake-claude-cli.ts")).href)});`); chmodSync(wrapper, 0o755);
  const instances = { qa: { driver: "claudeAgent", config: { cli: wrapper, permissionMode: "bypassPermissions" } } };
  if (process.env.GBS_QA_LIVE_CODEX) {
    const liveWrapper = join(temp, "live-codex.mjs");
    writeFileSync(liveWrapper, `#!/usr/bin/env node\nimport {spawn} from 'node:child_process';const child=spawn(${JSON.stringify(process.env.GBS_QA_LIVE_CODEX)},process.argv.slice(2),{stdio:'inherit',env:{...process.env,HOME:${JSON.stringify(process.env.HOME)},USERPROFILE:${JSON.stringify(process.env.HOME)}}});child.on('exit',code=>process.exit(code??1));`); chmodSync(liveWrapper,0o755);
    instances.live = { driver: "codex", config: { cli: liveWrapper, fullAuto: true } };
  }
  writeFileSync(join(data, "config.json"), JSON.stringify({ profile: { name: "Preview QA" }, instances }));
  const projectsFile = join(temp, "projects.json"); writeFileSync(projectsFile, JSON.stringify([{ id: "fixture-project", name: "Preview fixture", mention: "preview-fixture", path: project, source: "existing", addedAt: Date.now() }]));
  const env = { ...process.env, HOME: temp, USERPROFILE: temp, GBS_DATA_DIR: data, GBS_PROJECTS_FILE: projectsFile, GBS_PORT: String(port), GBS_STATIC_DIR: join(root, "dist") };
  child(process.execPath, ["--experimental-strip-types", join(root, "server/index.ts")], env);
  await until(() => api("/api/health"), x => x?.app === "gerer-build-studio");
  const bot = (await api("/api/bots", "POST", {})).bot;
  await api(`/api/bots/${bot.id}`, "PATCH", { name: "Preview tester", modelSelection: { instanceId: "qa", model: "sonnet" } });
  await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Initialize the test tool integration." });
  await until(() => existsSync(dump), Boolean);
  const argv = JSON.parse(readFileSync(dump, "utf8")).argv;
  const entry = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]).mcpServers.agents;
  const proxy = mcp(entry); await proxy.rpc("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(text(await proxy.call("preview_status")).available, false);
  const runner = join(root, "scripts/testing/preview-testing-desktop.mjs");
  child(electronPath, [runner], { ...env, ELECTRON_RUN_AS_NODE: undefined, GBS_QA_BASE: base, GBS_QA_SECRET: secret, GBS_QA_CONTROL_PORT: String(controlPort), GBS_QA_PRELOAD: join(root, "electron/preload.cjs"), GBS_QA_USER_DATA: join(temp, "electron-profile") });
  await until(() => desktop("/state"), x => x !== undefined);
  await until(async () => text(await proxy.call("preview_status")), s => s.available);
  console.log("Desktop bridge ready; opening fixture");
  const result = text(await proxy.call("preview_open", { url: fixtureURL, project_id: "fixture-project", name: "Profile form", preset: "phone" }));
  console.log("Fixture opened");
  const id = result.sessionId; assert.equal(result.viewport.width, 390);
  await until(() => desktop("/state"), x => x.text?.includes("Controlled by Preview tester"));
  const act = args => proxy.call("preview_action", { session_id: id, ...args });
  let snapshot = text(await proxy.call("preview_snapshot", { session_id: id }));
  const control = name => snapshot.controls.find(c => c.name === name)?.ref;
  assert.ok(control("Name"), JSON.stringify(snapshot.controls));
  await act({ action: "fill", ref: control("Name"), text: "Ada" });
  await act({ action: "fill", ref: control("Name"), text: "" });
  await act({ action: "fill", ref: control("Name"), text: "Ada" });
  await act({ action: "select", ref: control("Plan"), value: "pro" });
  await act({ action: "click", ref: control("Save profile") });
  try { await act({ action: "wait", text: "Saved Ada pro" }); } catch(error) {
    console.log("Form debug", text(await proxy.call("preview_snapshot", { session_id: id })));
    await desktop("/capture", { path: join(artifacts, "failed-form.png") });
    throw error;
  }
  await act({ action: "fill", ref: control("Name"), text: "Grace" });
  await act({ action: "press", ref: control("Name"), key: "Enter" });
  await act({ action: "wait", text: "Saved Grace pro" });
  await act({ action: "fill", ref: control("Name"), text: "Ada" });
  await act({ action: "press", ref: control("Name"), key: "Enter" });
  await act({ action: "wait", text: "Saved Ada pro" });
  snapshot = text(await proxy.call("preview_snapshot", { session_id: id })); assert.ok(snapshot.text.includes("Saved Ada pro")); assert.ok(snapshot.text.includes("Narrow layout"));
  const stale = control("Name"); await proxy.call("preview_snapshot", { session_id: id });
  assert.equal((await proxy.call("preview_action", { session_id: id, action: "click", ref: stale }, true)).isError, true);
  snapshot = text(await proxy.call("preview_snapshot", { session_id: id }));
  await act({ action: "click", ref: control("Report error") });
  const diagnostics = await until(async () => text(await proxy.call("preview_diagnostics", { session_id: id })), x => x.events.some(e => e.kind === "http" && e.status === 404));
  assert.ok(diagnostics.events.some(e => e.message?.includes("Fixture diagnostic")));
  for (const [width, height] of [[768,1024],[1440,900],[390,844]]) { const sized = text(await act({ action: "resize", width, height })); assert.equal(sized.viewport.width, width); assert.equal(sized.viewport.height, height); }
  console.log("Forms, diagnostics and viewports verified");
  const image = await proxy.call("preview_screenshot", { session_id: id, full_page: true });
  assert.equal(image.content[1].type, "image"); const evidence = text(image); assert.ok(evidence.artifactPath.startsWith(realpathSync(project))); assert.equal(existsSync(evidence.artifactPath), true);
  writeFileSync(join(artifacts, "full-page.png"), Buffer.from(image.content[1].data, "base64"));
  const second = text(await proxy.call("preview_open", { url: fixtureURL, name: "Second bot target", preset: "tablet" }));
  const inactiveImage = await proxy.call("preview_screenshot", { session_id: second.sessionId });
  writeFileSync(join(artifacts,"second-session.png"),Buffer.from(inactiveImage.content[1].data,"base64"));
  assert.notEqual(second.sessionId, id); assert.equal((await desktop("/state")).count, 2);
  assert.ok(text(await proxy.call("preview_snapshot", { session_id: id })).text.includes("Saved Ada pro"));
  const other = (await api("/api/bots", "POST", {})).bot;
  const foreign = await fetch(`${base}/api/internal/preview-testing/snapshot`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${entry.env.GBS_COMMS_TOKEN}`, "x-gbs-bot-id": other.id, "x-gbs-preview-token": entry.env.GBS_PREVIEW_TOKEN }, body: JSON.stringify({ session_id: id }) }); assert.equal(foreign.status, 401);
  console.log("Evidence and isolation verified");
  const pending = proxy.call("preview_action", { session_id: id, action: "wait", text: "This text never appears", timeout_ms: 10000 }, true);
  await until(async () => text(await proxy.call("preview_status")), x => x.sessions.some(s => s.id === id && s.runningOperation === "wait"));
  const queued = proxy.call("preview_action", { session_id: id, action: "scroll", y: 600 }, true);
  await until(async () => text(await proxy.call("preview_status")), x => x.sessions.some(s => s.id === id && s.pendingCount === 2));
  await desktop("/control", { sessionId: id, action: "pause" });
  assert.equal((await pending).isError, true); assert.equal((await queued).isError, true);
  assert.equal((await proxy.call("preview_snapshot", { session_id: id }, true)).isError, true);
  await desktop("/control", { sessionId: id, action: "resume" });
  assert.ok(text(await proxy.call("preview_snapshot", { session_id: id })).text.includes("Saved Ada pro"));
  await act({ action: "resize", preset: "responsive" });
  const before = text(await proxy.call("preview_snapshot", { session_id: id })).viewport;
  await desktop("/resize", { width: 1000, height: 760 });
  const after = await until(async () => text(await proxy.call("preview_snapshot", { session_id: id })).viewport, x => x.height < before.height);
  assert.ok(after.width >= 240);
  await act({ action: "navigate", url: fixtureURL + "allowed-navigation" });
  assert.ok(text(await proxy.call("preview_snapshot", { session_id: id })).url.endsWith("/allowed-navigation"));
  for (const url of [base + "/api/config", "file:///etc/hosts"]) assert.equal((await proxy.call("preview_action", { session_id: id, action: "navigate", url }, true)).isError, true);
  await proxy.call("preview_action", { session_id: id, action: "navigate", url: fixtureURL + "redirect-app" }, true);
  const blocked = text(await proxy.call("preview_snapshot", { session_id: id })); assert.ok(!blocked.url.startsWith(base + "/api/"));
  await desktop("/capture", { path: join(artifacts, "desktop.png") });
  await proxy.call("preview_close", { session_id: id }); await proxy.call("preview_close", { session_id: second.sessionId });
  const file = text(await proxy.call("preview_open", { project_id: "fixture-project", path: "index.html", preset: "desktop" }));
  assert.ok(file.text.includes("Preview testing fixture"));
  await proxy.call("preview_close", { session_id: file.sessionId });
  console.log("Navigation and project HTML verified; checking host reload");
  const reloadTarget = text(await proxy.call("preview_open", { url: fixtureURL, name: "Reload cancellation", preset: "phone" }));
  await desktop("/reload", {});
  await until(async () => text(await proxy.call("preview_status")), s => s.sessions.some(x => x.id === reloadTarget.sessionId && x.state === "paused"));
  assert.equal((await proxy.call("preview_snapshot", { session_id: reloadTarget.sessionId }, true)).isError, true);
  await proxy.call("preview_close", { session_id: reloadTarget.sessionId });
  const untrusted = await fetch(base + "/api/preview-testing/bridge"); assert.equal(untrusted.status, 401);
  const crossOrigin = await fetch(base + "/api/preview-testing/bridge", { headers: { origin: fixtureURL.slice(0,-1) } }); assert.equal(crossOrigin.status, 403);
  let live = null;
  if (process.env.GBS_QA_LIVE_CODEX) {
    console.log("Starting actual Codex Preview test");
    const beforeFiles = new Set(readdirSync(join(realpathSync(project), ".gbs-preview-evidence")));
    const before = beforeFiles.size;
    const liveBot = (await api("/api/bots", "POST", {})).bot;
    await api(`/api/bots/${liveBot.id}`, "PATCH", { name: "Live Preview tester", modelSelection: { instanceId: "live", model: process.env.GBS_QA_LIVE_MODEL ?? "gpt-6.1-sol" }, description: "You are a website tester. Use only the preview tools for this test. Do not use other bots, task tools, shell commands or external browsers." });
    await api(`/api/bots/${liveBot.id}/messages`, "POST", { text: `Test #preview-fixture at ${fixtureURL} using only preview tools. Call preview_status, open a named session with project_id fixture-project and preset phone, inspect it, fill Name with Lin, choose Plan pro, submit Save profile, and verify Saved Lin pro. Capture a screenshot. Resize to desktop and verify the actual viewport. Return a short report with exact observed text and actual viewport dimensions. Leave the session open. Do not use Chrome, shell, filesystem tools, task tools or other bots. Do not invent test results.` });
    // New bots start with a greeting; only count bot text that follows our prompt.
    const afterPrompt = b => b.messages.slice(b.messages.findLastIndex(m => m.role === "user") + 1).filter(m => m.role === "bot" && m.kind === "text");
    const completed = await until(async () => (await api("/api/bots")).bots.find(b => b.id === liveBot.id), b => b && !b.busy && afterPrompt(b).length > 0, 300000);
    const reply = afterPrompt(completed).map(m=>m.text).join("\n");
    writeFileSync(join(artifacts, "live-codex-reply.txt"), reply);
    for (const file of readdirSync(join(realpathSync(project), ".gbs-preview-evidence"))) if (!beforeFiles.has(file)) writeFileSync(join(artifacts, `live-${file}`), readFileSync(join(realpathSync(project), ".gbs-preview-evidence", file)));
    assert.ok(submissions.includes("Lin"), "Actual model did not submit the fixture form");
    assert.ok(readdirSync(join(realpathSync(project), ".gbs-preview-evidence")).length > before, "Actual model did not save screenshot evidence");
    assert.ok(reply.includes("Saved Lin pro"), reply);
    await desktop("/capture", { path: join(artifacts, "live-codex-desktop.png") });
    live = { provider: "Actual Codex CLI", model: process.env.GBS_QA_LIVE_MODEL ?? "gpt-6.1-sol", submittedName: "Lin", reply };
    writeFileSync(join(artifacts, "live-codex.json"), JSON.stringify(live,null,2));
  }
  const report = { passed: true, live, form: "Saved Ada pro", viewports: [390,768,1440,"Responsive"], actualImageBytes: Buffer.from(image.content[1].data,"base64").length, responsiveBefore: before, responsiveAfter: after, checks: ["real Electron PreviewFrame", "MCP screenshot image", "project evidence", "diagnostics", "stale refs", "session isolation", "Stop cancels queued/running commands", "user resume", "frame destruction on reload stops session", "blocked app navigation/redirect", "project HTML", "unauthenticated/cross-origin bridge rejection"], provider: process.env.GBS_QA_LIVE_CODEX ? "Fake CLI regression plus actual Codex smoke test" : "Fake Claude CLI transport; no paid model call" };
  writeFileSync(join(artifacts, "report.json"), JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
} finally {
  for (const p of children.reverse()) { p.kill("SIGTERM"); }
  await Promise.all(children.map(p => p.exitCode !== null ? undefined : Promise.race([new Promise(r => p.once("exit",r)), delay(3000).then(()=>p.kill("SIGKILL"))])));
  if (fixture) await new Promise(r => fixture.close(r));
  rmSync(temp, { recursive:true, force:true });
}
