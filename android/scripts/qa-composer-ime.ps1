param(
    [Parameter(Mandatory = $true)]
    [string]$Adb,
    [Parameter(Mandatory = $true)]
    [string]$Serial,
    [int]$MaximumGapPx = 120
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Adb)) { throw "adb not found: $Adb" }

function Read-WindowXml {
    & $Adb -s $Serial shell uiautomator dump /sdcard/openmaus-window.xml | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not capture the Android accessibility tree.' }
    return ((& $Adb -s $Serial shell cat /sdcard/openmaus-window.xml) -join '')
}

$xml = Read-WindowXml
$composer = [regex]::Match($xml, 'text="Message Chief"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
if (-not $composer.Success) {
    throw 'Open the Chief chat before running this check; the empty Message Chief composer was not visible.'
}

$tapX = [math]::Floor(([int]$composer.Groups[1].Value + [int]$composer.Groups[3].Value) / 2)
$tapY = [math]::Floor(([int]$composer.Groups[2].Value + [int]$composer.Groups[4].Value) / 2)
& $Adb -s $Serial shell input tap $tapX $tapY | Out-Null
Start-Sleep -Milliseconds 700

$xml = Read-WindowXml
$focused = [regex]::Match(
    $xml,
    'class="android.widget.EditText"[^>]*focused="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
)
if (-not $focused.Success) { throw 'The message composer did not receive focus.' }

$window = ((& $Adb -s $Serial shell dumpsys window) -join "`n")
$ime = [regex]::Match($window, 'type=ime frame=\[0,(\d+)\]\[\d+,\d+\][^\r\n]*visible=true')
if (-not $ime.Success) { throw 'The keyboard did not become visible.' }

$composerBottom = [int]$focused.Groups[4].Value
$imeTop = [int]$ime.Groups[1].Value
$gap = $imeTop - $composerBottom
$backButton = [regex]::Match(
    $xml,
    'content-desc="Back"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
)

if (-not $backButton.Success) {
    throw 'Opening the keyboard removed the chat navigation header.'
}

$headerTop = [int]$backButton.Groups[2].Value
$headerBottom = [int]$backButton.Groups[4].Value
if ($headerTop -lt 0 -or $headerBottom -gt $imeTop) {
    throw "The chat navigation header moved outside the visible resized frame: ${headerTop}-${headerBottom}px."
}

if ($gap -gt $MaximumGapPx) {
    throw "Composer-to-keyboard gap is ${gap}px; expected no more than ${MaximumGapPx}px."
}
if ($gap -lt 0) {
    throw "Composer overlaps the keyboard by $(-$gap)px."
}

"PASS header=${headerTop}-${headerBottom}px composer-to-keyboard gap=${gap}px limit=${MaximumGapPx}px"
