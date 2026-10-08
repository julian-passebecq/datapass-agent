param(
  [Parameter(Mandatory=$true)][string]$ReadyPath,
  [Parameter(Mandatory=$true)][string]$UserDataDir,
  [Parameter(Mandatory=$true)][string]$ExtensionsDir,
  [string]$CodeCommand = 'code'
)
$ErrorActionPreference = 'Stop'
$taskReadyFile = (Resolve-Path -LiteralPath $ReadyPath).Path
$taskRoot = Split-Path -Parent $taskReadyFile
$taskReady = Get-Content -LiteralPath $taskReadyFile -Raw | ConvertFrom-Json
if ($taskReady.schema -ne 'galaxy.component-ready/1' -or $taskReady.lane -ne 'AGENT' -or $taskReady.contractMajor -ne 1 -or $taskReady.workstreamId -ne 'COCKPIT-20261008-NIGHT4') { throw 'Unsupported Agent READY.' }
$taskPackage = @($taskReady.artifacts | Where-Object { $_.kind -eq 'vsix' })
if ($taskPackage.Count -ne 1) { throw 'READY must reference one Agent VSIX.' }
$taskArtifact = $taskPackage[0]
if ($taskArtifact.relativePath -notmatch '^[a-zA-Z0-9._-]+\.vsix$') { throw 'Unsafe VSIX locator.' }
$taskVSIX = Join-Path $taskRoot $taskArtifact.relativePath
if ((Get-Item -LiteralPath $taskVSIX).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked VSIX refused.' }
if ((Get-FileHash -LiteralPath $taskVSIX -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskArtifact.sha256 -or (Get-Item -LiteralPath $taskVSIX).Length -ne $taskArtifact.bytes) { throw 'Agent VSIX hash or size mismatch.' }
# Explicit separate profile arguments are required; do not modify the everyday profile.
& $CodeCommand --user-data-dir $UserDataDir --extensions-dir $ExtensionsDir --install-extension $taskVSIX --force
if ($LASTEXITCODE -ne 0) { throw 'VSIX installation failed.' }
