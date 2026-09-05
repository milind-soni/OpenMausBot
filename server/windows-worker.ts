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

export const WINDOWS_HEALTH_SCRIPT = String.raw`
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
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$adminGroupSid = 'S-1-5-32-544'
$privileged = @($currentIdentity.Groups | Where-Object { $_.Value -eq $adminGroupSid }).Count -gt 0
# WMI process ownership is unavailable to this non-admin OpenSSH token. Use
# query-only process/token handles and the named-pipe server PID instead.
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class WorkerNative { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint processId); [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId); [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle); }'
function Get-ProcessOwnerSid([uint32]$processId) {
  $handle = [WorkerNative]::OpenProcess(0x1000, $false, $processId)
  if ($handle -eq [IntPtr]::Zero) { return $null }
  $token = [IntPtr]::Zero
  try {
    if (-not [WorkerNative]::OpenProcessToken($handle, 8, [ref]$token)) { return $null }
    $identity = [Security.Principal.WindowsIdentity]::new($token)
    try { return $identity.User.Value } finally { $identity.Dispose() }
  } finally {
    if ($token -ne [IntPtr]::Zero) { [void][WorkerNative]::CloseHandle($token) }
    [void][WorkerNative]::CloseHandle($handle)
  }
}
$explorers = @(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object {
  $_.SessionId -gt 0 -and (Get-ProcessOwnerSid $_.Id) -eq $currentIdentity.User.Value
})
$interactiveSessions = @($explorers | ForEach-Object { $_.SessionId } | Select-Object -Unique)
$locked = @(Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object { $interactiveSessions -contains $_.SessionId }).Count -gt 0
$channelAvailable = $false
$channelAccess = 'unknown'
$daemonProcessId = [uint32]0
# CUA 0.20.0 status has no Windows session field. Bind readiness to the actual
# named-pipe server, not the PID file printed by the CLI or another user.
function Get-LoadedDigest([string]$path, [string]$kind) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $stream = [IO.MemoryStream]::new()
  try {
    $domain = if ($kind -eq 'policy') { 'cua-driver-policy-v1' } else { 'cua-driver-capability-manifest-v3' }
    $prefix = [Text.Encoding]::UTF8.GetBytes($domain + [char]0)
    $stream.Write($prefix, 0, $prefix.Length)
    if ($kind -eq 'policy') {
      $name = [Text.Encoding]::UTF8.GetBytes([IO.Path]::GetFileName($path))
      foreach ($part in @($name, $bytes)) {
        $length = [BitConverter]::GetBytes([uint64]$part.Length)
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($length) }
        $stream.Write($length, 0, $length.Length)
        $stream.Write($part, 0, $part.Length)
      }
    } else { $stream.Write($bytes, 0, $bytes.Length) }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($stream.ToArray()))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
  } finally { $stream.Dispose() }
}
try {
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'cua-driver', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
  try {
    $pipe.Connect(1000)
    $channelAvailable = $pipe.IsConnected
    $channelAccess = if ($channelAvailable) { 'ok' } else { 'missing' }
    if ($channelAvailable) { [void][WorkerNative]::GetNamedPipeServerProcessId($pipe.SafePipeHandle.DangerousGetHandle(), [ref]$daemonProcessId) }
  }
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
if ($daemonProcessId -gt 0) {
  $daemon = Get-Process -Id $daemonProcessId -ErrorAction SilentlyContinue
  if ($daemon -and $daemon.ProcessName -ieq 'cua-driver') {
    $expectedExecutable = (Get-Command cua-driver -CommandType Application -ErrorAction SilentlyContinue).Source
    if ((Get-ProcessOwnerSid $daemonProcessId) -eq $currentIdentity.User.Value -and $daemon.Path -ieq $expectedExecutable) {
      $interactiveSessionId = [int]$daemon.SessionId
    }
  }
}
$interactive = $interactiveSessionId -ne $null -and $interactiveSessions -contains $interactiveSessionId
$policyLoaded = $false
if ($policyDigest) {
  $loadedDigest = Get-LoadedDigest $policyPath 'policy'
  $policyLoaded = $daemonStatus -match ('(?m)^\s*user policy sha256:\s*' + $loadedDigest + '\s*$')
}
$permissionMode = 'unknown'
if ($daemonStatus -match '\bbounded\b') { $permissionMode = 'bounded' }
elseif ($daemonStatus -match '\bstandard\b') { $permissionMode = 'standard' }
elseif ($daemonStatus -match '\bunrestricted\b') { $permissionMode = 'unrestricted' }
$capabilityPath = Join-Path $env:LOCALAPPDATA 'OpenMausBot\active-capabilities.yaml'
$capabilityDigest = $null
if (Test-Path -LiteralPath $capabilityPath -PathType Leaf) { $capabilityDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $capabilityPath).Hash.ToLowerInvariant() }
$capabilityLoaded = $false
if ($capabilityDigest) {
  $loadedDigest = Get-LoadedDigest $capabilityPath 'capability'
  $capabilityLoaded = $daemonStatus -match ('(?m)^\s*capability manifest sha256:\s*' + $loadedDigest + '\s*$')
}
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
    expectedCapabilityDigest?: string | null;
  } = {},
): Promise<RemoteWorkerStatus> {
  const status = baseWorkerStatus(worker);
  status.expectedCapabilityDigest = options.expectedCapabilityDigest ?? worker.expectedParkedCapabilitySha256;
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
  } catch {
    return failWorker(status, "offline", "worker_offline", "Worker SSH is offline or unreachable");
  }

  applyHealthReport(status, report);
  const failed = evaluateSharedHealth(status);
  if (failed) return failed;
  return finishWorkerStatus(status, worker.sshAlias, options);
}
