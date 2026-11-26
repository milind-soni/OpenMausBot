# Windows dictation through the newer Windows speech (Windows.Media.SpeechRecognition), for display languages the
# desktop recognizer has no recognizer for (Portuguese (Brazil) and others Windows covers only with its newer speech
# packs). speech-helper-windows.ps1 runs this script in its own session, so Send-Line and Join-Text are its functions,
# and the output lines and stdin commands are the same.
# Exit code 3, with nothing written, means this script cannot listen here (no newer speech, the language is not
# installed, or Windows' online speech recognition setting is off): the caller goes on without it.
param([int]$EndpointMs = 0)

$ErrorActionPreference = 'Stop'
$cannotListen = 3

# The display language first, then the same language in another region; $null when Windows has neither.
function Select-SpeechLanguage($tags, [string]$name) {
  $exact = @($tags | Where-Object { $_ -eq $name })
  if ($exact.Count) { return $exact[0] }
  $base = ($name -split '-')[0]
  $same = @($tags | Where-Object { ($_ -split '-')[0] -eq $base })
  if ($same.Count) { return $same[0] }
  return $null
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Media.SpeechRecognition, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
} catch {
  exit $cannotListen
}

$asTask = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 })
$asTaskAction = $asTask | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
$asTaskOperation = $asTask | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Wait-Action($action) {
  $asTaskAction.Invoke($null, @($action)).Wait() | Out-Null
}
function Wait-Operation($operation, [Type]$type) {
  $task = $asTaskOperation.MakeGenericMethod($type).Invoke($null, @($operation))
  $task.Wait() | Out-Null
  return $task.Result
}

$sources = 'omb-onecore-heard', 'omb-onecore-recognized', 'omb-onecore-completed'
$recognizer = $null
function Exit-CannotListen {
  foreach ($source in $sources) { Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue }
  if ($recognizer) { $recognizer.Dispose() }
  exit $cannotListen
}
try {
  $tags = @([Windows.Media.SpeechRecognition.SpeechRecognizer]::SupportedTopicLanguages | ForEach-Object { $_.LanguageTag })
  $tag = Select-SpeechLanguage $tags ([System.Globalization.CultureInfo]::CurrentUICulture.Name)
  if (-not $tag) { Exit-CannotListen }
  $recognizer = [Windows.Media.SpeechRecognition.SpeechRecognizer]::new([Windows.Globalization.Language]::new($tag))
  # No constraint added: the recognizer compiles its own dictation grammar.
  $compiled = Wait-Operation ($recognizer.CompileConstraintsAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult])
  if ($compiled.Status -ne [Windows.Media.SpeechRecognition.SpeechRecognitionResultStatus]::Success) { Exit-CannotListen }
  $session = $recognizer.ContinuousRecognitionSession
  # Its default ends a dictation after a few seconds of quiet; the app ends it with "finish" or -EndpointMs instead.
  $session.AutoStopSilenceTimeout = [TimeSpan]::FromMinutes(10)
  Register-ObjectEvent -InputObject $recognizer -EventName HypothesisGenerated -SourceIdentifier $sources[0] | Out-Null
  Register-ObjectEvent -InputObject $session -EventName ResultGenerated -SourceIdentifier $sources[1] | Out-Null
  Register-ObjectEvent -InputObject $session -EventName Completed -SourceIdentifier $sources[2] | Out-Null
  Wait-Action ($session.StartAsync())
} catch {
  # Windows refuses to start when its online speech recognition setting is off.
  Exit-CannotListen
}

$commands = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$command = $commands.ReadLineAsync()
$committed = ''
$shown = ''
$changedAt = [DateTime]::UtcNow
$finishedAt = $null
$success = [Windows.Media.SpeechRecognition.SpeechRecognitionResultStatus]::Success

# A failure while listening ends the dictation with an error, never by trying the desktop recognizer.
try {
  while ($true) {
    foreach ($received in @(Get-Event)) {
      Remove-Event -EventIdentifier $received.EventIdentifier
      switch ($received.SourceIdentifier) {
        'omb-onecore-heard' {
          $text = Join-Text $committed $received.SourceEventArgs.Hypothesis.Text
          if ($text -ne $shown) {
            $shown = $text
            $changedAt = [DateTime]::UtcNow
            Send-Line @{ partial = $true; text = $text }
          }
        }
        'omb-onecore-recognized' {
          $result = $received.SourceEventArgs.Result
          if ($result.Status -eq $success -and $result.Text) {
            $committed = Join-Text $committed $result.Text
          }
          $shown = $committed
          $changedAt = [DateTime]::UtcNow
          Send-Line @{ partial = $true; text = $committed }
        }
        'omb-onecore-completed' {
          # Success after "finish", TimeoutExceeded after the long quiet above: both end with what was heard.
          $status = $received.SourceEventArgs.Status
          if ($status -ne $success -and $status -ne [Windows.Media.SpeechRecognition.SpeechRecognitionResultStatus]::TimeoutExceeded) {
            Send-Line @{ error = 'helper-exited' }
            exit 1
          }
          Send-Line @{ partial = $false; text = $committed }
          exit 0
        }
      }
    }
    if (-not $finishedAt -and $command.IsCompleted) {
      $line = $null
      if (-not $command.IsFaulted) { $line = $command.Result }
      if ($null -eq $line) {
        $session.CancelAsync() | Out-Null
        exit 0
      }
      if ($line.Trim() -eq 'finish') {
        $finishedAt = [DateTime]::UtcNow
        $session.StopAsync() | Out-Null
      } else {
        $command = $commands.ReadLineAsync()
      }
    }
    if (-not $finishedAt -and $EndpointMs -gt 0 -and $shown -and ([DateTime]::UtcNow - $changedAt).TotalMilliseconds -ge $EndpointMs) {
      $finishedAt = [DateTime]::UtcNow
      $session.StopAsync() | Out-Null
    }
    # Windows normally reports Completed soon after the stop; if it never does, end with what was heard.
    if ($finishedAt -and ([DateTime]::UtcNow - $finishedAt).TotalSeconds -ge 5) {
      Send-Line @{ partial = $false; text = $committed }
      exit 0
    }
    Start-Sleep -Milliseconds 50
  }
} catch {
  Send-Line @{ error = 'helper-exited' }
  exit 1
}
