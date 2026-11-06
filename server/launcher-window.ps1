param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$portText = if ($env:PAGEATLAS_PORT) { $env:PAGEATLAS_PORT } else { '4317' }
$hash = [Security.Cryptography.SHA256]::Create()
try {
  $identity = [Text.Encoding]::UTF8.GetBytes("$($projectRoot.ToLowerInvariant()):$portText")
  $key = ([BitConverter]::ToString($hash.ComputeHash($identity))).Replace('-', '')
} finally { $hash.Dispose() }

# Keep ownership for the entire menu lifetime. A second double-click opens the
# existing app and exits its temporary command window instead of adding a menu.
$mutex = [Threading.Mutex]::new($false, "Local\PageAtlasMenu-$key")
$ownsMenu = $false
try {
  try { $ownsMenu = $mutex.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $ownsMenu = $true }
  if (-not $ownsMenu) {
    Write-Output 'The PageAtlas menu is already open. Opening the existing app.'
    $openArgs = @('--open')
    if ($NoBrowser) { $openArgs += '--no-browser' }
    & node (Join-Path $PSScriptRoot 'launch.mjs') @openArgs
    exit $LASTEXITCODE
  }
  $launcher = Join-Path $projectRoot 'Start PageAtlas.bat'
  # Reuse this console; do not use Start-Process or create another console.
  & $env:ComSpec /d /c "call `"$launcher`" --menu"
  exit $LASTEXITCODE
} finally {
  if ($ownsMenu) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
