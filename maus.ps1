[string[]]$ComposeArgs = @(if ($args.Count) { $args } else { 'ps' })
$ErrorActionPreference = 'Stop'
$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
$dockerPath = if ($dockerCommand) { $dockerCommand.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe' }
if (-not (Test-Path -LiteralPath $dockerPath)) {
    $dockerPath = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
}
if (-not (Test-Path -LiteralPath $dockerPath)) {
    throw 'Docker CLI was not found. Install Docker Desktop and add docker to PATH.'
}
& $dockerPath compose --project-directory $PSScriptRoot -f (Join-Path $PSScriptRoot 'compose.yaml') @ComposeArgs
exit $LASTEXITCODE
