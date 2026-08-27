// Windows adapter for a named remote CUA worker.
//
// Everything transport-shaped lives in ./remote-worker.ts. This module owns
// only what has no macOS counterpart: the PowerShell health probe, the
// interactive Session 1+ window station, the named-pipe control channel, and
// the Administrators-group rule.
import {
  applyHealthReport,
  baseWorkerStatus,
  defaultRemoteWorkerRunner,
  evaluateSharedHealth,
  failWorker,
  finishWorkerStatus,
  remoteWorkerSshBaseArgs,
  WORKER_SSH_TIMEOUT_MS,
  type RemoteWorkerLease,
  type RemoteWorkerSshRunner,
  type RemoteWorkerStatus,
} from "./remote-worker.ts";
import type { ResolvedWorker } from "./computer-workers.ts";
import { parseJson, type JsonValue } from "./schema.ts";

export const WINDOWS_CUA_PIPE = "\\\\.\\pipe\\cua-driver";
export const WINDOWS_POLICY_PATH = "%LOCALAPPDATA%\\OpenMausBot\\windows-policy.yaml";

const WINDOWS_HEALTH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$driverVersion = $null
try {
  $versionText = (& cua-driver --version 2>&1 | Out-String).Trim()
  if ($versionText -match '(\d+\.\d+\.\d+)') { $driverVersion = $Matches[1] }
} catch {}
$companionVersion = $null
try {
  $companionText = (& openmausbot-worker-companion --version 2>&1 | Out-String).Trim()
  if ($companionText -match '(\d+)$') { $companionVersion = [int]$Matches[1] }
} catch {}
$privileged = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$explorers = @(Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -ieq $currentUser })
$interactiveSessions = @($explorers | ForEach-Object { $_.SessionId } | Select-Object -Unique)
$locked = @(Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object { $interactiveSessions -contains $_.SessionId }).Count -gt 0
$channelAvailable = $false
$channelAccess = 'unknown'
try {
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'cua-driver', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
  try { $pipe.Connect(1000); $channelAvailable = $pipe.IsConnected; $channelAccess = if ($channelAvailable) { 'ok' } else { 'missing' } }
  finally { $pipe.Dispose() }
} catch [System.UnauthorizedAccessException] { $channelAccess = 'denied' }
catch [System.TimeoutException] { $channelAccess = 'missing' }
catch { $channelAccess = 'missing' }
$policyPath = Join-Path $env:LOCALAPPDATA 'OpenMausBot\windows-policy.yaml'
$policyDigest = $null
if (Test-Path -LiteralPath $policyPath -PathType Leaf) { $policyDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $policyPath).Hash.ToLowerInvariant() }
$daemonStatus = ''
try { $daemonStatus = (& cua-driver status --socket '\\.\pipe\cua-driver' 2>&1 | Out-String).ToLowerInvariant() } catch {}
$interactiveSessionId = $null
if ($daemonStatus -match 'session:\s*(\d+)') { $interactiveSessionId = [int]$Matches[1] }
$interactive = $interactiveSessionId -ne $null -and $interactiveSessions -contains $interactiveSessionId
$policyLoaded = $false
if ($policyDigest) { $policyLoaded = $daemonStatus.Contains($policyDigest) }
$permissionMode = 'unknown'
if ($daemonStatus -match '\bbounded\b') { $permissionMode = 'bounded' }
elseif ($daemonStatus -match '\bstandard\b') { $permissionMode = 'standard' }
elseif ($daemonStatus -match '\bunrestricted\b') { $permissionMode = 'unrestricted' }
$capabilityPath = Join-Path $env:LOCALAPPDATA 'OpenMausBot\active-capabilities.yaml'
$capabilityDigest = $null
if (Test-Path -LiteralPath $capabilityPath -PathType Leaf) { $capabilityDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $capabilityPath).Hash.ToLowerInvariant() }
$capabilityLoaded = $false
if ($capabilityDigest) { $capabilityLoaded = $daemonStatus.Contains($capabilityDigest) }
[ordered]@{
  driverVersion = $driverVersion
  companionVersion = $companionVersion
  privileged = $privileged
  interactiveSession = $interactive
  interactiveSessionId = $interactiveSessionId
  locked = $locked
  channelPath = '\\.\pipe\cua-driver'
  channelAvailable = $channelAvailable
  channelAccess = $channelAccess
  policyDigest = $policyDigest
  policyLoaded = $policyLoaded
  permissionMode = $permissionMode
  capabilityDigest = $capabilityDigest
  capabilityLoaded = $capabilityLoaded
} | ConvertTo-Json -Compress
`;

// Windows PowerShell's `-Command -` reads stdin interactively and does not
// reliably assemble multiline blocks. Keep argv short and fixed by encoding
// only this tiny bootstrap; the full fixed probe stays on stdin and is parsed
// as one script block.
const HEALTH_STDIN_WRAPPER_BASE64 = Buffer.from(
  "$source = [Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($source))",
  "utf16le",
).toString("base64");

export function windowsWorkerHealthArgs(sshAlias: string): string[] {
  return [
    ...remoteWorkerSshBaseArgs(sshAlias),
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    HEALTH_STDIN_WRAPPER_BASE64,
  ];
}

export async function windowsWorkerStatus(
  worker: ResolvedWorker,
  options: {
    runner?: RemoteWorkerSshRunner;
    lease?: RemoteWorkerLease;
    isBotBusy?: (botId: string) => boolean;
  } = {},
): Promise<RemoteWorkerStatus> {
  const status = baseWorkerStatus(worker);
  if (!worker.configured) return status;
  if (worker.paused) return failWorker(status, "paused", "worker_paused", "This worker is paused");

  const runner = options.runner ?? defaultRemoteWorkerRunner;
  let report: JsonValue;
  try {
    // Keep the fixed health program off argv. Windows OpenSSH invokes the
    // user's command through cmd.exe, whose command-line ceiling is lower
    // than PowerShell's encoded form of this probe. Stdin also keeps process
    // listings limited to one fixed, inspectable command.
    const result = await runner(
      windowsWorkerHealthArgs(worker.sshAlias),
      WORKER_SSH_TIMEOUT_MS,
      WINDOWS_HEALTH_SCRIPT,
    );
    report = parseJson(result.stdout.trim());
  } catch (error) {
    return failWorker(status, "offline", "worker_offline",
      `Worker SSH is offline: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
  }

  applyHealthReport(status, report);
  const failed = evaluateSharedHealth(status);
  if (failed) return failed;
  return finishWorkerStatus(status, worker.sshAlias, options);
}
