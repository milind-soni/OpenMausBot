param(
    [Parameter(Mandatory = $true)]
    [string]$Adb,
    [Parameter(Mandatory = $true)]
    [string]$Apk,
    [string]$Serial = '',
    [int]$Launches = 10
)

$ErrorActionPreference = 'Stop'
$package = 'com.openmausbot.chief'
$activity = "$package/.MainActivity"
$target = if ([string]::IsNullOrWhiteSpace($Serial)) { @() } else { @('-s', $Serial) }

if (-not (Test-Path -LiteralPath $Adb)) { throw "adb not found: $Adb" }
if (-not (Test-Path -LiteralPath $Apk)) { throw "APK not found: $Apk" }

$installOutput = & $Adb @target install -r -t $Apk 2>&1
if ($LASTEXITCODE -ne 0 -or $installOutput -notcontains 'Success') {
    throw "APK installation failed:`n$($installOutput -join "`n")"
}

for ($attempt = 1; $attempt -le $Launches; $attempt++) {
    & $Adb @target shell am force-stop $package | Out-Null
    & $Adb @target logcat -c

    $startOutput = & $Adb @target shell am start -W -n $activity 2>&1
    if ($LASTEXITCODE -ne 0 -or ($startOutput -join "`n") -match 'Error:') {
        throw "Launch $attempt failed to start:`n$($startOutput -join "`n")"
    }

    Start-Sleep -Seconds 2
    $fatal = (& $Adb @target logcat -d -v brief 'AndroidRuntime:E' '*:S' 2>&1) -join "`n"
    $appPid = (& $Adb @target shell pidof $package 2>$null).Trim()
    $activityState = (& $Adb @target shell dumpsys activity activities 2>$null) -join "`n"
    $isVisible = $activityState -match "topResumedActivity=.*$([regex]::Escape($package))" -or
        $activityState -match "mResumedActivity:.*$([regex]::Escape($package))"

    if ($fatal -match 'FATAL EXCEPTION' -or [string]::IsNullOrWhiteSpace($appPid) -or -not $isVisible) {
        throw "Launch $attempt reproduced an app close.`nPID=$appPid`nVisible=$isVisible`n$startOutput`n$fatal"
    }

    "PASS launch=$attempt pid=$appPid visible=$isVisible"
}

"PASS exact-apk cold-launch stress ($Launches/$Launches) sha256=$((Get-FileHash -Algorithm SHA256 -LiteralPath $Apk).Hash.ToLowerInvariant())"
