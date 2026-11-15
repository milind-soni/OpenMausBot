$replacements = @(
  @{ From = "Obot"; To = "Obot" },
  @{ From = "obot"; To = "obot" },
  @{ From = "Obot"; To = "Obot" },
  @{ From = "OBOT"; To = "OBOT" },
  @{ From = "Obot"; To = "Obot" },
  @{ From = "www.obot.com"; To = "github.com/alnatourm/obot" },
  @{ From = "obot.com"; To = "github.com/alnatourm/obot" },
  @{ From = "alnatourm/Obot"; To = "alnatourm/obot" }
)
$excludeDirs = @(".git", "node_modules", "dist", "release", ".next")
$extensions = @("*.ts","*.tsx","*.js","*.jsx","*.json","*.html","*.md","*.yml","*.yaml","*.toml","*.css","*.txt")
Get-ChildItem -Recurse -File -Include $extensions | Where-Object {
  $full = $_.FullName
  -not ($excludeDirs | Where-Object { $full -like "*\$_\*" })
} | ForEach-Object {
  try {
    $text = [System.IO.File]::ReadAllText($_.FullName)
  } catch { return }
  $original = $text
  foreach ($r in $replacements) { $text = $text.Replace($r.From, $r.To) }
  if ($text -ne $original) {
    [System.IO.File]::WriteAllText($_.FullName, $text)
    Write-Host "Updated: $($_.FullName)"
  }
}
Write-Host "Done"