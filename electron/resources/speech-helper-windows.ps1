# Windows dictation through the speech recognizer built into Windows (System.Speech): on this computer, offline, no key.
# Same output as speech-helper.swift, one JSON object per line on stdout:
#   {"partial":true,"text":"..."}   while recognizing
#   {"partial":false,"text":"..."}  final result, then exit 0
#   {"error":"..."}                 then exit 1
# Commands arrive on stdin, one per line: "finish" ends the audio and sends the final result. stdin closing because the
# app is gone exits at once without one; the app stops a session by ending this process.
# -EndpointMs N finishes after N milliseconds without a changed transcript (calls); dictation leaves it 0.
param([int]$EndpointMs = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Send-Line($line) {
  [Console]::Out.WriteLine(($line | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Join-Text($left, $right) {
  if ($left -and $right) { return "$left $right" }
  if ($left) { return $left }
  return $right
}

try {
  Add-Type -AssemblyName System.Speech
  $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
} catch {
  Send-Line @{ error = 'speech-unavailable' }
  exit 1
}
if ($installed.Count -eq 0) {
  Send-Line @{ error = 'speech-language-missing' }
  exit 1
}
# The person's display language first, then the same language in another region, then any installed recognizer.
$culture = [System.Globalization.CultureInfo]::CurrentUICulture
$recognizer = $installed | Where-Object { $_.Culture.Name -eq $culture.Name } | Select-Object -First 1
if (-not $recognizer) {
  $recognizer = $installed | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $culture.TwoLetterISOLanguageName } | Select-Object -First 1
}
if (-not $recognizer) { $recognizer = $installed[0] }

try {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($recognizer)
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToDefaultAudioDevice()
} catch {
  Send-Line @{ error = 'helper-start-failed' }
  exit 1
}

Register-ObjectEvent -InputObject $engine -EventName SpeechHypothesized -SourceIdentifier 'omb-heard' | Out-Null
Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier 'omb-recognized' | Out-Null
Register-ObjectEvent -InputObject $engine -EventName RecognizeCompleted -SourceIdentifier 'omb-completed' | Out-Null

$commands = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$command = $commands.ReadLineAsync()
$committed = ''
$shown = ''
$changedAt = [DateTime]::UtcNow
$finishing = $false
$engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

while ($true) {
  foreach ($received in @(Get-Event)) {
    Remove-Event -EventIdentifier $received.EventIdentifier
    switch ($received.SourceIdentifier) {
      'omb-heard' {
        $text = Join-Text $committed $received.SourceEventArgs.Result.Text
        if ($text -ne $shown) {
          $shown = $text
          $changedAt = [DateTime]::UtcNow
          Send-Line @{ partial = $true; text = $text }
        }
      }
      'omb-recognized' {
        $committed = Join-Text $committed $received.SourceEventArgs.Result.Text
        $shown = $committed
        $changedAt = [DateTime]::UtcNow
        Send-Line @{ partial = $true; text = $committed }
      }
      'omb-completed' {
        if ($received.SourceEventArgs.Error) {
          Send-Line @{ error = 'helper-exited' }
          exit 1
        }
        Send-Line @{ partial = $false; text = $committed }
        exit 0
      }
    }
  }
  if (-not $finishing -and $command.IsCompleted) {
    $line = $null
    if (-not $command.IsFaulted) { $line = $command.Result }
    if ($null -eq $line) {
      $engine.RecognizeAsyncCancel()
      exit 0
    }
    if ($line.Trim() -eq 'finish') {
      $finishing = $true
      $engine.RecognizeAsyncStop()
    } else {
      $command = $commands.ReadLineAsync()
    }
  }
  if (-not $finishing -and $EndpointMs -gt 0 -and $shown -and ([DateTime]::UtcNow - $changedAt).TotalMilliseconds -ge $EndpointMs) {
    $finishing = $true
    $engine.RecognizeAsyncStop()
  }
  Start-Sleep -Milliseconds 50
}
