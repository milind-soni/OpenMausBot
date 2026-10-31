#!/usr/bin/env node
// How Windows Security treats the real installer on a fresh GitHub Windows runner, after `pnpm package:win`
// (.github/workflows/windows-defender-check.yml). GitHub's image turns most of Defender off and excludes every drive, so
// its protection is first set to a home PC's defaults. The installer is saved with a browser download's Zone.Identifier
// (ZoneId=3), started the way a double-click starts it, and the app opened for two minutes; Start screen control is
// then pressed through the app's DevTools port. report.md says what Defender found, whether cua-driver-background.exe
// runs and whether Start screen control worked; the run fails when any of those went wrong. It changes Defender's
// settings and installs the app, so it runs only on a GitHub Windows runner.
//
//   node scripts/defender-check-win.mjs --installer release/OpenMausBot-<version>-setup.exe --out <folder> [--wait 120]
import { execFile, execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: options } = parseArgs({
  options: { installer: { type: "string" }, out: { type: "string" }, wait: { type: "string", default: "120" } },
});
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") {
  console.error("defender-check-win turns Windows Security's protection on and installs the app, so it runs only on a GitHub Windows runner.");
  process.exit(2);
}
if (!options.installer || !existsSync(options.installer) || !options.out) {
  console.error("usage: node scripts/defender-check-win.mjs --installer <OpenMausBot-<version>-setup.exe> --out <folder> [--wait 120]");
  process.exit(2);
}

const OUT = path.resolve(options.out);
const SCRIPTS = path.join(OUT, "powershell");
mkdirSync(SCRIPTS, { recursive: true });
const WAIT_SECONDS = Math.max(10, Number(options.wait) || 120);
const DEVTOOLS_PORT = 9339;
const STARTED = new Date();
const APP = "OpenMausBot.exe";
const DRIVER = "cua-driver-background.exe";
const DEFENDER_EVENTS = [1006, 1007, 1008, 1015, 1116, 1117];
const MPCMDRUN = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Windows Defender", "MpCmdRun.exe");
/** The app's own files: a detection naming one of these is about us, anything else is the machine's. */
const OURS = /openmausbot|cua-driver|cua_driver|cua-sdk/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const say = (line) => console.log(`[defender-check] ${line}`);
/** PowerShell 5.1 can hand back a one-item list as the item itself. */
const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const firstLines = (text) => String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 6).join(" | ");

function run(file, args, timeout = 120_000, signal = undefined) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, signal, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : null) : 0,
        timedOut: Boolean(error?.killed),
        out: String(stdout ?? "").trim(),
        err: String(stderr ?? "").trim(),
        error: error && typeof error.code !== "number" ? `${error.code ?? ""} ${error.message}`.trim() : undefined,
      });
    });
  });
}

const PRELUDE = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
Remove-TypeData -TypeName System.Array -ErrorAction SilentlyContinue`;
let scriptCount = 0;

/** Windows PowerShell 5.1, where the Defender cmdlets live. */
async function ps(script, timeout = 120_000, signal = undefined) {
  const base = path.join(SCRIPTS, String(++scriptCount).padStart(2, "0"));
  writeFileSync(`${base}.ps1`, `\uFEFF${PRELUDE}
try {
$result = @(& {
${script}
})
ConvertTo-Json -InputObject $result -Depth 6 -Compress | Set-Content -LiteralPath ${quote(`${base}.json`)} -Encoding UTF8
} catch {
[Console]::Error.WriteLine($_.Exception.Message)
exit 1
}
`);
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${base}.ps1`], timeout, signal);
  if (result.code !== 0 || !existsSync(`${base}.json`)) {
    throw new Error(result.timedOut ? `no answer within ${timeout / 1000} s` : firstLines(result.err || result.error || result.out) || `PowerShell ended with ${result.code}`);
  }
  const answer = JSON.parse(readFileSync(`${base}.json`, "utf8").replace(/^\uFEFF/, "") || "[]");
  return Array.isArray(answer) ? answer : [answer];
}

const report = { started: STARTED.toISOString(), commit: git(["rev-parse", "HEAD"]), version: appVersion(), errors: [] };

async function step(name, check) {
  say(name);
  try {
    return await check();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.errors.push(`${name}: ${message}`);
    say(`${name}: ${message}`);
    return { error: message };
  }
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}

function appVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}

const MACHINE = String.raw`
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  os = "$($os.Caption)"; version = "$($os.Version)"; image = "$env:ImageOS $env:ImageVersion".Trim()
  user = "$env:USERDOMAIN\$env:USERNAME"; session = (Get-Process -Id $PID).SessionId
  defenderService = "$((Get-Service WinDefend -ErrorAction SilentlyContinue).Status)"
}`;

const defenderNow = (label) => ps(String.raw`
Get-MpComputerStatus | Format-List * | Out-File -LiteralPath ${quote(path.join(OUT, `defender-status-${label}.txt`))} -Width 200
Get-MpPreference | Format-List * | Out-File -LiteralPath ${quote(path.join(OUT, `defender-preferences-${label}.txt`))} -Width 200
$status = Get-MpComputerStatus
$preferences = Get-MpPreference
$policies = foreach ($key in 'HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender', 'HKLM:\SOFTWARE\Policies\Microsoft\Windows Advanced Threat Protection') {
  if (Test-Path -LiteralPath $key) {
    foreach ($item in @(Get-Item -LiteralPath $key) + @(Get-ChildItem -LiteralPath $key -Recurse)) {
      foreach ($name in $item.Property) { "$($item.Name -replace '^HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\', '')\$name = $($item.GetValue($name))" }
    }
  }
}
[pscustomobject]@{
  realTimeProtection = $status.RealTimeProtectionEnabled; onAccessProtection = $status.OnAccessProtectionEnabled
  behaviourMonitoring = $status.BehaviorMonitorEnabled; downloadScanning = $status.IoavProtectionEnabled
  antivirus = $status.AntivirusEnabled; runningMode = "$($status.AMRunningMode)"; tamperProtected = $status.IsTamperProtected
  signatureVersion = "$($status.AntivirusSignatureVersion)"; signatureAge = $status.AntivirusSignatureAge; signatureUpdated = "$($status.AntivirusSignatureLastUpdated)"
  engineVersion = "$($status.AMEngineVersion)"; productVersion = "$($status.AMProductVersion)"
  cloudProtection = [int]$preferences.MAPSReporting; sampleSubmission = [int]$preferences.SubmitSamplesConsent
  blockAtFirstSight = -not $preferences.DisableBlockAtFirstSeen; puaProtection = [int]$preferences.PUAProtection
  exclusions = @(@($preferences.ExclusionPath) + @($preferences.ExclusionProcess) + @($preferences.ExclusionExtension) | Where-Object { $_ } | ForEach-Object { "$_" })
  policies = @($policies)
}`).then(([answer]) => ({ ...answer, exclusions: list(answer.exclusions), policies: list(answer.policies) }));

/** A home PC's defaults: real-time, behaviour and download scanning, cloud protection with automatic safe samples
 * (what block at first sight needs) and blocking unwanted apps; and none of the drive exclusions GitHub adds. */
const TURN_ON = String.raw`
$settings = foreach ($setting in @(
  @{ DisableRealtimeMonitoring = $false }, @{ DisableBehaviorMonitoring = $false }, @{ DisableIOAVProtection = $false },
  @{ DisableScriptScanning = $false }, @{ DisableArchiveScanning = $false }, @{ DisableBlockAtFirstSeen = $false },
  @{ MAPSReporting = 2 }, @{ SubmitSamplesConsent = 1 }, @{ PUAProtection = 1 })) {
  $name = @($setting.Keys)[0]
  try { Set-MpPreference @setting; [pscustomobject]@{ setting = "$name = $($setting[$name])"; done = $true; why = '' } }
  catch { [pscustomobject]@{ setting = "$name = $($setting[$name])"; done = $false; why = "$($_.Exception.Message)".Trim() } }
}
$preferences = Get-MpPreference
$exclusions = foreach ($kind in 'ExclusionPath', 'ExclusionProcess', 'ExclusionExtension') {
  foreach ($value in @($preferences.$kind | Where-Object { $_ })) {
    $remove = @{}
    $remove[$kind] = $value
    try { Remove-MpPreference @remove; [pscustomobject]@{ exclusion = "$value"; removed = $true; why = '' } }
    catch { [pscustomobject]@{ exclusion = "$value"; removed = $false; why = "$($_.Exception.Message)".Trim() } }
  }
}
[pscustomobject]@{ settings = @($settings); exclusions = @($exclusions) }`;
const turnOn = async () => {
  const [answer] = await ps(TURN_ON);
  return { settings: list(answer.settings), exclusions: list(answer.exclusions) };
};

const SMART_SCREEN = String.raw`
function Read-Value($key, $name) { try { "$((Get-ItemProperty -LiteralPath $key -Name $name).$name)" } catch { '' } }
[pscustomobject]@{
  explorer = Read-Value 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' 'SmartScreenEnabled'
  policy = Read-Value 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'EnableSmartScreen'
  policyLevel = Read-Value 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'ShellSmartScreenLevel'
  smartAppControl = Read-Value 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' 'VerifiedAndReputablePolicyState'
}`;

async function waitForRealTime(ms) {
  const until = Date.now() + ms;
  for (;;) {
    const [on] = await ps("(Get-MpComputerStatus).RealTimeProtectionEnabled");
    if (on === true || Date.now() > until) return on === true;
    await sleep(3000);
  }
}

const screenshot = (file) => ps(String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
$bitmap.Save(${quote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[pscustomobject]@{ file = ${quote(path.basename(file))}; width = $bounds.Width; height = $bounds.Height }`).then(([shot]) => shot, (error) => ({ error: error.message }));

/** The windows on screen, and whether the installer or SmartScreen runs. */
const onScreen = (installer) => ps(String.raw`
$windows = @(Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle } })
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'smartscreen.exe', 'consent.exe', ${quote(path.basename(installer))} } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = "$($_.Name)" } })
[pscustomobject]@{ windows = $windows; processes = $processes }`).then(([seen]) => ({ windows: list(seen.windows), processes: list(seen.processes) }));

/** Saved to Downloads with the mark a browser gives a download (the Internet zone), so Windows treats it as one. */
async function saveAsDownload(installer) {
  const [saved] = await ps(String.raw`
$downloads = Join-Path $env:USERPROFILE 'Downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$target = Join-Path $downloads ${quote(path.basename(installer))}
Copy-Item -LiteralPath ${quote(installer)} -Destination $target -Force
Set-Content -LiteralPath $target -Stream Zone.Identifier -Value @('[ZoneTransfer]', 'ZoneId=3', 'ReferrerUrl=https://www.openmausbot.com/download', 'HostUrl=https://github.com/milind-soni/OpenMausBot/releases/latest/download/OpenMausBot-setup.exe')
[pscustomobject]@{
  path = $target; bytes = (Get-Item -LiteralPath $target).Length; sha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  zone = @(Get-Content -LiteralPath $target -Stream Zone.Identifier) -join ' | '
  signature = "$((Get-AuthenticodeSignature -LiteralPath $target).Status)"
}`);
  // Real-time protection acts on a file just written; give it the moment it takes.
  await sleep(15_000);
  return { ...saved, stillThere: existsSync(saved.path) };
}

/** Defender's verdict on a file or folder, without acting on it or logging it (so the event log keeps only what
 * real-time protection did). */
async function scan(target) {
  const result = await run(MPCMDRUN, ["-Scan", "-ScanType", "3", "-File", target, "-DisableRemediation"], 900_000);
  const output = `${result.out}\n${result.err}`.trim();
  return {
    target,
    ran: result.code === 0 || result.code === 2,
    clean: result.code === 0,
    code: result.code,
    threats: [...output.matchAll(/^\s*Threat\s*:\s*(.+)$/gim)].map((match) => match[1].trim()),
    files: [...output.matchAll(/^\s*file\s*:\s*(.+)$/gim)].map((match) => match[1].trim()),
    output: output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-12),
  };
}

function installedFolder() {
  const programs = path.join(process.env.LOCALAPPDATA ?? "", "Programs");
  if (!existsSync(programs)) return null;
  const name = readdirSync(programs).find((entry) => existsSync(path.join(programs, entry, APP)));
  return name ? path.join(programs, name) : null;
}

/** First the way a double-click starts it: Windows' shell checks a downloaded file before it runs, and a prompt it shows
 * waits for a click nobody gives here, with no installer running. Then, if that didn't install it, directly. */
async function install(installer) {
  const began = Date.now();
  const stop = new AbortController();
  const shellStart = ps(String.raw`
$process = Start-Process -FilePath ${quote(installer)} -ArgumentList '/S' -PassThru
$null = $process.Handle
$exited = $process.WaitForExit(240000)
if (-not $exited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
[pscustomobject]@{ exited = $exited; exitCode = $(if ($exited) { $process.ExitCode } else { $null }) }`, 300_000, stop.signal)
    .then((answer) => answer[0], (error) => ({ error: error.message }));
  const settled = await Promise.race([shellStart, sleep(30_000).then(() => null)]);
  let held = null;
  if (!settled) {
    const [seen, shot] = await Promise.all([onScreen(installer).catch((error) => ({ error: error.message })), screenshot(path.join(OUT, "shell-start.png"))]);
    const installing = seen.processes?.some((entry) => entry.name.toLowerCase() === path.basename(installer).toLowerCase());
    held = { windows: seen.windows ?? [], processes: seen.processes ?? [], screenshot: shot, error: seen.error };
    if (seen.processes && !installing) stop.abort();
  }
  const shell = { ...(await shellStart), held: Boolean(held && stop.signal.aborted), seen: held };
  const shellSeconds = Math.round((Date.now() - began) / 1000);
  let folder = installedFolder();
  let direct = null;
  if (!folder) {
    // A start the shell never finished may have left the installer waiting.
    await run("taskkill.exe", ["/F", "/IM", path.basename(installer)], 60_000);
    const result = await run(installer, ["/S"], 300_000);
    direct = { code: result.code, timedOut: result.timedOut, error: result.error };
    folder = installedFolder();
  }
  return { shell: { ...shell, seconds: shellSeconds }, direct, folder, seconds: Math.round((Date.now() - began) / 1000) };
}

const installedFiles = (folder) => ps(String.raw`
$root = ${quote(folder)}
$names = @('OpenMausBot.exe', 'resources\cua-driver-background.exe', 'resources\cua-driver.exe')
$sdk = Join-Path $root 'resources\cua-sdk'
if (Test-Path -LiteralPath $sdk) {
  $names += @(Get-ChildItem -LiteralPath $sdk -Recurse -File | Where-Object { $_.Extension -in '.exe', '.node', '.dll' } | ForEach-Object { $_.FullName.Substring($root.Length + 1) })
}
foreach ($name in $names) {
  $file = Join-Path $root $name
  if (Test-Path -LiteralPath $file) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    [pscustomobject]@{ file = $name; present = $true; bytes = (Get-Item -LiteralPath $file).Length; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash; signature = "$($signature.Status)"; signer = "$($signature.SignerCertificate.Subject)" }
  } else {
    [pscustomobject]@{ file = $name; present = $false; bytes = 0; sha256 = ''; signature = ''; signer = '' }
  }
}`);

async function processes() {
  const list = await ps(String.raw`
Get-CimInstance Win32_Process -Filter "Name = '${APP}' OR Name = '${DRIVER}'" | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = "$($_.Name)"; path = "$($_.ExecutablePath)" } }`)
    .catch(() => []);
  const named = (name) => list.filter((entry) => String(entry.name).toLowerCase() === name.toLowerCase());
  return { app: named(APP).length, driver: named(DRIVER).map((entry) => ({ pid: entry.pid, path: entry.path })) };
}

const describe = (now) => `${now.app ? `app running (${now.app} processes)` : "app not running"}; ${
  now.driver.length ? `${DRIVER} running (pid ${now.driver.map((entry) => entry.pid).join(", ")})` : `${DRIVER} not running`}`;

/** Opened as a person opens it, without the runner's own variables, plus a DevTools port for Start screen control. */
async function watchApp(exe) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CI|GITHUB_\w*|RUNNER_\w*|ACTIONS_\w*)$/i.test(key)));
  const child = spawn(exe, [`--remote-debugging-port=${DEVTOOLS_PORT}`], {
    env,
    stdio: ["ignore", openSync(path.join(OUT, "app-stdout.log"), "w"), openSync(path.join(OUT, "app-stderr.log"), "w")],
  });
  const refused = await new Promise((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (error) => resolve(error.message));
  });
  if (refused) return { opened: false, error: `the app didn't start: ${refused}` };
  const began = Date.now();
  const timeline = [];
  let last = "";
  let driverFirstSeen = null;
  for (let second = 0; ; second += 10) {
    const now = await processes();
    const elapsed = Math.round((Date.now() - began) / 1000);
    if (now.driver.length && driverFirstSeen === null) driverFirstSeen = elapsed;
    const line = describe(now);
    if (line !== last) timeline.push(`${elapsed} s: ${line}`);
    last = line;
    if (second >= WAIT_SECONDS) {
      const shot = await screenshot(path.join(OUT, "app-open.png"));
      return { opened: true, timeline, driverFirstSeen, appRunning: now.app > 0, driver: now.driver, screenshot: shot };
    }
    const wait = began + (second + 10) * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
  }
}

async function devtools(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("the app's DevTools port refused the connection")), { once: true });
  });
  let last = 0;
  const waiting = new Map();
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(String(event.data));
    const settle = waiting.get(reply.id);
    if (!settle) return;
    waiting.delete(reply.id);
    settle(reply);
  });
  return {
    close: () => socket.close(),
    evaluate: (expression, ms = 30_000) => new Promise((resolve, reject) => {
      const id = ++last;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`no answer within ${ms / 1000} s`));
      }, ms);
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        const failed = reply.error?.message ?? reply.result?.exceptionDetails?.exception?.description ?? reply.result?.exceptionDetails?.text;
        if (failed) reject(new Error(failed));
        else resolve(reply.result?.result?.value);
      });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    }),
  };
}

/** The app's own window: the local server's page, with the full desktop bridge. */
async function appPage(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json();
      for (const page of pages.filter((entry) => entry.type === "page" && /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(entry.url))) {
        const tab = await devtools(page.webSocketDebuggerUrl);
        try {
          if (await tab.evaluate("typeof window.ogb?.localControl?.retry === 'function'")) return page;
        } finally {
          tab.close();
        }
      }
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  return null;
}

const SHOWN = "window.ogb.getCapabilities().then(({ localComputer }) => localComputer)";

/** The call the Start screen control button makes. */
async function pressStart() {
  const page = await appPage(90_000);
  if (!page) return { pressed: false, error: "the app's window never showed its page on the DevTools port" };
  const tab = await devtools(page.webSocketDebuggerUrl);
  try {
    const shown = await tab.evaluate(SHOWN);
    const before = (await processes()).driver;
    const began = Date.now();
    const answer = await tab.evaluate("window.ogb.localControl.retry()", 180_000);
    const seconds = Math.round((Date.now() - began) / 1000);
    await sleep(3000);
    const after = (await processes()).driver;
    const shownAfter = await tab.evaluate(SHOWN);
    return { pressed: true, page: page.url, shown, before, answer, seconds, after, shownAfter };
  } finally {
    tab.close();
  }
}

function appLog() {
  const folder = path.join(process.env.APPDATA ?? "", "OpenMausBot", "logs");
  const file = path.join(folder, "server.log");
  if (!existsSync(file)) return { file, present: false, lines: [] };
  for (const name of readdirSync(folder)) {
    const source = path.join(folder, name);
    if (statSync(source).isFile()) copyFileSync(source, path.join(OUT, `app-log-${name}`));
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => /computer control|\[cua\]|cua-driver|screen control/i.test(line));
  return { file, present: true, lines: lines.slice(-40) };
}

async function closeApp() {
  await run("taskkill.exe", ["/F", "/T", "/IM", APP], 60_000);
  await run("taskkill.exe", ["/F", "/IM", DRIVER], 60_000);
  return { closed: true };
}

async function findings() {
  const [found] = await ps(String.raw`
$since = [datetime]::Parse(${quote(STARTED.toISOString())}).ToLocalTime()
$detections = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{
  threatId = "$($_.ThreatID)"; time = "$($_.InitialDetectionTime)"; since = ($_.InitialDetectionTime -ge $since); process = "$($_.ProcessName)"
  resources = @($_.Resources | ForEach-Object { "$_" }); action = "$($_.CleaningActionID)"; succeeded = $_.ActionSuccess; source = "$($_.DetectionSourceTypeID)" } })
$threats = @(Get-MpThreat -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{
  threatId = "$($_.ThreatID)"; name = "$($_.ThreatName)"; severity = "$($_.SeverityID)"; active = $_.IsActive; executed = $_.DidThreatExecute
  resources = @($_.Resources | ForEach-Object { "$_" }) } })
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; Id = ${DEFENDER_EVENTS.join(", ")}; StartTime = $since } -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ time = $_.TimeCreated.ToString('o'); id = $_.Id; message = "$($_.Message)" } })
[pscustomobject]@{ detections = $detections; threats = $threats; events = $events }`);
  const field = (message, name) => message.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "mi"))?.[1]?.trim() ?? "";
  const events = list(found.events);
  writeFileSync(path.join(OUT, "defender-events.txt"), events.map((event) => `${event.time}  event ${event.id}\n${event.message}\n`).join("\n") || "none\n");
  const threats = list(found.threats).map((threat) => ({ ...threat, resources: list(threat.resources) }));
  const names = new Map(threats.map((threat) => [threat.threatId, threat.name]));
  return {
    detections: list(found.detections).filter((detection) => detection.since)
      .map((detection) => ({ ...detection, resources: list(detection.resources).map((resource) => resource.replace(/^file:_/i, "")), name: names.get(detection.threatId) ?? "" })),
    threats,
    events: events.map((event) => ({
      time: event.time,
      id: event.id,
      threat: field(event.message, "Name"),
      path: field(event.message, "Path").replace(/^file:_/i, ""),
      source: field(event.message, "Detection Source"),
      action: field(event.message, "Action"),
      process: field(event.message, "Process Name"),
    })),
  };
}

report.machine = await step("the machine", async () => (await ps(MACHINE))[0]);
report.asFound = await step("Defender as GitHub's machine has it", () => defenderNow("as-found"));
report.turnOn = await step("turn Defender's protection on as a home PC has it", turnOn);
report.realTimeOn = await step("wait for real-time protection", () => waitForRealTime(45_000));
report.cloud = await step("Defender's cloud connection", async () => {
  const result = await run(MPCMDRUN, ["-ValidateMapsConnection"], 180_000);
  return { reached: result.code === 0, output: firstLines(`${result.out}\n${result.err}`) || result.error || `ended with ${result.code}` };
});
report.signatureUpdate = await step("update Defender's signatures", async () => (await ps("Update-MpSignature\n'updated'", 900_000))[0]);
report.protection = await step("Defender after turning it on", () => defenderNow("turned-on"));
report.smartScreen = await step("SmartScreen on this machine", async () => (await ps(SMART_SCREEN))[0]);
report.download = await step("save the installer like a browser download", () => saveAsDownload(path.resolve(options.installer)));
const downloaded = report.download?.stillThere ? report.download.path : null;
report.installerScan = downloaded ? await step("Defender's scan of the installer", () => scan(downloaded)) : null;
report.install = downloaded ? await step("install it silently", () => install(downloaded)) : null;
const folder = report.install?.folder ?? null;
report.files = folder ? await step("the installed files", () => installedFiles(folder)) : null;
report.app = folder ? await step(`open the app and watch it for ${WAIT_SECONDS} s`, () => watchApp(path.join(folder, APP))) : null;
report.startScreen = report.app?.opened ? await step("press Start screen control", () => pressStart()) : null;
report.log = await step("the app's log", () => appLog());
await step("close the app", () => closeApp());
report.appScan = folder ? await step("Defender's scan of the installed app", () => scan(folder)) : null;
report.findings = await step("what Windows Security found", () => findings());
report.end = await step("Defender at the end", () => defenderNow("end"));
report.finished = new Date().toISOString();

const verdict = judge(report);
report.problems = verdict.problems;
const markdown = render(report, verdict);
writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(OUT, "report.md"), markdown);
console.log(`\n${markdown}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
for (const problem of verdict.problems) console.log(`::error title=Windows Defender check::${problem}`);
process.exitCode = verdict.problems.length ? 1 : 0;

function judge(r) {
  const problems = [];
  const ourEvents = (r.findings?.events ?? []).filter((event) => OURS.test(`${event.path} ${event.process}`));
  const ourDetections = (r.findings?.detections ?? []).filter((detection) => detection.resources.some((resource) => OURS.test(resource)));
  for (const event of ourEvents) {
    problems.push(`Windows Security flagged ${event.path || "an OpenMausBot file"}: ${event.threat || `event ${event.id}`}${event.action ? ` (${event.action})` : ""}`);
  }
  if (!ourEvents.length && ourDetections.length) problems.push(`Windows Security recorded ${ourDetections.length} detection(s) in OpenMausBot's files`);
  if (r.download?.error) problems.push(`the installer couldn't be saved to Downloads: ${r.download.error}`);
  else if (r.download && !r.download.stillThere) problems.push("the installer was gone 15 s after it was saved to Downloads");
  if (r.installerScan?.ran && !r.installerScan.clean) problems.push(`Defender's scan of the installer found ${r.installerScan.threats.join(", ") || "a threat"}`);
  if (r.appScan?.ran && !r.appScan.clean) problems.push(`Defender's scan of the installed app found ${r.appScan.threats.join(", ") || "a threat"} in ${r.appScan.files.join(", ") || "its files"}`);
  if (r.download?.stillThere && !r.install?.folder) problems.push("the installer didn't install the app");
  const missing = (Array.isArray(r.files) ? r.files : []).filter((file) => !file.present).map((file) => file.file);
  if (missing.length) problems.push(`installed files are missing: ${missing.join(", ")}`);
  if (r.install?.folder && !r.app?.opened) problems.push(`the app didn't open${r.app?.error ? `: ${r.app.error}` : ""}`);
  if (r.app?.opened && !r.app.appRunning) problems.push(`the app wasn't running ${WAIT_SECONDS} s after it opened`);
  if (r.app?.opened && !r.app.driver?.length) problems.push(`${DRIVER} wasn't running ${WAIT_SECONDS} s after the app opened`);
  if (r.app?.opened) {
    if (!r.startScreen?.pressed) problems.push(`Start screen control couldn't be pressed: ${r.startScreen?.error ?? "unknown"}`);
    else if (r.startScreen.answer?.status !== "ready" || !r.startScreen.after?.length) {
      problems.push(`Start screen control didn't start it: ${r.startScreen.answer?.message ?? r.startScreen.answer?.status ?? "no answer"}`);
    }
  }
  const p = r.protection ?? {};
  const weaker = [];
  if (p.realTimeProtection !== true) weaker.push("real-time protection stayed off");
  if (p.runningMode && !/normal/i.test(p.runningMode)) weaker.push(`Defender ran in ${p.runningMode}, so it reports without blocking`);
  if (p.cloudProtection !== 2) weaker.push("cloud protection wasn't on");
  else if (r.cloud && !r.cloud.reached) weaker.push("Defender couldn't reach its cloud, so cloud verdicts and block at first sight couldn't work");
  if (p.exclusions?.length) weaker.push(`exclusions stayed: ${p.exclusions.join(", ")}`);
  return { problems, weaker, ourEvents, otherEvents: (r.findings?.events ?? []).filter((event) => !ourEvents.includes(event)) };
}

function render(r, verdict) {
  const lines = [];
  const add = (line = "") => lines.push(line);
  const yesNo = (value) => (value === true ? "yes" : value === false ? "no" : "unknown");
  const cloud = (value) => ({ 0: "off", 1: "basic", 2: "advanced" })[value] ?? `unknown (${value})`;
  const samples = (value) => ({ 0: "ask every time", 1: "send safe samples automatically", 2: "never send", 3: "send all samples automatically" })[value] ?? `unknown (${value})`;
  const unwanted = (value) => ({ 0: "off", 1: "on", 2: "audit only" })[value] ?? `unknown (${value})`;
  const failed = (part) => (part?.error ? `couldn't tell: ${part.error}` : null);
  const before = r.asFound ?? {};
  const after = r.protection ?? {};

  add("## Windows Security and the OpenMausBot installer");
  add();
  add(`OpenMausBot ${r.version}, commit \`${String(r.commit).slice(0, 12)}\`, on ${r.machine?.os ?? "Windows"} ${r.machine?.version ?? ""} (GitHub's ${r.machine?.image || "windows-latest"}).`);
  add();
  if (verdict.problems.length) {
    add("**Verdict: something went wrong for a person installing the app.**");
    for (const problem of verdict.problems) add(`- ${problem}`);
  } else {
    add(`**Verdict: Windows Security left the installer and the app alone, and screen control runs.** ${DRIVER} was running ${WAIT_SECONDS} s after the app opened, and Start screen control started it again.`);
  }
  if (verdict.weaker.length) add(`\nThis is weaker evidence than it looks, because on GitHub's machine ${verdict.weaker.join("; ")}.`);
  add();

  add("### What GitHub's machine allowed");
  if (failed(r.asFound)) add(`- Defender as found: ${failed(r.asFound)}`);
  else {
    add(`- As GitHub's machine comes: real-time protection ${before.realTimeProtection ? "on" : "off"}, cloud protection ${cloud(before.cloudProtection)}, block at first sight ${before.blockAtFirstSight ? "on" : "off"}, exclusions ${before.exclusions?.length ? before.exclusions.join(", ") : "none"}; signatures ${before.signatureVersion || "unknown"}.`);
  }
  for (const setting of r.turnOn?.settings ?? []) {
    if (!setting.done) add(`- Refused: \`Set-MpPreference -${setting.setting.replace(" = ", " ")}\`: ${setting.why}`);
  }
  const refusedExclusions = (r.turnOn?.exclusions ?? []).filter((exclusion) => !exclusion.removed);
  for (const exclusion of refusedExclusions) add(`- Couldn't remove the exclusion ${exclusion.exclusion}: ${exclusion.why}`);
  if (r.turnOn?.settings?.length && r.turnOn.settings.every((setting) => setting.done) && !refusedExclusions.length) {
    add(`- It let every setting through: \`Set-MpPreference\` turned real-time, behaviour, download and archive scanning, cloud protection, automatic safe samples, block at first sight and unwanted-app blocking on, and \`Remove-MpPreference\` took out ${(r.turnOn.exclusions ?? []).length} exclusion(s).`);
  } else if (failed(r.turnOn)) add(`- Turning protection on: ${failed(r.turnOn)}`);
  if (failed(r.protection)) add(`- Defender after turning it on: ${failed(r.protection)}`);
  else {
    add(`- During the check: real-time protection ${yesNo(after.realTimeProtection)}, running mode ${after.runningMode || "unknown"}, behaviour monitoring ${yesNo(after.behaviourMonitoring)}, download scanning ${yesNo(after.downloadScanning)}, cloud protection ${cloud(after.cloudProtection)} (${samples(after.sampleSubmission)}), block at first sight ${after.blockAtFirstSight ? "on" : "off"}, unwanted-app blocking ${unwanted(after.puaProtection)}, exclusions ${after.exclusions?.length ? after.exclusions.join(", ") : "none"}.`);
    add(`- Signatures: ${before.signatureVersion || "unknown"} before, ${after.signatureVersion || "unknown"} after the update${r.signatureUpdate?.error ? ` (the update failed: ${r.signatureUpdate.error})` : ""}, ${after.signatureAge ?? "unknown"} day(s) old; engine ${after.engineVersion || "unknown"}, platform ${after.productVersion || "unknown"}.`);
    if (r.cloud) add(`- Defender's cloud (\`MpCmdRun -ValidateMapsConnection\`): ${r.cloud.error ? `couldn't tell: ${r.cloud.error}` : r.cloud.reached ? "reached" : `**not reached**: ${r.cloud.output}`}.`);
    if (after.policies?.length) {
      const passive = after.policies.some((policy) => /ForceDefenderPassiveMode = 1/.test(policy)) && /normal/i.test(after.runningMode ?? "");
      add(`- Defender policies GitHub sets on this machine: ${after.policies.join("; ")}${passive ? ". Passive mode applies only to a machine enrolled in Microsoft Defender for Endpoint; Defender reported Normal mode, so it acts on what it finds" : ""}.`);
    }
  }
  if (r.end && !r.end.error) add(`- At the end: real-time protection ${yesNo(r.end.realTimeProtection)}, running mode ${r.end.runningMode || "unknown"}.`);
  add();

  add("### The installer");
  if (failed(r.download)) add(`- Saving it to Downloads: ${failed(r.download)}`);
  else if (r.download) {
    add(`- Saved to Downloads with a browser's mark (\`${r.download.zone}\`): ${r.download.stillThere ? "still there 15 s later" : "**gone 15 s later**"}. ${r.download.bytes} bytes, SHA-256 \`${r.download.sha256}\`, signature: ${r.download.signature}.`);
  }
  if (r.installerScan) add(`- Defender's scan of the installer: ${scanLine(r.installerScan)}.`);
  if (failed(r.install)) add(`- Installing: ${failed(r.install)}`);
  else if (r.install) {
    const shell = r.install.shell ?? {};
    const titles = (shell.seen?.windows ?? []).map((window) => `"${window.title}" (${window.name})`);
    const running = (shell.seen?.processes ?? []).map((entry) => entry.name);
    const shellLine = shell.held
      ? `held: 30 s later no installer was running${titles.length ? `; the windows on screen were ${titles.join(", ")}` : ""}${running.length ? `; running: ${running.join(", ")}` : ""}. A prompt was waiting for a click nobody gives here`
      : shell.error
        ? (/no answer within/.test(shell.error) ? `still waiting after ${shell.seconds} s` : `refused: ${shell.error}`)
        : shell.exited
          ? `finished in ${shell.seconds} s with exit code ${shell.exitCode}`
          : "still running after 4 minutes";
    add(`- Started the way a double-click starts it (\`/S\`, through the Windows shell): ${shellLine}.`);
    if (shell.seen?.screenshot) add(`- The screen 30 s after that start: ${shotLine(shell.seen.screenshot)}.`);
    if (r.install.direct) {
      add(`- Started directly instead: ${r.install.direct.code === 0 ? "finished" : `ended with ${r.install.direct.code ?? r.install.direct.error ?? "a timeout"}`}.`);
    }
    add(`- Installed: ${r.install.folder ? `yes, in \`${r.install.folder}\`` : "**no**"}.`);
  }
  if (Array.isArray(r.files)) {
    for (const file of r.files.filter((entry) => !/cua-sdk/i.test(entry.file) || !entry.present)) {
      add(`- \`${file.file}\`: ${file.present ? `${file.bytes} bytes, signature ${file.signature}${file.signer ? ` (${file.signer})` : ""}` : "**missing**"}.`);
    }
  } else if (failed(r.files)) add(`- The installed files: ${failed(r.files)}`);
  if (r.appScan) add(`- Defender's scan of the installed app, after it ran: ${scanLine(r.appScan)}.`);
  add();

  add("### Computer control");
  if (failed(r.app)) add(`- Opening the app: ${failed(r.app)}`);
  else if (r.app) {
    if (!r.app.opened) add(`- The app didn't open: ${r.app.error}`);
    else {
      add(`- ${DRIVER} ${r.app.driver?.length ? `was running ${WAIT_SECONDS} s after the app opened (pid ${r.app.driver.map((entry) => entry.pid).join(", ")}, \`${r.app.driver[0].path}\`)` : `**wasn't running** ${WAIT_SECONDS} s after the app opened`}${r.app.driverFirstSeen !== null ? `; first seen ${r.app.driverFirstSeen} s after opening` : ""}.`);
      add(`- What ran, second by second: ${r.app.timeline.join(" → ")}.`);
      if (r.app.screenshot) add(`- The screen ${WAIT_SECONDS} s after the app opened: ${shotLine(r.app.screenshot)}.`);
    }
  }
  if (failed(r.log)) add(`- The app's log: ${failed(r.log)}`);
  else if (r.log) {
    if (!r.log.present) add(`- The app's log: \`${r.log.file}\` wasn't written.`);
    else if (!r.log.lines.length) add(`- The app's log (\`${r.log.file}\`) says nothing about computer control.`);
    else {
      add(`- The app's log (\`${r.log.file}\`) says:`);
      add("```");
      for (const line of r.log.lines) add(line);
      add("```");
    }
  }
  if (failed(r.startScreen)) add(`- Start screen control: ${failed(r.startScreen)}`);
  else if (r.startScreen) {
    if (!r.startScreen.pressed) add(`- Start screen control couldn't be pressed: ${r.startScreen.error}.`);
    else {
      const answer = r.startScreen.answer ?? {};
      add(`- Before pressing it, the app showed: ${shownLine(r.startScreen.shown)}.`);
      add(`- Start screen control (the button's own call, \`window.ogb.localControl.retry()\`): ${answer.status === "ready" ? "**worked**" : "**didn't work**"} in ${r.startScreen.seconds} s, answer \`${JSON.stringify(answer)}\`; ${DRIVER} ${r.startScreen.after?.length ? `running afterwards (pid ${r.startScreen.after.map((entry) => entry.pid).join(", ")}; before: ${r.startScreen.before?.map((entry) => entry.pid).join(", ") || "none"})` : "**not running afterwards**"}.`);
      add(`- Afterwards the app showed: ${shownLine(r.startScreen.shownAfter)}.`);
    }
  }
  add();

  add("### What Windows Security found");
  const findings = r.findings;
  if (failed(findings)) add(`- ${failed(findings)}`);
  else if (findings) {
    add(`- Threat detections since the check started (\`Get-MpThreatDetection\`): ${findings.detections.length ? "" : "none."}`);
    for (const detection of findings.detections) {
      add(`  - ${detection.time}: ${detection.name || detection.threatId} in ${detection.resources.join(", ")} (action ${detection.action}, ${detection.succeeded ? "done" : "not done"}).`);
    }
    add(`- Defender Operational events ${DEFENDER_EVENTS.join(", ")}: ${findings.events.length ? "" : "none."}`);
    for (const event of findings.events) {
      add(`  - ${event.time}, event ${event.id}: ${event.threat || "(no name)"}${event.path ? ` in ${event.path}` : ""}${event.source ? `, by ${event.source}` : ""}${event.action ? `, action ${event.action}` : ""}${OURS.test(`${event.path} ${event.process}`) ? "" : " (not OpenMausBot's)"}.`);
    }
  }
  add();

  add("### Not covered here");
  add(`- GitHub's machine runs ${r.machine?.os ?? "Windows Server"}, not Windows 10 or 11. SmartScreen's "Windows protected your PC" screen (an unsigned installer from the internet shows it; people click More info, then Run anyway) and Windows 11's Smart App Control only show on a person's PC.`);
  if (r.smartScreen && !r.smartScreen.error) {
    add(`- SmartScreen here: Explorer setting "${r.smartScreen.explorer || "not set"}", policy "${r.smartScreen.policy || "not set"}"; Smart App Control: ${r.smartScreen.smartAppControl === "" ? "not on this edition" : `state ${r.smartScreen.smartAppControl}`}.`);
  }
  add(`- The full report, Defender's own status lists, its events and the app's logs are in this run's \`defender-check\` artifact.`);
  if (r.errors.length) {
    add();
    add("### Parts of the check that couldn't run");
    for (const error of r.errors) add(`- ${error}`);
  }
  add();
  return `${lines.join("\n")}\n`;
}

function shotLine(shot) {
  return shot.error ? `no screenshot (${shot.error})` : `\`${shot.file}\` in the artifact (${shot.width}×${shot.height})`;
}

function scanLine(result) {
  if (result.error) return `couldn't run: ${result.error}`;
  if (!result.ran) return `couldn't run (MpCmdRun ended with ${result.code ?? "a timeout"}: ${result.output.slice(-2).join(" ")})`;
  return result.clean ? "clean" : `**found ${result.threats.join(", ") || "a threat"}**${result.files.length ? ` in ${result.files.join(", ")}` : ""}`;
}

function shownLine(shown) {
  if (!shown) return "nothing";
  const why = [shown.reasonCode, shown.message].filter(Boolean).join(": ");
  return `computer control ${shown.available ? "available" : "not available"} (${shown.status ?? "no status"}${why ? `; ${why}` : ""})${shown.driverVersion ? `, driver ${shown.driverVersion}` : ""}`;
}
