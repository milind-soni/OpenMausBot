# Windows/WSL2 entry point. Run setup once, then pass Compose arguments verbatim.
$ErrorActionPreference = 'Stop'
if (-not $args.Count -or $args[0] -in @('--help', '-h', 'help')) {
    Write-Output 'Usage: .\deploy\podman\maus.ps1 setup | <compose arguments>'
    Write-Output 'Example: .\deploy\podman\maus.ps1 up -d --build'
    Write-Output 'Options: OMB_PODMAN_MACHINE (default openmausbot), OMB_PODMAN_ENV_FILE (default .env)'
    exit 0
}
$podmanCommand = Get-Command podman.exe -ErrorAction SilentlyContinue
$podman = if ($podmanCommand) { $podmanCommand.Source } else { 'C:\Program Files\RedHat\Podman\podman.exe' }
if (-not (Test-Path -LiteralPath $podman)) { throw 'Install Podman and WSL2 first; then reopen PowerShell.' }
$machine = if ($env:OMB_PODMAN_MACHINE) { $env:OMB_PODMAN_MACHINE } else { 'openmausbot' }
if ($machine -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid Podman machine name.' }
if ($PSScriptRoot -notmatch '^([A-Za-z]):\\(.+)$') { throw 'Place the repository on a Windows drive accessible to WSL2.' }
$linuxProject = '/mnt/' + $Matches[1].ToLower() + '/' + $Matches[2].Replace('\', '/')
function Quote-Posix([string]$value) { return "'" + $value.Replace("'", "'\''") + "'" }
$quotedProject = Quote-Posix $linuxProject
$machinesJson = & $podman machine list --format json
if ($LASTEXITCODE -ne 0) { throw 'Could not list Podman machines.' }
$selected = ($machinesJson | ConvertFrom-Json) | Where-Object Name -eq $machine
if ($args[0] -eq 'setup') {
    if (-not $selected) {
        & $podman machine init --cpus 4 --memory 10240 --disk-size 60 $machine
        if ($LASTEXITCODE -ne 0) { throw 'Podman machine creation failed.' }
    }
    if ($selected -and $selected.VMType -ne 'wsl') { throw 'This launcher requires a WSL2 Podman machine.' }
    if (-not $selected -or -not $selected.Running) {
        & $podman machine start $machine
        if ($LASTEXITCODE -ne 0) { throw 'Podman machine startup failed.' }
    }
    # Installation is explicit and limited to setup, never run for ps/logs/down.
    & $podman machine ssh $machine 'command -v podman-compose >/dev/null || sudo dnf install -y podman-compose'
    if ($LASTEXITCODE -ne 0) { throw 'Install podman-compose in the machine, then retry setup.' }
    & $podman machine ssh $machine "cd $quotedProject && sh setup.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Podman setup failed. Check the user systemd service and rootless configuration.' }
    exit 0
}
if (-not $selected -or -not $selected.Running) { throw 'Start the selected machine with podman machine start, or run this script with setup first.' }
if ($selected.VMType -ne 'wsl') { throw 'This launcher requires a WSL2 Podman machine.' }
$envFile = if ($env:OMB_PODMAN_ENV_FILE) { $env:OMB_PODMAN_ENV_FILE } else { '.env' }
# Podman machine ssh uses a remote POSIX shell. Quote each argument separately,
# including paths containing spaces or apostrophes; never concatenate raw input.
$command = 'cd ' + $quotedProject + ' && PODMAN_COMPOSE_PROVIDER=podman-compose podman compose --env-file ' + (Quote-Posix $envFile) + ' -f compose.yaml ' + (($args | ForEach-Object { Quote-Posix $_ }) -join ' ')
& $podman machine ssh $machine $command
exit $LASTEXITCODE
