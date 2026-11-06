param([Parameter(Mandatory = $true)][ValidateRange(1024, 65535)][int]$Port)

$ErrorActionPreference = 'Stop'
try {
  $connections = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  if ($connections.Count -eq 0) {
    Write-Output 'PageAtlas is already stopped.'
    exit 0
  }
  $info = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/server-info" -TimeoutSec 3
  $expectedRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\', '/')
  if ($info.app -ne 'PageAtlas' -or -not [string]::Equals(([string]$info.projectRoot).TrimEnd('\', '/'), $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The app on this port is not PageAtlas from this folder. It was left running.'
  }
  if ($connections.Count -ne 1 -or $connections[0].OwningProcess -ne $info.pid) {
    throw 'The server process changed. Try again.'
  }
  $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($connections[0].OwningProcess)"
  if (-not $serverProcess -or $serverProcess.Name -ne 'node.exe' -or $serverProcess.CommandLine -notmatch 'server[/\\]index\.ts(?:"|\s|$)') {
    throw 'The process could not be verified as the PageAtlas server. It was left running.'
  }
  $stopId = $serverProcess.ProcessId
  $parentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($serverProcess.ParentProcessId)"
  if ($parentProcess -and $parentProcess.Name -eq 'node.exe' -and
      $parentProcess.ExecutablePath -eq $serverProcess.ExecutablePath -and
      $parentProcess.CommandLine -match '(?:^|\s)--watch(?:\s|$)' -and
      $parentProcess.CommandLine -match 'server[/\\]index\.ts(?:"|\s|$)') {
    # Stop the watcher too, so it cannot bring the server back immediately.
    $stopId = $parentProcess.ProcessId
  }
  & taskkill.exe /PID $stopId /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Windows could not stop PageAtlas.' }
  Write-Output 'PageAtlas server stopped.'
} catch {
  Write-Host "Could not stop PageAtlas: $($_.Exception.Message)"
  Write-Host 'If this is an older running copy, close its original server window once and try again.'
  exit 1
}
